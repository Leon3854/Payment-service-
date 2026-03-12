import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { PaymentScheduler } from './scheduler/payment.scheduler';
import { PrismaService } from 'src/prisma.service';
import { RedisService } from 'src/providers/redis/redis.service';
import { RabbitMQService } from 'src/providers/rabbitmq/rabbitmq.service';
import { YookassaService } from 'src/providers/yookassa/yookassa.service';
import { HttpModule } from '@nestjs/axios';
import { ScheduleModule } from '@nestjs/schedule';
import { PaymentGateway } from './payment.gateway';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000,
      maxRedirects: 5,
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentScheduler,
    PrismaService,
    RedisService,
    RabbitMQService,
    YookassaService,
    PaymentGateway,
  ],
  exports: [PaymentService, RabbitMQService, RedisService],
})
export class PaymentModule {}
