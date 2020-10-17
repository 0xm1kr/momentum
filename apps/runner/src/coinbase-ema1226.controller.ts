import { Controller, Inject } from '@nestjs/common'
import { ClientProxy, EventPattern } from '@nestjs/microservices'
import { RedisService } from 'nestjs-redis'
import { Redis } from 'ioredis'
import { ema } from 'moving-averages'
import { CancelOrderPeriod, Order, OrderSide, TimeInForce } from 'coinbase-pro-node'
import bn from 'big.js'
import * as Redlock from 'redlock'

import { AlgorithmEvent, SubscriptionUpdateEvent, ClockEvent, ClockInterval, ClockIntervalText, EMAEvent, TradeEvent } from '@momentum/events'
import { CoinbaseService } from '@momentum/coinbase-client'

export type AlgorithmData = {
    pair: string
    startTime: number
    period: ClockIntervalText
    pricePeriods: number[]
    ema12: number[]
    ema26: number[]
    size: string
}

export type ActivePairs = Record<string, AlgorithmData>

@Controller()
export class CoinbaseEMA1226Controller {
    constructor(
        @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
        private readonly redisSvc: RedisService,
        private readonly cbService: CoinbaseService
    ) { }

    private MARGIN = 0.006
    private redis: Redis
    private redlock: Redlock
    private activePairs: ActivePairs = {}

    private pendingOrderResolver!: (value: Order) => void
    private pendingOrder!: Order

    async onApplicationBootstrap() {
        // connect to store
        this.redis = this.redisSvc.getClient('momentum-state')

        // set up redis lock
        this.redlock = new Redlock([this.redis], { retryCount: 0 })

        // check for running algos
        const algos = await this.redis.keys('algorithms:ema1226:coinbase:*')
        if (algos.length) {
            for (const a of algos) {
                const params = await this.redis.hgetall(a) as unknown
                console.log('params', params)
                const lastTrade = await this.redis.hgetall(`trade:coinbase:ema1226:${(params as AlgorithmEvent).pair}`)
                console.log('lastTrade', lastTrade)
                this._start({
                    ...params as AlgorithmEvent,
                    lastTrade: Object.keys(lastTrade).length
                        ? `${lastTrade.side},${lastTrade.price},${lastTrade.time}`
                        : (params as AlgorithmEvent).lastTrade
                })
            }
        }
    }

