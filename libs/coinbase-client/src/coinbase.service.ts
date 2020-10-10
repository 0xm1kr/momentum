import { Injectable } from '@nestjs/common'
import {
  CoinbasePro,
  Account,
  WebSocketClient,
  WebSocketEvent,
  WebSocketChannelName,
  WebSocketResponse,
  WebSocketTickerMessage,
  WebSocketChannel,
  WebSocketResponseType,
  OrderBookLevel2,
  WebSocketMatchMessage,
  OrderBookLevel,
  LimitOrder,
  OrderSide,
  OrderStatus,
  Order,
  OrderType,
  FeeUtil,
  FeeEstimate,
  CandleGranularity,
  Candle, WebSocketSubscription, WebSocketErrorMessage, TimeInForce, FilledOrder
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

// bid/ask orderbook RedBlack trees
export type Book = {
  bids: Record<string, RBTree<string[]>>
  asks: Record<string, RBTree<string[]>>
}

// order map indexed by orderId
export type Orders = Record<string, Order>

export type CoinbaseSubscription = {
  productId: string
  connected: string[]
  unsubscribe?: () => void
  book: Book
  orders?: Orders
  ticker?: WebSocketTickerMessage
  lastUpdate?: number // unix time
  lastUpdateProperty?: string // which property was updated
}

export type CoinbaseSubscriptions = Record<string, Observable<CoinbaseSubscription>>

@Injectable()
export class CoinbaseService {
  
  protected _heartbeatTimeout = 30000
  protected _client!: CoinbasePro
  protected _wsClient!: ReconnectingWebSocket
  protected _heartbeat!: NodeJS.Timeout
  protected _lastHeartBeat: number = null
  protected _channels: WebSocketChannel[] = []
  protected _observableSubscriptions: CoinbaseSubscriptions = {}
  protected _subscriptionMap: Record<string, CoinbaseSubscription> = {}
  protected _subscriptionObservers: Record<string, Observer<CoinbaseSubscription>> = {}

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
   * place an order
   * 
   * @param productId 
   * @param params
   * @param awaitOrder
   */
  public async placeOrder(
    productId: string, 
    params: {
      size: string // amount in base token
      side: OrderSide
      price: string
      timeInForce?: TimeInForce 
      stop?: 'loss' | 'entry'
      stopPrice?: string,
    },
    awaitOrder?: boolean
  ): Promise<Order> {

    // TODO other order types?
    const o: LimitOrder = {
      type: OrderType.LIMIT,
      product_id: productId,
      side: params.side,
      size: params.size,
      price: params.price,
      time_in_force: params.timeInForce || TimeInForce.GOOD_TILL_CANCELED
    }

    // create stop order
    if (params.stop) {
      o.stop = params.stop
      if (!params.stopPrice) throw new Error(`stopPrice is required for a stop ${params.stop} order`)
      o.stop_price = params.stopPrice
    }

    // place order
    const placedOrder = await this._client.rest.order.placeOrder(o)

    // if awaitOrder, wait for
    // order to fill or fail
    if (awaitOrder) {
      return this.awaitOrder(placedOrder)
    }

    return placedOrder    
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
   * Get an order
   * 
   * @param orderId 
   */
  public async getOrder(orderId: string): Promise<Order> {
    return this._client.rest.order.getOrder(orderId)
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
    conn.subscribe([{ 
      name: WebSocketChannelName.TICKER,
      product_ids: [productId]
    },
    { 
      name: WebSocketChannelName.LEVEL2,
      product_ids: [productId]
    },
    { 
      name: WebSocketChannelName.USER,
      product_ids: [productId]
    }])
    
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
      delete this._subscriptionObservers[productId]
    } catch(err) {
      console.warn(err)
    }

    return true
  }

  /**
   * Await an order
   * 
   * @param order 
   */
  public async awaitOrder(order: Order): Promise<Order> {

    if (!this._observableSubscriptions[order.product_id]) {
      return Promise.reject(`Not subscribed to ${order.product_id}`)
    }
    
    return new Promise((res, rej) => {
      this._observableSubscriptions[order.product_id].subscribe(sub => {
        if (sub.lastUpdateProperty === 'orders') {
          const o = this._subscriptionMap[order.product_id].orders[order.id]

          if (!o) {
            return rej(`Unable to listen to order ${order.id}`)
          }

          if (o.status === 'done') {
            // TODO reject if "done reason" isn't filled?
            return res(o)
          }
        }
      })
    })
  }

  // ----- internal methods --------

  /**
   * Connect to Coinbase Websocket
   */
  protected async _connect(): Promise<WebSocketClient> {
    let resolved = false
    return new Promise((res, rej) => {
      // on open
      this._client.ws.on(WebSocketEvent.ON_OPEN, () => {
        console.log('Coinbase connection established')
        console.log('Coinbase active subscriptions:', Object.keys(this.subscriptions))

        // init heartbeat
        this._handleHeartBeat()

        // resolve
        if (!resolved) {
          resolved = true
          res(this._client.ws)
        }
      })

      // on close
      this._client.ws.on(WebSocketEvent.ON_CLOSE, () => {
        console.log('Coinbase connection closed!')
        console.log('Coinbase active subscriptions:', Object.keys(this.subscriptions))
        if (this._heartbeat) {
          clearTimeout(this._heartbeat)
        }
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
        this._handleSubscriptionMessage.bind(this)
      )

      // connect
      try {
          this._wsClient = this._client.ws.connect()

          // implement custom heartbeat while waiting for:
          // https://github.com/pladaria/reconnecting-websocket/issues/98
          this._wsClient.removeEventListener('message', this._handleHeartBeatMessage)
          this._wsClient.addEventListener('message', this._handleHeartBeatMessage.bind(this))
      } catch(err) {
        console.error('Coinbase wsClient connection failed')
        rej(err)
      }
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
      },
      orders: {}
    }
       
    // setup observable
    const subscription = new Observable<CoinbaseSubscription>(subject => {
      this._subscriptionObservers[productId] = subject

      // setup unsubscribe function
      this._subscriptionMap[productId].unsubscribe = function unsubscribe() {
        conn.unsubscribe([{ 
          name: WebSocketChannelName.TICKER,
          product_ids: [productId]
        },
        { 
          name: WebSocketChannelName.LEVEL2,
          product_ids: [productId]
        },
        {
          name: WebSocketChannelName.USER,
          product_ids: [productId]
        }])
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
    if (Object.keys(this._subscriptionMap)?.length) {
      // set subscription connected flag
      for(const c of subscriptions.channels) {
        for(const p of c.product_ids) {
          if (!this._subscriptionMap[p].connected.includes(c.name)) {
            this._subscriptionMap[p].connected.push(c.name)
          }
          if (!this._subscriptionObservers[p]) {
            this._observableSubscriptions[p] = await this._createSubscriptionObserver(p)
          }
          this._subscriptionObservers[p].next(this._subscriptionMap[p])
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
    // this._subscriptionObservers[].error(error)
    // delete this._subscriptionMap[productId]
    console.error('Coinbase subscription error', error)
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
    this._subscriptionObservers[productId].next(this._subscriptionMap[productId])
  }

  /**
   * Handle all Websocket Responses
   * 
   * @param message 
   */
  protected _handleSubscriptionMessage(
    message: WebSocketResponse
  ) {
    const productId = (message as any).product_id

    // event fired after unsubscribe
    if (!this._subscriptionMap?.[productId]) return

    // handle book updates
    if (message.type === WebSocketResponseType.LEVEL2_UPDATE 
      || message.type === WebSocketResponseType.LEVEL2_SNAPSHOT) {
      this._handleSubscriptionBookMessage(message)
    }

    // handle order updates
    if (message.type === WebSocketResponseType.FULL_OPEN
      || message.type === WebSocketResponseType.LAST_MATCH 
      || message.type === WebSocketResponseType.FULL_DONE) {
      this._handleSubscriptionOrderMessage(message)
    }
  }

  /**
   * Handles order updates
   * 
   * @param message 
   */
  private async _handleSubscriptionOrderMessage(
    message: WebSocketResponse
  ) {
    const productId = (message as any).product_id

    // order created/placed by us (TODO validate profile_id?)
    if (message.type === WebSocketResponseType.FULL_OPEN) {
      const m = (message as any)
      const orderId = m.order_id

      if (orderId) {
        const o = await this.getOrder(orderId)
        this._subscriptionMap[productId].orders[o.id] = o        
        this._subscriptionMap[productId].lastUpdateProperty = 'orders'
        this._subscriptionMap[productId].lastUpdate = new Date().getTime()
        this._subscriptionObservers[productId].next(this._subscriptionMap[productId])
        console.log('ORDER CREATED!', this._subscriptionMap[productId])
      }
    }

    // order matches
    if (message.type === WebSocketResponseType.LAST_MATCH) {
      const m = (message as WebSocketMatchMessage)
      // const o = this._subscriptionMap[productId].orders[m.product_id]
      console.log('ORDER MATCH!', m)
      // TODO update order filled amount? maker vs. taker
    }

    // order "done" (removed from book)
    // TODO message typing?
    //   {
    //     "type": "done",
    //     "time": "2014-11-07T08:19:27.028459Z",
    //     "product_id": "BTC-USD",
    //     "sequence": 10,
    //     "price": "200.2",
    //     "order_id": "d50ec984-77a8-460a-b958-66f114b0de9b",
    //     "reason": "filled", // or "canceled"
    //     "side": "sell",
    //     "remaining_size": "0"
    // }
    if (message.type === WebSocketResponseType.FULL_DONE) {
      const m = (message as any) 
      const o = this._subscriptionMap[productId].orders[m.order_id]
      console.log(m)
      if (o) {
        // update order with filled data
        const filled = (o as FilledOrder)
        filled.done_at = m.time
        filled.done_reason = m.reason
        filled.status = OrderStatus.DONE
        filled.filled_size = bn(o.size).minus(m.remaining_size).toString()
        filled.settled = true

        this._subscriptionMap[productId].orders[o.id] = filled
        this._subscriptionMap[productId].lastUpdateProperty = 'orders'
        this._subscriptionMap[productId].lastUpdate = new Date().getTime()
        this._subscriptionObservers[productId].next(this._subscriptionMap[productId])
        console.log('ORDER DONE!', this._subscriptionMap[productId])
      }
    }
    
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
      this._subscriptionObservers[productId].next(this._subscriptionMap[productId])
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
      this._subscriptionObservers[productId].next(this._subscriptionMap[productId])
    }
  }

  /**
   * Set last message date
   */
  protected _handleHeartBeatMessage() {
    this._lastHeartBeat = new Date().getTime()
  }

  /**
   * handle heartbeat logic
   */
  protected _handleHeartBeat() {
    const activeSubs = Object.keys(this._subscriptionMap)?.length
    if (activeSubs && this._heartbeat) {
      const now = new Date().getTime()
      if ((now - this._lastHeartBeat) > this._heartbeatTimeout) {
        throw new Error('Coinbase heartbeat timed out!')
      }
      this._heartbeat = setTimeout(this._handleHeartBeat.bind(this), this._heartbeatTimeout)
    } else {
      this._heartbeat = setTimeout(this._handleHeartBeat.bind(this), this._heartbeatTimeout)
    }
  }
}
