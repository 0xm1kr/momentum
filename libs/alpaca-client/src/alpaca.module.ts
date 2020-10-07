import { Module } from '@nestjs/common'
import { AlpacaService } from './alpaca.service'

@Module({
  providers: [AlpacaService],
  exports: [AlpacaService],
})
export class AlpacaModule {}
