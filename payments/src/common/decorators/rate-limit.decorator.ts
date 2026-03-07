import { SetMetadata } from '@nestjs/common';

/**
 * Ключ, по которому Guard будет искать настройки в метаданных
 */
export const RATE_LIMIT_KEY = 'rate_limit';

/**
 * Описание интерфейса настроек (для типизации)
 */
export interface RateLimitOptions {
  windowMs: number; // Окно в миллисекундах (напр. 60000 = 1 минута)
  maxRequests: number; // Макс. кол-во запросов за это время
  keyPrefix?: string; // Префикс ключа в Redis (опционально)
}

/**
 * Декоратор @RateLimit({ windowMs: 60000, maxRequests: 5 })
 * Позволяет гибко настраивать лимиты для каждого эндпоинта
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
