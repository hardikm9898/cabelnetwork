import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AppModule } from './app.module';
import { AppConfig } from './config/env';
import { requestContext } from './common/request-context';

export const API_PREFIX = 'api/v1';

/** Builds a fully configured (not yet listening) application. Used by main.ts and tests. */
export async function createApp(cfg: AppConfig): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), {
    bufferLogs: true,
    abortOnError: false,
  });
  app.useLogger(app.get(Logger));
  app.set('trust proxy', cfg.TRUST_PROXY);
  app.disable('x-powered-by');
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' });
  app.enableCors({
    origin: cfg.CORS_ORIGINS.length > 0 ? cfg.CORS_ORIGINS : false,
    credentials: false,
    exposedHeaders: ['x-request-id'],
  });

  // Request context (request id, client IP, user agent) for logs and the audit trail.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('x-request-id', requestId);
    // Customer data must not stay in shared office browsers' caches (security review L-5).
    res.setHeader('Cache-Control', 'no-store');
    requestContext.run(
      { requestId, ip: req.ip ?? null, userAgent: req.headers['user-agent']?.slice(0, 500) ?? null },
      next,
    );
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  if (cfg.SWAGGER_ENABLED) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Cable Network API')
        .setDescription('Subscription, billing and field-collection backend. All responses use { data, meta? } / { error }.')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(`${API_PREFIX}/docs`, app, doc);
  }
  return app;
}
