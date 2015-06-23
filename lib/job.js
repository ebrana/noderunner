exports = module.exports = Job;

var parser = require('cron-parser');

function Job (db, nconf) {
  this.db = db;
  this.nconf = nconf;
};

Job.prototype.isAvailable = function(callback) {
  var self = this;

  this.db.immediate.findAndModify({
      query:  {status: self.nconf.get('statusAlias:planned')}, 
      update: {$set: {status: self.nconf.get('statusAlias:running')}},
      sort:   {nextRun: 1, priority: -1}, 
      new:    true
    },function(err, doc) {
      if (err) {
        console.error(err);
      }
      if( !err && doc) {
        self.document = doc;
        callback(true);
      } else {
        self.document = null;
        callback(false);
      }
    }
  );
}

Job.prototype.run = function(callback) {
  var job     = this;
  var command = this._buildCommand();
  console.log('running', command[0]+' '+command[1].join(' '));

  var spawn = require('child_process').spawn;
  var child = spawn(command[0], command[1]);

  child.stdout.on('data', function(data) {
      console.log(data);
      job._appendToProperty('output', data);
  });
  child.stderr.on('data', function(data) {
      job._appendToProperty('errors', data);
  });
  child.on('close', function(code) {
      job._finish(code);
      callback(code);
  });
}

Job.prototype.isDue = function() {
  // next() vraci pristi spusteni daneho cronu, proto se musime vratit o minutu v case abychom ziskali aktualni spusteni
  var now  = new Date();
  var next = parser.parseExpression(this.document.schedule, {currentDate: now.valueOf() - 60000}).next();
  now.setSeconds(0);

  return now.valueOf() == next.valueOf();
}

Job.prototype.copyToImmediate = function() {
  console.log('copying planned job '+this.document._id+' to immediate');
  var newDocument = this.document
  delete newDocument._id
  newDocument.status = this.nconf.get('statusAlias:planned');
  this.db.immediate.insert(newDocument)
}

Job.prototype.initByDocument = function(doc) {
  this.document = doc;
}

Job.prototype._finish = function(code) {
  this.document.status = 'success2';
  this._save();
}

Job.prototype._appendToProperty = function(property, value) {
  this.document[property] += value;
  this._save();
}

Job.prototype._save = function() {
  this.collection.update(
    {_id:this.document._id},
    {$set: this.document},
    {},
    function (err, doc) {
      console.error('cannot save doc ', err, doc)
    }
  );
}

Job.prototype._buildCommand = function() {
  args = ['-u','vyvoj','-g','www-data'];  
  args = args.concat(this._hasProperty('nice')        ? ['nice', '-n', this.document.nice] : []);
  args = args.concat(this._hasProperty('interpreter') ? [this.document.interpreter]        : []);
  if (this._hasProperty('basePath')) {
    var path = this.document.basePath + '/';
    if (this._hasProperty('executable')) {
      path += this.document.executable;
    }
    args.push(path);
  }
  args = args.concat(this._hasProperty('args') ? this.document.args.split(' '): []);
  
  return ['sudo', args];
}

Job.prototype._hasProperty = function(prop) {
  return typeof this.document[prop] !== 'undefined' && this.document[prop] !== null;
}
