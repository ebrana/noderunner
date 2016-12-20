#!/bin/sh
#
# Note runlevel 2345, 86 is the Start order and 85 is the Stop order
#
# chkconfig: 2345 86 85 
# description: Node.js daemon service for background running jobs from queuerunner MongoDB queue.

export PATH=$PATH:/usr/local/bin
export NODE_PATH=$NODE_PATH:/usr/local/lib/node_modules

export NR_HOME=/home/noderunner
export NR_LOGS=/var/log/noderunner
export NR_USER=nginx
export NR_GROUP=nginx

case "$1" in
  start)
  cd $NR_HOME

  mkdir -p $NR_LOGS
  mkdir -p $NR_HOME/.forever/pids
  chown -R $NR_USER:$NR_GROUP $NR_LOGS
  chown -R $NR_USER:$NR_GROUP $NR_HOME/.forever/pids
  sudo HOME=$NR_HOME -u $NR_USER -g $NR_GROUP forever stop -p $NR_HOME noderunner.js > /dev/null 2>&1
  sudo HOME=$NR_HOME -u $NR_USER -g $NR_GROUP forever start -a -p . --killSignal=SIGABRT --minUptime 1000 --spinSleepTime 100 -e $NR_LOGS/error.log -l $NR_LOGS/forever.log --pidFile ./forever.pid noderunner.js
  ;;
status)
  cd $NR_HOME
  sudo HOME=$NR_HOME -u $NR_USER -g $NR_GROUP forever list
  ;;
stop)
  cd $NR_HOME
  sudo HOME=$NR_HOME -u $NR_USER -g $NR_GROUP forever stop noderunner.js
  ;;
restart)
  cd $NR_HOME
  sudo HOME=$NR_HOME -u $NR_USER -g $NR_GROUP forever restart noderunner.js
  ;;
log)
  cd $NR_HOME/bin
  ./log.sh
  ;;  
*)
  echo "Usage: /etc/init.d/noderunner {start|stop}"
  exit 1
  ;;
esac

exit 0

