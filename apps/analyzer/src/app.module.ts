import { Module } from '@nestjs/common'
import { AppController } from './app.controller'

@Module({
  imports: [],
  controllers: [AppController],
  providers: [],
})
export class AppModule {
  async beforeApplicationShutdown() {
    console.log('ANALYZER: SHUTTING DOWN!')
    // TODO emit shutdown event?
  }
}
