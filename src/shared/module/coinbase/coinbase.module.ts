import { Module } from '@nestjs/common';
import { CoinbaseService } from './coinbase.service';
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [ConfigModule.forRoot()],
    providers: [CoinbaseService],
    exports: [CoinbaseService],
})
export class CoinbaseModule {}