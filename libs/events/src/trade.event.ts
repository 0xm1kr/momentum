
export class TradeEvent {
    pair: string
    side: string
    size: string
    price: string
    time: number
    delta: number
    exchange: string

    /**
     * Handle a moving average update event
     * 
     * @param pair 
     *
     */
    constructor(
        pair: string,
        side: string,
        size: string,
        price: string,
        time: number,
        delta: number,
        exchange: string
    ) {
        this.pair = pair
        this.side = side
        this.size = size
        this.price = price
        this.time = time
        this.delta = delta
        this.exchange = exchange
    }
}