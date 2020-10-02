import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { Transport, MicroserviceOptions } from '@nestjs/microservices'

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
      console.log('🔍 🕵️ 🔬 Momentum Analyzer Activated🔬 🕵️ 🔎')
    }
  )
}
bootstrap()
