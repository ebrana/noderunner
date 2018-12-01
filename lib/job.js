exports = module.exports = Job

var parser = require('cron-parser')
var chance = require('chance')

function Job(queue) {
  this.db = queue.db
  this.nconf = queue.nconf
  this.logger = queue.logger
  this.queue = queue
}

Job.prototype.run = function(callback, fallback, onStatusSaved) {
  var self = this
  var command = this._buildCommandArray()
  this.threadName = this._buildThreadName(self.document.thread)
  this.threadIndex = self.document.thread

  this.logger.info(
    'THREAD ' +
      this.threadName +
      ' ' +
      this.queue.getThreadsInfo(this.threadIndex) +
      ' running ' +
      /*self.toString()*/ this.document._id
  )

  self._save(
    {
      status: self.nconf.get('statusAlias:running'),
      executedCommand: command[0] + ' ' + command[1].join(' ')
    },
    function(document) {
      if (typeof onStatusSaved != 'undefined') {
        onStatusSaved(document)
      }

      var spawn = require('child_process').spawn
      var child = spawn(command[0], command[1])

      self._save({
        pid: child.pid
      })

      child.stdout.on('data', function(data) {
        // TODO dodelat buffer, aby se nevolalo mongo pri kazdem radku
        //self.logger.verbose('THREAD ' + self.threadName + ': data ', data.toString().replace('\n', ' '));
        self._appendToProperty('output', data.toString())
      })
      child.stderr.on('data', function(data) {
        self.logger.warn(
          'THREAD ' + self.threadName + ': error ',
          data.toString().replace('\n', ' ')
        )
        self._appendToProperty('errors', data.toString())
      })
      child.on('exit', function(code) {
        self._finish(code, callback, fallback)
      })
    },
    function() {
      if (typeof fallback != 'undefined') {
        fallback()
      }
    }
  )
}

// parameters and all calculations are in seconds
Job.prototype.isDue = function(checkIntervalStart, checkIntervalEnd) {
  // load distribution algorithm - for example when using */10 * * * * schedule, every job should run in any minute in interval 0..9 (but every job every time with the same offset - derieved from its ID)
  var parsedSchedule = /\*\/(\d*)( \*){4}/.exec(this.document.schedule)
  if (parsedSchedule && parsedSchedule[1]) {
    var minutesInterval = parsedSchedule[1]

    // find random number derived from job id in interval (0..minutesInterval)
    var randomGenerator = new chance(this.document._id.toString())
    var offset = Math.round(
      randomGenerator.integer({ min: 0, max: (minutesInterval - 1) * 100 }) * 0.6
    )
  } else {
    var offset = 0
  }

  // next() returns next due time, so we need to move time back by one check interval to get current due time
  var now = new Date()
  var next = parser
    .parseExpression(this.document.schedule, {
      currentDate: now.valueOf() - this.nconf.get('planned:interval')
    })
    .next()
  var nextWithoutOffset = Math.floor(next.valueOf() / 1000)
  var nextWithOffset = nextWithoutOffset - offset

  function time(timestamp) {
    var date = new Date(timestamp * 1000)
    return date.getHours() + ':' + date.getMinutes() + ':' + date.getSeconds()
  }

  if (checkIntervalStart < nextWithOffset) {
    if (nextWithOffset <= checkIntervalEnd) {
      // inside of interval
      this.logger.debug(
        '✓ job ' +
          this.document._id +
          ' with next due time ' +
          time(nextWithoutOffset) +
          '-' +
          offset +
          's=' +
          time(nextWithOffset) +
          ' is inside of check interval: (' +
          time(checkIntervalStart) +
          '..[' +
          time(nextWithOffset) +
          ']..' +
          time(checkIntervalEnd) +
          '>'
      )
    } else {
      // after interval
      this.logger.debug(
        '✗ job ' +
          this.document._id +
          ' with next due time ' +
          time(nextWithoutOffset) +
          '-' +
          offset +
          's=' +
          time(nextWithOffset) +
          ' is after check interval: (' +
          time(checkIntervalStart) +
          '..' +
          time(checkIntervalEnd) +
          '>  ' +
          (nextWithOffset - checkIntervalStart) +
          's  [' +
          time(nextWithOffset) +
          ']'
      )
    }
  } else {
    // before interval
    this.logger.debug(
      '✗ job ' +
        this.document._id +
        ' with next due time ' +
        time(nextWithoutOffset) +
        '-' +
        offset +
        's=' +
        time(nextWithOffset) +
        ' is before check interval: [' +
        time(nextWithOffset) +
        ']  ' +
        (checkIntervalStart - nextWithOffset) +
        's  (' +
        time(checkIntervalStart) +
        '..' +
        time(checkIntervalEnd) +
        '>'
    )
  }

  return checkIntervalStart < nextWithOffset && nextWithOffset <= checkIntervalEnd
}

