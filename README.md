# noderunner

Node.js daemon service for background running jobs from queuerunner MongoDB queue. It can/should be used with [dvorakjan/QueueRunner](https://github.com/dvorakjan/QueueRunner) (QueueManager sublibrary respectively) originally created by [vojtabiberle](https://github.com/vojtabiberle) as a backend for job creation and management.

## Architecture
Daemon is composed by four separate modules. Three of them are corresponding to queuerunner queuees. Activity diagram of service function can be found [here](docs/modules-activity.png).
  
  * ``Immediate`` is fetching jobs from queue of same name and executes them. Command is composed as follows: ``sudo -u $user -g $group nice -n $nice $interpreter $basePath/$executable $args``. Status ``running`` is set to job during execution and ``error`` or ``success`` when complete. Stderr and stdout of proccess is continuously saved to ``error`` and ``output`` fields of job in queue.
  * ``Planned`` is checking every minute all jobs in ``planned`` queue. If any of has ``schedule`` field (in CRON syntax) which is matching actual time, it is copied to ``immediate`` queue with new ID.
  * ``History`` is contiunously checking ``immediate`` queue and moves jobs with field ``finished`` (timestamp created when status changed to success or error) older than certain value (one minute by default) to ``history`` queue.
  * ``Watchdog`` module is continuously checking count of jobs in ``immediate`` queue with ``status=planned``. If certain value (set in config) of consecutive samples exceeds limit, warning email is sent and info is pushed to log.

## Installation
```bashp
git clone https://github.com/dvorakjan/noderunner.git /home/noderunner
cd /home/noderunner
npm install

# Systemd
cp /home/noderunner/bin/noderunner.service /etc/systemd/system/noderunner.service
systemctl daemon-reload
systemctl enable noderunner
systemctl start noderunner

# SysVInit
cp /home/noderunner/bin/initScript.sh /etc/init.d/noderunner
chmod +x /etc/init.d/noderunner
# modify NR_* variables in /etc/init.d/noderunner
# mkdir "NR_LOGS" when "NR_USER" can't write to NR_LOGS/..

npm install -g forever
update-rc.d noderunner defaults # Ubuntu
chkconfig --add noderunner # CentOS
```
## Debugging
  * During development, ``bin/dev.sh`` script runs noderunner using ``nodemon`` for automatic reloading based on filechange. 
  * Control daemon using init script ``service noderunner start|stop|restart|status|log``
  * Manual restart of service using ``service noderunner restart`` will try to gracefully let threads finish first. Timeout for force restart can be set using ``gracefulShutdownTimeout``.

## Configuration
Default config file ``config/defaults.json`` is possible to override by ``config/custom.json`` file.
```javascript
{
  "mongoDSN": "mongodb://localhost:27017/db",	
  "logLevel": "info", 
  "sudo": {
    "user": "nginx",
    "group": "nginx"
  },
  "immediate": {
    "interval": 5000,				// num of millis to wait when nothing to do
    "maxThreadsCount": 3			// num of allowed parallel proccesses 
  },
  "history": {
    "interval": 30000,				// frequency of history check in millis
    "maxAge": 60000					// num of millis from job finish before its move to history queue
  },
  "watchdog": {
    "interval": 360000,				// frequency of check in millis (every 6 minutes)
    "badSamplesLimit": 15,			// number of consecutive samples before warning is send (1.5 hour)
    "email": {
      "from": "noderunner@ebrana.cz",
      "to": "dvorak@ebrana.cz"
    }
  },
  "statusAlias": {					// can be used to rename statuses (especially for testing purposes)
    "planned": "planed2",
    "fetched": "fetched2",
    "running": "running2",
    "success": "success2",
    "error": "error2"
  },
  "debug":{
    "threadNames":["Chuck","Paul"] // you can call threads by yourself :-)
  }
}
```
