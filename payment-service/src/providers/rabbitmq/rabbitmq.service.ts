// src/payment/rabbitmq/rabbitmq.service.ts
import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';

@Injectable()
export class RabbitMQService implements OnModuleDestroy {
  private readonly logger = new Logger(RabbitMQService.name);
  private connection: any = null;
  private channel: any = null;

  async onModuleInit() {
    await this.connect();
  }

  async connect() {
    const rabbitMqUrl =
      process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';

    if (!rabbitMqUrl) {
      throw new Error('RABBITMQ_URL environment variable is required');
    }

    this.logger.log(`Connecting to RabbitMQ: ${rabbitMqUrl}`);

    try {
      const amqp = await import('amqplib');
      this.connection = await amqp.connect(rabbitMqUrl);
      this.channel = await this.connection.createChannel(); // Исправлено: createChannel, а не createChanel

      // Объявляем все необходимые очереди
      const queues = [
        'payment.created',
        'payment.succeeded',
        'payment.failed',
        'payment.refunded',
        'payment.retry_succeeded',
        'payment.recurring_succeeded',
        'subscription.created',
        'subscription.canceled',
        'subscription.renewal_due',
        'invoice.created',
        'dunning.started',
        'dunning.stage_completed',
        'notification.dunning',
        'yookassa.webhook',
      ];

      for (const queue of queues) {
        await this.channel.assertQueue(queue, {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum', // Для надежности
          },
        });
      }

      this.logger.log('RabbitMQ connected successfully');
    } catch (error) {
      this.logger.error('Failed to connect to RabbitMQ', error);
      throw error;
    }
  }

  async sendToQueue(queue: string, message: any): Promise<boolean> {
    if (!this.channel) {
      await this.connect();
    }

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available');
    }

    return this.channel.sendToQueue(
      queue,
      Buffer.from(JSON.stringify(message)),
      {
        persistent: true,
        contentType: 'application/json',
        timestamp: Date.now(),
      },
    );
  }

  async subscribe(queue: string, callback: (message: any) => Promise<void>) {
    if (!this.channel) {
      await this.connect();
    }

    await this.channel.consume(queue, async (msg) => {
      if (msg !== null) {
        try {
          const content = JSON.parse(msg.content.toString());
          await callback(content);
          this.channel.ack(msg);
        } catch (error) {
          this.logger.error(`Error processing message from ${queue}:`, error);
          this.channel.nack(msg, false, false); // Не переотправляем
        }
      }
    });
  }

  async onModuleDestroy() {
    try {
      if (this.channel) {
        await this.channel.close();
        this.channel = null;
      }
      if (this.connection) {
        await this.connection.close();
        this.connection = null;
      }
      this.logger.log('RabbitMQ connection closed');
    } catch (error) {
      this.logger.error('Error closing RabbitMQ connection', error);
    }
  }
}
