// load .env
import { resolve } from 'path'
import { config } from 'dotenv'

if (!process.env.ENVIRONMENT) {
    config({ path: resolve(__dirname, '../../.env') })
    process.env.ENVIRONMENT = process.env.ENVIRONMENT || 'DEV'
}
