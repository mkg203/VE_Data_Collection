'use server'

import { Pool } from 'pg'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'
import { cookies } from 'next/headers'

// In a real app we would want to instantiate Prisma in a global singleton
// to avoid exhaustion in development. We'll do a simple setup here.
const globalForPrisma = global as unknown as { prisma: PrismaClient }

let prisma: PrismaClient;

if (globalForPrisma.prisma) {
  prisma = globalForPrisma.prisma;
} else {
  const connectionString = process.env.DATABASE_URL;
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  prisma = new PrismaClient({ adapter });
}

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
export async function getAnonUserId() {
  const cookieStore = await cookies();
  return cookieStore.get('anon_user_id')?.value;
}

export async function getOrStartSession() {
  const userId = await getAnonUserId();
  if (!userId) {
    throw new Error('User session not found');
  }
  
  // Upsert the user so they exist in the DB
  const user = await prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId }
  });

  return user;
}

const THRESHOLD = 10;
const QUESTION_TYPES = ["DISTANCE", "ANGLE", "SIZE", "STABILITY", "FIT"];

export async function fetchNextQuestions() {
  const user = await getOrStartSession();
  
  // Find imageIds the user has already answered (by checking any variant of that image)
  const answeredResponses = await prisma.userResponse.findMany({
    where: { userId: user.id },
    select: {
      question: {
        select: { imageId: true }
      }
    }
  });

  const answeredImageIds = Array.from(new Set(answeredResponses.map(r => r.question.imageId)));

  const selectedQuestions: Question[] = [];

  for (const type of QUESTION_TYPES) {
    // Fetch all questions of this type that the user hasn't seen any variant of
    const availableQuestions = await prisma.question.findMany({
      where: {
        type: type,
        imageId: { notIn: answeredImageIds }
      }
    });

    if (availableQuestions.length === 0) continue;

    // Group by imageId to ensure we pick one variant from one image
    const groupedByImage: Record<string, Question[]> = {};
    for (const q of availableQuestions) {
      if (!groupedByImage[q.imageId]) groupedByImage[q.imageId] = [];
      groupedByImage[q.imageId].push(q);
    }

    const imageIds = Object.keys(groupedByImage);

    // Priority 1: Images that have at least one variant in progress (0 < timesAsked < THRESHOLD)
    const inProgressImages = imageIds.filter(id => 
      groupedByImage[id].some(q => q.timesAsked > 0 && q.timesAsked < THRESHOLD)
    );

    let targetImageId: string | null = null;
    let targetQuestion: Question | null = null;

    if (inProgressImages.length > 0) {
      targetImageId = inProgressImages[Math.floor(Math.random() * inProgressImages.length)];
      const inProgressVariants = groupedByImage[targetImageId].filter(q => q.timesAsked > 0 && q.timesAsked < THRESHOLD);
      targetQuestion = inProgressVariants[Math.floor(Math.random() * inProgressVariants.length)];
    }
    // Priority 2: Images that have at least one variant with 0 responses
    else {
      const emptyImages = imageIds.filter(id =>
        groupedByImage[id].some(q => q.timesAsked === 0)
      );

      if (emptyImages.length > 0) {
        targetImageId = emptyImages[Math.floor(Math.random() * emptyImages.length)];
        const emptyVariants = groupedByImage[targetImageId].filter(q => q.timesAsked === 0);
        targetQuestion = emptyVariants[Math.floor(Math.random() * emptyVariants.length)];
      }
      // Priority 3: All variants reached threshold
      else {
        targetImageId = imageIds[Math.floor(Math.random() * imageIds.length)];
        targetQuestion = groupedByImage[targetImageId][Math.floor(Math.random() * groupedByImage[targetImageId].length)];
      }
    }

    if (targetQuestion) {
      selectedQuestions.push(targetQuestion);
      // Add the selected imageId to answeredImageIds so we don't pick it for another type in the same session
      // (though each type usually has different images, it's safer)
      answeredImageIds.push(targetQuestion.imageId);
    }
  }

  return selectedQuestions;
}

export async function submitAnswers(answers: { questionId: string, answerNumMin?: number | null, answerNumMax?: number | null, answerBool?: boolean | null }[]) {
  const user = await getOrStartSession();
  
  for (const answer of answers) {
    try {
      await prisma.userResponse.create({
        data: {
          userId: user.id,
          questionId: answer.questionId,
          answerNumMin: answer.answerNumMin,
          answerNumMax: answer.answerNumMax,
          answerBool: answer.answerBool
        }
      });

      // Increment timesAsked
      await prisma.question.update({
        where: { id: answer.questionId },
        data: { timesAsked: { increment: 1 } }
      });
    } catch (e) {
      console.error(`Failed to submit answer for question ${answer.questionId}:`, e);
      // Ignores unique constraint violations if the user somehow submits twice
    }
  }

  return { success: true };
}

export async function verifyCaptchaAndStartSession(token: string) {
  // Use dummy secret for testing if env is not provided
  const secret = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';
  
  const formData = new FormData();
  formData.append('secret', secret);
  formData.append('response', token);

  const result = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });

  const outcome = await result.json();

  if (outcome.success) {
    const cookieStore = await cookies();
    cookieStore.set('anon_user_id', crypto.randomUUID(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 365, // 1 year
    });

    return { success: true };
  } else {
    throw new Error('CAPTCHA verification failed.');
  }
}
