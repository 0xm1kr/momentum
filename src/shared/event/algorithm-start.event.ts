export class AlgorithmStartEvent {
    algorithm: string
    productId: string
    exchange: string
    period: number
    size: string
    lastTrade: string

    /**
     * Required params to start a new algo
     * 
     * @param productId 
     * @param size 
     * @param lastTrade 
     * @param exchange 
     * @param algorithm 
     * @param period 
     */
    constructor(productId, size = '1', lastTrade = '', exchange = 'coinbase', period = 60 * 1000) {
        this.productId = productId;
        this.exchange = exchange;
        this.period = period
        this.size = size
        this.lastTrade = lastTrade
    }
}