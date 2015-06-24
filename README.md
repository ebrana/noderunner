# queuerunner-node

Node.js daemon service for background running jobs from queuerunner MongoDB queue. 

## Installation

```bashp
npm install -g forever 

git clone https://github.com/dvorakjan/queuerunner-node.git /opt/queuerunner-node
cd /opt/queuerunner-node

ln -s /opt/queuerunner-node/bin/initScript.sh /etc/init.d/queuerunner-node
chmod +x /etc/init.d/queuerunner-node
update-rc.d queuerunner-node defaults
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
