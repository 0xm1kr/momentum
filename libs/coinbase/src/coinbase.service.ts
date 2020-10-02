import { Injectable } from '@nestjs/common';
import {
  CoinbasePro,
  Account,
  WebSocketEvent,
  WebSocketChannelName,
  OrderSide,
  WebSocketResponse,
  WebSocketTickerMessage,
  WebSocketChannel,
  WebSocketResponseType,
  OrderBookLevel2,
  OrderBookLevel,
  LimitOrder,
  MarketOrder,
  Order,
  OrderType,
  FeeUtil,
  FeeEstimate,
  CandleGranularity,
  Candle
} from 'coinbase-pro-node'
import { RBTree } from 'bintrees'
import ReconnectingWebSocket from 'reconnecting-websocket'
import bn from 'big.js'

//
// The CBPService handles  
// all interactions with  
// the Coinbase Pro API.
// 
// Built on top of:
// [coinbase-pro-node](https://github.com/bennyn/coinbase-pro-node)
//
// API Keys are needed for any secure 
// functionality and can be created here:
// https://pro.coinbase.com/profile/api
// https://public.sandbox.pro.coinbase.com/profile/api
//

export type CBPParams = {
  action: string
  product?: string
  param?: string
}

export type BookSubscription = {
  productId: string,
  handler?: (message: WebSocketResponse|WebSocketTickerMessage) => void
}

export type BookSubscriptionMap = {
  [key in WebSocketChannelName]?: BookSubscription[]
}

export type BookSnapshot = {
  type: WebSocketResponseType
  product_id: string
} & OrderBookLevel2

export type BookUpdate = {
  type: WebSocketResponseType
  product_id: string
  // [
  //     "buy|sell",  // buy/sell
  //     "11602.18",  // price level
  //     "0.00000000" // size: size of zero means this price level can be removed
  // ]
  changes: string[][]
}

@Injectable()
export class CoinbaseService {

  protected client!: CoinbasePro
  protected connection: ReconnectingWebSocket

  public channels: WebSocketChannel[] = []
  public bids: Record<string, RBTree<string[]>> = {}
  public asks: Record<string, RBTree<string[]>> = {}

  constructor() {
    this.client = new CoinbasePro({
      apiKey: process.env.CBP_KEY,
      apiSecret: process.env.CBP_SECRET,
      passphrase: process.env.CBP_PASSPHRASE,
      useSandbox: (process.env.ENVIRONMENT !== 'LIVE')
    })
  }

  /**
   * place a limit order
   * 
   * @param productId 
   * @param params {
   *  amount: amount in quote (e.g. USD)
   *  side: buy or sell
   * }
   */
  public async limitOrder(productId: string, params: {
    size: string
    side: OrderSide
    price: string
    stop?: 'loss' | 'entry'
    stopPrice?: string
  }): Promise<Order> {
    const o: LimitOrder = {
      type: OrderType.LIMIT,
      product_id: productId,
      side: params.side,
      size: params.size,
      price: params.price
    }

    // stop order
    if (params.stop) {
      o.stop = params.stop
      if (!params.stopPrice) throw new Error(`stopPrice is required for a stop ${params.stop} order`)
      o.stop_price = params.stopPrice
    }

    return this.client.rest.order.placeOrder(o)
  }

  /**
   * place a market order
   * 
   * @param productId 
   * @param params {
   *  amount: amount in quote (e.g. USD)
   *  side: buy or sell
   * }
   */
  public async marketOrder(productId: string, params: {
    amount: string
    side: OrderSide
  }): Promise<Order> {
    const o: MarketOrder = {
      type: OrderType.MARKET,
      product_id: productId,
      side: params.side,
      funds: params.amount
    }
    return this.client.rest.order.placeOrder(o)
  }

  /**
   * estimate an order fee
   * 
   * @param product 
   * @param params 
   */
  public async getFeeEstimate(product: string, params: {
    size: string
    price: string | number
    side: OrderSide
    type: OrderType
  }): Promise<FeeEstimate> {
    const pair = product.split('-')
    const quote = pair[1]
    const feeTier = await this.client.rest.fee.getCurrentFees()
    return FeeUtil.estimateFee(params.size, params.price, params.side, params.type, feeTier, quote)
  }

  /**
   * get accounts
   */
  public async getAccounts(): Promise<Account[]> {
    return this.client.rest.account.listAccounts()
  }

  /**
   * getBook
   * 
   * @param productId 
   */
  public async getBook(productId = 'BTC-USD'): Promise<OrderBookLevel2> {
    return this.client.rest.product.getProductOrderBook(productId, {
      level: OrderBookLevel.TOP_50_BIDS_AND_ASKS
    })
  }

  /**
   * getBook
   * 
   * @param productId 
   */
  public async getCandles(productId = 'BTC-USD', granularity: CandleGranularity): Promise<Candle[]> {
    return this.client.rest.product.getCandles(productId, {
      granularity
    })
  }

