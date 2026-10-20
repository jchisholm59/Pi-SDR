#!/bin/bash
# Copy Pi-SDR to the Pi, rebuild the engine if its source changed, restart under pm2.
# PI=root@192.168.2.94 by default (root SSH; files end up owned by jim, who runs pm2).
set -e
PI=${PI:-root@192.168.2.94}
cd "$(dirname "$0")"
tar cf - --exclude=node_modules --exclude=data --exclude=engine/sdrplay-inc --exclude=engine/sdr-engine --exclude=.git . |
  ssh "$PI" 'cd /home/jim/pi-sdr && tar xf - && chown -R jim:jim /home/jim/pi-sdr &&
    su - jim -c "cd ~/pi-sdr && make -s -C engine && npm install --omit=dev --no-audit --no-fund --silent && pm2 restart pi-sdr --update-env >/dev/null && echo deployed"'
