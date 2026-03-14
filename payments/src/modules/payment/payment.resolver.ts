import {
  Resolver,
  Query,
  Args,
  ID,
  ResolveField,
  Parent,
} from '@nestjs/graphql';
import { PaymentService } from '../../payment/payment.service';
import { Subscription } from './models/subscription.model';
import { Payment } from './models/payment.model';

/**
 * @class SubscriptionResolver
 * @description Слой гибкого API для управления жизненным циклом подписок пользователя.
 *
 * ПОНЯТНЫМИ СЛОВАМИ (ДЛЯ ЧЕЛОВЕКА):
 * Этот файл — "умный диспетчер". Представьте, что клиент запрашивает список своих тарифов.
 * Если ему нужно просто название — сервер отдает название. Если он хочет увидеть "А за что
 * я платил?" — этот диспетчер сам "сбегает" в базу и подтянет только нужные чеки (платежи).
 *
 * ПОЧЕМУ ЭТО КРУТО:
 * 1. Решает проблему N+1: Мы не грузим всё сразу, а используем Lazy Fetching.
 * 2. Low Coupling: Логика получения данных отделена от логики отображения.
 * 3. UX Friendly: Фронтенд сам решает, какой объем данных ему нужен для текущего экрана.
 */
@Resolver(() => Subscription)
export class SubscriptionResolver {
  constructor(private readonly paymentService: PaymentService) {}

  /**
   * ЗАПРОС: Список всех подписок конкретного пользователя.
   *
   * @param {string} userId - Идентификатор владельца (из БД).
   * @returns {Promise<Subscription[]>} Массив объектов подписок.
   *
   * ПРОСТЫМИ СЛОВАМИ:
   * "Дай мне все подписки этого человека (например, Premium, Standart)".
   * Это точка входа для личного кабинета пользователя.
   */
  @Query(() => [Subscription], {
    name: 'userSubscriptions',
    description: 'Получить список всех тарифных планов пользователя',
  })
  async getSubscriptions(@Args('userId', { type: () => ID }) userId: string) {
    return await this.paymentService.getUserSubscriptions(userId);
  }

  /**
   * ДИНАМИЧЕСКОЕ ПОЛЕ: История платежей внутри конкретной подписки.
   *
   * @param {Subscription} subscription - Родительский объект подписки.
   * @returns {Promise<Payment[]>} Последние транзакции.
   *
   * ПРОСТЫМИ СЛОВАМИ:
   * Если на сайте пользователь нажал кнопку "Показать историю оплат" у конкретной подписки,
   * этот метод "просыпается" и достает последние 5 чеков из базы.
   * Если кнопку не нажали — база данных отдыхает. Это экономит ресурсы сервера.
   */
  @ResolveField(() => [Payment], {
    description: 'Последние 5 транзакций по данной подписке для аудита',
  })
  async payments(@Parent() subscription: Subscription) {
    const { userId } = subscription;
    // Оптимизация: берем только 5 записей, чтобы не "раздувать" ответ
    return await this.paymentService.getUserPayments(userId, 5);
  }
}
