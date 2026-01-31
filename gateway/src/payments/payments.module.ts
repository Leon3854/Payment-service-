// gateway/src/payments/payments.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PaymentsResolver } from './payments.resolver';
import { PaymentsService } from './payments.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      useFactory: () => ({
        timeout: 10000,
        maxRedirects: 3,
        baseURL: process.env.PAYMENT_SERVICE_URL || 'http://payment-service:3000',
      }),
    }),
  ],
  providers: [PaymentsResolver, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}