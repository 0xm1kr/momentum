import { Controller, Get } from '@nestjs/common'
import { EventPattern } from '@nestjs/microservices'

@Controller('/analyzer')
export class AppController {

  @Get('/ping')
  async handlePing() {
      return {
        pong: new Date().getTime()
      }
  }

  // @EventPattern('update:coinbase')
  // async handleCBOneSec(data: any) {
  //   console.log('CB UPDATE:', data.pair, new Date(data.timestamp).toLocaleTimeString())
  // }

  @EventPattern('trade:coinbase')
  async handleCBTrade(data: any) {
    console.log(data)
  }

  @EventPattern('clock:1m:coinbase')
  async handleCBOneMin(data: any) {
    console.log(data)
  }

  @EventPattern('clock:5m:coinbase')
  async handleCBFiveMin(data: any) {
    console.log(data)
  }

  @EventPattern('clock:15m:coinbase')
  async handleCBFifteenMin(data: any) {
    console.log(data)
  }

  // @EventPattern('update:alpaca')
  // async handleAlpOneSec(data: any) {
  //   console.log(data)
  // }

  @EventPattern('trade:alpaca')
  async handleAlpTrade(data: any) {
    console.log(data)
  }

  @EventPattern('clock:1m:alpaca')
  async handleAlpOneMin(data: any) {
    console.log(data)
  }

  @EventPattern('clock:5m:alpaca')
  async handleAlpFiveMin(data: any) {
    console.log(data)
  }

  @EventPattern('clock:15m:alpaca')
  async handleAlpFifteenMin(data: any) {
    console.log(data)
  }

}
