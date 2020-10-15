
import { Order as CoinbaseOrder } from '@momentum/coinbase-client'
import { Order as AlpacaOrder } from '@momentum/alpaca-client'

export type Trade = {
    id: string
    price: string
    size: string
    timestamp: number // unix
    side?: string
    flags?: string[]
    exchange?: string 
}
  
export class SubscriptionUpdateEvent {
    pair: string
    bestBid: string[]
    bestAsk: string[]
    timestamp: number // unix
    property: string // which property has changed
    bidLiquidity?: string
    askLiquidity?: string
    lastTrade?: Trade
    orders?: Record<string, CoinbaseOrder|AlpacaOrder>

    /**
     * Handle an exchange event
     * 
     * @param pair 
     */
    constructor(
        pair: string,
        timestamp: number, // unix
        property: string,
        bestBid: string[],
        bestAsk: string[],
        bidLiquidity?: string,
        askLiquidity?: string,
        lastTrade?: Trade,
        orders?: Record<string, CoinbaseOrder|AlpacaOrder>
    ) {
        this.pair = pair
        this.timestamp = timestamp
        this.property = property
        this.bestBid = bestBid
        this.bestAsk = bestAsk
        this.bidLiquidity = bidLiquidity
        this.askLiquidity = askLiquidity
        this.lastTrade = lastTrade
        this.orders = orders
    }
}