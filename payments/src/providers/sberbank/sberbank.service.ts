import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class SberbankService {
  private readonly logger = new Logger(SberbankService.name);

  async registerPreAuth(params: {
    orderNumber: string;
    amount: number;
    returnUrl: string;
    failUrl: string;
  }) {
    this.logger.log(`Create Sberbank payment: ${params.orderNumber}`);

    // Заглушка
    return {
      orderId: Math.random().toString(36).substr(2, 9),
      formUrl: 'https://securecardpayment.ru/stub',
    };
  }
}
