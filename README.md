# noderunner

Node.js daemon service for background running jobs from queuerunner MongoDB queue. 

## Installation

```bashp
npm install -g forever 

git clone https://github.com/dvorakjan/noderunner.git /opt/noderunner
cd /opt/noderunner

ln -s /opt/noderunner/bin/initScript.sh /etc/init.d/noderunner
chmod +x /etc/init.d/noderunner
update-rc.d noderunner defaults
```
## Configuration
Default config file ``config/defaults.json`` is possible to override with ``config/custom.json`` file.
```json
{
	"mongoDSN":"mongodb://localhost:27017/queuerunner",
	"immediate":{
		"interval": 4500,
		"maxThreadsCount": 3
	},
	"history":{
		"interval":120000
	},
	"statusAlias":{
		"planned": "planed2",
		"running": "running2",
		"success": "success2",
		"error":   "error2"
	},
    "debug":{
      "threadNames":["Thread 1", "Thread 2", "Thread 3"]
    }
}
```
