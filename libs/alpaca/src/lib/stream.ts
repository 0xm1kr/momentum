import * as WebSocket from 'ws'
import urls from './urls'

import { EventEmitter } from 'events'
import { Credentials } from './entities'

export declare interface AlpacaStream {
  on<U extends keyof AlpacaStreamEvents>(
    event: U,
    listener: AlpacaStreamEvents[U]
  ): this
  emit<U extends keyof AlpacaStreamEvents>(
    event: U,
    ...args: Parameters<AlpacaStreamEvents[U]>
  ): boolean
}

export declare interface AlpacaStreamEvents {
  open: (connection: AlpacaStream) => void
  close: (connection: AlpacaStream) => void
  authenticated: (connection: AlpacaStream) => void
  error: (error: Error) => void
  message: (data: Record<string, any>) => void
  trade: (data: Record<string, any>) => void
  trade_updates: (data: Record<string, any>) => void
  account_updates: (data: Record<string, any>) => void
  quote: (data: Record<string, any>) => void
  aggregate_minute: (data: Record<string, any>) => void
}

export class AlpacaStream extends EventEmitter {
  private host: string
  private connection: WebSocket
  private subscriptions: string[] = []
  private authenticated = false
  protected lastHeartBeat = null
  protected heartbeat: NodeJS.Timeout = null
  protected heartbeatTimeout = 10000

  constructor(
    protected params: {
      credentials: Credentials
      stream: 'account' | 'market_data',
      paper?: boolean
    }
  ) {
    // construct EventEmitter
    super()

    // assign the host we will connect to
    switch (params.stream) {
      case 'account':
        this.host = params.paper ? urls.websocket.account.replace('api.', 'paper-api.') : urls.websocket.account
        break
      case 'market_data':
        this.host = urls.websocket.market_data
        break
      default:
        this.host = 'unknown'
    }
    
    this.connection = new WebSocket(this.host)
      .once('open', () => {
        // if we are not authenticated yet send a request now
        if (!this.authenticated) {
          this.connection.send(
            JSON.stringify({
              action: 'authenticate',
              data: {
                key_id: params.credentials.key,
                secret_key: params.credentials.secret,
              },
            })
          )
        }

        // pass the open
        this.emit('open', this)
      })
      // pass the close
      .once('close', () => this.emit('close', this))
      .on('message', (message) => {
        // parse the incoming message
        const object = JSON.parse(message.toString())

        // if the message is an authorization response
        if ('stream' in object && object.stream == 'authorization') {
          if (object.data.status == 'authorized') {
            this.authenticated = true
            // init heartbeat
            this.initHeartBeat.apply(this)
            this.emit('authenticated', this)
          } else {
            this.connection.close()
            throw new Error(
              'There was an error in authorizing your websocket connection. Object received: ' +
                JSON.stringify(object, null, 2)
            )
          }
        }

        // pass the message
        this.emit('message', object)

        // emit based on the stream
        if ('stream' in object) {
          this.emit(
            {
              trade_updates: 'trade_updates',
              account_updates: 'account_updates',
              T: 'trade',
              Q: 'quote',
              AM: 'aggregate_minute',
            }[(object.stream as string).split('.')[0]],
            object.data
          )
        }
      })
      // pass the error
      .on('error', (err: Error) => this.emit('error', err))
      .on('pong', () => {
        this.lastHeartBeat = new Date().getTime()
      })
      
  }

  send(message: any): this {
    // don't bother if we aren't authenticated yet
    if (!this.authenticated) {
      throw new Error("You can't send a message until you are authenticated!")
    }

    // if the message is in object form, stringify it for the user
    if (typeof message == 'object') {
      message = JSON.stringify(message)
    }

    // send it off
    this.connection.send(message)

    // chainable return
    return this
  }

  subscribe(channels: string[]): this {
    // add these channels internally
    this.subscriptions.push(...channels)

    // try to subscribe to them
    return this.send(
      JSON.stringify({
        action: 'listen',
        data: {
          streams: channels,
        },
      })
    )
  }

  unsubscribe(channels: string[]): this {
    // remove these channels internally
    for (let i = 0, ln = this.subscriptions.length; i < ln; i++) {
      if (channels.includes(this.subscriptions[i])) {
        this.subscriptions.splice(i, 1)
      }
    }

    // try to unsubscribe from them
    return this.send(
      JSON.stringify({
        action: 'unlisten',
        data: {
          streams: channels,
        },
      })
    )
  }

  close() {
    if (this.connection.OPEN) {
      if (this.heartbeat) {
        clearTimeout(this.heartbeat)
      }
      this.connection.close()
    }
  }

  // ----- internal methods ------

  protected initHeartBeat() {
    if (this.connection.OPEN && this.heartbeat) {
      const now = new Date().getTime()
      if ((now - this.lastHeartBeat) > this.heartbeatTimeout) {
        throw new Error('Alpaca heartbeat timed out!')
      }
    }
    this.connection.ping()
    this.heartbeat = setTimeout(() => {
      this.initHeartBeat()
    }, this.heartbeatTimeout)
  }

}
