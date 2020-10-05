import { Controller, Get } from '@nestjs/common'
import { EventPattern } from '@nestjs/microservices'
import { TradeEvent, ClockEvent, EMAEvent } from '@momentum/events'
import { AppService } from './app.service'


@Controller('/analyzer')
export class AppController {
  constructor(
    private readonly appSvc: AppService
  ){}

  async onApplicationBootstrap() {
    // create indexes
    try {
      await this.appSvc.createIndex('trade')
      await this.appSvc.createIndex('price-ema')
      await this.appSvc.createIndex('price-clock')
    } catch(err) {}
  }

  @Get('/ping')
  async handlePing() {
      return {
        pong: new Date().getTime()
      }
  }

  // @EventPattern('update:coinbase')
  // async handleCBUpdate(data: any) {
  //   console.log('CB UPDATE:', data.pair, new Date(data.timestamp).toLocaleTimeString())
  // }

  @EventPattern('trade:coinbase')
  async handleCBTrade(data: TradeEvent) {
    this.appSvc.createDoc('trade', {
      exchange: 'coinbase',
      pair: data.pair,
      side: data.side,
      size: Number(data.size),
      price: Number(data.price),
      time: data.time
    })
  }

  @EventPattern('clock:1m:coinbase')
  async handleCBOneMin(data: ClockEvent) {
    console.log(data)
    this.appSvc.createDoc('price-clock', {
      ...data,
      bestBid: Number(data.bestBid?.[0]),
      bestBidDepth: Number(data.bestBid?.[1]),
      bestAsk: Number(data.bestAsk?.[0]),
      bestAskDepth: Number(data.bestAsk?.[1]),
      avgTradePrice: Number(data.avgTradePrice),
      avgTradeSize: Number(data.avgTradeSize)
    })
  }

  @EventPattern('clock:5m:coinbase')
  async handleCBFiveMin(data: ClockEvent) {
    console.log(data)
    this.appSvc.createDoc('price-clock', {
      ...data,
      bestBid: Number(data.bestBid?.[0]),
      bestBidDepth: Number(data.bestBid?.[1]),
      bestAsk: Number(data.bestAsk?.[0]),
      bestAskDepth: Number(data.bestAsk?.[1]),
      avgTradePrice: Number(data.avgTradePrice),
      avgTradeSize: Number(data.avgTradeSize)
    })
  }

  @EventPattern('clock:15m:coinbase')
  async handleCBFifteenMin(data: ClockEvent) {
    console.log(data)
    this.appSvc.createDoc('price-clock', {
      ...data,
      bestBid: Number(data.bestBid?.[0]),
      bestBidDepth: Number(data.bestBid?.[1]),
      bestAsk: Number(data.bestAsk?.[0]),
      bestAskDepth: Number(data.bestAsk?.[1]),
      avgTradePrice: Number(data.avgTradePrice),
      avgTradeSize: Number(data.avgTradeSize)
    })
  }

  @EventPattern('ema:coinbase')
  async handleCoinbaseEma(data: EMAEvent) {
    console.log(data)
    this.appSvc.createDoc('price-ema', data)
  }

  // @EventPattern('update:alpaca')
  // async handleAlpUpdate(data: any) {
  //   console.log(data)
  // }

  @EventPattern('trade:alpaca')
  async handleAlpTrade(data: any) {
    console.log(data)
  }

  @EventPattern('clock:1m:alpaca')
  async handleAlpOneMin(data: ClockEvent) {
    console.log(data)
  }

  @EventPattern('clock:5m:alpaca')
  async handleAlpFiveMin(data: ClockEvent) {
    console.log(data)
  }

  @EventPattern('clock:15m:alpaca')
  async handleAlpFifteenMin(data: ClockEvent) {
    console.log(data)
  }

  @EventPattern('ema:alpaca')
  async handleAlpEma(data: any) {
    console.log(data)
  }

}
