import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';
import { RateLimitGuard } from './rate-limit.guard';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [ConfigModule],
  providers: [RedisService, RateLimitGuard],
  exports: [RedisService, RateLimitGuard],
})
export class RedisModule {}
