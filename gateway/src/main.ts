// gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    })
  );

  // CORS configuration
  app.enableCors({
    origin: configService.get('CORS_ORIGIN', '*').split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
    ],
    credentials: true,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  console.log(`🚀 Gateway запущен на порту: ${port}`);
  console.log(`📊 GraphQL Playground: http://localhost:${port}/graphql`);
  console.log(`🔄 REST Endpoint: http://localhost:${port}/api`);
}

bootstrap();