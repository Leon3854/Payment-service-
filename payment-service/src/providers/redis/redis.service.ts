/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/require-await */
import { Injectable, OnModuleDestroy } from '@nestjs/common';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: any = null;

  constructor() {
    // Временная заглушка со Всеми методами
    this.client = {
      get: async (key: string): Promise<string | null> => null,
      setex: async (key: string, ttl: number, value: string) => {},
      del: async (key: string): Promise<void> => {},
    };
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setex(key: string, ttl: number, value: string): Promise<void> {
    await this.client.setex(key, ttl, value);
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async acquireLock(key: string, ttl: number = 30): Promise<boolean> {
    return true;
  }

  async releaseLock(key: string): Promise<void> {}

  async getIdempotencyResult(key: string): Promise<any> {
    return null;
  }

  async setIdempotencyResult(
    key: string,
    result: any,
    ttl: number = 86400,
  ): Promise<void> {}

  async onModuleDestroy() {}
}
