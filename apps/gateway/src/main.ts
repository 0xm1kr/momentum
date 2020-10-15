import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // enable shutdown hook
  app.enableShutdownHooks();

  await app.listen(8000, () => {
    console.log('')
    console.log('💸 💰 🤑 💵 🏦  Momentum Activated 🏦 💵 🤑 💰 💸')
  })
}
bootstrap()