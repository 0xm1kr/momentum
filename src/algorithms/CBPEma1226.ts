import { ema } from 'moving-averages'
import { WebSocketChannelName, OrderSide } from 'coinbase-pro-node'
import { CBPService } from '../services/CBP'
import { logInfo, logFile } from '../utils/log'
import bn from 'big.js'
import * as chalk from 'chalk'

// 
// use basic ema 12/26
//

// env vars
const {
    ENVIRONMENT,
    CBP_KEY,
    CBP_SECRET,
    CBP_PASSPHRASE
} = process.env

export class CBPEma1226 {

    // moving average config
    private period!: number
    private cbp: CBPService
    private pricePeriods = []
    private ema12 = []
    private ema26 = []

    constructor(config: { 
        period: number
    } = {
        // defaults to 1 min
        period: 60 * 1000
    }) {
        this.period = config.period
        
        // init CBPService
        this.cbp = new CBPService({
            auth: {
                apiKey: CBP_KEY,
                apiSecret: CBP_SECRET,
                passphrase: CBP_PASSPHRASE,
                useSandbox: (ENVIRONMENT === 'DEV') ? true : false
            }
        })

    }

    /**
     * calculate moving average
     * 
     * @param start     start time in ms
     * @param productId product id e.g. BTC-USD
     * @param track     track twitter e.g. "#bitcoin"
     */
    private async calcMovingAverage(start: number, productId: string): Promise<void> {

        // subscribe to trades
        let priceArr = []
        this.cbp.subscribe([{
            name: WebSocketChannelName.TICKER,
            product_ids: [productId],
        }], {
            ticker: (message) => priceArr.push(Number(message.price))
        })
        
        // --- calculate moving averages ---

        setInterval(() => {
            // calculate periods
            const tPeriods = Math.round((new Date().getTime() - start) / this.period)
            logInfo(`calculating period: ${tPeriods}`)

            // prices
            if (priceArr.length) {
                this.pricePeriods.push(
                    (priceArr.reduce((sum, s) => {
                        return sum += (s || 0)
                    }) / priceArr.length)
                )
                // logInfo('Prices: ' + JSON.stringify(this.pricePeriods))
            }
            priceArr = []

            // calculate moving averages
            if (tPeriods >= 26) {
                this.ema12 = ema(this.pricePeriods, 12)
                this.ema26 = ema(this.pricePeriods, 26)
                // logInfo('price ema:')
                // logDetail(JSON.stringify(this.ema26))
            }
        }, this.period)
    }

    /**
     * run the algo
     * 
     * @param productId 
     * @param track 
     */
    async run(productId: string): Promise<void> {
        const start = new Date().getTime()
        logInfo(chalk.white(`EMA 12 / 26: ${new Date(start).toISOString()}`))

        // calculate moving averages
        this.calcMovingAverage(start, productId)

        // sync book
        this.cbp.syncBook(productId)

        // trading time
        let lastBuy: {
            price: string
            time: number
        } 
        let lastSell: {
            price: string
            time: number
        } 
        setInterval(() => {

            if (this.ema26.length) {
                const bestAsk = this.cbp.asks.min()
                const bestBid = this.cbp.bids.max()
                const ema12 = bn(this.ema12[this.ema12.length-1])
                const ema26 = bn(this.ema26[this.ema26.length-1])
                const ema12Slope = bn(this.ema12[this.ema12.length-1]).minus(bn(this.ema12[this.ema12.length-3]))
                const ema26Slope = bn(this.ema26[this.ema26.length-1]).minus(bn(this.ema26[this.ema26.length-3]))

                logInfo('-------------------------')
                logInfo(chalk.red(`best ask: ${bestAsk}`))
                logInfo(chalk.green(`best bid: ${bestBid}`))
                logInfo(chalk.white(`ema12 ${ema12}, ${ema12Slope}`))
                logInfo(chalk.white(`ema26 ${ema26}, ${ema26Slope}`))
                logInfo('-------------------------')

                // TODO calc available depth and fee
                
                // if the ema12 < ema26 
                // and the price is > last buy+fee
                // == short position (sell)
                if (bn(ema12).lt(ema26)
                    && ema12Slope.lt(0)
                    && ema26Slope.lt(0)
                    && !lastSell
                ) {
                    
                    if (!lastSell && (!lastBuy || bn(lastBuy.price).lt(bestAsk[0]))) {
                        const order = {
                            size: bestAsk[1],
                            side: OrderSide.SELL,
                            price: bestAsk[0]
                        }
                        logFile(order)
                        // this.cbp.limitOrder(productId, order)
                        lastSell = {
                            price: order.price,
                            time: new Date().getTime()
                        }
                        lastBuy = null
                    }
                }

                // if the ema12 > ema26
                // and the price is < last sell-fee
                // == long position (buy)
                if (bn(ema12).gt(ema26)
                    && ema12Slope.gt(0)
                    && ema26Slope.gt(0)
                    && !lastBuy
                ) {
                    if (!lastBuy && (!lastSell || bn(lastSell.price).gt(bestBid[0]))) {
                        const order = {
                            size: bestBid[1],
                            side: OrderSide.BUY,
                            price: bestBid[0]
                        }
                        logFile(order)
                        // this.cbp.limitOrder(productId, order)
                        lastBuy = {
                            price: order.price,
                            time: new Date().getTime()
                        }
                        lastSell = null
                    }
                }
            }
            
        }, 5000)
    }

}