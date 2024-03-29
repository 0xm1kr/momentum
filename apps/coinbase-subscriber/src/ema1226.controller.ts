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
export class EMA1226Controller {
    constructor(
        @Inject('MOMENTUM_SERVICE') private readonly momentum: ClientProxy,
        private readonly redisSvc: RedisService,
        private readonly cbService: CoinbaseService
    ) { }

    private MARGIN = 0.005
    private FEE = 0.0025

    private redis: Redis
    private redlock: Redlock
    private activePairs: ActivePairs = {}

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
                this._start({
                    ...params as AlgorithmEvent,
                    // do not pass initial params lastTrade again
                    lastTrade: null
                })
            }
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

    @EventPattern('update:coinbase')
    async handleUpdate(data: SubscriptionUpdateEvent) {
        if (!this.activePairs[data.pair]) return

        try {
            // get a lock 
            const lock = await this.redlock.lock(`lock:ema1226:coinbase:${data.pair}`, 30000)
            if (!lock) return

            // get last trade
            const lastTrade = (await this.redis.hgetall(`trade:coinbase:ema1226:${data.pair}`) as unknown) as TradeEvent
            const pendingOrder = (await this.redis.hgetall(`pending:coinbase:ema1226:${data.pair}`) as unknown) as Order

            // check pending logic
            const order = data.orders[pendingOrder.id] as Order
            if (order) {
                await this._handlePendingOrder(order, lastTrade)
                await lock.unlock()
                return
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
                    const curFee = bn(bestAsk[0]).times(this.FEE)
                    const reqPrice = lastTotal.plus(curFee)
                    console.log('Required sell price:', reqPrice.toString())
                    if (lastTrade?.side === 'buy' && reqPrice.lte(bestAsk[0])) {
                        // place an order
                        const placedOrder = await this.cbService.limitOrder(data.pair, {
                            size: this.activePairs[data.pair].size,
                            side: OrderSide.SELL,
                            price: bestAsk[0],
                            timeInForce: TimeInForce.GOOD_TILL_TIME,
                            cancelAfter: CancelOrderPeriod.ONE_MINUTE
                        })
                        await this.redis.hmset(`pending:coinbase:ema1226:${placedOrder.product_id}`, placedOrder as any)
                        console.log(`Sell order placed`, placedOrder)
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
                    // NOTE: "long" (only make up for fee)
                    const reqPrice = bn(lastSellPrice).minus((bn(lastSellPrice).times(this.FEE)))
                    // const curFee = bn(bestAsk[0]).times(this.FEE)
                    // const reqPrice = lastTotal.minus(curFee)

                    console.log('Required buy price', reqPrice.toString())
                    if ((lastTrade?.side === 'sell' && bn(reqPrice).gte(bestBid[0]))) {
                        // place an order
                        const placedOrder = await this.cbService.limitOrder(data.pair, {
                            size: this.activePairs[data.pair].size,
                            side: OrderSide.BUY,
                            price: bestBid[0],
                            timeInForce: TimeInForce.GOOD_TILL_TIME,
                            cancelAfter: CancelOrderPeriod.ONE_MINUTE
                        })
                        await this.redis.hmset(`pending:coinbase:ema1226:${placedOrder.product_id}`, placedOrder as any)
                        console.log(`Buy order placed`, placedOrder)
                    }
                }
            }

            // release lock
            await lock.unlock()

        } catch (err) {
            console.log(err.message)
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

    /**
     * Handle a completed order
     * 
     * @param pair
     * @param order 
     */
    private async _handlePendingOrder(order: Order, lastTrade?: TradeEvent) {

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
                    time: new Date(order.done_at).getTime()
                }
                trade.delta = this._getTradeDelta(trade, lastTrade)

                // TODO array?
                await this.redis.hmset(`trade:coinbase:ema1226:${order.product_id}`, trade as any)
                await this.redis.del(`pending:coinbase:ema1226:${order.product_id}`)
                this.momentum.emit('trade:coinbase', trade)
                console.log('Coinbase trade!', trade)
            }

            // partially filled but done (cancel/expire)
            if ((order as any).done_reason === 'canceled') {
                if (bn(order.filled_size).eq(0)) {
                    await this.redis.del(`pending:coinbase:ema1226:${order.product_id}`)
                } else {
                    console.log('Partial fill!!', order)
                }
            }
            
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
     * 
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

        // init with algo data
        if (data.lastTrade) {
            const lt = data.lastTrade.split(',')
            const order = {
                pair: data.pair,
                side: lt[0],
                size: data.size,
                price: lt[1],
                time: Number(lt[2]) || new Date().getTime(),
                delta: '0',
                exchange: 'coinbase',
                id: ''
            }

            // persist last trade
            // NOTE: overwrites last trade!
            await this.redis.hmset(`trade:coinbase:ema1226:${data.pair}`, order)
        }

        // get last trade
        const lastTrade = (await this.redis.hgetall(`trade:coinbase:ema1226:${data.pair}`) as unknown) as TradeEvent
        const pendingOrder = (await this.redis.hgetall(`pending:coinbase:ema1226:${data.pair}`) as unknown) as Order

        // handle potential incomplete pending order
        if (pendingOrder?.id) {
            const order = await this.cbService.getOrder(pendingOrder.id)
            if (order) {
                await this._handlePendingOrder(order, lastTrade)
            }
        }

        // log info
        console.log(`COINBASE EMA 12 / 26: ${startTime.toISOString()}`, this.activePairs[data.pair], lastTrade)

        // backfill price data
        const period = ClockInterval[data.period]
        const candles = await this.cbService.getCandles(data.pair, period / 1000)
        this.activePairs[data.pair].pricePeriods = candles.map(c => (c.close))
    }
}
