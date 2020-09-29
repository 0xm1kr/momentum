import { Module } from '@nestjs/common';
import { AlpacaService } from './alpaca.service';
import { ConfigModule } from '@nestjs/config';

@Module({
    imports: [ConfigModule.forRoot()],
    providers: [AlpacaService],
    exports: [AlpacaService],
})
export class AlpacaModule {}