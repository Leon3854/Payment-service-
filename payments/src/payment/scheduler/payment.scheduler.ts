// src/payment/scheduler/payment.scheduler.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { PaymentService } from '../payment.service';
import { RabbitMQService } from '../../providers/rabbitmq/rabbitmq.service';

@Injectable()
export class PaymentScheduler {
  private readonly logger = new Logger(PaymentScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly rabbitmq: RabbitMQService,
  ) {}

  // Каждый час проверяем подписки для продления
  @Cron(CronExpression.EVERY_HOUR)
  async processSubscriptionRenewals() {
    this.logger.log('Processing subscription renewals');

    const now = new Date();
    const oneDayFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Находим подписки, у которых заканчивается период в ближайшие 24 часа
    const subscriptions = await this.prisma.subscription.findMany({
      where: {
        status: 'ACTIVE',
        autoRenew: true,
        currentPeriodEnd: {
          lte: oneDayFromNow,
          gte: now,
        },
      },
    });

    this.logger.log(`Found ${subscriptions.length} subscriptions to renew`);

    for (const subscription of subscriptions) {
      try {
        // Отправляем в очередь для асинхронной обработки
        await this.rabbitmq.sendToQueue('subscription.renewal_due', {
          subscriptionId: subscription.id,
          userId: subscription.userId,
          renewAt: subscription.currentPeriodEnd,
          timestamp: new Date().toISOString(),
        });

        this.logger.log(
          `Scheduled renewal for subscription ${subscription.id}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to schedule renewal for subscription ${subscription.id}:`,
          error,
        );
      }
    }
  }

  // Каждый день в 9 утра проверяем просроченные инвойсы
  @Cron('0 9 * * *')
  async processOverdueInvoices() {
    this.logger.log('Processing overdue invoices');

    const now = new Date();
    const overdueInvoices = await this.prisma.invoice.findMany({
      where: {
        status: 'OPEN',
        dueDate: { lt: now },
        nextAttemptAt: { lt: now },
      },
      include: {
        subscription: true,
      },
    });

    this.logger.log(`Found ${overdueInvoices.length} overdue invoices`);

    for (const invoice of overdueInvoices) {
      try {
        if (invoice.attemptCount >= invoice.maxAttempts) {
          // Превышено максимальное количество попыток
          await this.prisma.invoice.update({
            where: { id: invoice.id },
            data: { status: 'UNCOLLECTIBLE' },
          });

          if (invoice.subscriptionId) {
            await this.paymentService.cancelSubscription(
              invoice.subscriptionId,
              false,
            );
          }

          this.logger.log(`Invoice ${invoice.id} marked as uncollectible`);
        } else {
          // Запускаем процесс даннинга
          await this.paymentService.startDunningProcess(invoice.id);
          this.logger.log(`Started dunning process for invoice ${invoice.id}`);
        }
      } catch (error) {
        this.logger.error(
          `Failed to process overdue invoice ${invoice.id}:`,
          error,
        );
      }
    }
  }

  // Каждые 5 минут проверяем стадии даннинга
  @Cron('*/5 * * * *')
  async processDunningStages() {
    this.logger.log('Processing dunning stages');

    const now = new Date();
    const dunningProcesses = await this.prisma.dunningProcess.findMany({
      where: {
        status: 'ACTIVE',
        nextActionAt: { lte: now },
      },
    });

    this.logger.log(
      `Found ${dunningProcesses.length} dunning processes to process`,
    );

    for (const dunning of dunningProcesses) {
      try {
        const result = await this.paymentService.processDunningStage(
          dunning.id,
        );

        if (result.completed) {
          this.logger.log(
            `Dunning process ${dunning.id} completed: ${result.reason}`,
          );
        } else {
          this.logger.log(
            `Dunning process ${dunning.id} moved to stage ${result.nextStage}`,
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to process dunning stage ${dunning.id}:`,
          error,
        );
      }
    }
  }
}
