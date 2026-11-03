import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../config/env';
import { AppLogger, errorMessage } from '../common/logger';
import { AuthService } from './auth.service';
import { AuthGuard, CurrentUser, SESSION_COOKIE, type SessionUser, cookieOptions, signSession } from './session';

const STATE_COOKIE = 'oauth_state';
const log = new AppLogger('auth');

/** Only allow same-site relative redirects after login (no open redirect). */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}

@Controller('api/auth')
export class AuthController {
  private readonly env = loadEnv();

  constructor(private readonly auth: AuthService) {}

  @Get('login')
  login(@Query('next') next: string | undefined, @Res() res: Response) {
    const state = randomBytes(24).toString('base64url');
    // State is bound to this browser via an httpOnly cookie and checked on callback (CSRF on the OAuth flow).
    res.cookie(STATE_COOKIE, JSON.stringify({ state, next: safeNext(next) }), cookieOptions(10 * 60_000));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', this.env.GITHUB_CLIENT_ID);
    url.searchParams.set('redirect_uri', `${this.env.APP_URL}/api/auth/callback`);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    let expected: { state: string; next: string } | null = null;
    try {
      expected = JSON.parse((req.cookies as Record<string, string>)[STATE_COOKIE] ?? 'null') as {
        state: string;
        next: string;
      } | null;
    } catch {
      expected = null;
    }
    res.clearCookie(STATE_COOKIE, { path: '/' });

    const valid =
      typeof code === 'string' &&
      typeof state === 'string' &&
      expected !== null &&
      state.length === expected.state.length &&
      timingSafeEqual(Buffer.from(state), Buffer.from(expected.state));
    if (!valid) {
      log.warn('oauth.state_mismatch');
      return res.redirect('/login?error=state');
    }

    try {
      const user = await this.auth.completeLogin(code);
      const { token, maxAgeMs } = signSession(user);
      res.cookie(SESSION_COOKIE, token, cookieOptions(maxAgeMs));
      log.info('login.success', { userId: user.id, login: user.login });
      return res.redirect(safeNext(expected!.next));
    } catch (err) {
      log.error('login.failed', { error: errorMessage(err) });
      return res.redirect('/login?error=github');
    }
  }

  @Post('logout')
  logout(@Res() res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.status(204).end();
  }

  @Get('me')
  @UseGuards(AuthGuard)
  async me(@CurrentUser() user: SessionUser) {
    return this.auth.profile(user.id);
  }
}
