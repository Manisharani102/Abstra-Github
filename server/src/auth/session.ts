import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import type { CookieOptions, Request } from 'express';
import jwt from 'jsonwebtoken';
import { loadEnv } from '../config/env';

export const SESSION_COOKIE = 'session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600;

export interface SessionUser {
  id: string;
  login: string;
}

export function cookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: loadEnv().isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function signSession(user: SessionUser): { token: string; maxAgeMs: number } {
  const token = jwt.sign({ login: user.login }, loadEnv().SESSION_SECRET, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: SESSION_TTL_SECONDS,
  });
  return { token, maxAgeMs: SESSION_TTL_SECONDS * 1000 };
}

export function readSession(req: Request): SessionUser | null {
  const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, loadEnv().SESSION_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.login !== 'string') return null;
    return { id: payload.sub, login: payload.login };
  } catch {
    return null;
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser }>();
    const user = readSession(req);
    if (!user) throw new UnauthorizedException();
    req.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest<Request & { user: SessionUser }>().user;
});
