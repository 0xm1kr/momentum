import { Inject, Injectable } from '@nestjs/common'
import { ClientProxy } from '@nestjs/microservices'
import bn from 'big.js'
import { ClockService, ClockIntervalText, ClockInterval } from './clock.service'
import {
  CoinbaseService,
  WebSocketChannelName,
  WebSocketTickerMessage,
} from '@momentum/coinbase'

export type ClockEvent = {
  exchange: string
  pair: string
  interval: ClockIntervalText
  bestBid: string
  bestAsk: string
  avgTradePrice: string
  avgTradeSize?: string
  avgBidDepth?: string
  avgAskDepth?: string
  time: number
};

type Tickers = WebSocketTickerMessage[] // | AlpacaTickerMessage
type PairTickers = Record<string, Tickers>
type ExchangeTickers = Record<string, PairTickers>

type TickerTimes = number[]
type PairTickerTimes = Record<string, TickerTimes>
type ExchangeTickerTimes = Record<string, PairTickerTimes>

@Injectable()
export class ExchangeSubscriberService {
  constructor(
    @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
    private readonly coinbaseSvc: CoinbaseService,
    private readonly clockSvc: ClockService
  ) { }

  private tickers: ExchangeTickers = {}
  private tickerTimes: ExchangeTickerTimes = {}

  async onApplicationBootstrap() {
    // connect to momentum pubsub
    await this.momentum.connect()
  }

  /**
   * subscribe to pairs
   */
  async subscribe(subscriptions: string[], exchange = 'coinbase') {
    // get subscriptions
    if (!subscriptions.length) {
      throw new Error('at least one pair is required to subscribe')
    }

    switch (exchange) {
      case 'coinbase':
        this._subscribeToCoinbasePairs(subscriptions)
        break
      case 'alpaca':
        // TODO
        break
      default:
        throw new Error('invalid exchange')
    }
  }

  /**
   * unsubscribe from pairs
   */
  async unsubscribe(subscriptions: string[], exchange = 'coinbase') {
    // get coinbase subscriptions
    if (!subscriptions.length) {
      throw new Error('at least one pair is required to unsubscribe')
    }

    switch (exchange) {
      case 'coinbase':
        this._unsubscribeFromCoinbasePairs(subscriptions)
        break
      case 'alpaca':
        // TODO
        break
      default:
        throw new Error('invalid exchange')
    }
  }

  /**
   * Handle a clock event
   * 
   * @param exchange 
   * @param interval 
   * @param pair 
   */
  private _clockEventHandler(interval: ClockIntervalText, exchange: string,  pair: string) {

    const now = new Date().getTime()
    const intvlTime = ClockInterval[interval]
    const lastIndex = this.tickerTimes?.[exchange]?.[pair]?.findIndex((t) => t < (now-intvlTime))
    const tickers = this.tickers?.[exchange]?.[pair]?.slice(0, lastIndex)
    const priceSum = tickers?.reduce<bn>((t, {price}) => bn(t).plus(price), bn('0'))
    const avgTradePrice = priceSum.gt(0) ? priceSum.div(tickers.length)?.toString() : null

    const ev: ClockEvent = {
      interval,
      exchange,
      pair,
      bestBid: this.coinbaseSvc.getBestBid(pair),
      bestAsk: this.coinbaseSvc.getBestAsk(pair),
      avgTradePrice,
      time: now 
      // avgTradeSize: string
    }

    // tell our app what's up
    this.momentum.emit(`clock:${interval}`, ev)
  }

  /**
   * Record a ticker price
   * 
   * @param exchange 
   * @param m 
   */
  private _recordTicker(exchange: string, m: WebSocketTickerMessage) {
    const pair = m.product_id

    // init
    if (typeof this.tickers[exchange] === 'undefined') {
        this.tickers[exchange] = {}
        this.tickerTimes[exchange] = {}
    }
    if (typeof this.tickers[exchange][pair] === 'undefined') {
        this.tickers[exchange][pair] = []
        this.tickerTimes[exchange][pair] = []
    }

    // push
    this.tickers[exchange][pair].unshift(m)
    this.tickerTimes[exchange][pair].unshift(new Date(m.time).getTime())
  }

   /**
   * Subscribe to coinbase 
   * tickers and order books
   * 
   * @param pairs 
   */
  private _subscribeToCoinbasePairs(pairs: string[]) {
    // Subscribe to tickers
    this.coinbaseSvc.subscribe({
      [WebSocketChannelName.TICKER]: pairs.map(s => ({
        productId: s,
        handler: (m: WebSocketTickerMessage) => {
          this._recordTicker('coinbase', m)
          this.momentum.emit(`ticker:coinbase:${m.product_id}`, m)
        }
      }))
    })

    // Start syncing books
    pairs.forEach((s: string) => {
      this.coinbaseSvc.syncBook(s)
    })

    // Start clocks
    pairs.forEach((p: string) => {
      Object.values(ClockIntervalText).forEach(
        (i: ClockIntervalText) => this.clockSvc.start(
          'coinbase', i, p, this._clockEventHandler.bind(this)
        )
      )
    })
  }

  /**
   * Unsubscribe from coinbase 
   * tickers and order books
   * 
   * @param pairs 
   */
  private _unsubscribeFromCoinbasePairs(pairs: string[]) {
    if (pairs.length) {

      // Stop clocks
      pairs.forEach((p: string) => {
        Object.values(ClockIntervalText).forEach(
          (i: ClockIntervalText) => this.clockSvc.stop('coinbase', i, p)
        )
      })

      // Unsubscribe
      this.coinbaseSvc.unsubscribe({
        [WebSocketChannelName.TICKER]: pairs.map(s => ({
          productId: s
        })),
        [WebSocketChannelName.LEVEL2]: pairs.map(s => ({
          productId: s
        }))
      })
    }
  }

  /**
   * Subscribe to alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _subscribeToAlpacaPairs(pairs: string[]) {
    // TODO
  }

  /**
   * Unsubscribe from alpaca 
   * tickers and quotes
   * 
   * @param pairs 
   */
  private _unsubscribeFromAlpacaPairs(pairs: string[]) {
    // TODO
  }

}
