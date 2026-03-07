import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RedisService } from './redis.service';
import { SetMetadata } from '@nestjs/common';

export interface RateLimitOptions {
  windowMs: number; // Время окна в миллисекундах
  maxRequests: number; // Максимальное количество запросов
  keyPrefix?: string; // Префикс для ключа (опционально)
  skipFailedRequests?: boolean; // Не учитывать упавшие запросы
  skipSuccessfulRequests?: boolean; // Не учитывать успешные запросы
}

export const RATE_LIMIT_KEY = 'rate_limit';

/**
 * Декоратор для применения rate limiting к контроллеру или методу
 * @example
 * @RateLimit({ windowMs: 60000, maxRequests: 10 })
 * @Post()
 * async create() { ... }
 */
export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly redisService: RedisService,
  ) {}

  // Этот метод — «контрольно-пропускной пункт» твоего API. Здесь
  // показываем, как Guard в NestJS превращается в активную защиту,
  // взаимодействуя с Redis.
  /**
   * Основная логика валидации входящего запроса на соответствие лимитам (Rate Limiting).
   * Реализует паттерн Middleware-фильтрации перед выполнением бизнес-логики контроллера.
   *
   * @param context Контекст выполнения NestJS (позволяет работать как с REST, так и с GraphQL/RPC).
   * @returns Promise<boolean> - true, если лимит не превышен.
   *
   * @throws {HttpException} 429 (Too Many Requests) - если количество запросов
   * за временное окно (Sliding Window) превысило допустимый порог.
   *
   * @description
   * 1. Извлекает настройки лимитов (windowMs, maxRequests) из метаданных декораторов.
   * 2. Идентифицирует субъект запроса (IP или JWT UserID) для точечной блокировки.
   * 3. Обращается к RedisService для атомарной проверки состояния счетчика.
   * 4. При превышении лимита возвращает детальную информацию: через сколько (retryAfter)
   *    и когда (reset) доступ будет восстановлен, что соответствует стандартам RFC 6585.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Получаем опции rate limiting из метаданных
    const options = this.getRateLimitOptions(context);

    // Если нет опций - пропускаем запрос
    if (!options) {
      return true;
    }

    // Получаем идентификатор для rate limiting (IP или User ID)
    const identifier = await this.getIdentifier(context);

    // Проверяем rate limit
    const result = await this.redisService.checkRateLimit(
      identifier,
      options.windowMs,
      options.maxRequests,
      options.keyPrefix || 'rate-limit:',
    );

    // Добавляем заголовки в ответ
    this.addRateLimitHeaders(context, result);

    // Если запрос не разрешен - выбрасываем исключение
    if (!result.allowed) {
      this.logger.warn(`Rate limit exceeded for ${identifier}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests',
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((result.reset.getTime() - Date.now()) / 1000),
          limit: result.total,
          remaining: result.remaining,
          reset: result.reset.toISOString(),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Получает опции rate limiting из метаданных
   */
  private getRateLimitOptions(
    context: ExecutionContext,
  ): RateLimitOptions | null {
    // Сначала проверяем метод, потом контроллер
    const methodOptions = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );

    if (methodOptions) {
      return methodOptions;
    }

    const controllerOptions = this.reflector.get<RateLimitOptions>(
      RATE_LIMIT_KEY,
      context.getClass(),
    );

    return controllerOptions || null;
  }

  /**
   * Получает идентификатор для Rate Limiting
   * Приоритет: User ID (если аутентифицирован) > IP адрес
   */
  private async getIdentifier(context: ExecutionContext): Promise<string> {
    const request = context.switchToHttp().getRequest();

    // Если пользователь аутентифицирован - используем его ID
    if (request.user?.id) {
      return `user:${request.user.id}`;
    }

    // Иначе используем IP с учетом прокси
    let ip =
      request.ip ||
      request.connection?.remoteAddress ||
      request.headers['x-forwarded-for'] ||
      'unknown';

    // Если IP пришел через прокси, берем первый
    if (ip.includes(',')) {
      ip = ip.split(',')[0].trim();
    }

    return `ip:${ip}`;
  }

  /**
   * Добавляет заголовки rate limiting в ответ
   */
  private addRateLimitHeaders(context: ExecutionContext, result: any): void {
    const response = context.switchToHttp().getResponse();

    // Стандартные заголовки Rate Limiting
    response.set('X-RateLimit-Limit', result.total);
    response.set('X-RateLimit-Remaining', result.remaining);
    response.set('X-RateLimit-Reset', Math.ceil(result.reset.getTime() / 1000));

    // Дополнительные заголовки
    response.header('X-RateLimit-Window', Math.ceil(result.windowMs / 1000));

    // Если лимит исчерпан, добавляем Retry-After
    if (!result.allowed) {
      const retryAfter = Math.ceil(
        (result.reset.getTime() - Date.now()) / 1000,
      );
      response.header('Retry-After', retryAfter);
    }
  }

  //
}
