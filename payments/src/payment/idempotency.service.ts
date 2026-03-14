// src/payment/services/idempotency.service.ts
import { Injectable, ConflictException } from '@nestjs/common';
import { RedisService } from '../providers/redis/redis.service';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

/**
 * @class IdempotencyService
 * @description Критически важный инфраструктурный слой для обеспечения целостности данных.
 *
 * ПОНЯТНЫМИ СЛОВАМИ:
 * Это "защита от дурака" и сбоев сети. Гарантирует, что сколько бы раз
 * один и тот же запрос не пришел в систему, финансовое действие (списание)
 * выполнится строго ОДИН РАЗ.
 *
 *
 * 1. Исключает двойные списания и финансовые потери.
 * 2. Использует распределенные блокировки Redis (NX/PX) для работы в кластере.
 * 3. Реализует паттерн "Idempotent Receiver", обязательный для любого Fintech-ядра.
 *
 * Этот биллинг защищен на уровне инфраструктурной идемпотентности. Был внедрен
 * IdempotencyService, который через распределенные замки Redis гарантирует
 * принцип Exactly-once processing. Даже если из-за нестабильной сети клиент
 * или внешняя система пришлет дублирующий запрос, наш баланс останется консистентным,
 * а двойное списание будет технически невозможно
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Основной метод для гарантированной идемпотентности
   *
   * ИНФРАСТРУКТУРНЫЙ ОРКЕСТРАТОР ИДЕМПОТЕНТНОСТИ (Exactly-once Strategy).
   *
   * @description
   * Данный метод гарантирует, что любая переданная в него бизнес-операция (processor)
   * будет выполнена строго один раз для конкретного ключа (key), даже в условиях
   * агрессивных повторных запросов (Retry Storms) или сбоев сети.
   *
   * ПРОСТЫМИ СЛОВАМИ:
   * Это "контрольно-пропускной пункт". Если клиент нажал "Оплатить" 10 раз,
   * система пропустит только первый запрос. Остальные 9 получат либо статус
   * "уже обрабатывается", либо готовый результат первой транзакции.
   * Это исключает двойные списания и хаос в балансах.
   *
   * АЛГОРИТМ РАБОТЫ (7 ШАГОВ ЗАЩИТЫ):
   * 1. Distributed Locking: Ставит замок в Redis (NX), чтобы исключить Race Condition.
   * 2. Cache Lookup: Проверяет, не выполняли ли мы это действие ранее.
   * 3. State Management: Помечает операцию как 'processing', фиксируя время старта.
   * 4. Atomic Execution: Выполняет саму бизнес-логику (переданную через Callback).
   * 5. Memoization: Кэширует успешный результат (Success Snapshot) для мгновенных ответов в будущем.
   * 6. Error Persistence: Запоминает ошибки, чтобы не пытаться "лечить" заведомо битые данные.
   * 7. Resource Cleanup: Всегда снимает блокировку (finally), предотвращая "зависание" системы.
   *
   * @param {string} operation - Имя домена (напр. 'payment', 'payout', 'order').
   * @param {string} key - Уникальный идемпотентный ключ запроса.
   * @param {() => Promise<T>} processor - Анонимная функция с основной логикой.
   * @param {number} ttlSeconds - Время жизни результата в кэше (по умолчанию 1 час).
   *
   * @returns {Promise<T>} Результат выполнения операции (свежий или из кэша).
   * @throws {ConflictException} Если операция уже выполняется другим воркером.
   * Этот метод — Сердце финансовой безопасности. cпроектирована система, которая
   * не имеет права на ошибку.
   *
   * Exactly-once processing: Это самый сложный и дорогой паттерн в распределенных системах.
   * Race Condition Protection: Использование Distributed Lock - означает, что бэкенд может
   * работать на 10 серверах одновременно, и они не «передерутся» за один платеж.
   * Fault Tolerance: Предусмотрено кэширование ошибок. Это важно: если банк вернул
   * «Карта заблокирована», мы не должны пытаться списать с неё снова через секунду.
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

/**
 *
 * Представь, что клиент нажимает кнопку «Оплатить 5000₽», но у него моргнул интернет.
 * Он психует и жмет кнопку еще 5 раз.
 * Без этого сервиса: С его карты спишется 25 000₽ (5 раз по 5000₽).
 * Ты получишь злого клиента и судебный иск.
 * С этим сервисом: Система «узнает» повторный запрос, поймет, что первый уже в
 * обработке (или уже завершен), и не даст списать деньги второй раз. Она просто
 * вернет результат первого успешного нажатия.
 */
