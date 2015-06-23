var Job = require("../job.js");

exports = module.exports = Planned; 

function Planned(db, nconf) {
  this.db = db
  this.nconf = nconf
  this.timeout = null
}

Planned.prototype.run = function() {
  var self = this;
  console.log('planning jobs...');

  // nacist naplanovane ulohy a projit je po jedne
  this.db.planned.find(function(err, docs){
    if (docs) {
      docs.forEach(function(doc){
        var job = new Job(self.db);
        job.initByDocument(doc);

        if (job.isDue()) {
          job.copyToImmediate();
        }
      })
    }

    // prodleva mezi behy tohoto skriptu musi byt presne minuta, aby nepreskocil nektere cronjoby nebo je nespustil 2x
    setTimeout(function(){self.run()}, 60000);
  })
}

