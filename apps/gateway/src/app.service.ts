import { Injectable } from '@nestjs/common'
import { Redis } from 'ioredis';
import { RedisService } from 'nestjs-redis';

@Injectable()
export class AppService {
    constructor(
        private readonly redisSvc: RedisService
    ) {}
    
    private redis: Redis

    async onApplicationBootstrap() {
        // connect to store
        this.redis = await this.redisSvc.getClient('momentum-state')
    }

    /**
     * Get a list of all subscriptions
     */
    async getSubscriptions() {
        const keys = await this.redis.keys('subscriptions:*')

        return Promise.all(
            keys.map(async (k: string) => {
                const params = k.split(':')
                return {
                    exchange: params[1],
                    pairs: await this.redis.smembers(k)
                }
            })
        )
    }
}