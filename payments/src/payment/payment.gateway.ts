import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';

/**
 * @class PaymentGateway
 * @description Реалтайм-шлюз для уведомления клиентов о статусах транзакций через WebSockets.
 * Обеспечивает Low-Latency фидбек без необходимости поллинга (Polling) со стороны фронтенда.
 */
@WebSocketGateway({ cors: true, namespace: 'payments' })
export class PaymentGateway implements OnGatewayConnection {
  private readonly logger = new Logger(PaymentGateway.name);

  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    this.logger.log(`Client connected to real-time payments: ${client.id}`);
  }

  /**
   * Отправляет пуш-уведомление конкретному пользователю об изменении статуса платежа.
   *
   * @param userId - ID пользователя (комната в сокетах)
   * @param payload - Данные о статусе (success/failed/pending)
   */
  emitPaymentStatus(userId: string, payload: any) {
    this.server.to(`user_${userId}`).emit('payment_update', payload);
  }

  @SubscribeMessage('join_room')
  handleJoinRoom(client: Socket, userId: string) {
    client.join(`user_${userId}`);
    this.logger.log(`User ${userId} joined room for real-time updates`);
  }
}
