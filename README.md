# noderunner

Noderunner is Node.js daemon service for background running jobs from some queue with strictly limited number of concurrent processes. Currently only supported queue storage is MongoDB. You can use (see [dvorakjan/noderunner-php](https://github.com/dvorakjan/noderunner-php) to create queue items from PHP application.

## Architecture
Daemon is composed of three main queues and some additional modules. Each of these three queues corresponds to one queue in MongoDB. Activity diagram of service functionality can be found [here](docs/modules-activity.png).
  
  * ``Immediate`` is fetching jobs from queue of same name and executes their `command` in child process. When `sudo` is set in config, noderunner will automatically run command under given user and group. Status ``running`` is set to job during execution and ``error`` or ``success`` when complete. Stderr and stdout of proccess is continuously saved to ``error`` and ``output`` fields of job in queue. Maximum number of concurrent threads is set by `maxThreadsCount` config.
  * ``Planned`` is checking every minute all jobs in ``planned`` queue. If any of has ``schedule`` field (in CRON syntax) which is matching actual time, it is copied to ``immediate`` queue with new ID. When `*/N ...` CRON expression is used for minutes schedule, noderunner will automatically shift execution time randomly in given interval to avoid for example all `*/30` jobs to run exactly in `0,30` which is not necessary. 
  * ``History`` is contiunously checking ``immediate`` queue and moves jobs with field ``finished`` (timestamp created when status changed to success or error) older than certain value (one minute by default) to ``history`` queue.
  * ``Watchdog`` module is continuously checking count of jobs in ``immediate`` queue with ``status=planned``. If certain value (set in config) of consecutive samples exceeds limit, warning email is sent and info is pushed to log.
  * ``Gui`` module provides WS connection with variety of possible events regarding noderunner and its queues status information. When enabled, [dvorakjan/noderunner-gui](https://github.com/dvorakjan/noderunner-gui) can be used for showing this status info in the real time.

## Installation
```bash
git clone https://github.com/dvorakjan/noderunner.git /home/noderunner
cd /home/noderunner
npm install

# Systemd
cp /home/noderunner/bin/noderunner.service /etc/systemd/system/noderunner.service
systemctl daemon-reload
systemctl enable noderunner
systemctl start noderunner

# SysVInit
npm install -g forever
cp /home/noderunner/bin/initScript.sh /etc/init.d/noderunner
chmod +x /etc/init.d/noderunner
# modify NR_* variables in /etc/init.d/noderunner
# mkdir "NR_LOGS" when "NR_USER" can't write to NR_LOGS/..
update-rc.d noderunner defaults # Ubuntu
chkconfig --add noderunner      # CentOS
```
## Development
  * During development, ``bin/dev.sh`` script runs noderunner using ``nodemon`` for automatic reloading based on filechange. 
  * Control daemon using init script ``service noderunner start|stop|restart|status|log``
  * Manual restart of service using ``service noderunner restart`` will try to gracefully let threads finish first. Timeout for force restart can be set using ``gracefulShutdownTimeout``.

## Configuration
Default config file ``config/defaults.json`` is possible to override by ``config/custom.json`` file.
```json
{
  "mongoDSN": "mongodb://localhost:27017/db",	
  "logLevel": "info", 
  "sudo": {
    "user": "nginx",
    "group": "nginx"
  },
  "immediate": {
    "interval": 5000,               // num of millis to wait when nothing to do
    "maxThreadsCount": 3            // num of allowed parallel proccesses 
  },
  "history": {
    "interval": 30000,              // frequency of history check in millis
    "maxAge": 60000                 // num of millis from job finish before its move to history queue
  },
  "watchdog": {
    "interval": 360000,             // frequency of check in millis (every 6 minutes)
    "badSamplesLimit": 15,          // number of consecutive samples before warning is send (1.5 hour)
    "email": {
      "from": "noderunner@ebrana.cz",
      "to": "dvorak@ebrana.cz"
    }
  },
  "statusAlias": {                  // can be used to rename statuses (especially for testing purposes)
    "planned": "planed2",
    "fetched": "fetched2",
    "running": "running2",
    "success": "success2",
    "error": "error2"
  },
  "debug":{
    "threadNames":["Chuck","Paul"]  // you can call threads by yourself :-)
  }
}
```

## Credits
  *  [dvorakjan](https://github.com/dvorakjan) as the author of current Node.js based solution
  *  [vojtabiberle](https://github.com/vojtabiberle) as the inventor of original idea, which was implemented in ReactPHP
  
