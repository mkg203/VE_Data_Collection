import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { parse } from 'csv-parse/sync';
import { Storage } from '@google-cloud/storage';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const storageOptions: any = {};
if (process.env.GCP_PROJECT_ID) {
  storageOptions.projectId = process.env.GCP_PROJECT_ID;
}
if (process.env.GCP_CLIENT_EMAIL && process.env.GCP_PRIVATE_KEY) {
  storageOptions.credentials = {
    client_email: process.env.GCP_CLIENT_EMAIL,
    private_key: process.env.GCP_PRIVATE_KEY.replace(/\\n/g, '\n'),
  };
}
const storageClient = new Storage(storageOptions);

const BUCKET_NAME = process.env.GCP_BUCKET_NAME || 'vetest-data-collection';

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log("=== DRY RUN MODE: No database changes will be made ===");
  }
  console.log("starting questions import");

  let promptGroups: Record<string, string> = {};
  if (fs.existsSync('uploadthing/prompt_groups.json')) {
    promptGroups = JSON.parse(fs.readFileSync('uploadthing/prompt_groups.json', 'utf-8'));
    console.log(`Loaded ${Object.keys(promptGroups).length} prompt groups.`);
  } else {
    console.warn("prompt_groups.json not found.");
  }

  const csvPaths = glob.sync('uploadthing/data_export-*.csv');
  if (csvPaths.length === 0) {
    console.error(`No CSV files found matching uploadthing/data_export-*.csv`);
    process.exit(1);
  }

  let allRecords: any[] = [];
  for (const p of csvPaths) {
    const csvContent = fs.readFileSync(p, 'utf-8');
    const records = parse(csvContent, { columns: true, skip_empty_lines: true });
    allRecords = allRecords.concat(records);
  }

  const baseRecords = new Map<string, any>();
  for (const record of allRecords) {
    if (!record.filename || !record.type) continue;
    const match = record.filename.match(/^([A-Z])-([a-zA-Z_]+)-(image\d+)(?:[-_](.+))?\.jpg$/);
    if (match) {
        const bn = `${match[1]}-${match[2]}-${match[3]}`;
        baseRecords.set(bn, record);
    }
  }

  const allImages = glob.sync('uploadthing/images/*.jpg');
  
  for (const imagePath of allImages) {
    const filename = path.basename(imagePath);
    const match = filename.match(/^([A-Z])-([a-zA-Z_]+)-(image\d+)(?:[-_](.+))?\.jpg$/);
    
    if (!match) {
      console.warn(`Skipping ${filename}: Invalid filename format.`);
      continue;
    }

    const alphabet = match[1];
    const fileType = match[2].toUpperCase(); 
    const imageIdPart = match[3];
    const variantTag = match[4] || 'normal';
    
    const bn = `${alphabet}-${match[2]}-${imageIdPart}`;
    const record = baseRecords.get(bn);

    if (!record) {
        console.warn(`Skipping ${filename}: No matching base record found in CSVs.`);
        continue;
    }

    const { type, custom_prompt, shorthand_notes } = record;

    const imageId = `${alphabet}-${imageIdPart}`;

    const dbType = type.toUpperCase();
    const lowerNotes = shorthand_notes?.trim().toLowerCase() || '';
    const isBoolean = lowerNotes === 'yes' || lowerNotes === 'no';

    let text = custom_prompt;
    if (custom_prompt && custom_prompt.length <= 3) {
      text = promptGroups[custom_prompt] || `Missing prompt for ID ${custom_prompt}`;
    }

    let actualAnswerNum: number | null = null;
    let actualAnswerBool: boolean | null = null;
    let unit: string | null = null;

    if (isBoolean) {
      actualAnswerBool = lowerNotes === 'yes';
    } else {
      const match = shorthand_notes?.trim().match(/^([\d.]+)\s+(.+)$/);
      if (match) {
        actualAnswerNum = parseFloat(match[1]);
        unit = match[2];
        if (isNaN(actualAnswerNum)) {
          console.warn(`Skipping ${filename}: parsed NaN for ${shorthand_notes}`);
          continue;
        }
      } else {
        console.warn(`Skipping ${filename}: numeric format not matched in '${shorthand_notes}'.`);
        continue;
      }
    }
    
    const existingQuestion = await prisma.question.findUnique({
      where: { imageId_variantTag_type: { imageId, variantTag, type: dbType } },
    });

    let imageUrl = existingQuestion?.imageUrl || '';
    const needsUpload = !imageUrl.startsWith('https://storage.googleapis.com/');
    const localImagePath = path.join('uploadthing/images', filename);

    if (needsUpload && fs.existsSync(localImagePath) && process.env.GCP_BUCKET_NAME) {
      try {
        const fileContent = fs.readFileSync(localImagePath);
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : 'image/jpeg';
        
        const key = `uploads/${Date.now()}-${filename}`;
        if (isDryRun) {
          console.log(`[DRY RUN] Would upload ${filename} to GCP Storage at ${key}`);
        } else {
          await storageClient.bucket(BUCKET_NAME).file(key).save(fileContent, { contentType });
          console.log(`Uploaded ${filename} to GCP Storage`);
        }
        
        imageUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${key}`;
      } catch (err) {
        console.error(`Failed to upload ${filename} to GCP Storage:`, err);
        imageUrl = `/placeholder/${filename}`; 
      }
    } else if (needsUpload) {
      imageUrl = `/placeholder/${filename}`; 
    }
    
    const questionData = {
      imageId,
      variantTag,
      type: dbType,
      is_boolean: isBoolean,
      text,
      imageUrl,
      unit,
      actualAnswerNum,
      actualAnswerBool,
    };

    if (existingQuestion) {
      const isDifferent = 
        existingQuestion.type !== questionData.type ||
        existingQuestion.is_boolean !== questionData.is_boolean ||
        existingQuestion.text !== questionData.text ||
        existingQuestion.imageUrl !== questionData.imageUrl ||
        existingQuestion.unit !== questionData.unit ||
        existingQuestion.actualAnswerNum !== questionData.actualAnswerNum ||
        existingQuestion.actualAnswerBool !== questionData.actualAnswerBool;

      if (isDifferent) {
        try {
          if (isDryRun) {
            console.log(`[DRY RUN] Would update existing Question record for ${filename}`);
            console.log(`[DRY RUN] New data:`, questionData);
          } else {
            await prisma.question.update({
              where: { imageId_variantTag_type: { imageId, variantTag, type: dbType } },
              data: questionData,
            });
            console.log(`Successfully updated existing Question record for ${filename}`);
          }
        } catch (err) {
          console.error(`Failed to update record for ${filename}:`, err);
        }
      } else {
        console.log(`Skipping update for ${filename}: No changes detected.`);
      }
    } else {
      try {
        if (isDryRun) {
          console.log(`[DRY RUN] Would create new Question record for ${filename}`);
          console.log(`[DRY RUN] New data:`, questionData);
        } else {
          await prisma.question.create({
            data: questionData,
          });
          console.log(`Successfully created new Question record for ${filename}`);
        }
      } catch (err) {
        console.error(`Failed to create record for ${filename}:`, err);
      }
    }
  }

  console.log("Questions import process completed.");
  if (isDryRun) {
    console.log("=== DRY RUN MODE: Completed without making database changes ===");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
