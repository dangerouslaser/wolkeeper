# ⚡ WoL Keeper

**Keep ethernet Wake-on-LAN working *forever* on rooted LG webOS TVs.**

Stock behavior on recent LG TVs (verified on a 2025 G5, webOS 25): after you
turn the TV off with the remote, Wake-on-LAN works for only ~15 minutes. Then
the TV drops off the network entirely and magic packets do nothing — the only
way to turn it on is the remote. WoL Keeper fixes that: the TV stays reachable
and WoL-wakeable in standby indefinitely (verified across 17+ hour overnight
standby, including the TV's own scheduled standby reboots).

Requires a [rooted TV](https://rootmy.tv/) with
[Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).

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

1. Sets `alwaysOn=on` with a zero-length nightly disable window
   (settings persist across reboots; also reachable in the TV menu, but the
   window neutralization is not exposed in the UI).
2. Installs `/home/root/wolkeeper.sh` — daemon renewing the sleepd activity
   `org.webosbrew.wolkeeper` (300 s) every 120 s; logs power-state changes to
   `/home/root/wolkeeper.log`.
3. Installs `/var/lib/webosbrew/init.d/98-wolkeeper` — on every boot (cold
   boot, quick-start boot, or the TV's scheduled standby reboots) recreates
   `webosbrew-wolkeeper.service` in `/run/systemd/system` (tmpfs — the
   read-only rootfs is never touched) and starts it.

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

Fully reversible: Disable restores `alwaysOn=off`, the stock 01:00–06:00
window, and removes every installed file.

## Install

Grab the `.ipk` from [Releases](../../releases) (or the Homebrew Channel once
accepted) and install it, then open **WoL Keeper** and press **Enable**.

Manual install without the app:

```sh
luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings \
  '{"category":"general","settings":{"alwaysOn":"on","alwaysOnDisableStartHour":"6","alwaysOnDisableEndHour":"6","alwaysOnDisableStartMinute":"0","alwaysOnDisableEndMinute":"0"}}'
cp daemon/wolkeeper.sh /home/root/wolkeeper.sh
cp daemon/98-wolkeeper /var/lib/webosbrew/init.d/98-wolkeeper
chmod +x /home/root/wolkeeper.sh /var/lib/webosbrew/init.d/98-wolkeeper
sh /var/lib/webosbrew/init.d/98-wolkeeper
```

## Uninstall / revert

Press **Disable** in the app, or:

```sh
luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings \
  '{"category":"general","settings":{"alwaysOn":"off","alwaysOnDisableStartHour":"1","alwaysOnDisableEndHour":"6"}}'
systemctl stop webosbrew-wolkeeper.service
rm -f /run/systemd/system/webosbrew-wolkeeper.service \
      /var/lib/webosbrew/init.d/98-wolkeeper /home/root/wolkeeper.sh
systemctl daemon-reload
```

Nothing outside `/var`, `/home/root`, and `/run` is ever written.

## Notes

- Your WoL sender must be on the same L2 segment/VLAN as the TV (or your
  router must forward directed broadcasts).
- Verified on: OLED77G5WUA, webOS 25 (10.3.0), FW 33.30.97 — 17 h overnight
  standby with the TV remaining reachable and wakeable throughout. Reports
  from other models welcome; the mechanisms (Always Ready, sleepd activities,
  systemd) should apply to other recent webOS versions.

## Build

```sh
./build.sh          # produces org.webosbrew.wolkeeper_<version>_all.ipk
```
