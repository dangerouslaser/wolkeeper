#!/bin/sh
# wolkeeper: hold LG webOS 25 TV in Active Standby so ethernet WoL keeps working.
# Renews a sleepd activity (sleepd gates nyx_system_suspend on active activities).
# Managed by webosbrew-wolkeeper.service (created in /run/systemd/system by
# /var/lib/webosbrew/init.d/98-wolkeeper). Logs: /home/root/wolkeeper.log
LOG=/home/root/wolkeeper.log
PREV=""
echo "$(date) wolkeeper started (pid $$)" >> $LOG
while true; do
  A=$(luna-send -a webosbrew -n 1 -f luna://com.webos.service.sleep/com/palm/power/activityStart \
    '{"id":"org.webosbrew.wolkeeper","duration_ms":300000}' 2>&1 | tr -d '\n ')
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
