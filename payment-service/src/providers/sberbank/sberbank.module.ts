import { Module } from '@nestjs/common';
import { on } from 'events';
import { SberbankService } from './sberbank.service';

@Module({
  providers: [SberbankService],
})
export class SberbankModule {}
