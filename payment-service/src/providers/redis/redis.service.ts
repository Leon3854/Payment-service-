/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/require-await */
import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private client: Redis;

  onModuleInit() {
    // В реальном проекте параметры берать из ConfigService
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;

    this.client = new Redis({
      host,
      port,
      retryStrategy: (times) => Math.min(times * 50, 2000), // Авто-реконнект
    });

    this.client.on('error', (err) => this.logger.error('Redis Error', err));
    this.client.on('connect', () => this.logger.log('✅ Redis Connected'));
  }

  // constructor() {
  //   // Временная заглушка со Всеми методами
  //   this.client = {
  //     get: async (key: string): Promise<string | null> => null,
  //     setex: async (key: string, ttl: number, value: string) => {},
  //     del: async (key: string): Promise<void> => {},
  //   };
  // }

  // --- Базовые методы ---
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  // async setex(key: string, ttl: number, value: string): Promise<void> {
  //   await this.client.setex(key, ttl, value);
  // }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  // --- Идемпотентность ---

  async getIdempotencyResult(key: string): Promise<any> {
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async setIdempotencyResult(
    key: string,
    result: any,
    ttl: number = 86400,
  ): Promise<void> {
    // Используем setex (set with expire) для атомарности
    await this.client.set(key, JSON.stringify(result), 'EX', ttl);
  }

  // --- Блокировки (Locks) против Race Condition ---
  // приобретение ключа
  async acquireLock(key: string, ttl: number = 30): Promise<boolean> {
    // NX - установить только если нет ключа
    // EX - время жизни в секундах
    const result = await this.client.set(
      `lock:${key}`,
      'processing',
      'NX',
      'EX',
      ttl,
    );
    return result === 'OK';
  }

  // разболокировать ключь
  async releaseLock(key: string): Promise<void> {
    await this.client.del(`lock:${key}`);
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
