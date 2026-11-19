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
#
# If the app is uninstalled without pressing Disable, this script's file goes
# away while the shell keeps running from the open (deleted) inode. Each loop
# checks for that and, once it is sure the app is really gone (not mid-update),
# undoes what Enable did: ends the activity, restores the saved Always Ready
# settings, removes the dangling boot hook and the unit, and stops itself.
APP_ID=com.github.dangerouslaser.wolkeeper
SELF="$0"
LOG=/home/root/wolkeeper.log
HOOK=/var/lib/webosbrew/init.d/98-wolkeeper
STASH=/var/lib/webosbrew/wolkeeper.prev-alwayson.json
UNIT=wolkeeper.service
UNITFILE=/run/systemd/system/$UNIT
SETTINGS=luna://com.webos.settingsservice
AR_KEYS='"alwaysOn","alwaysOnDisableStartHour","alwaysOnDisableStartMinute","alwaysOnDisableEndHour","alwaysOnDisableEndMinute"'
# LG's stock values; same fallback the app's Disable uses when nothing was saved.
AR_STOCK='{"alwaysOn":"off","alwaysOnDisableStartHour":"1","alwaysOnDisableStartMinute":"0","alwaysOnDisableEndHour":"6","alwaysOnDisableEndMinute":"0"}'

note() {
  command -v logger >/dev/null 2>&1 && logger -t wolkeeper "$1"
  echo "$(date) $1" >> $LOG
}

# Current alwaysOn* settings as one line of JSON (no whitespace).
ar_read() {
  luna-send -n 1 -f $SETTINGS/getSystemSettings \
    "{\"category\":\"general\",\"keys\":[$AR_KEYS]}" 2>/dev/null | tr -d ' \n\t'
}

# Value of key $1 in the flat JSON $2, quoted or not.
jget() {
  echo "$2" | sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p"
}

app_gone() {
  [ ! -f "$SELF" ]
}

# The app was uninstalled while Enabled. Undo Enable, keeping the saved settings
# and the log if the restore can't be confirmed, so they can be put back by hand.
uninstall_cleanup() {
  note "app removed without Disable ($SELF is gone) - cleaning up"
  luna-send -a $APP_ID -n 1 luna://com.webos.service.sleep/com/palm/power/activityEnd \
    "{\"id\":\"$APP_ID\"}" >/dev/null 2>&1

  RESTORE=""
  if [ -f "$STASH" ]; then
    RESTORE=$(tr -d '\n' < "$STASH" | sed -n 's/.*"settings":\({[^}]*}\).*/\1/p')
    WHAT="saved settings from $STASH"
  else
    # Nothing saved (enabled with 0.1.0): only put LG's defaults back if the
    # settings are still exactly WoL Keeper's override.
    CUR=$(ar_read)
    if [ "$(jget alwaysOn "$CUR")" = on ] &&
       [ "$(jget alwaysOnDisableStartHour "$CUR")" = 6 ] &&
       [ "$(jget alwaysOnDisableStartMinute "$CUR")" = 0 ] &&
       [ "$(jget alwaysOnDisableEndHour "$CUR")" = 6 ] &&
       [ "$(jget alwaysOnDisableEndMinute "$CUR")" = 0 ]; then
      RESTORE=$AR_STOCK
      WHAT="LG defaults (nothing was saved)"
    fi
  fi

  RESTORED=no
  if [ -n "$RESTORE" ]; then
    luna-send -n 1 $SETTINGS/setSystemSettings \
      "{\"category\":\"general\",\"settings\":$RESTORE}" >/dev/null 2>&1
    NOW=$(ar_read)
    WANT=$(jget alwaysOn "$RESTORE")
    if [ -n "$WANT" ] && [ "$(jget alwaysOn "$NOW")" = "$WANT" ]; then
      RESTORED=yes
      note "Always Ready restored: $WHAT"
    else
      note "could not confirm Always Ready restore (wanted alwaysOn=$WANT, now: $NOW); keeping $STASH and this log"
    fi
  else
    RESTORED=yes   # nothing to restore
    note "Always Ready left as is (no saved settings, and not WoL Keeper's override)"
  fi

  # Only remove the hook if it is our dangling link, never a reinstalled one.
  [ -L "$HOOK" ] && [ ! -e "$HOOK" ] && rm -f "$HOOK"
  if [ "$RESTORED" = yes ]; then
    rm -f "$STASH" "$LOG"
  fi
  rm -f "$UNITFILE"
  systemctl daemon-reload 2>/dev/null
  # Stop ourselves through systemd so Restart=always doesn't bring us back.
  systemctl --no-block stop $UNIT 2>/dev/null
  sleep 30
  exit 0
}

PREV=""
echo "$(date) wolkeeper started (pid $$)" >> $LOG
while true; do
  if app_gone; then
    # An app update replaces the package directory, so the file is briefly
    # missing then too. Only treat it as an uninstall if it stays gone.
    sleep 30
    app_gone && uninstall_cleanup
  fi
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
  sleep 60
done
