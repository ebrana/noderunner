var Job = require("../job.js");

exports = module.exports = Immediate; 


function Immediate (db, nconf) {
  this.db = db
  this.nconf = nconf
  this.timeout = null
  this.interval = nconf.get('immediate:interval')
  this.maxThreadsCount = nconf.get('immediate:maxThreadsCount');
  this.activeThreadsCount = 0;
}

Immediate.prototype.run = function() {
  this._check()
}

Immediate.prototype._check = function() {
  var self = this;  

  // pokud neni k dispozici volne vlakno, pak nic nedelame - _check() se znovu zavola po dokonceni nektereho beziciho jobu
  if (!self._isAvailableThread()) {
    return false;
  }

  // zkontrolujeme zdali je nejaky job k dispozici
  var job = new Job(this.db, this.nconf);   
    job.isAvailable(function(result){
      if (result) {
        // mame job k dispozici, hned spustime
        this.activeThreadsCount ++;
        job.run(function(){
          // job dobehl, hned bez timeoutu zkusime naplanovat dalsi
          this.activeThreadsCount --;
          clearTimeout(self.timeout);
          self._check();
        });
        // po spusteni jednoho jobu hned kontrolujeme, jestli neni dostupny dalsi
        self._check();
      } else {
        // zadny immediate job k dispozici, zkusime to znovu za chvili
        console.log('nothig to do in immediate, sleep for ' + self.interval);
        self.timeout = setTimeout(function(){
          self._check();
        }, self.interval);
      }
  }); 
  return true;
}

Immediate.prototype._isAvailableThread = function() {
  return this.activeThreadsCount < this.maxThreadsCount;
}
