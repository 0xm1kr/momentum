import { Injectable } from '@nestjs/common';

@Injectable()
export class AlpacaService {
  getBook(): any {
    return [ { alpaca: '' } ];
  }
}
