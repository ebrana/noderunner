#!/bin/sh

export PATH=$PATH:/usr/local/bin
export NODE_PATH=$NODE_PATH:/usr/local/lib/node_modules

case "$1" in
  start)
  cd $(dirname `readlink -f $0 || realpath $0`)
  cd ..
  mkdir -p /var/log/noderunner
  forever stop noderunner.js > /dev/null 2>&1
  forever start -a -p . --killSignal=SIGABRT --minUptime 1000 --spinSleepTime 100 -e /var/log/noderunner/error.log -l /var/log/noderunner/forever.log --pidFile ./forever.pid noderunner.js
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
*)
  echo "Usage: /etc/init.d/noderunner {start|stop}"
  exit 1
  ;;
esac

exit 0

