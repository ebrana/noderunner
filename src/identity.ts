import * as fs from 'fs'
import { IncomingMessage, request } from 'http'
import * as https from 'https'
import * as jwt from 'jsonwebtoken'
import { Provider as Nconf } from 'nconf'

export default class Identity {

  private readonly publicCert
  private nconf: Nconf

  constructor(nconf: Nconf) {
    this.nconf = nconf
    this.publicCert = fs.readFileSync(nconf.get('jwt:cert'));  // get public key
  }

  public refresh(token: string, callback: CallableFunction) {
    const data = JSON.stringify({
      'args': {
        'token': token
      },
      'methodname': 'refresh',
      'type': 'jsonwsp/request',
      'version': '1.0'
    })
    this.post(data, callback)
  }

  public login(username: string, password: string, callback: CallableFunction) {
    const data = JSON.stringify({
      'args': {
        'password': password,
        'username': username
      },
      'methodname': 'login',
      'type': 'jsonwsp/request',
      'version': '1.0'
    })
    this.post(data, callback)
  }

  public isValidate(token: string): boolean {
    try {
      jwt.verify(token, this.publicCert)
      return true
    } catch (e) {
      return false
    }
  }

  public validate(token: string) {
    jwt.verify(token, this.publicCert)
  }

  protected post(data: string, callback: CallableFunction) {
    const options = {
      headers: {
        'Authorization': 'Bearer ' + this.nconf.get('jwt:webserviceToken'),
        'Content-Type': 'application/json'
      },
      method: 'POST',
    }
    if (this.nconf.get('jwt:https')) {
      const req = https.request(this.nconf.get('jwt:url'), options, res => {
        this.httpClientCallback(res, callback)
      })
      req.on('error', (error) => {
        callback(null, '', error.message)
      })
      req.write(data)
      req.end()
    } else {
      const req = request(this.nconf.get('jwt:url'), options, res => {
        this.httpClientCallback(res, callback)
      })
      req.on('error', (error) => {
        callback(null, '', error.message)
        // callback('test', 200, null)
      })
      req.write(data)
      req.end()
    }
  }

  protected httpClientCallback(res: IncomingMessage, callback: CallableFunction) {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) { // stranka vrati status 200
        try {
          const token = JSON.parse(rawData.toString()).result.token
          if (token !== undefined) {
            callback(token, 200, null)
          } else {
            callback(null, 500, 'token is undefined')
          }
        } catch (e) {
          callback(null, 500, e.message)
        }
      } else if (res.statusCode === 401) {
        callback(null, 401, 'invalid credetials')
      } else {
        callback(null, res.statusCode, res.statusMessage)
      }
    });
  }
}