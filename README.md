# ⚡ WoL Keeper

**Keep ethernet Wake-on-LAN working *forever* on rooted LG webOS TVs.**

Stock behavior on recent LG TVs (verified on a 2025 G5, webOS 25): after you
turn the TV off with the remote, Wake-on-LAN works for only ~15 minutes. Then
the TV drops off the network entirely and magic packets do nothing — the only
way to turn it on is the remote. WoL Keeper fixes that: the TV stays reachable
and WoL-wakeable in standby indefinitely (verified across 17+ hour overnight
standby, including the TV's own scheduled standby reboots).

Requires a [rooted TV](https://rootmy.tv/) with
[Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel), and
**webOS 22 or newer** — see [Compatibility](#compatibility).

## Why this happens (the root cause)

LG's power-off sequence is a staged descent:

1. **Active Standby** — the SoC keeps running with networking up. This is the
   ~15 minute window where WoL works. `tvpowerd`'s
   `ActiveStandbyForcedOffTimer` ends it.
2. **Suspend** — a quick-start snapshot is written to eMMC, then…
3. **Zero-watt standby** — the micom (standby MCU) cuts power to nearly
   everything, *including the ethernet PHY*. The TV literally leaves the
   network (link down on your switch). No software can receive a packet in
   this state, and the next power-on is a cold boot.

Enabling the firmware's WoL setting (`wolwowlOnOff`) and Quick Start+ does
**not** prevent the descent. Linux-side WoL arming (`ethtool wol g`) is also
impossible: the SoC's ethernet (Synopsys stmmac, internal LG1K PHY) has no
wake interrupt wired up, and the SWOL ioctl returns ENOTSUPP.

Two independent mechanisms have to be defeated:

- The **suspend path**: `tvpowerd` makes the policy decision, but the actual
  kernel suspend is executed by `sleepd`, which still honors the classic webOS
  **activity** API. A continuously renewed activity blocks it.
- The **micom warmwait watchdog**: even with suspend blocked, the micom
  force-kills a warm standby after ~4 hours (`OFF_BY_WARMWAIT`, on the
  un-vetoable `powerOffReasonsForce` list). The escape hatch is LG's own
  **Always Ready** mode (`alwaysOn`): 24/7 warm standby is what that feature
  is *for*, so the micom sanctions it (`ON_BY_ALWAYSON`) and the watchdog
  never fires. Always Ready has a nightly deep-off window (default
  01:00–06:00) — WoL Keeper sets it to zero length.

One more wrinkle: processes launched from SSH or Homebrew Channel init.d hooks
live in `ls-hubd.service`'s cgroup and get cleaned up at suspend transitions —
which is why naive keepalive loops mysteriously die. WoL Keeper runs its
daemon under its own transient systemd unit with `Restart=always`: nothing
reaps it, and even if something kills it, systemd restarts it and the activity
is re-armed within seconds.

## What Enable does

1. **Saves your current Always Ready settings** to
   `/var/lib/webosbrew/wolkeeper.prev-alwayson.json`, so Disable can put back
   exactly what you had rather than assuming LG's defaults. Saved once — a
   second Enable won't overwrite it with WoL Keeper's own values.
2. Sets `alwaysOn=on` with a zero-length nightly disable window (settings
   persist across reboots; Always Ready itself is in the TV menu, but the
   window neutralization is not exposed in the UI).
3. Symlinks `/var/lib/webosbrew/init.d/98-wolkeeper` to the copy inside the
   app package. On every boot (cold boot, quick-start boot, or the TV's
   scheduled standby reboots) that hook recreates `wolkeeper.service` in
   `/run/systemd/system` (tmpfs — the read-only rootfs is never touched) and
   starts it.
4. The unit runs `wolkeeper.sh` **from the app directory**, renewing the sleepd
   activity `com.github.dangerouslaser.wolkeeper` (300 s) every 120 s and
   logging power-state changes to `/home/root/wolkeeper.log`.
5. **Verifies the result** and refuses to claim success otherwise: that the
   unit actually reached `active`, that `alwaysOn` reads back as `on`, and that
   the zero-length window stuck. If any of those fails it says so and shows
   `systemctl status` output rather than reporting a silent no-op.

Nothing is copied outside the package, so **uninstalling the app disarms it**:
the symlink dangles, the `[ -x ]` test in webosbrew's hook runner fails, and
nothing starts. The unit lives in tmpfs and is gone after the next boot. An app
update likewise takes effect on its own — there is only ever one copy of the
daemon, the one inside the package.

In this state the TV parks in warm standby with the network up. The TV still
performs its scheduled standby maintenance reboots (`REBOOT_ARREGULAR`,
roughly 6-hourly); the hook re-arms everything within seconds of each one —
expect a ~2 minute network gap around those.

## Trade-offs

- Warm standby keeps the SoC running, so standby power consumption is higher
  than the near-zero-watt deep state. That is inherent to keeping the ethernet
  PHY powered.
- Always Ready may enable voice wake-word and instant-on behaviors; check
  General → Always Ready in the TV settings if you care.

**Press Disable before uninstalling.** Disable restores your saved Always Ready
settings and removes everything else. Uninstalling the app on its own disarms
the daemon and the boot hook, but the `alwaysOn` override is a system setting —
it stays as WoL Keeper left it, with the app that knew how to undo it gone.
(The saved values are still readable at
`/var/lib/webosbrew/wolkeeper.prev-alwayson.json` if you need to put them back
by hand.)

## Compatibility

| | |
|---|---|
| **Requires** | webOS 22 or newer (starfish release ≥ 7.0), rooted, Homebrew Channel |
| **Verified on** | OLED77G5WUA, webOS 25 (10.3.0), FW 33.30.97 — 17 h overnight standby, reachable and wakeable throughout |
| **Unverified** | everything else — see below |

Two things set that floor. `systemctl` only exists from webOS 5 onwards, so on
webOS 4 and older the keepalive service cannot be started at all. And Always
Ready — the mechanism the whole design rests on — arrived with webOS 22 on the
2022 models, so webOS 5 and 6 sets have systemd but no `alwaysOn` to hold warm
standby open. The app checks for both up front and tells you if they're
missing, instead of reporting Enable as successful and doing nothing.

Between that floor and the G5 it was developed on, two things are genuinely
unverified, and **reports from other models — especially a different
generation — would settle them**:

- whether a transient unit dropped into `/run/systemd/system` is honoured the
  same way on other firmware versions; the unit directory layout and what is
  mounted read-only there varies.
- whether the zero-length disable window is interpreted the same everywhere. A
  firmware that reads start == end as "disabled all day" rather than "never
  disabled" would do exactly the opposite of what's intended.

If you try it, please [open an
issue](https://github.com/dangerouslaser/wolkeeper/issues) with your model,
webOS version and firmware version, and what the app reported — a failure
report is as useful as a success one.

## Install

Grab the `.ipk` from [Releases](../../releases) (or the Homebrew Channel once
accepted) and install it, then open **WoL Keeper** and press **Enable**.

Manual install without the app (`APP` is where the package was installed):

```sh
APP=/media/developer/apps/usr/palm/applications/com.github.dangerouslaser.wolkeeper

# save your current Always Ready settings first
luna-send -n 1 -f luna://com.webos.settingsservice/getSystemSettings \
  '{"category":"general","keys":["alwaysOn","alwaysOnDisableStartHour","alwaysOnDisableStartMinute","alwaysOnDisableEndHour","alwaysOnDisableEndMinute"]}'

luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings \
  '{"category":"general","settings":{"alwaysOn":"on","alwaysOnDisableStartHour":"6","alwaysOnDisableEndHour":"6","alwaysOnDisableStartMinute":"0","alwaysOnDisableEndMinute":"0"}}'

ln -sfn $APP/assets/98-wolkeeper /var/lib/webosbrew/init.d/98-wolkeeper
sh /var/lib/webosbrew/init.d/98-wolkeeper
systemctl is-active wolkeeper.service    # must print: active
```

## Uninstall / revert

Press **Disable** in the app, or, substituting the Always Ready values you
saved above:

```sh
luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings \
  '{"category":"general","settings":{"alwaysOn":"off","alwaysOnDisableStartHour":"1","alwaysOnDisableStartMinute":"0","alwaysOnDisableEndHour":"6","alwaysOnDisableEndMinute":"0"}}'
luna-send -a com.github.dangerouslaser.wolkeeper -n 1 \
  luna://com.webos.service.sleep/com/palm/power/activityEnd \
  '{"id":"com.github.dangerouslaser.wolkeeper"}'
systemctl stop wolkeeper.service
rm -f /run/systemd/system/wolkeeper.service \
      /var/lib/webosbrew/init.d/98-wolkeeper \
      /var/lib/webosbrew/wolkeeper.prev-alwayson.json \
      /home/root/wolkeeper.log
systemctl daemon-reload
```

Nothing outside `/var/lib/webosbrew`, `/home/root` (the log) and `/run` is ever
written.

## Notes

- Your WoL sender must be on the same L2 segment/VLAN as the TV (or your
  router must forward directed broadcasts).
- Upgrading from 0.1.0: the app id changed from `org.webosbrew.wolkeeper` to
  `com.github.dangerouslaser.wolkeeper` (the `org.webosbrew.` namespace is
  reserved for packages from github.com/webosbrew). Enable in 0.2.0 tears down
  0.1.0's `webosbrew-wolkeeper.service`, its activity and its copy of the
  daemon at `/home/root/wolkeeper.sh` before installing over them, so upgrading
  does not leave a second daemon behind. Uninstall the old app afterwards.

## Build

```sh
./build.sh          # produces com.github.dangerouslaser.wolkeeper_<version>_all.ipk
```
