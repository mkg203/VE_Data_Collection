import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;

  // 1. Route Protection
  const hasAnonCookie = request.cookies.has('anon_user_id');

  // If trying to play without a session cookie, send back to home to complete CAPTCHA
  if (path.startsWith('/play') && !hasAnonCookie) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/((?!api|_next/static|_next/image|favicon.ico).*)',
};
