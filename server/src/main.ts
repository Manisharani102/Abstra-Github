import './load-env';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { AppLogger } from './common/logger';

const log = new AppLogger('bootstrap');

async function bootstrap() {
  const env = loadEnv(); // fail fast on bad config, before anything else starts
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // needed to verify GitHub webhook signatures byte-for-byte
    logger: AppLogger.nest,
  });

  app.set('trust proxy', 1); // behind Render's proxy: correct req.ip and secure cookies
  app.useBodyParser('json', { limit: '5mb' }); // push payloads can be large
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { 'img-src': ["'self'", 'data:', 'https://avatars.githubusercontent.com'] },
      },
    }),
  );
  app.use(cookieParser());

  // CSRF defence in depth (cookies are already SameSite=Lax): state-changing API calls must come from our origin.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== env.APP_URL) {
      res.status(403).json({ message: 'Cross-origin request blocked' });
      return;
    }
    next();
  });

  // In production the React build is served by this same process (one origin, no CORS).
  const clientDist = resolve(process.env.CLIENT_DIST ?? join(__dirname, '..', '..', 'client', 'dist'));
  if (existsSync(join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/webhooks')) return next();
      res.sendFile(join(clientDist, 'index.html'));
    });
  }

  app.enableShutdownHooks();
  await app.listen(env.PORT);
  log.info('server.started', { port: env.PORT, appUrl: env.APP_URL, servingClient: existsSync(clientDist) });
}

void bootstrap();
