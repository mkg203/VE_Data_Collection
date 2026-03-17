import { config } from 'dotenv';
config({ override: true });
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);
const prisma = new PrismaClient({ adapter });

async function main() {
  const questions = [
    {
      imageId: 'img_1',
      variantTag: 'normal',
      type: 'DISTANCE',
      text: 'Estimate the distance between the two red points in cm.',
      imageUrl: '/file.svg',
      unit: 'cm',
      actualAnswerNum: 15.5,
      aiAnswerMin: 14.8,
      aiAnswerMax: 14.8,
    },
    {
      imageId: 'img_1',
      variantTag: 'blurred',
      type: 'DISTANCE',
      text: 'Estimate the distance between the two red points in cm (blurred).',
      imageUrl: '/file.svg',
      unit: 'cm',
      actualAnswerNum: 15.5,
      aiAnswerMin: 14.8,
      aiAnswerMax: 14.8,
    },
    {
      imageId: 'img_2',
      variantTag: 'normal',
      type: 'ANGLE',
      text: 'Estimate the angle between the two lines in degrees.',
      imageUrl: '/window.svg',
      unit: 'degrees',
      actualAnswerNum: 45,
      aiAnswerMin: 42,
      aiAnswerMax: 42,
    },
    {
      imageId: 'img_3',
      variantTag: 'normal',
      type: 'SIZE',
      text: 'Estimate the length of the blue square in inches.',
      imageUrl: '/globe.svg',
      unit: 'inches',
      actualAnswerNum: 5,
      aiAnswerMin: 5.2,
      aiAnswerMax: 5.2,
    },
    {
      imageId: 'img_4',
      variantTag: 'normal',
      type: 'STABILITY',
      is_boolean: true,
      text: 'Is this structure stable?',
      imageUrl: '/next.svg',
      actualAnswerBool: false,
      aiAnswerBool: false,
    },
    {
      imageId: 'img_5',
      variantTag: 'normal',
      type: 'FIT',
      is_boolean: true,
      text: 'Will the smaller object fit inside the larger container?',
      imageUrl: '/vercel.svg',
      actualAnswerBool: true,
      aiAnswerBool: true,
    },
    {
      imageId: 'img_6',
      variantTag: 'normal',
      type: 'FIT',
      is_boolean: true,
      text: '21Will the smaller object fit inside the larger container?',
      imageUrl: '/vercel.svg',
      actualAnswerBool: true,
      aiAnswerBool: true,
    },
    {
      imageId: 'img_7',
      variantTag: 'normal',
      type: 'FIT',
      is_boolean: true,
      text: 'faWill the smaller object fit inside the larger container?',
      imageUrl: '/vercel.svg',
      actualAnswerBool: true,
      aiAnswerBool: true,
    },
    {
      imageId: 'img_8',
      variantTag: 'normal',
      type: 'DISTANCE',
      text: 'Estimate the distance from the character to the tree in meters.',
      imageUrl: '/file.svg',
      unit: 'm',
      actualAnswerNum: 2.3,
      aiAnswerMin: 2.0,
      aiAnswerMax: 2.0,
    }
  ];

  console.log('Seeding database...');
  for (const q of questions) {
    await prisma.question.create({
      data: q,
    });
  }
  console.log('Database seeded!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
