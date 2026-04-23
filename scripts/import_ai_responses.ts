import fs from 'fs';
import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import * as dotenv from 'dotenv';

dotenv.config({ override: true });

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

// Basic color coding for console output
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
};

const colorize = (text: string, color: keyof typeof colors) => `${colors[color]}${text}${colors.reset}`;

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  if (isDryRun) {
    console.log(colorize("=== DRY RUN MODE: No database changes will be made ===", 'yellow'));
  }

  console.log("Starting AI responses import");

  const aiAnswersPath = 'uploadthing/ai_answers.csv';
  if (!fs.existsSync(aiAnswersPath)) {
    console.error(colorize("No ai_answers.csv found! Cannot import AI responses.", 'red'));
    process.exit(1);
  }

  console.log("Found ai_answers.csv, loading AI responses.");
  const aiContent = fs.readFileSync(aiAnswersPath, 'utf-8');
  const aiAnswersData: any[] = parse(aiContent, { columns: true, skip_empty_lines: true });

  if (aiAnswersData.length === 0) {
    console.warn(colorize("ai_answers.csv is empty. Nothing to import.", 'yellow'));
    process.exit(0);
  }

  const allHeaders = Object.keys(aiAnswersData[0]);
    const modelNameHeaders = allHeaders
    .map(h => h.match(/(.*?)_(num|bool|reasoning)/)?.[1])
    .filter((h): h is string => !!h);
  const models = [...new Set(modelNameHeaders)];
  
  console.log(`Discovered models from CSV: ${models.join(', ')}`);

  for (const aiRecord of aiAnswersData) {
    const { filename } = aiRecord;
    if (!filename) {
      console.warn(colorize("Skipping record due to missing filename.", 'yellow'), aiRecord);
      continue;
    }

    const match = filename.match(/^([A-Z])-([a-zA-Z_]+)-(image\d+)(?:[-_](.+))?\.jpg$/);
    
    if (!match) {
      console.warn(colorize(`Skipping ${filename}: Invalid filename format.`, 'yellow'));
      continue;
    }

    const alphabet = match[1];
    const type = match[2].toUpperCase();
    const imageIdPart = match[3];
    const variantTag = match[4] || 'normal';

    const imageId = `${alphabet}-${imageIdPart}`;

    const existingQuestion = await prisma.question.findFirst({
      where: { 
        imageId, 
        variantTag,
        type,
      },
      include: { aiResponses: true },
    });

    if (!existingQuestion) {
      console.warn(colorize(`Skipping ${filename}: Question not found in DB for imageId '${imageId}', variantTag '${variantTag}', and type '${type}'.`, 'yellow'));
      continue;
    }

    for (const model of models) {
      const boolKey = `${model}_bool`;
      const numKey = `${model}_num`;

      let answerBool: boolean | null = null;
      let answerNum: number | null = null;

      if (existingQuestion.is_boolean) {
        if (aiRecord[boolKey] !== undefined && aiRecord[boolKey] !== '') {
          answerBool = aiRecord[boolKey].toLowerCase() === 'true';
        }
      } else {
        if (aiRecord[numKey] !== undefined && aiRecord[numKey] !== '') {
          const parsedNum = parseFloat(aiRecord[numKey]);
          if (!isNaN(parsedNum)) {
            answerNum = parsedNum;
          }
        }
      }
      
      if (answerBool === null && answerNum === null) {
        continue;
      }

      const existingAiResponse = existingQuestion.aiResponses.find(r => r.model === model);
      const isDifferent = !existingAiResponse || existingAiResponse.answerBool !== answerBool || existingAiResponse.answerNum !== answerNum;

      if (isDifferent) {
        if (isDryRun) {
          if (existingAiResponse) {
            console.log(colorize(`[DRY RUN] Would update ${model} response for ${filename}`, 'yellow'));
            console.log(`  - ${colorize('Old Data:', 'red')} Bool: ${existingAiResponse.answerBool}, Num: ${existingAiResponse.answerNum}`);
            console.log(`  - ${colorize('New Data:', 'green')} Bool: ${answerBool}, Num: ${answerNum}`);
          } else {
            console.log(colorize(`[DRY RUN] Would create new ${model} response for ${filename} (Bool: ${answerBool}, Num: ${answerNum})`, 'green'));
          }
        } else {
          try {
            await prisma.aiResponse.upsert({
              where: { questionId_model: { questionId: existingQuestion.id, model: model } },
              update: { answerBool, answerNum },
              create: { questionId: existingQuestion.id, model: model, answerBool, answerNum },
            });
            const action = existingAiResponse ? 'updated' : 'created';
            console.log(colorize(`Successfully ${action} ${model} response for ${filename}`, 'green'));
          } catch (err) {
            console.error(colorize(`Failed to upsert ${model} response for ${filename}:`, 'red'), err);
          }
        }
      }
    }
  }

  console.log("AI responses import completed.");
  if (isDryRun) {
    console.log(colorize("=== DRY RUN MODE: Completed without making database changes ===", 'yellow'));
  }
}

main()
  .catch((e) => {
    console.error(colorize('An unexpected error occurred:', 'red'), e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
