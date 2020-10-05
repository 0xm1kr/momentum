
export class TradeEvent {
    pair: string
    side: string
    size: string
    price: string
    time: number
    delta: number

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
        delta: number
    ) {
        this.pair = pair
        this.side = side
        this.size = size
        this.price = price
        this.time = time
        this.delta = delta
    }
}