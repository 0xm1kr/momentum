import { Module } from '@nestjs/common'
import { Transport, ClientsModule } from '@nestjs/microservices'
import { RedisModule} from 'nestjs-redis'
import { ConfigModule } from '@nestjs/config'
import { AppController } from './app.controller'

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
    // Redis as a simple DB service
    RedisModule.register({
      name: 'momentum-state',
      url: 'redis://localhost:6379/1',
      keyPrefix: 'mmtm'
    })
  ],
  providers: [],
  controllers: [
    AppController
  ]
})
export class AppModule {}
