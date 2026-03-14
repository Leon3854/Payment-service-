import { InputType, Field, Float } from '@nestjs/graphql';

/**
 * @InputType CreatePaymentInput
 * @description Входной контракт для инициализации транзакции через GraphQL интерфейс.
 * Обеспечивает строгую типизацию и защиту от передачи некорректных финансовых данных.
 */
@InputType({ description: 'Данные для создания нового платежа' })
export class CreatePaymentInput {
  @Field(() => Float, { description: 'Сумма транзакции' })
  amount: number;

  @Field({ description: 'Валюта платежа (напр. RUB, USD)' })
  currency: string;

  @Field({ description: 'Идентификатор пользователя в системе' })
  userId: string;

  @Field({
    nullable: true,
    description: 'Внешний ID заказа (для интеграции с E-commerce)',
  })
  orderId?: string;

  @Field({ nullable: true, description: 'Краткое описание назначения платежа' })
  description?: string;
}
