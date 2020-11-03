import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { AppController } from './app.controller'
import { AppService } from './app.service'
import { TwilioModule } from 'nestjs-twilio'

@Module({
  imports: [
    // Config
    ConfigModule.forRoot(),
    // Twilio for notifications
    TwilioModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: async (cfg: ConfigService) => ({
        accountSid: cfg.get('TWILIO_ACCOUNT_SID'),
        authToken: cfg.get('TWILIO_AUTH_TOKEN'),
      }),
      inject: [ConfigService],
    })
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
  async beforeApplicationShutdown() {
    console.log('ANALYZER: SHUTTING DOWN!')
    // TODO emit shutdown event?
  }
}
