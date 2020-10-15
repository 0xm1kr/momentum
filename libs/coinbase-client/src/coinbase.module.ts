import { Module } from '@nestjs/common'
import { CoinbaseService } from './coinbase.service'

@Module({
    providers: [CoinbaseService],
    exports: [CoinbaseService],
})
export class CoinbaseModule {}