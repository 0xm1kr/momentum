import { Controller, Get } from '@nestjs/common'

@Controller('/runner')
export class AppController {

    @Get('/ping')
    async handlePing() {
        return {
            pong: new Date().getTime(),
            running: []
        }
    }

}