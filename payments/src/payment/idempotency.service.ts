// src/payment/services/idempotency.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import { RedisService } from '../providers/redis/redis.service';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Основной метод для гарантированной идемпотентности
   */
  async executeIdempotent<T>(
    operation: string,
    key: string,
    processor: () => Promise<T>,
    ttlSeconds: number = 3600,
  ): Promise<T> {
    const lockKey = `lock:idempotency:${operation}:${key}`;
    const cacheKey = `idempotency:${operation}:${key}`;

    // 1. Пытаемся получить блокировку (5 секунд TTL)
    const hasLock = await this.acquireLock(lockKey, 5000);
    if (!hasLock) {
      throw new ConflictException(
        `Operation ${operation} with key ${key} is already being processed`,
      );
    }

    try {
      // 2. Проверяем кэш на существующий результат
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        const result = JSON.parse(cached);

        if (result.status === 'processing') {
          // Если операция все еще в процессе
          throw new ConflictException('Operation is still processing');
        }

        if (result.status === 'error') {
          // Если была ошибка, выбрасываем ее снова
          throw new Error(result.error);
        }

        // Возвращаем кэшированный результат
        return result.data;
      }

      // 3. Устанавливаем маркер "в процессе"
      await this.redis.setex(
        cacheKey,
        ttlSeconds,
        JSON.stringify({
          status: 'processing',
          startedAt: new Date().toISOString(),
        }),
      );

      // 4. Выполняем реальную операцию
      const data = await processor();

      // 5. Сохраняем успешный результат
      await this.redis.setex(
        cacheKey,
        ttlSeconds,
        JSON.stringify({
          status: 'completed',
          data,
          completedAt: new Date().toISOString(),
        }),
      );

      return data;
    } catch (error) {
      // 6. Обработка ошибок
      if (error instanceof ConflictException) {
        throw error; // Пробрасываем конфликты как есть
      }

      // Сохраняем информацию об ошибке (короткий TTL)
      await this.redis.setex(
        cacheKey,
        300, // 5 минут для ошибок
        JSON.stringify({
          status: 'error',
          error: error.message,
          failedAt: new Date().toISOString(),
        }),
      );

      throw error;
    } finally {
      // 7. Всегда освобождаем блокировку
      await this.releaseLock(lockKey);
    }
  }

  /**
   * Генерация idempotency key на основе данных запроса
   */
  generateIdempotencyKey(operation: string, payload: any): string {
    const payloadString =
      typeof payload === 'string' ? payload : JSON.stringify(payload);

    const hash = crypto
      .createHash('sha256')
      .update(`${operation}:${payloadString}`)
      .digest('hex')
      .substring(0, 32);

    return `idemp_${hash}`;
  }

  /**
   * Проверка существования платежа по orderId
   */
  async checkOrderIdUniqueness(orderId: string): Promise<void> {
    if (!orderId) return;

    const key = `payment:order:${orderId}`;
    const exists = await this.redis.get(key);

    if (exists) {
      throw new ConflictException(
        `Payment for order ${orderId} already exists or is being processed`,
      );
    }

    // Бронируем orderId на 1 час
    await this.redis.setex(key, 3600, 'reserved');
  }

  /**
   * Приобретение распределенной блокировки
   */
  private async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const lockKey = `lock:${key}`;

    // Пытаемся установить ключ с NX (только если не существует) и EX (таймаут)
    const result = await this.redis.set(lockKey, '1', 'PX', ttlMs, 'NX');
    return result === 'OK';
  }

  /**
   * Освобождение блокировки
   */
  private async releaseLock(key: string): Promise<void> {
    const lockKey = `lock:${key}`;
    await this.redis.del(lockKey);
  }

  /**
   * Очистка кэша идемпотентности (для тестов/админки)
   */
  async clearIdempotencyCache(operation?: string, key?: string): Promise<void> {
    if (operation && key) {
      await this.redis.del(`idempotency:${operation}:${key}`);
      await this.redis.del(`lock:idempotency:${operation}:${key}`);
    } else if (operation) {
      // Очистка всех ключей операции (используйте с осторожностью!)
      const pattern = `idempotency:${operation}:*`;
      // Реализуйте SCAN + DEL если нужно
    }
  }
}
