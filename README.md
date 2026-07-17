# ⚡ WoL Keeper

**Keep ethernet Wake-on-LAN working *forever* on rooted LG webOS TVs.**

Stock behavior on recent LG TVs (verified on a 2025 G5, webOS 25): after you turn
the TV off with the remote, Wake-on-LAN works for only ~15 minutes. Then the TV
drops off the network entirely and magic packets do nothing — the only way to
turn it on is the remote. WoL Keeper fixes that: the TV stays reachable and
WoL-wakeable in standby indefinitely.

Requires a [rooted TV](https://rootmy.tv/) with
[Homebrew Channel](https://github.com/webosbrew/webos-homebrew-channel).

## Why this happens (the root cause)

LG's power-off sequence is a three-stage descent:

1. **Active Standby** — the SoC keeps running with networking up. This is the
   ~15 minute window where WoL works. `tvpowerd`'s
   `ActiveStandbyForcedOffTimer` ends it.
2. **Suspend** — a CRIU/hibernation snapshot is written to eMMC, then…
3. **Zero-watt standby** — the micom (standby MCU) cuts power to nearly
   everything, *including the ethernet PHY*. The TV literally leaves the
   network (link down on your switch). No software can receive a packet in this
   state, and the next remote power-on is a cold boot.

Enabling the firmware's WoL setting (`wolwowlOnOff`) and Quick Start+ does
**not** prevent the descent. Linux-side WoL arming (`ethtool wol g`) is also
impossible: the SoC's ethernet (Synopsys stmmac, internal LG1K PHY) has no wake
interrupt wired up, and the SWOL ioctl returns ENOTSUPP.

However: while `tvpowerd` makes the *policy* decision, the actual kernel
suspend is executed by `sleepd`, which still honors the classic webOS
**activity** API. As long as an activity is being renewed, the suspend never
executes and the TV parks in Active Standby with the network alive.

The reason naive keepalive loops (from SSH or an init.d hook) die is that they
live in `ls-hubd.service`'s cgroup and get cleaned up at the suspend
transition. The fix is to run the keepalive under its own transient systemd
unit with `Restart=always` — nothing reaps it, and even if something kills it,
systemd restarts it and the activity is re-armed within seconds.

## How it works

- `wolkeeper.sh` — daemon that renews the sleepd activity
  `org.webosbrew.wolkeeper` (300 s duration) every 120 s and logs power-state
  changes to `/home/root/wolkeeper.log`.
- `98-wolkeeper` — a Homebrew Channel startup hook
  (`/var/lib/webosbrew/init.d/`) that on every boot writes
  `webosbrew-wolkeeper.service` into `/run/systemd/system` (tmpfs — the
  read-only rootfs is never touched) and starts it.
- The TV app is just a thin installer/status UI on top of these two files,
  using `org.webosbrew.hbchannel.service/exec` for the privileged bits.

The TV's own 24-hour instant-boot snapshot refresh (it reboots itself in
standby once a day) is handled automatically: the hook re-runs on that boot and
the TV settles back into held Active Standby.

## Trade-off

Held Active Standby keeps the SoC running, so standby power consumption is
higher than the near-zero-watt deep state. That is inherent to keeping the
ethernet PHY powered. If you want deep sleep back, just press Disable in the
app (or delete the two files).

## Install

Grab the `.ipk` from [Releases](../../releases) (or the Homebrew Channel once
accepted) and install it, then open **WoL Keeper** and press **Enable**.

Manual install without the app:

```sh
cp daemon/wolkeeper.sh /home/root/wolkeeper.sh
cp daemon/98-wolkeeper /var/lib/webosbrew/init.d/98-wolkeeper
chmod +x /home/root/wolkeeper.sh /var/lib/webosbrew/init.d/98-wolkeeper
sh /var/lib/webosbrew/init.d/98-wolkeeper
```

## Uninstall / revert

Press **Disable** in the app, or:

```sh
systemctl stop webosbrew-wolkeeper.service
rm -f /run/systemd/system/webosbrew-wolkeeper.service \
      /var/lib/webosbrew/init.d/98-wolkeeper /home/root/wolkeeper.sh
systemctl daemon-reload
```

Nothing outside `/var`, `/home/root`, and `/run` is ever written.

## Notes

- Your WoL sender must be on the same L2 segment/VLAN as the TV (or your router
  must forward directed broadcasts).
- Verified on: OLED77G5WUA, webOS 25 (10.3.0), FW 33.30.97. Reports from other
  models welcome — the mechanism (sleepd activities + systemd) should apply to
  other recent webOS versions.

## Build

```sh
./build.sh          # produces org.webosbrew.wolkeeper_<version>_all.ipk
```
