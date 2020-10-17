import { Module } from '@nestjs/common'
import { Transport, ClientsModule } from '@nestjs/microservices'
import { RedisModule} from 'nestjs-redis'
import { ConfigModule } from '@nestjs/config'
import { AlpacaModule } from '@momentum/alpaca-client'
import { AppService } from './app.service'
import { ClockModule } from '@momentum/clock'
import { AppController } from './app.controller'

// eslint-disable-next-line @typescript-eslint/no-var-requires
require('events').EventEmitter.prototype._maxListeners = 100;

@Module({
  imports: [
    // Config
    ConfigModule.forRoot(),
    // Momentum events service
    ClientsModule.register([
      {
        name: 'MOMENTUM_SERVICE',
        transport: Transport.REDIS,
        options: {
          url: 'redis://localhost:6379',
          db: '0'
        }
      },
    ]),
    // Redis as distributed state
    RedisModule.register({
      name: 'momentum-state',
      url: 'redis://localhost:6379/1',
      keyPrefix: 'mmtm'
    }),
    // Clock
    ClockModule,
    // Alpaca
    AlpacaModule
  ],
  providers: [
    AppService
  ],
  controllers: [
    AppController
  ]
})
export class AppModule {
  async beforeApplicationShutdown() {
    console.log('SUBSCRIBER: SHUTTING DOWN!')
    // TODO emit shutdown event?
  }
}
