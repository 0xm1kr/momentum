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
    // create indexes and store exchange data
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
  //   console.log('UPDATE:', data.pair, new Date(data.timestamp).toLocaleTimeString())
  // }

  @EventPattern('trade:coinbase')
  async handleCBTrade(data: TradeEvent) {
    this._storeTradeEvent('coinbase', data)
  }

  @EventPattern('clock:1m:coinbase')
  async handleCBOneMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('clock:5m:coinbase')
  async handleCBFiveMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('clock:15m:coinbase')
  async handleCBFifteenMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('ema:coinbase')
  async handleCBEma(data: EMAEvent) {
    console.log(data)
    this.appSvc.createDoc('price-ema', data)
  }

  // @EventPattern('update:alpaca')
  // async handleAlpUpdate(data: any) {
  //   console.log('UPDATE:', data.pair, new Date(data.timestamp).toLocaleTimeString())
  // }

  @EventPattern('trade:alpaca')
  async handleAlpTrade(data: TradeEvent) {
    this._storeTradeEvent('alpaca', data)
  }

  @EventPattern('clock:1m:alpaca')
  async handleAlpOneMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('clock:5m:alpaca')
  async handleAlpFiveMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('clock:15m:alpaca')
  async handleAlpFifteenMin(data: ClockEvent) {
    this._storeClockEvent(data)
  }

  @EventPattern('ema:alpaca')
  async handleAlpEma(data: EMAEvent) {
    console.log(data)
    this.appSvc.createDoc('price-ema', data)
  }

  /**
   * Store a clock event in ES
   * 
   * @param index 
   * @param data 
   */
  private async _storeClockEvent(data: ClockEvent) {
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

  /**
   * Store a trade event in ES
   * 
   * @param string
   * @param data 
   */
  private async _storeTradeEvent(exchange: string, data: TradeEvent) {
    this.appSvc.createDoc('trade', {
      exchange: exchange,
      pair: data.pair,
      side: data.side,
      size: Number(data.size),
      price: Number(data.price),
      delta: Number(data.delta),
      time: data.time
    })
  }

}
