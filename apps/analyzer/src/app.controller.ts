import { Controller, Get } from '@nestjs/common'
import { EventPattern } from '@nestjs/microservices'

@Controller()
export class AppController {

  @EventPattern('clock:1s')
  async handleOneSec(data: any) {
    console.log(data)
  }

  @EventPattern('clock:1m')
  async handleOneMin(data: any) {
    console.log(data)
  }

  @EventPattern('trade')
  async handleTrade(data: any) {
    console.log(data)
  }
}
