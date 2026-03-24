import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 1. Route Protection
  const hasPassedCaptcha = request.cookies.has('captcha_passed');

  // If trying to play without verifying CAPTCHA this session, send back to home
  if (path.startsWith('/play') && !hasPassedCaptcha) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/((?!api|_next/static|_next/image|favicon.ico).*)',
};
