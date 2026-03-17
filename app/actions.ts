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

export async function fetchNextQuestions() {
  const user = await getOrStartSession();
  
  // Find questions the user has already answered
  const answered = await prisma.userResponse.findMany({
    where: { userId: user.id },
    select: { questionId: true }
  });
  const answeredIds = answered.map(r => r.questionId);

  // Fetch 5 questions not answered, sorted by timesAsked ascending
  const nextQuestions = await prisma.question.findMany({
    where: {
      id: { notIn: answeredIds }
    },
    orderBy: {
      timesAsked: 'asc'
    },
    take: 5
  });

  return nextQuestions;
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
