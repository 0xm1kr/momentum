import { Injectable } from '@nestjs/common'
import { InjectTwilio, TwilioClient } from 'nestjs-twilio'
import axios from 'axios'

const ELK_USER = process.env.ELK_USER || 'elastic'
const ELK_PASS = process.env.ELK_PASS || 'changeme'

@Injectable()
export class AppService {

    private elkEndpoint = 'http://localhost:9200'

    constructor(
        @InjectTwilio() private readonly twilio: TwilioClient
    ) {}
    
    /**
     * Create an index
     * 
     * @param index 
     */
    async createIndex(index: string) {
        return axios({
            url: `${this.elkEndpoint}/${index}`,
            method: 'PUT',
            data: {
                "mappings": {
                    "properties": {
                        "date": {
                            "type":   "date"
                        },
                        "time": {
                            "type":   "date"
                        },
                        "timestamp": {
                            "type":   "date"
                        }
                    }
                }
            },
            headers: {
                'Content-Type': 'application/json',
                "Authorization": `Basic ${Buffer.from(`${ELK_USER}:${ELK_PASS}`).toString('base64')}`
            }
        })
    }

    /**
     * Create an ELK index doc
     * 
     * @param data 
     */
    async createDoc(index: string, data: any) {
        return axios({
            url: `${this.elkEndpoint}/${index}/_doc`,
            method: 'post',
            data,
            headers: {
                'Content-Type': 'application/json',
                "Authorization": `Basic ${Buffer.from(`${ELK_USER}:${ELK_PASS}`).toString('base64')}`
            }
        })
    }

    /**
     * Send a text message
     * 
     * @param message 
     * @param to 
     */
    async sendSMS(message: string, to: string) {
        try {
            return await this.twilio.messages.create({
                body: message,
                from: process.env.TWILIO_PHONE_NUMBER,
                to
            })
        } catch (e) {
          console.log(e)
        }
      }
}