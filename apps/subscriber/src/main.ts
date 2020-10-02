import { NestFactory } from '@nestjs/core'
import { MicroserviceOptions, Transport } from '@nestjs/microservices'
import { AppModule } from './app.module'

async function bootstrap() {
  // Create redis transport
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.REDIS,
    options: {
      url: 'redis://localhost:6379',
      db: '0'
    }
  })
  
  app.listen(
    () => {
      console.log('')
      console.log('🗞️🗞️🗞️🗞️  Momentum Subscriber Activated 🗞🗞️🗞️🗞️')
    }
  )
}
bootstrap()