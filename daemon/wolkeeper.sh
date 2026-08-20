#!/bin/sh
# wolkeeper: hold the TV in Active Standby so ethernet WoL keeps working.
#
# sleepd gates nyx_system_suspend on outstanding activities, and still honours the
# classic webOS activity API, so a continuously renewed activity blocks the descent
# into zero-watt standby (where the ethernet PHY loses power).
#
# Runs from inside the app package, started by wolkeeper.service, which
# /var/lib/webosbrew/init.d/98-wolkeeper creates in /run/systemd/system on boot.
# Logs to /home/root/wolkeeper.log.
APP_ID=com.github.dangerouslaser.wolkeeper
LOG=/home/root/wolkeeper.log
PREV=""
echo "$(date) wolkeeper started (pid $$)" >> $LOG
while true; do
  A=$(luna-send -a $APP_ID -n 1 -f luna://com.webos.service.sleep/com/palm/power/activityStart \
    "{\"id\":\"$APP_ID\",\"duration_ms\":300000}" 2>&1 | tr -d '\n ')
  S=$(luna-send -n 1 luna://com.webos.service.tvpower/power/getPowerState '{}' 2>&1 | tr -d '\n')
  # log only on state change or activity failure, to keep the log small
  CUR="$S|$A"
  if [ "$CUR" != "$PREV" ]; then
    echo "$(date) | $S | $A" >> $LOG
    PREV="$CUR"
  fi
  # bound log size ~100KB
  if [ "$(wc -c < $LOG 2>/dev/null)" -gt 100000 ]; then
    tail -c 50000 $LOG > $LOG.tmp && mv $LOG.tmp $LOG
  fi
  sleep 120
done