Job.prototype.copyToImmediate = function(callback) {
  var self = this
  var newDocument = this.document
  newDocument.sourceId = newDocument._id
  delete newDocument._id
  newDocument.status = this.nconf.get('statusAlias:planned')
  newDocument.added = new Date().getTime() / 1000
  this.logger.silly('copyToImmediate')
  this.db.collection('immediate').insert(newDocument, function() {
    self.logger.silly('copyToImmediate DONE')
    // self.queue.emit('copiedToImmediate', {oldDocument: self.document, newDocument: newDocument});
    callback()
  })
}

Job.prototype.moveToHistory = function() {
  var self = this
  var newDocument = this.document
  this.db.collection('immediate').remove({ _id: newDocument._id })
  delete newDocument._id
  this.logger.silly('moveToHistory')
  this.db.collection('history').insert(newDocument, function() {
    self.logger.silly('moveToHistory DONE')
    // self.queue.emit('movedToHistory', {oldDocument: self.document, newDocument: newDocument});
  })
}

Job.prototype.rerun = function() {
  var self = this
  var newDocument = this.document

  delete newDocument._id
  newDocument.status = this.nconf.get('statusAlias:planned')
  newDocument.added = new Date().getTime() / 1000
  newDocument.output = ''
  newDocument.errors = ''
  this.logger.debug('rerun')
  this.db.collection('immediate').insert(newDocument, function() {
    self.logger.debug('rerun DONE')
    self.queue.emit('rerunDone', { oldDocument: self.document, newDocument: newDocument })
  })
}

Job.prototype.initByDocument = function(doc) {
  this.document = doc
}

Job.prototype.toString = function() {
  return this.document._id + ' ' + this._buildCommand()
}

Job.prototype._finish = function(code, callback, fallback) {
  var finished = new Date().getTime() / 1000

  if (code == 0) {
    this._save(
      { status: this.nconf.get('statusAlias:success'), finished: finished },
      callback,
      fallback
    )
    this.logger.info(
      'THREAD ' +
        this.threadName +
        ' ' +
        this.queue.getThreadsInfo(this.threadIndex) +
        '  -> ' +
        this.document._id +
        ' done with SUCCESS'
    )
  } else {
    this._save(
      { status: this.nconf.get('statusAlias:error'), finished: finished },
      callback,
      fallback
    )
    this.logger.warn(
      'THREAD ' +
        this.threadName +
        ' ' +
        this.queue.getThreadsInfo(this.threadIndex) +
        '  -> ' +
        this.document._id +
        ' done with ERROR, status ' +
        code
    )
  }
}

Job.prototype._appendToProperty = function(property, value) {
  if (this.document[property] === null || typeof this.document[property] == 'undefined') {
    this.document[property] = value
  } else {
    this.document[property] += value
  }

  var data = {}
  data[property] = this.document[property]
  this._save(data)
}

Job.prototype._save = function(data, callback, fallback) {
  var self = this
  var saveId = Math.random()
  this.db
    .collection('immediate')
    .findAndModify({ _id: this.document._id }, [], { $set: data }, { new: true }, function(
      err,
      doc
    ) {
      if (err || doc === null) {
        self.logger.error(
          'THREAD ' + self.threadName + ':',
          'cannot save document',
          err,
          doc !== null ? doc.value : ''
        )
        if (typeof fallback != 'undefined') {
          fallback(err)
        }
      } else {
        if (typeof callback != 'undefined') {
          callback(doc.value)
        }
      }
    })
}

Job.prototype._buildCommandArray = function() {
  return this._buildCommand(true)
}

Job.prototype._buildCommand = function(returnAsArray) {
  if (this.nconf.get('sudo:user') && this.nconf.get('sudo:user').length > 0) {
    var args = ['sudo', '-u', this.nconf.get('sudo:user'), '-g', this.nconf.get('sudo:group')]
  } else {
    var args = []
  }

  args = args.concat(this._hasProperty('nice') ? ['nice', '-n', this.document.nice] : [])

  // if we had command property, use it instead of deprecated interpreter, basepath, executable, args
  if (this._hasProperty('command')) {
    args = args.concat(this.document.command.split(' '))
  } else {
    args = args.concat(this._hasProperty('interpreter') ? [this.document.interpreter] : [])
    if (this._hasProperty('basePath') && this.document.basePath.length > 0) {
      var path = this.document.basePath + '/'
      if (this._hasProperty('executable')) {
        path += this.document.executable
      }
      args.push(path)
    }
    args = args.concat(this._hasProperty('args') ? this.document.args.split(' ') : [])
  }

  var exe = args.shift()

  if (typeof returnAsArray === 'undefined' || !returnAsArray) {
    return exe + ' ' + args.join(' ')
  } else {
    return [exe, args]
  }
}

Job.prototype._buildThreadName = function(threadIndex) {
  var name = '#' + (threadIndex + 1)

  var threadNames = this.nconf.get('debug:threadNames')
  if (threadNames) {
    var name = threadNames[threadIndex]
  }

  return name
}

Job.prototype._hasProperty = function(prop) {
  return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null
}
