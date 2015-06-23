var mongojs   = require("mongojs"),
	nconf     = require('nconf'),
    Immediate = require("./lib/queue/immediate.js"),
    Planned   = require("./lib/queue/planned.js");


// Konfigurace z defaulltu, ENV, CLI a souboru
nconf.argv().env().file({file: 'config.json'});

var db = mongojs.connect(nconf.get('mongoDSN'), ['immediate','planned','history']);

// Spustit jednotlive fronty
new Immediate(db, nconf).run(); 
new Planned(db, nconf).run();
