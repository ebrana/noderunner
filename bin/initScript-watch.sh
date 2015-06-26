#!/bin/sh
#
# Note runlevel 2345, 86 is the Start order and 85 is the Stop order
#
# chkconfig: 2345 86 85
# description: Node.js daemon service for background running jobs from queuerunner MongoDB queue.

export PATH=$PATH:/usr/local/bin
export NODE_PATH=$NODE_PATH:/usr/local/lib/node_modules

case "$1" in
  start)
  cd $(dirname `readlink -f $0 || realpath $0`)
  cd ..
  mkdir -p /var/log/noderunner
  forever stop noderunner.js > /dev/null 2>&1
  forever start -a -p . --killSignal=SIGABRT --minUptime 1000 --spinSleepTime 100 -e /var/log/noderunner/error.log -l /var/log/noderunner/forever.log --pidFile ./forever.pid -w --watchIgnore "logs/*" noderunner.js
  ;;
stop)
  cd $(dirname `readlink -f $0 || realpath $0`)
  cd ..
  exec forever stop noderunner.js
  ;;
restart)
  cd $(dirname `readlink -f $0 || realpath $0`)
  cd ..
  exec forever restart noderunner.js
  ;;
log)
  cd $(dirname `readlink -f $0 || realpath $0`)
  exec ./log.sh
  ;;  
*)
  echo "Usage: /etc/init.d/noderunner {start|stop}"
  exit 1
  ;;
esac

exit 0

