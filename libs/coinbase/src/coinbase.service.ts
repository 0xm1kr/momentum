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
  Candle, WebSocketSubscription, WebSocketErrorMessage
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

export type Book = {
  bids: Record<string, RBTree<string[]>>
  asks: Record<string, RBTree<string[]>>
}

export type CoinbaseSubscription = {
  productId: string
  connected: string[]
  unsubscribe?: () => void
  book: Book
  ticker?: WebSocketTickerMessage
  lastUpdate?: number // unix time
  lastUpdateProperty?: string // which property was updated
}

export type CoinbaseSubscriptions = Record<string, Observable<CoinbaseSubscription>>

@Injectable()
export class CoinbaseService {

  protected _client!: CoinbasePro
  protected _wsClient!: ReconnectingWebSocket
  protected _channels: WebSocketChannel[] = []
  protected _observableSubscriptions: CoinbaseSubscriptions = {}
  protected _subscriptionMap: Record<string, CoinbaseSubscription> = {}
  protected _observers: Record<string, Observer<CoinbaseSubscription>> = {}

  constructor() {
    this._client = new CoinbasePro({
      apiKey: process.env.CBP_KEY,
      apiSecret: process.env.CBP_SECRET,
      passphrase: process.env.CBP_PASSPHRASE,
      useSandbox: (process.env.ENVIRONMENT !== 'LIVE')
    })
  }

  public get connection(): Promise<WebSocketClient> {
    if (this._wsClient?.OPEN) {
      return Promise.resolve(this._client.ws)
    }
    return this._connect()
  }

  public get subscriptions() {
    return this._observableSubscriptions
  }

  /**
   * place a limit order
   * TODO make observable via socket
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
   * Subscribe to a product
   * 
   * @param subscription 
   */
  public async subscribe(productId: string): Promise<Observable<CoinbaseSubscription>> {

    // get connection
    const conn = await this.connection

    // resubscribe or refresh?
    if (this.subscriptions[productId]) {
      return Promise.resolve(this.subscriptions[productId])
    }

    // setup observer
    this._observableSubscriptions[productId] = await this._createSubscriptionObserver(productId)

    // subscribe
    conn.subscribe({ 
      name: WebSocketChannelName.TICKER,
      product_ids: [productId]
    })
    conn.subscribe({ 
      name: WebSocketChannelName.LEVEL2,
      product_ids: [productId]
    })
    
    return this._observableSubscriptions[productId]
  }

  /**
   * Unsubscribe from a product
   * 
   * @param productId 
   */
  public async unsubscribe(productId: string) {
    if (!this._subscriptionMap?.[productId]) return

    try {
      // unsubscribe
      this._subscriptionMap[productId]?.unsubscribe()
      // remove data
      delete this._subscriptionMap[productId]
      delete this._observableSubscriptions[productId]
      delete this._observers[productId]
    } catch(err) {
      console.warn(err)
    }

    return true
  }


  // ----- internal methods --------

  /**
   * Connect to Coinbase Websocket
   */
  protected async _connect(): Promise<WebSocketClient> {
    return new Promise((res, rej) => {
      // on open
      this._client.ws.on(WebSocketEvent.ON_OPEN, () => {
        console.log('coinbase connected')
        res(this._client.ws)
      })

      // on error
      this._client.ws.on(WebSocketEvent.ON_ERROR, (e) => {
        console.error(e)
        this._wsClient = null
        rej(e)
      })

      // watch changes to subscriptions
      this._client.ws.on(
        WebSocketEvent.ON_SUBSCRIPTION_UPDATE, 
        this._handleSubscriptionUpdate.bind(this)
      )

      // on message error
      this._client.ws.on(
        WebSocketEvent.ON_MESSAGE_ERROR,
        this._handleSubscriptionError.bind(this)
      )

      // ticker message
      this._client.ws.on(
        WebSocketEvent.ON_MESSAGE_TICKER, 
        this._handleSubscriptionTickerMessage.bind(this)
      )

      // book update
      this._client.ws.on(
        WebSocketEvent.ON_MESSAGE, 
        this._handleSubscriptionBookMessage.bind(this)
      )

      // connect
      this._wsClient = this._client.ws.connect()
    })
  }