  /**
   * subscribe to websocket channels
   * 
   * @param subscriptions 
   */
  public subscribe(subscriptions: BookSubscriptionMap): void {

    // l2 message handler
    if (subscriptions[WebSocketChannelName.LEVEL2]) {
      this.client.ws.on(WebSocketEvent.ON_MESSAGE, (m: WebSocketResponse) => {
        const subs = subscriptions[WebSocketChannelName.LEVEL2].filter((val => val.productId === (m as any).product_id))
        if (subs.length) {
          subs.forEach((s) => s.handler(m))
        }
      })
    }

    // ticker handler
    if (subscriptions[WebSocketChannelName.TICKER]) {
      this.client.ws.on(WebSocketEvent.ON_MESSAGE_TICKER, (m: WebSocketTickerMessage) => {
        const subs = subscriptions[WebSocketChannelName.TICKER].filter((val => val.productId === (m as any).product_id))
        if (subs.length) {
          subs.forEach((s) => s.handler(m))
        }
      })
    }

    // setup channels
    const channels = Object.keys(subscriptions).map(s => ({
      name: s,
      product_ids: subscriptions[s].map(sId => (sId.productId))
    })) as WebSocketChannel[]

    // connection already open
    if (this.connection?.OPEN) {

      // subscribe
      this.client.ws.subscribe(channels)

    } else {
      // on open, subscribe
      this.client.ws.on(WebSocketEvent.ON_OPEN, () => {
        console.log('ON_OPEN')
        this.client.ws.subscribe(channels)
      })

      // on error
      this.client.ws.on(WebSocketEvent.ON_ERROR, (e) => {
        console.log('ON_ERROR', e)
        throw new Error(e.message);
      })
      this.client.ws.on(WebSocketEvent.ON_MESSAGE_ERROR, (e) => {
        console.log('ON_MESSAGE_ERROR', e)
        throw new Error(e.message);
      })

      // changes to subscriptions
      this.client.ws.on(WebSocketEvent.ON_SUBSCRIPTION_UPDATE, subscriptions => {
        console.log('ON_SUBSCRIPTION_UPDATE', JSON.stringify(subscriptions))
        // disconnect if no more subscriptions?
        if (subscriptions.channels.length === 0) {
          this.client.ws.disconnect()
        }
        this.channels = subscriptions.channels
      })

      // open connection
      this.connection = this.client.ws.connect({
        // debug: true
      })
    }
  }

  /**
   * Unsubscribe from channels
   * 
   * @param subscriptions 
   */
  public unsubscribe(subscriptions: BookSubscriptionMap) {
    const channels = Object.keys(subscriptions).map(s => ({
      name: s,
      product_ids: subscriptions[s].map(sId => (sId.productId))
    })) as WebSocketChannel[]
    console.log(channels)
    this.client.ws.unsubscribe(channels)
  }

  /**
   * Synchronize a product 
   * orderbook in memory
   * 
   * @param productId 
   * @param callback 
   */
  public syncBook(
    productId: string, 
    callback: (productId: string, bestBid: number[], bestAsk: number[]) => void
  ): void {
    if (!this.bids[productId]) {
      this.bids[productId] = new RBTree(
        (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
      )
    }

    if (!this.asks[productId]) {
      this.asks[productId] = new RBTree(
        (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
      )
    }

    // watch the book
    this.subscribe({
      [WebSocketChannelName.LEVEL2]: [{
        productId,
        handler: (message: WebSocketResponse) => {
          const productId = (message as any).product_id

          // handle snapshot
          if (message.type === WebSocketResponseType.LEVEL2_SNAPSHOT) {
            for (let b = 0; b < (message as any).bids.length; b++) {
              this.bids[productId].insert((message as any).bids[b])
            }
            for (let a = 0; a < (message as any).asks.length; a++) {
              this.asks[productId].insert((message as any).asks[a])
            }
          }

          // handle update
          if (message.type === WebSocketResponseType.LEVEL2_UPDATE) {
            for (let c = 0; c < (message as any).changes.length; c++) {
              const change = (message as any).changes[c]
              if (change[0] === 'buy') {
                const bid = this.bids[productId].find([change[1], change[2]])
                if (bid) {
                  if (bn(change[2]).eq(0)) {
                    this.bids[productId].remove([change[1], change[2]])
                  } else {
                    this.bids[productId].insert([change[1], change[2]])
                  }
                } else {
                  this.bids[productId].insert([change[1], change[2]])
                }
              }
              if (change[0] === 'sell') {
                const ask = this.asks[productId].find([change[1], change[2]])
                if (ask) {
                  if (bn(change[2]).eq(0)) {
                    this.asks[productId].remove([change[1], change[2]])
                  } else {
                    this.asks[productId].insert([change[1], change[2]])
                  }
                } else {
                  this.asks[productId].insert([change[1], change[2]])
                }
              }
            }
          }

          // return best bid/ask
          const bestBid = this.getBestBid(productId)
          const bestAsk = this.getBestAsk(productId)
          callback(productId, bestBid, bestAsk)
        }
      }]
    })
  }

  /**
   * Get the best bid for a book
   * @param productId 
   */
  public getBestBid(productId: string){
    return this.bids[productId] ? this.bids[productId].max() : []
  }

  /**
   * Get the best ask for a book
   * @param productId 
   */
  public getBestAsk(productId: string){
    return this.asks[productId] ? this.asks[productId].min() : []
  }

}

export {
  WebSocketChannelName,
  WebSocketResponse,
  WebSocketTickerMessage,
  WebSocketResponseType
}