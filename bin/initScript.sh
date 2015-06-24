#!/bin/sh

export PATH=$PATH:/usr/local/bin
export NODE_PATH=$NODE_PATH:/usr/local/lib/node_modules

case "$1" in
  start)
  cd $(dirname `readlink -f $0 || realpath $0`)
  cd ..
  mkdir -p /var/log/queuerunner-node
  forever stop queuerunner-node.js > /dev/null 2>&1
  forever start -a -p . --minUptime 1000 --spinSleepTime 100 -o /var/log/queuerunner-node/output.log -e /var/log/queuerunner-node/error.log -l /var/log/queuerunner-node/forever.log --pidFile ./forever.pid -w --watchIgnore "logs/*" queuerunner-node.js
  ;;
stop)
  exec forever stop queuerunner-node.js
  ;;
*)
  echo "Usage: /etc/init.d/queuerunner-node {start|stop}"
  exit 1
  ;;
esac

exit 0

