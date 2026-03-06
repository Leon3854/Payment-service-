import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class TinkoffService {
  private readonly logger = new Logger(TinkoffService.name);

  async initPayment(params: {
    Amount: number;
    OrderId: string;
    Description: string;
    SuccessURL: string;
    FailURL: string;
  }) {
    this.logger.log(`Creating Tinkoff payment for order: ${params.OrderId}`);

    // Заглушка
    return {
      Success: true,
      ErrorCode: '0',
      PaymentId: Math.random().toString(36).substr(2, 9),
      Status: 'NEW',
      PaymentURL: 'https://securepay.tinkoff.ru/stub',
    };
  }
}
