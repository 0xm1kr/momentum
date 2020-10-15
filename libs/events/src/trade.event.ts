
export class TradeEvent {
    id?: string
    pair: string
    side: string
    size: string
    price: string
    time: number
    delta: string
    exchange: string

    /**
     * Handle a moving average update event
     * 
     * @param pair 
     */
    constructor(
        id: string,
        pair: string,
        side: string,
        size: string,
        price: string,
        time: number,
        delta: string,
        exchange: string
    ) {
        this.id = id
        this.pair = pair
        this.side = side
        this.size = size
        this.price = price
        this.time = time
        this.delta = delta
        this.exchange = exchange
    }
}