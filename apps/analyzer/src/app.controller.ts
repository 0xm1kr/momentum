import { Controller, Get } from '@nestjs/common'
import { EventPattern } from '@nestjs/microservices'

@Controller('/analyzer')
export class AppController {

  @Get('/ping')
  async handlePing() {
      return {
          pong: new Date().getTime(),
          running: []
      }
  }

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
