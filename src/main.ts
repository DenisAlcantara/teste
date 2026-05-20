import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger as PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { EnvVars } from './config/env.validation';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService<EnvVars, true>);
  const port = config.get('PORT', { infer: true });

  const corsRaw = config.get('CORS_ORIGINS', { infer: true });
  const corsOrigin =
    corsRaw === '*'
      ? true
      : corsRaw
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean);

  app.enableCors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'x-request-id'],
    exposedHeaders: ['x-request-id'],
    credentials: false,
    maxAge: 600,
  });

  app.enableShutdownHooks();
  await app.listen(port);

  const logger = app.get(PinoLogger);
  logger.log(`API listening on :${port}`);
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err);
  process.exit(1);
});