  /**
   * Create a subscription observer
   * 
   * @param productId 
   */
  protected async _createSubscriptionObserver(productId: string): Promise<Observable<CoinbaseSubscription>> {
    // connect
    const conn = await this.connection

    // init subscription
    this._subscriptionMap[productId] = {
      productId,
      connected: [],
      ticker: null,
      book: {
        bids: new RBTree(
          (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
        ),
        asks: new RBTree(
          (a, b) => (bn(a[0]).gt(bn(b[0])) ? 1 : (bn(a[0]).eq(bn(b[0])) ? 0 : -1))
        )
      }
    }
       
    // setup observable
    const subscription = new Observable<CoinbaseSubscription>(subject => {
      this._observers[productId] = subject

      // setup unsubscribe function
      this._subscriptionMap[productId].unsubscribe = function unsubscribe() {
        conn.unsubscribe({ 
          name: WebSocketChannelName.TICKER,
          product_ids: [productId]
        })
        conn.unsubscribe({ 
          name: WebSocketChannelName.LEVEL2,
          product_ids: [productId]
        })
        subject.complete()
      }
    })
    
    return subscription
  }

  /**
   * Handle a subscription update event
   * 
   * @param productId 
   * @param subject 
   * @param subscriptions 
   */
  protected async _handleSubscriptionUpdate(
    subscriptions: WebSocketSubscription
  ) {
    // disconnect if no more subscriptions
    if (subscriptions.channels.length === 0) {
      this._client.ws.disconnect()
      this._wsClient = null
    }
    if (this._subscriptionMap) {
      // set subscription connected flag
      for(const c of subscriptions.channels) {
        for(const p of c.product_ids) {
          if (!this._subscriptionMap[p].connected.includes(c.name)) {
            this._subscriptionMap[p].connected.push(c.name)
          }
          if (!this._observers[p]) {
            this._observableSubscriptions[p] = await this._createSubscriptionObserver(p)
          }
          this._observers[p].next(this._subscriptionMap[p])
        }
      }
    }
    
  }

  /**
   * Handle a subscription error message
   * 
   * @param productId 
   * @param subject 
   * @param error 
   */
  protected _handleSubscriptionError(
    error: WebSocketErrorMessage
  ) {
    // TODO
    // this._observers[].error(error)
    // delete this._subscriptionMap[productId]
    console.error(error)
  }

  /**
   * Handle a subscription ticker message
   * 
   * @param subject 
   * @param message 
   */
  protected _handleSubscriptionTickerMessage(
    message: WebSocketTickerMessage
  ) {
    const productId = message.product_id
    
    // event fired without initialized subscription?
    if (!this._subscriptionMap?.[productId]) return

    this._subscriptionMap[productId].ticker = message
    this._subscriptionMap[productId].lastUpdateProperty = 'ticker'
    this._subscriptionMap[productId].lastUpdate = new Date().getTime()
    this._observers[productId].next(this._subscriptionMap[productId])
  }

  /**
   * Handle a subscription book 
   * update (l2, l2snapshot)
   * 
   * @param subject 
   * @param message 
   */
  protected _handleSubscriptionBookMessage(
    message: WebSocketResponse
  ) {
    const productId = (message as any).product_id

    // event fired after unsubscribe
    if (!this._subscriptionMap?.[productId]) return

    // handle snapshot
    if (message.type === WebSocketResponseType.LEVEL2_SNAPSHOT) {
      for (let b = 0; b < (message as any).bids.length; b++) {
        this._subscriptionMap[productId].book.bids.insert((message as any).bids[b])
      }
      for (let a = 0; a < (message as any).asks.length; a++) {
        this._subscriptionMap[productId].book.asks.insert((message as any).asks[a])
      }
      this._subscriptionMap[productId].lastUpdateProperty = 'book'
      this._subscriptionMap[productId].lastUpdate = new Date().getTime()
      this._observers[productId].next(this._subscriptionMap[productId])
    }

    // handle update
    if (message.type === WebSocketResponseType.LEVEL2_UPDATE) {

      for (let c = 0; c < (message as any).changes.length; c++) {
        const change = (message as any).changes[c]
        if (change[0] === 'buy') {
          const bid = this._subscriptionMap[productId].book.bids.find([change[1], change[2]])
          if (bid) {
            if (bn(change[2]).eq(0)) {
              this._subscriptionMap[productId].book.bids.remove([change[1], change[2]])
            } else {
              this._subscriptionMap[productId].book.bids.insert([change[1], change[2]])
            }
          } else {
            this._subscriptionMap[productId].book.bids.insert([change[1], change[2]])
          }
        }

        if (change[0] === 'sell') {
          const ask = this._subscriptionMap[productId].book.asks.find([change[1], change[2]])
          if (ask) {
            if (bn(change[2]).eq(0)) {
              this._subscriptionMap[productId].book.asks.remove([change[1], change[2]])
            } else {
              this._subscriptionMap[productId].book.asks.insert([change[1], change[2]])
            }
          } else {
            this._subscriptionMap[productId].book.asks.insert([change[1], change[2]])
          }
        }
      }
      
      this._subscriptionMap[productId].lastUpdateProperty = 'book'
      this._subscriptionMap[productId].lastUpdate = new Date().getTime()
      this._observers[productId].next(this._subscriptionMap[productId])
    }
  }
}
