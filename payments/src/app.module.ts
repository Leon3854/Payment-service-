import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaService } from './prisma.service';
import { PaymentModule } from './payment/payment.module';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { GraphQLModule } from '@nestjs/graphql';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    // 2. ГРАФКЬЮЭЛЬ: Настройка "Стеклянного небоскреба"
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Автогенерация схемы в корне папки src
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      // Включаем песочницу (Playground) для тестирования запросов в браузере
      playground: true,
    }),

    PaymentModule,
  ],
  controllers: [AppController],
  providers: [AppService, PrismaService],
})
export class AppModule {}
