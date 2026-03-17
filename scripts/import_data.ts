import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
});

const BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || 'vetest-data-collection';

async function main() {
  console.log("starting data import");

  let promptGroups: Record<string, string> = {};
  if (fs.existsSync('uploadthing/prompt_groups.json')) {
    promptGroups = JSON.parse(fs.readFileSync('uploadthing/prompt_groups.json', 'utf-8'));
    console.log(`Loaded ${Object.keys(promptGroups).length} prompt groups.`);
  } else {
    console.warn("prompt_groups.json not found. Will use IDs as fallback text if prompts are missing.");
  }

  const csvPath = 'uploadthing/data_export-P.csv';
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file ${csvPath} not found!`);
    process.exit(1);
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true });

  for (const record of records) {
    const { filename, type, custom_prompt, shorthand_notes } = record;

    if (!filename || !type) {
      console.warn("Skipping record due to missing filename or type.", record);
      continue;
    }

    // filename format: <randomthing>-<type>-<imageid>-<variant>.jpg/png
    // e.g. P-angle-image1.jpg -> randomthing: P, type: angle, imageid: image1
    // e.g. P-fit-image3-blurred.png -> randomthing: P, type: fit, imageid: image3, variant: blurred

    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    const parts = nameWithoutExt.split('-');

    if (parts.length < 3) {
      console.warn(`Skipping ${filename} due to invalid filename format. Expected at least 3 parts separated by '-'.`);
      continue;
    }

    const randomThing = parts[0];
    const imageIdPart = parts[2];
    const imageId = `${randomThing}-${imageIdPart}`;
    const variantTag = parts.length >= 4 ? parts.slice(3).join('-') : 'normal';

    const dbType = type.toUpperCase();
    const isBoolean = ['STABILITY', 'FIT'].includes(dbType);

    let text = custom_prompt;
    if (custom_prompt && custom_prompt.length <= 3) {
      text = promptGroups[custom_prompt] || `Missing prompt for ID ${custom_prompt}`;
    }

    let actualAnswerNum: number | null = null;
    let actualAnswerBool: boolean | null = null;
    let unit: string | null = null;
    let aiAnswerMin: number | null = null;
    let aiAnswerMax: number | null = null;
    let aiAnswerBool: boolean | null = null;

    if (isBoolean) {
      const lowerNotes = shorthand_notes?.trim().toLowerCase();
      if (lowerNotes === 'yes') {
        actualAnswerBool = true;
      } else if (lowerNotes === 'no') {
        actualAnswerBool = false;
      } else {
        console.warn(`Skipping ${filename}: shorthand_notes '${shorthand_notes}' is not Yes/No for boolean type ${dbType}.`);
        continue;
      }
      aiAnswerBool = !actualAnswerBool; // placeholder
    } else {
      // numeric type
      const match = shorthand_notes?.trim().match(/^([\d.]+)\s+(.+)$/);
      if (match) {
        actualAnswerNum = parseFloat(match[1]);
        unit = match[2];
        if (isNaN(actualAnswerNum)) {
          console.warn(`Skipping ${filename}: parsed NaN for ${shorthand_notes}`);
          continue;
        }
        aiAnswerMin = actualAnswerNum - 20;
        aiAnswerMax = actualAnswerNum + 20;
      } else {
        console.warn(`Skipping ${filename}: numeric format not matched in '${shorthand_notes}'. Expected '<value> <unit>'.`);
        continue;
      }
    }

    // Handle Image S3 Upload
    let imageUrl = '';
    const localImagePath = path.join('uploadthing/images', filename); // Assuming images are inside 'images' folder
    
    // We only upload if AWS creds are provided (rudimentary check)
    const canUpload = process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY;

    if (fs.existsSync(localImagePath) && canUpload) {
      try {
        const fileContent = fs.readFileSync(localImagePath);
        const ext = path.extname(filename).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream');
        
        const key = `uploads/${Date.now()}-${filename}`;
        await s3Client.send(new PutObjectCommand({
          Bucket: BUCKET_NAME,
          Key: key,
          Body: fileContent,
          ContentType: contentType,
        }));
        
        imageUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
        console.log(`Uploaded ${filename} to S3`);
      } catch (err) {
        console.error(`Failed to upload ${filename} to S3:`, err);
        imageUrl = `/placeholder/${filename}`; // Fallback
      }
    } else {
      if (!fs.existsSync(localImagePath)) {
        console.warn(`Image file ${localImagePath} not found locally.`);
      } else if (!canUpload) {
        console.warn(`AWS credentials missing. Skipping S3 upload for ${filename}.`);
      }
      imageUrl = `/placeholder/${filename}`; // Fallback
    }

    try {
      await prisma.question.create({
        data: {
          imageId,
          variantTag,
          type: dbType,
          is_boolean: isBoolean,
          text,
          imageUrl,
          unit,
          actualAnswerNum,
          actualAnswerBool,
          aiAnswerMin,
          aiAnswerMax,
          aiAnswerBool,
          timesAsked: 0,
        }
      });
      console.log(`Successfully inserted DB record for ${filename}`);
    } catch (err) {
      console.error(`Failed to insert record for ${filename}:`, err);
    }
  }

  console.log("Import process completed.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