    @EventPattern('update:coinbase')
    async handleUpdate(data: SubscriptionUpdateEvent) {
        if (!this.activePairs[data.pair]) return

        // get last trade
        const lastTrade = (await this.redis.hgetall(`trade:coinbase:ema1226:${data.pair}`) as unknown) as TradeEvent
        
        // check for pending order updates
        const order = (data.orders[this.pendingOrder?.id] as Order)
        if (order) {
            await this._checkPendingOrder(order, lastTrade)
        }

        // perform algo logic
        if (this.activePairs[data.pair].ema26.length) {

            // setup data
            const bestAsk = data.bestAsk
            const bestBid = data.bestBid
            const ema12 = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
            const ema26 = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
            const ema12Slope = bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 1])
                .minus(bn(this.activePairs[data.pair].ema12[this.activePairs[data.pair].ema12.length - 2]))
            const ema26Slope = bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 1])
                .minus(bn(this.activePairs[data.pair].ema26[this.activePairs[data.pair].ema26.length - 2]))

            // log data
            console.log('-------------------------')
            console.log('-----', data.pair, '-----')
            console.log(`bestAsk ${data.bestAsk}`)
            console.log(`bestBid ${data.bestBid}`)
            console.log(`ema12 ${ema12}, ${ema12Slope}`)
            console.log(`ema26 ${ema26}, ${ema26Slope}`)
            console.log('-------------------------')

            // TODO auto calc available depth and fee

            // if the ema12 < ema26 
            // and the price is > last buy+fee
            // == short position (sell)
            if (bn(ema12).lt(ema26)
                && ema12Slope.lt(0)
                && ema26Slope.lt(0)
                && (lastTrade?.side !== 'sell')
            ) {
                const lastBuyPrice = lastTrade?.price || 0
                const lastTotal = bn(lastBuyPrice).plus((bn(lastBuyPrice).times(this.MARGIN)))
                const curFee = bn(bestAsk[0]).times(0.001)
                const reqPrice = lastTotal.plus(curFee)
                console.log('required sell price:', reqPrice.toString())
                if (lastTrade?.side === 'buy' && reqPrice.lt(bestAsk[0])) {

                    // get a lock 
                    let lock: Redlock.Lock
                    try {
                        lock = await this.redlock.lock(`lock:ema1226:alpaca:${data.pair}`, 61000)
                    } catch(err){
                        console.log(`algorithms:ema1226:coinbase:${data.pair} locked...`)
                        return
                    }

                    // place an order
                    try {
                        const completeOrder = await this._placeOrder({
                            pair: data.pair,
                            size: this.activePairs[data.pair].size,
                            side: OrderSide.SELL,
                            price: bestAsk[0],
                            time: new Date().getTime(),
                            // TODO partial fills?
                            timeInForce: TimeInForce.GOOD_TILL_TIME,
                            cancelAfter: CancelOrderPeriod.ONE_MINUTE
                        })
                        console.log('Coinbase sell order', completeOrder)
                    } catch(err) {
                        console.error(err)
                    }

                    // release lock
                    await lock.unlock()

                }
            }

            // if the ema12 > ema26
            // and the price is < last sell-fee
            // == long position (buy)
            if (bn(ema12).gt(ema26)
                && ema12Slope.gt(0)
                && ema26Slope.gt(0)
                && (lastTrade?.side !== 'buy')
            ) {
                const lastSellPrice = lastTrade?.price || 0
                const lastTotal = bn(lastSellPrice).minus((bn(lastSellPrice).times(this.MARGIN)))
                const curFee = bn(bestBid[0]).times(0.001)
                const reqPrice = lastTotal.minus(curFee)

                console.log('required buy price', reqPrice.toString())
                if ((lastTrade?.side === 'sell' && bn(reqPrice).gt(bestBid[0]))) {
                    // get a lock 
                    let lock: Redlock.Lock
                    try {
                        lock = await this.redlock.lock(`lock:ema1226:alpaca:${data.pair}`, 60000)
                    } catch(err){
                        console.log(`algorithms:ema1226:coinbase:${data.pair} locked...`)
                        return
                    }

                    // place an order
                    try {
                        const completeOrder = await this._placeOrder({
                            pair: data.pair,
                            size: this.activePairs[data.pair].size,
                            side: OrderSide.BUY,
                            price: bestBid[0],
                            time: new Date().getTime(),
                            // TODO partial fills?
                            timeInForce: TimeInForce.GOOD_TILL_TIME,
                            cancelAfter: CancelOrderPeriod.ONE_MINUTE
                        })
                        console.log('Coinbase buy order', completeOrder)
                    } catch(err) {
                        console.error(err)
                    }

                    // release lock
                    await lock.unlock()

                }
            }
        }
    }

    @EventPattern('clock:1m:coinbase')
    async handleOneMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '1m') {
            this._calcMovingAvg(data, ClockIntervalText.OneMinute)
        }
    }

    @EventPattern('clock:5m:coinbase')
    async handleFiveMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '5m') {
            this._calcMovingAvg(data, ClockIntervalText.FiveMinute)
        }
    }

    @EventPattern('clock:15m:coinbase')
    async handleFifteenMin(data: ClockEvent): Promise<void> {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period === '15m') {
            this._calcMovingAvg(data, ClockIntervalText.FifteenMinute)
        }
    }

    @EventPattern('start:ema1226:coinbase')
    async handleStart(data: AlgorithmEvent) {
        // persist config
        await this.redis.hmset(`algorithms:ema1226:coinbase:${data.pair}`, { ...data })
        // start
        await this._start(data)
    }

    @EventPattern('stop:ema1226:coinbase')
    async handleStop(data: AlgorithmEvent) {
        console.log('stopping', data.pair)
        delete this.activePairs[data.pair]
        await this.redis.del(`algorithms:ema1226:coinbase:${data.pair}`)
    }

    /**
     * Start running an algo
     * 
     * @param data 
     * @param restart 
     */
    private async _start(data: AlgorithmEvent) {
        const startTime = new Date()

        // set active
        this.activePairs[data.pair] = {
            pair: data.pair,
            startTime: startTime.getTime(),
            period: data.period,
            size: data.size,
            pricePeriods: [],
            ema12: [],
            ema26: [],
        }

        // init with previous trade
        if (data.lastTrade) {
            const lt = data.lastTrade.split(',')
            const order = {
                pair: data.pair,
                side: lt[0],
                size: data.size,
                price: lt[1],
                time: Number(lt[2]) || new Date().getTime(),
                delta: '0',
                exchange: 'coinbase'
            }

            // persist last trade
            // NOTE: overwrites last trade!
            await this.redis.hmset(`trade:coinbase:ema1226:${data.pair}`, order)
        }

        // log info
        console.log(`COINBASE EMA 12 / 26: ${startTime.toISOString()}`, JSON.stringify(this.activePairs[data.pair], null, 2))

        // backfill price data
        const period = ClockInterval[data.period]
        const candles = await this.cbService.getCandles(data.pair, period / 1000)
        this.activePairs[data.pair].pricePeriods = candles.map(c => (c.close))
    }

    /**
     * Place an order
     * 
     * @param order 
     */
    private async _placeOrder(order: any) {
        return new Promise<Order>((resolve, reject) => {
            this.pendingOrderResolver = resolve
            this.cbService.limitOrder(order.pair, order)
                .then(o => (this.pendingOrder = o))
                .catch(err => (reject(err)))
        })
    }

    /**
     * Handle change to a placed order
     * 
     * @param pair
     * @param order 
     */
    private async _checkPendingOrder(order: Order, lastTrade?: TradeEvent) {

        console.log('CHECK ORDER', order)

        if (order.status === 'done') {

            // store / set trade
            if (order.done_reason === 'filled') {

                const trade: TradeEvent = {
                    id: order.id,
                    pair: order.product_id,
                    exchange: 'coinbase',
                    size: order.filled_size,
                    price: order.price,
                    side: order.side,
                    delta: '0',
                    time: new Date(order.created_at).getTime()
                }
                trade.delta = this._getTradeDelta(trade, lastTrade)

                // TODO array?
                await this.redis.hmset(`trade:coinbase:ema1226:${order.product_id}`, trade as any)
                this.momentum.emit('trade:coinbase', trade)
            }

            // partially filled but done (cancel/expire)
            // TODO 

            // clear pending order
            this.pendingOrderResolver(order)
            this.pendingOrderResolver = null
            this.pendingOrder = null
        }
        
    }

    /**
     * Calc delta from last trade
     * 
     * @param trade 
     * @param lastTrade 
     */
    private _getTradeDelta(trade: TradeEvent, lastTrade: TradeEvent) {
        let delta = '0'
        const active = this.activePairs[trade.pair]
        if (trade.side === 'sell' && lastTrade) {
            const diff = bn(trade.price).minus(lastTrade.price)
            delta = diff.times(active.size).toString()
        }
        if (trade.side === 'buy' && lastTrade) {
            const diff = bn(lastTrade.price).minus(trade.price)
            delta = diff.times(active.size).toString()
        }
        return delta
    }

    /**
     * Calculate moving avg
     * @param data 
     */
    private _calcMovingAvg(data: ClockEvent, period: ClockIntervalText) {
        if (!this.activePairs[data.pair]) return
        if (this.activePairs[data.pair].period !== period) return
        if (!data.avgTradePrice) return

        // --- calculate moving averages ---
        const p = ClockInterval[period]
        const tPeriods = Math.round((new Date().getTime() - this.activePairs[data.pair].startTime) / p)
        console.log(`calculating period: ${tPeriods}`)

        // prices
        this.activePairs[data.pair].pricePeriods.push(Number(data.avgTradePrice))

        // calculate moving averages
        if (this.activePairs[data.pair].pricePeriods.length >= 12) {
            this.activePairs[data.pair].ema12 = ema(this.activePairs[data.pair].pricePeriods, 12)

            // emit for analysis
            const length = this.activePairs[data.pair].ema12.length
            this.momentum.emit('ema:coinbase', new EMAEvent(
                'coinbase',
                data.pair,
                12,
                this.activePairs[data.pair].ema12[length - 1],
                new Date().getTime()
            ))

            // shift one off
            this.activePairs[data.pair].pricePeriods.shift()
        }
        if (this.activePairs[data.pair].pricePeriods.length >= 26) {
            this.activePairs[data.pair].ema26 = ema(this.activePairs[data.pair].pricePeriods, 26)

            // emit for analysis
            const length = this.activePairs[data.pair].ema26.length
            this.momentum.emit('ema:coinbase', new EMAEvent(
                'coinbase',
                data.pair,
                26,
                this.activePairs[data.pair].ema26[length - 1],
                new Date().getTime()
            ))
        }
    }
}
