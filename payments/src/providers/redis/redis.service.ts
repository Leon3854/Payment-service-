/* eslint-disable @typescript-eslint/no-unsafe-argument */
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

  /**
   * Инициализация подключения к Redis при старте модуля.
   * Настроена стратегия автоматического реконнекта для обеспечения High Availability.
   */
  onModuleInit() {
    // В реальном проекте параметры брать из ConfigService
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;

    this.client = new Redis({
      host,
      port,
      retryStrategy: (times) => Math.min(times * 50, 2000), // Авто-реконнект
    });

    this.client.on('error', (err) => this.logger.error('Redis Error', err));
    this.client.on('connect', () =>
      this.logger.log('✅ Redis Connected (Highload Optimized)'),
    );
  }

  // --- Базовые методы ---
  /**
   * Получение строкового значения по ключу.
   */
  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }
  /**
   * Удаление данных или блокировки по ключу.
   */
  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  // --- Идемпотентность (защита от повторных списаний) ---
  /**
   * Получение сохраненного результата операции по ключу идемпотентности.
   * Позволяет вернуть готовый ответ клиенту без повторного выполнения бизнес-логики
   * и запросов к БД/банку.
   */
  async getIdempotencyResult(key: string): Promise<any> {
    const data = await this.client.get(`idempotency:${key}`);
    return data ? JSON.parse(data) : null;
  }

  /**
   * Сохранение результата успешной операции в кэш идемпотентности.
   * Предотвращает дублирование транзакций при повторных сетевых запросах.
   * По умолчанию хранится 24 часа (86400 сек).
   */
  async setIdempotencyResult(
    key: string,
    result: any,
    ttl: number = 86400,
  ): Promise<void> {
    // Используем setex (set with expire) для атомарности
    await this.client.set(
      `idempotency:${key}`,
      JSON.stringify(result),
      'EX',
      ttl,
    );
  }

  // --- Блокировки (Distributed Locks) против Race Condition ---
  // приобретение ключа
  /**
   * Захват распределенной блокировки (Distributed Lock) на базе алгоритма NX (Not Exists).
   * Гарантирует атомарный доступ к ресурсу в распределенной среде (через несколько инстансов).
   * Предотвращает состояние гонки (Race Condition) при обработке транзакций.
   *
   * @param key - Уникальный идентификатор ресурса (например, orderId или userId)
   * @param ttlSeconds - Время жизни блокировки в секундах (защита от "зависших" локов при падении воркера)
   * @returns Promise<boolean> - true, если блокировка успешно захвачена; false, если ресурс уже занят другим процессом
   */
  async acquireLock(key: string, ttlSeconds: number = 30): Promise<boolean> {
    // NX - атомарная проверка: установить, только если ключа нет
    // EX - время жизни в секундах
    const result = await this.client.set(
      `lock:${key}`,
      'processing',
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }

  // разболокировать ключь
  /**
   * Освобождение распределенной блокировки.
   * Удаляет флаг блокировки из Redis, позволяя другим инстансам/воркерам
   * приступить к обработке ресурса.
   *
   * @param key - Уникальный идентификатор ресурса (например, orderId или userId)
   */
  async releaseLock(key: string): Promise<void> {
    await this.client.del(`lock:${key}`);
  }

  // --- СКОЛЬЗЯЩИЙ ЛИМИТЕР (Rate Limiting) ---
  // Защищает API от перегрузки и брутфорса
  /**
   * Реализация алгоритма "Скользящее окно" (Sliding Window) для ограничения частоты запросов.
   * Использует Redis Sorted Set для атомарного подсчета событий в заданном временном интервале.
   *
   * @param key - Уникальный идентификатор ресурса (например, IP или UserId)
   * @param limit - Максимально допустимое кол-во запросов
   * @param windowSeconds - Размер временного окна в секундах
   * @returns Promise<boolean> - true, если лимит превышен (нужно блокировать)
   */
  async isRateLimited(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<boolean> {
    const now = Date.now();
    const fullKey = `ratelimit:${key}`;
    const windowMs = windowSeconds * 1000;

    // Используем MULTI (транзакцию Redis) для атомарности
    const multi = this.client.multi(); // делаем группу атомарной для последовательного выполнения
    multi.zremrangebyscore(fullKey, 0, now - windowMs); // Чистим старые запросы
    multi.zadd(fullKey, now, `${now}-${Math.random()}`); // Добавляем новый -
    // защита от перезаписи ключей одного другим
    multi.zcard(fullKey); // Считаем количество в окне
    multi.expire(fullKey, windowSeconds); // Продлеваем жизнь ключу

    const results = await multi.exec();
    if (!results) return false;

    // Деструктурируем результаты.
    // Нам нужен только ответ от zcard (третий по счету)
    const [_remErr, _addErr, [cardErr, count], _expErr] = results as any[];

    if (cardErr) {
      this.logger.error('Redis ZCARD error', cardErr);
      return false;
    }
    return (count as number) > limit;
  }

  /**
   * Проверка лимита запросов с возвратом детальной статистики.
   * Используется в RateLimitGuard для формирования HTTP-заголовков.
   */
  async checkRateLimit(
    identifier: string,
    windowMs: number,
    maxRequests: number,
    prefix: string = 'rate-limit:',
  ) {
    const now = Date.now();
    const key = `${prefix}${identifier}`;
    const windowSeconds = Math.ceil(windowMs / 1000);

    const multi = this.client.multi();
    multi.zremrangebyscore(key, 0, now - windowMs); // Чистим старье
    multi.zadd(key, now, `${now}-${Math.random()}`); // Фиксируем новый запрос
    multi.zcard(key); // Считаем, сколько их всего сейчас
    multi.expire(key, windowSeconds); // Продлеваем жизнь ключу в Redis

    const results = await multi.exec();

    // Вытаскиваем результат ZCARD (индекс 2 в массиве ответов)
    const count = results ? (results[2][1] as number) : 0;

    return {
      allowed: count <= maxRequests,
      total: maxRequests,
      remaining: Math.max(0, maxRequests - count),
      reset: new Date(now + windowMs),
      windowMs,
    };
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit();
    }
  }
}
