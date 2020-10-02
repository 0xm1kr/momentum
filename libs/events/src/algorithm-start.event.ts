export class AlgorithmStartEvent {
    algorithm: string
    pair: string
    exchange: string
    period: number
    size: string
    lastTrade: string

    /**
     * Required params to start a new algo
     * 
     * @param pair 
     * @param size 
     * @param lastTrade 
     * @param exchange 
     * @param algorithm 
     * @param period 
     */
    constructor(pair, size = '1', lastTrade = '', exchange = 'coinbase', period = 60 * 1000) {
        this.pair = pair
        this.exchange = exchange
        this.period = period
        this.size = size
        this.lastTrade = lastTrade
    }
}