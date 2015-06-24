queuerunner-node
================

Node.js daemon service for background running jobs from queuerunner MongoDB queue. 

Installation
------------
    npm install -g forever 
    ln -s /path/to/this/repo/bin/initScript.sh /etc/init.d/queuerunner-node
    chmod +x /etc/init.d/queuerunner-node
    update-rc.d queuerunner-node defaults
