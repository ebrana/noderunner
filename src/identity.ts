import * as fs from 'fs'
import { IncomingMessage } from 'http'
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
      'token': token
    })
    const options = {
      method: 'POST',
    }
    const req = https.request(this.nconf.get('jwt:url') + 'refresh', options, res => {
      this.httpClientCallback(res, callback)
    })
    req.on('error', (error) => {
      callback(null, '', error.message)
    })
    req.write(data)
    req.end()
  }

  public login(username: string, password: string, callback: CallableFunction) {
    const data = JSON.stringify({
      'password': password,
      'username': username
    })
    const options = {
      method: 'POST'
    }
    const req = https.request(this.nconf.get('jwt:url') + 'login_check', options, res => {
      this.httpClientCallback(res, callback)
    })
    req.on('error', (error) => {
      callback(null, '', error.message)
      // callback('test', 200, null)
    })
    req.write(data)
    req.end()
  }

  public isValidate(token: string): boolean {
    try {
      jwt.verify(token, this.publicCert)
      return true
    } catch (e) {
      return false
    }
  }

  public getIdentity(token: string): object|string|null {
    try {
      return jwt.verify(token, this.publicCert)
    } catch (e) {
      return null
    }
  }

  public validate(token: string) {
    jwt.verify(token, this.publicCert)
  }

  protected httpClientCallback(res: IncomingMessage, callback: CallableFunction) {
    res.setEncoding('utf8');
    let rawData = '';
    res.on('data', (chunk) => { rawData += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) { // stranka vrati status 200
        try {
          const token = JSON.parse(rawData.toString()).token
          if (token !== undefined) {
            callback(token, 200, null)
          } else {
            callback(null, 500, 'token is undefined')
          }
        } catch (e) {
          callback(null, 500, e.message)
        }
      } else {
        callback(null, res.statusCode, res.statusMessage)
      }
    });
  }
}