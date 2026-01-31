import { Module } from '@nestjs/common';
import { TinkoffService } from './tinkoff.service';

@Module({
  providers: [TinkoffService],
})
export class TinkoffModule {}
