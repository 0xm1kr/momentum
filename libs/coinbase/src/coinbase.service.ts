import { Injectable } from '@nestjs/common'
import {
  CoinbasePro,
  Account,
  WebSocketClient,
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
import { Observable, Observer } from 'rxjs'
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

export {
  Observable,
  WebSocketEvent,
  WebSocketChannelName,
  WebSocketResponse,
  WebSocketTickerMessage,
  WebSocketResponseType
}

export type Subscription = {
  productId: string,
  handler?: (message: WebSocketResponse | WebSocketTickerMessage) => void
}

export type CoinbaseSubscriptions = {
  [key in WebSocketChannelName]?: Subscription[]
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

  protected _client!: CoinbasePro
  protected _wsClient!: ReconnectingWebSocket
  protected _channels: WebSocketChannel[] = []
  protected _subscriptionMap: Observable<CoinbaseSubscriptions>
  protected _subscriptionMapObserver: Observer<CoinbaseSubscriptions>
  protected _bids: Record<string, RBTree<string[]>> = {}
  protected _asks: Record<string, RBTree<string[]>> = {}

  constructor() {
    this._client = new CoinbasePro({
      apiKey: process.env.CBP_KEY,
      apiSecret: process.env.CBP_SECRET,
      passphrase: process.env.CBP_PASSPHRASE,
      useSandbox: (process.env.ENVIRONMENT !== 'LIVE')
    })
  }

  public get subscriptions(): Promise<Observable<CoinbaseSubscriptions>> {
    if (this._subscriptionMap) {
      return Promise.resolve(this._subscriptionMap)
    }
    return this._createSubscriptionObserver()
  }

  public get connection(): Promise<WebSocketClient> {
    if (this._wsClient?.OPEN) {
      return Promise.resolve(this._client.ws)
    }
    return this._connect()
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

    return this._client.rest.order.placeOrder(o)
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
    return this._client.rest.order.placeOrder(o)
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
    const feeTier = await this._client.rest.fee.getCurrentFees()
    return FeeUtil.estimateFee(params.size, params.price, params.side, params.type, feeTier, quote)
  }

  /**
   * get accounts
   */
  public async getAccounts(): Promise<Account[]> {
    return this._client.rest.account.listAccounts()
  }

  /**
   * getBook
   * 
   * @param productId 
   */
  public async getBook(productId = 'BTC-USD'): Promise<OrderBookLevel2> {
    return this._client.rest.product.getProductOrderBook(productId, {
      level: OrderBookLevel.TOP_50_BIDS_AND_ASKS
    })
  }

  /**
   * getBook
   * 
   * @param productId 
   */
  public async getCandles(productId = 'BTC-USD', granularity: CandleGranularity): Promise<Candle[]> {
    return this._client.rest.product.getCandles(productId, {
      granularity
    })
  }

  /**
   * subscribe to websocket channels
   * 
   * @param subscriptions 
   */
  public async subscribe(subscriptions: CoinbaseSubscriptions): Promise<Observable<CoinbaseSubscriptions>> {

    // connect
    const conn = await this.connection

    // TODO prevent duplicate subscriptions?

    // setup l2 message handlers
    if (subscriptions[WebSocketChannelName.LEVEL2]) {
      conn.on(WebSocketEvent.ON_MESSAGE, (m: WebSocketResponse) => {
        const subs = subscriptions[WebSocketChannelName.LEVEL2].filter((val => val.productId === (m as any).product_id))
        if (subs.length) {
          subs.forEach((s) => s.handler(m))
        }
      })
    }

    // ticker handlers
    if (subscriptions[WebSocketChannelName.TICKER]) {
      conn.on(WebSocketEvent.ON_MESSAGE_TICKER, (m: WebSocketTickerMessage) => {
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

    // subscribe
    conn.subscribe(channels)

    return this._subscriptionMap
  }

  /**
   * Unsubscribe from channels
   * 
   * @param subscriptions 
   */
  public unsubscribe(subscriptions: CoinbaseSubscriptions) {
    const channels = Object.keys(subscriptions).map(s => ({
      name: s,
      product_ids: subscriptions[s].map(sId => (sId.productId))
    })) as WebSocketChannel[]
    this._client.ws.unsubscribe(channels)
  }

  /**
   * Synchronize a product 
   * orderbook in memory
   * 
   * @param productId
   */
  public syncBook(productId: string): void {
    if (!this._bids[productId]) {
      this._bids[productId] = new RBTree(
        (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
      )
    }

    if (!this._asks[productId]) {
      this._asks[productId] = new RBTree(
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
              this._bids[productId].insert((message as any).bids[b])
            }
            for (let a = 0; a < (message as any).asks.length; a++) {
              this._asks[productId].insert((message as any).asks[a])
            }
          }

          // handle update
          if (message.type === WebSocketResponseType.LEVEL2_UPDATE) {
            for (let c = 0; c < (message as any).changes.length; c++) {
              const change = (message as any).changes[c]
              if (change[0] === 'buy') {
                const bid = this._bids[productId].find([change[1], change[2]])
                if (bid) {
                  if (bn(change[2]).eq(0)) {
                    this._bids[productId].remove([change[1], change[2]])
                  } else {
                    this._bids[productId].insert([change[1], change[2]])
                  }
                } else {
                  this._bids[productId].insert([change[1], change[2]])
                }
              }
              if (change[0] === 'sell') {
                const ask = this._asks[productId].find([change[1], change[2]])
                if (ask) {
                  if (bn(change[2]).eq(0)) {
                    this._asks[productId].remove([change[1], change[2]])
                  } else {
                    this._asks[productId].insert([change[1], change[2]])
                  }
                } else {
                  this._asks[productId].insert([change[1], change[2]])
                }
              }
            }
          }
        }
      }]
    })
  }

  /**
   * Get the best bid for a book
   * @param productId 
   */
  public getBestBid(productId: string) {
    return this._bids[productId] ? this._bids[productId].max() : []
  }

  /**
   * Get the best ask for a book
   * @param productId 
   */
  public getBestAsk(productId: string) {
    return this._asks[productId] ? this._asks[productId].min() : []
  }

  // ----- internal methods --------

  /**
   * Connect to Coinbase Websocket
   */
  protected async _connect(): Promise<WebSocketClient> {
    return new Promise((res, rej) => {
      // on open
      this._client.ws.on(WebSocketEvent.ON_OPEN, () => {
        res(this._client.ws)
      })

      // on error
      this._client.ws.on(WebSocketEvent.ON_ERROR, (e) => {
        rej(e)
      })

      // connect
      this._wsClient = this._client.ws.connect()
    })
  }

  /**
   * Create a subscription observable
   */
  protected async _createSubscriptionObserver(): Promise<Observable<CoinbaseSubscriptions>> {

    // get coinbase socket connection
    const conn = await this.connection

    // setup observable
    this._subscriptionMap = new Observable<CoinbaseSubscriptions>(subject => {
      this._subscriptionMapObserver = subject 

      // watch changes to subscriptions
      conn.on(WebSocketEvent.ON_SUBSCRIPTION_UPDATE, subscriptions => {

        // disconnect if no more subscriptions
        if (subscriptions.channels.length === 0) {
          subject.complete()
          conn.disconnect()
        }
        // set active channels
        this._channels = subscriptions.channels

        // map back to CoinbaseSubscriptions
        const sMap = {}
        for (const c of subscriptions.channels) {
          if (typeof sMap[c.name] === 'undefined') {
            sMap[c.name] = []
          }
          sMap[c.name] = c.product_ids.map((p: string) => ({ productId: p }))
        }
        subject.next(sMap)
      })

      // on message error
      conn.on(WebSocketEvent.ON_MESSAGE_ERROR, (e) => {
        console.log('ON_MESSAGE_ERROR', e)
        // TODO 
        subject.error(e)
      })
    })

    return this._subscriptionMap
  }
}
