/* WoL Keeper — frontend.
 *
 * Every privileged action goes through the Homebrew Channel root shell
 * (luna://org.webosbrew.hbchannel.service/exec), same pattern as PicCap.
 *
 * Enable will not report success on trust: it checks up front that this firmware
 * has systemd and the Always Ready setting at all, and afterwards that the
 * keepalive unit actually reached `active` and that `alwaysOn` reads back as `on`
 * with the window we asked for. Anything else is reported as a failure with the
 * diagnostics attached, rather than as a silent no-op.
 */

var APP_ID  = 'com.github.dangerouslaser.wolkeeper';
var APP_DIR = '/media/developer/apps/usr/palm/applications/' + APP_ID;
var ASSETS  = APP_DIR + '/assets';
var HOOK    = '/var/lib/webosbrew/init.d/98-wolkeeper';
var UNIT    = 'wolkeeper.service';
var LOGFILE = '/home/root/wolkeeper.log';

/* Where the user's own Always Ready settings are parked while we override them.
 * Deliberately outside APP_DIR: an app update replaces the app directory, and
 * losing the stash would mean Disable could only guess at LG's defaults. */
var STASH = '/var/lib/webosbrew/wolkeeper.prev-alwayson.json';

/* Names used by 0.1.0 and by the old manual-install instructions. Enable clears
 * them out, so upgrading doesn't leave a second daemon and a stale activity. */
var OLD_ACTIVITY = 'org.webosbrew.wolkeeper';
var OLD_UNIT     = 'webosbrew-wolkeeper.service';
var OLD_DAEMON   = '/home/root/wolkeeper.sh';

var AR_KEYS = ['alwaysOn', 'alwaysOnDisableStartHour', 'alwaysOnDisableStartMinute',
               'alwaysOnDisableEndHour', 'alwaysOnDisableEndMinute'];

/* Always Ready on, with a zero-length nightly disable window: 24/7 warm standby
 * is what the feature is for, so the micom sanctions it (ON_BY_ALWAYSON) and the
 * ~4 h OFF_BY_WARMWAIT watchdog never fires. */
var AR_ON = {
  alwaysOn: 'on',
  alwaysOnDisableStartHour: '6', alwaysOnDisableStartMinute: '0',
  alwaysOnDisableEndHour: '6',   alwaysOnDisableEndMinute: '0'
};

/* LG's stock values. Only used by Disable when there is no stash to restore —
 * e.g. someone enabled with 0.1.0, which didn't save anything. */
var AR_STOCK = {
  alwaysOn: 'off',
  alwaysOnDisableStartHour: '1', alwaysOnDisableStartMinute: '0',
  alwaysOnDisableEndHour: '6',   alwaysOnDisableEndMinute: '0'
};

var NEED_RELEASE = 'WoL Keeper needs webOS 22 (release 7.0) or newer.';

/* --- plumbing --- */

function luna(uri, params, cb) {
  var bridge = new PalmServiceBridge();
  bridge.onservicecallback = function (msg) {
    var r;
    try { r = JSON.parse(msg); } catch (e) { r = { returnValue: false, errorText: String(msg) }; }
    cb(r);
  };
  bridge.call(uri, JSON.stringify(params || {}));
}

function rootExec(command, cb) {
  luna('luna://org.webosbrew.hbchannel.service/exec', { command: command }, cb);
}

/* Whether the Homebrew Channel service is reachable and running as root. exec
 * runs as whatever user that service runs as, so a successful exec proves
 * nothing about uid; getConfiguration reports it (root: process.getuid() === 0).
 * cb(null) when the call fails, else cb(the response). */
function checkRoot(cb) {
  luna('luna://org.webosbrew.hbchannel.service/getConfiguration', {}, function (r) {
    cb(r && r.returnValue ? r : null);
  });
}

/* Single-quote a value for the shell. */
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/* luna-send prints the response payload; be tolerant of anything around it. */
function parseJson(text) {
  if (!text) return null;
  var a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { return null; }
}

function settingsGetCmd() {
  return 'luna-send -n 1 -f luna://com.webos.settingsservice/getSystemSettings ' +
         sq(JSON.stringify({ category: 'general', keys: AR_KEYS }));
}

function settingsSetCmd(settings) {
  return 'luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings ' +
         sq(JSON.stringify({ category: 'general', settings: settings }));
}

function activityEndCmd(id) {
  return 'luna-send -a ' + APP_ID + ' -n 1 ' +
         'luna://com.webos.service.sleep/com/palm/power/activityEnd ' +
         sq(JSON.stringify({ id: id })) + ' >/dev/null 2>&1';
}

/* Reads the alwaysOn* keys through the root shell rather than the app's own
 * service bridge: writing them needs root anyway, and this way a read and the
 * write that follows it can never disagree about permissions. */
function readAlwaysOn(cb) {
  rootExec(settingsGetCmd(), function (r) {
    var p = parseJson(r && r.stdoutString);
    cb(p && p.returnValue && p.settings ? p.settings : null);
  });
}

function pick(settings) {
  if (!settings) return null;
  var out = {}, n = 0, i;
  for (i = 0; i < AR_KEYS.length; i++) {
    if (typeof settings[AR_KEYS[i]] !== 'undefined') { out[AR_KEYS[i]] = settings[AR_KEYS[i]]; n++; }
  }
  return n ? out : null;
}

function pad2(v) {
  v = String(typeof v === 'undefined' ? '?' : v);
  return v.length < 2 ? '0' + v : v;
}

function windowText(s) {
  if (!s) return 'unknown';
  return pad2(s.alwaysOnDisableStartHour) + ':' + pad2(s.alwaysOnDisableStartMinute) +
         '–' + pad2(s.alwaysOnDisableEndHour) + ':' + pad2(s.alwaysOnDisableEndMinute);
}

function sameWindow(a, b) {
  for (var i = 1; i < AR_KEYS.length; i++) {
    if (String(a[AR_KEYS[i]]) !== String(b[AR_KEYS[i]])) return false;
  }
  return true;
}

/* --- ui --- */

var busy = false;

/* Report from the last Enable/Disable. Kept in the log pane until the user
 * presses Refresh: the automatic refresh that follows an action must not
 * overwrite the verification result with the daemon's log tail. */
var lastResult = null;

function setDot(id, cls, text) {
  document.getElementById('dot-' + id).className = 'dot' + (cls ? ' ' + cls : '');
  document.getElementById('v-' + id).textContent = text;
}

function log(text) {
  document.getElementById('log').textContent = text;
}

function setBusy(b) {
  busy = b;
  var i;
  for (i = 0; i < buttons.length; i++) document.getElementById(buttons[i]).disabled = b;
}

function finish(text) {
  lastResult = text;
  log(text);
  setBusy(false);
  setTimeout(refresh, 500);
}

function collectDiagnostics(cb) {
  rootExec('systemctl status ' + UNIT + ' 2>&1 | head -n 12; ' +
           'echo "--- ' + LOGFILE + ' ---"; tail -n 10 ' + LOGFILE + ' 2>/dev/null',
    function (r) { cb(((r && r.stdoutString) || '') + ((r && r.stderrString) || '')); });
}

/* systemctl is-active exits non-zero when the unit isn't running, and reports
 * `activating` while it is still coming up — poll briefly before believing it. */
function waitForUnit(tries, cb) {
  rootExec('systemctl is-active ' + UNIT + ' 2>/dev/null || true', function (r) {
    var state = (((r && r.stdoutString) || '').trim().split('\n').pop() || 'unknown').trim();
    if (state === 'active' || tries <= 1) { cb(state || 'unknown'); return; }
    setTimeout(function () { waitForUnit(tries - 1, cb); }, 2000);
  });
}

/* --- status --- */

function probeCmd() {
  return 'echo ROOT_OK; ' +
    'command -v systemctl >/dev/null 2>&1 && echo SYSTEMD_YES || echo SYSTEMD_NO; ' +
    '[ -L ' + HOOK + ' ] && echo HOOK_LINK || echo HOOK_NOLINK; ' +
    '[ -x ' + HOOK + ' ] && echo HOOK_OK || echo HOOK_NO; ' +
    'echo UNIT:$(systemctl is-active ' + UNIT + ' 2>/dev/null || echo unavailable); ' +
    'echo "---LOG---"; tail -n 6 ' + LOGFILE + ' 2>/dev/null || true';
}

function refresh() {
  setDot('root', '', 'checking…');
  checkRoot(function (c) {
    if (!c || c.root !== true) {
      setDot('root', 'bad', !c ? 'unavailable — is Homebrew Channel installed and rooted?'
                               : 'unavailable — Homebrew Channel is not running as root');
      setDot('fw', '', 'unknown');
      setDot('ar', '', 'unknown');
      setDot('installed', '', 'unknown');
      setDot('unit', '', 'unknown');
      log(!c ? 'Cannot reach luna://org.webosbrew.hbchannel.service.\n' +
               'WoL Keeper needs a rooted TV with Homebrew Channel and root access enabled.'
             : 'Homebrew Channel is installed but is not running as root.\n' +
               'WoL Keeper needs a rooted TV with Homebrew Channel and root access enabled.');
      return;
    }
    refreshProbe();
  });
}

function refreshProbe() {
  rootExec(probeCmd(), function (r) {
    var out = (r && r.stdoutString) || '';
    if (!r || !r.returnValue || out.indexOf('ROOT_OK') < 0) {
      setDot('root', 'bad', 'unavailable — is Homebrew Channel installed and rooted?');
      setDot('fw', '', 'unknown');
      setDot('ar', '', 'unknown');
      setDot('installed', '', 'unknown');
      setDot('unit', '', 'unknown');
      log('Cannot reach luna://org.webosbrew.hbchannel.service/exec.\n' +
          'WoL Keeper needs a rooted TV with Homebrew Channel and root access enabled.\n' +
          JSON.stringify(r));
      return;
    }
    setDot('root', 'ok', 'available');

    var hasSystemd = out.indexOf('SYSTEMD_YES') >= 0;
    var hookOk     = out.indexOf('HOOK_OK') >= 0;
    var hookLink   = out.indexOf('HOOK_LINK') >= 0;
    var unitState  = (out.match(/UNIT:(\S*)/) || [])[1] || 'unknown';
    var tail       = out.split('---LOG---')[1];

    if (!hookOk) {
      setDot('installed', 'warn', hookLink ? 'broken link — reinstall the app' : 'not installed');
    } else {
      setDot('installed', 'ok', hookLink ? 'installed (symlink into app)' : 'installed (stale copy — press Enable)');
    }
    setDot('unit', unitState === 'active' ? 'ok' : 'warn',
           unitState === 'active' ? 'running' : unitState);

    readAlwaysOn(function (s) {
      var supported = hasSystemd && s && typeof s.alwaysOn !== 'undefined';
      if (!hasSystemd) {
        setDot('fw', 'bad', 'no systemd — cannot work on this TV');
      } else if (!s || typeof s.alwaysOn === 'undefined') {
        setDot('fw', 'bad', 'no Always Ready setting — cannot work on this TV');
      } else {
        setDot('fw', 'ok', 'systemd + Always Ready present');
      }

      if (!s || typeof s.alwaysOn === 'undefined') {
        setDot('ar', '', 'unavailable');
      } else if (s.alwaysOn !== 'on') {
        setDot('ar', 'warn', 'off');
      } else {
        setDot('ar', sameWindow(s, AR_ON) ? 'ok' : 'warn',
               'on, nightly disable window ' + windowText(s) +
               (sameWindow(s, AR_ON) ? ' (neutralised)' : ' (still active — press Enable)'));
      }

      if (!supported) {
        log(lastResult ||
            ('This TV cannot run WoL Keeper.\n' +
             (hasSystemd ? 'The Always Ready (alwaysOn) setting is not present on this firmware.\n'
                         : 'This firmware has no systemd, so the keepalive service cannot be started.\n') +
             NEED_RELEASE));
        return;
      }
      log(lastResult || (tail && tail.trim()) || '(no log yet — press Enable)');
    });
  });
}

/* --- enable --- */

/* True when the settings already are what Enable writes. Then they are almost
 * certainly ours, not the user's — 0.1.0 applied the same override without
 * saving anything first, and a zero-length window isn't settable from the TV
 * menu. Stashing them would record our own override as the user's preference,
 * so leave the stash alone and let Disable fall back to LG's defaults. */
function isOurOverride(s) {
  return !!s && s.alwaysOn === 'on' && sameWindow(s, AR_ON);
}

function enable() {
  if (busy) return;
  setBusy(true);
  log('Checking prerequisites…');
  checkRoot(function (c) {
    if (!c || c.root !== true) {
      finish('Not enabled: no root access.\n' +
             (c ? 'Homebrew Channel is installed but is not running as root.\n' : '') +
             'WoL Keeper needs a rooted TV with Homebrew Channel and root access enabled.');
      return;
    }
    enableCheck();
  });
}

function enableCheck() {
  rootExec(
    'echo ROOT_OK; ' +
    'command -v systemctl >/dev/null 2>&1 && echo SYSTEMD_YES || echo SYSTEMD_NO; ' +
    '[ -f ' + STASH + ' ] && echo STASH_YES || echo STASH_NO; ' +
    '[ -f ' + ASSETS + '/98-wolkeeper ] && [ -f ' + ASSETS + '/wolkeeper.sh ] && echo ASSETS_YES || echo ASSETS_NO',
    function (r) {
      var out = (r && r.stdoutString) || '';
      if (!r || !r.returnValue || out.indexOf('ROOT_OK') < 0) {
        finish('Not enabled: no root access.\n' +
               'WoL Keeper needs a rooted TV with Homebrew Channel and root access enabled.');
        return;
      }
      if (out.indexOf('SYSTEMD_NO') >= 0) {
        finish('Not enabled: this firmware has no systemd, so the keepalive service cannot\n' +
               'be started and WoL Keeper cannot work on this TV. ' + NEED_RELEASE);
        return;
      }
      if (out.indexOf('ASSETS_NO') >= 0) {
        finish('Not enabled: the app assets are missing from\n  ' + ASSETS + '\nReinstall WoL Keeper.');
        return;
      }
      enableReadSettings({ hadStash: out.indexOf('STASH_YES') >= 0 });
    });
}

function enableReadSettings(ctx) {
  log('Reading current Always Ready settings…');
  readAlwaysOn(function (s) {
    if (!s || typeof s.alwaysOn === 'undefined') {
      finish('Not enabled: this firmware does not expose the Always Ready (alwaysOn)\n' +
             'setting, which is the only sanctioned way to keep the TV in warm standby.\n' +
             NEED_RELEASE);
      return;
    }
    ctx.prev = pick(s);
    enableApply(ctx);
  });
}

function enableApply(ctx) {
  log('Applying…');

  /* Saved once, and never when the values are already ours. */
  ctx.saveNow = !ctx.hadStash && !isOurOverride(ctx.prev);
  var stash = JSON.stringify({
    note: 'Always Ready settings as they were before WoL Keeper changed them. ' +
          'Press Disable in the app to put them back, or restore them by hand with ' +
          'luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings.',
    savedAt: new Date().toISOString(),
    settings: ctx.prev
  });

  var cmd = ['mkdir -p /var/lib/webosbrew/init.d'];
  if (ctx.saveNow) {
    cmd.push('[ -f ' + STASH + ' ] || printf %s ' + sq(stash) + ' > ' + STASH);
  }
  cmd = cmd.concat([
    /* Tear down 0.1.0 / manual-install leftovers before installing over them. */
    'systemctl stop ' + OLD_UNIT + ' 2>/dev/null',
    activityEndCmd(OLD_ACTIVITY),
    'rm -f /run/systemd/system/' + OLD_UNIT + ' ' + OLD_DAEMON,

    settingsSetCmd(AR_ON),

    /* Symlink, not a copy: uninstalling the app leaves a dangling link, the
     * hook runner's [ -x ] test fails, and nothing starts. */
    'ln -sfn ' + ASSETS + '/98-wolkeeper ' + HOOK,
    'sh ' + HOOK,
    'echo APPLIED'
  ]).join('; ');

  rootExec(cmd, function (r) {
    var out = ((r && r.stdoutString) || '') + ((r && r.stderrString) || '');
    if (out.indexOf('APPLIED') < 0) {
      finish('Not enabled: the install commands did not run to completion.\n\n' + out);
      return;
    }
    enableVerify(ctx);
  });
}

function enableVerify(ctx) {
  log('Verifying…');
  waitForUnit(4, function (unitState) {
    readAlwaysOn(function (now) {
      var problems = [];
      if (unitState !== 'active') {
        problems.push('the keepalive service is "' + unitState + '", not "active" — the transient ' +
                      'unit in /run/systemd/system was not honoured on this firmware');
      }
      if (!now || now.alwaysOn !== 'on') {
        problems.push('Always Ready did not switch on (alwaysOn reads back as "' +
                      ((now && now.alwaysOn) || 'unavailable') + '") — without it the micom ' +
                      'force-kills warm standby after about 4 hours');
      } else if (!sameWindow(now, AR_ON)) {
        problems.push('the nightly disable window did not take the zero-length values ' +
                      '(reads back ' + windowText(now) + ') — the TV will still drop off the ' +
                      'network during that window');
      }

      if (problems.length) {
        collectDiagnostics(function (diag) {
          finish('NOT working — ' + problems.join('.\n\nAlso: ') + '.\n\n' +
                 'Please report this with your TV model and firmware version at\n' +
                 'https://github.com/dangerouslaser/wolkeeper/issues\n\n' + diag);
        });
        return;
      }

      var restoreNote;
      if (ctx.hadStash) {
        restoreNote = '  • Your earlier Always Ready settings are still saved in ' + STASH;
      } else if (ctx.saveNow) {
        restoreNote = '  • Previous Always Ready settings saved to ' + STASH;
      } else {
        restoreNote = '  • Always Ready was already set the way WoL Keeper sets it and nothing\n' +
                      '    was saved to restore (upgraded from 0.1.0?), so Disable will put back\n' +
                      "    LG's defaults: off, 01:00–06:00.";
      }

      finish('Enabled, and verified:\n' +
             '  • Always Ready: on, nightly disable window ' + windowText(now) + ' (zero length)\n' +
             '  • Keepalive service: active\n' +
             '  • Boot hook: ' + HOOK + ' → ' + ASSETS + '/98-wolkeeper\n' +
             restoreNote + '\n\n' +
             'The TV should now stay reachable on ethernet in standby. Press Disable to\n' +
             'put everything back — and press it before uninstalling the app, or the\n' +
             'Always Ready override stays behind with nothing left to undo it.');
    });
  });
}

/* --- disable --- */

function disable() {
  if (busy) return;
  setBusy(true);
  log('Reverting…');
  rootExec('cat ' + STASH + ' 2>/dev/null', function (r) {
    var stash = parseJson(r && r.stdoutString);
    var restore = pick(stash && stash.settings);
    var stock = !restore;
    if (stock) restore = AR_STOCK;

    var cmd = [
      'systemctl stop ' + UNIT + ' 2>/dev/null',
      'systemctl stop ' + OLD_UNIT + ' 2>/dev/null',
      activityEndCmd(APP_ID),
      activityEndCmd(OLD_ACTIVITY),
      settingsSetCmd(restore),
      'rm -f /run/systemd/system/' + UNIT + ' /run/systemd/system/' + OLD_UNIT + ' ' +
        HOOK + ' ' + OLD_DAEMON + ' ' + STASH + ' ' + LOGFILE,
      'systemctl daemon-reload 2>/dev/null',
      'echo REVERTED'
    ].join('; ');

    rootExec(cmd, function (r2) {
      var out = ((r2 && r2.stdoutString) || '') + ((r2 && r2.stderrString) || '');
      if (out.indexOf('REVERTED') < 0) {
        finish('Disable did not run to completion.\n\n' + out);
        return;
      }
      disableVerify(restore, stock);
    });
  });
}

function disableVerify(restore, stock) {
  log('Verifying…');
  rootExec('[ -e ' + HOOK + ' ] && echo HOOK_LEFT || echo HOOK_GONE; ' +
           'echo UNIT:$(systemctl is-active ' + UNIT + ' 2>/dev/null || echo inactive)',
    function (r) {
      var out = (r && r.stdoutString) || '';
      var unitState = (out.match(/UNIT:(\S*)/) || [])[1] || 'unknown';
      readAlwaysOn(function (now) {
        var problems = [];
        if (out.indexOf('HOOK_GONE') < 0) problems.push('the boot hook is still at ' + HOOK);
        if (unitState === 'active') problems.push('the keepalive service is still running');
        if (now && String(now.alwaysOn) !== String(restore.alwaysOn)) {
          problems.push('Always Ready reads back as "' + now.alwaysOn + '" instead of "' +
                        restore.alwaysOn + '"');
        }

        if (problems.length) {
          finish('Disable did not fully revert — ' + problems.join('; ') + '.');
          return;
        }
        finish('Disabled, and verified:\n' +
               '  • Always Ready: ' + restore.alwaysOn + ', nightly disable window ' +
                 windowText(restore) +
                 (stock ? ' (LG defaults — nothing was saved to restore)'
                        : ' (your settings from before Enable)') + '\n' +
               '  • Keepalive service: stopped, boot hook and unit removed\n\n' +
               'Ethernet WoL is back to stock behaviour: it stops working roughly 15\n' +
               'minutes after the TV goes into standby.');
      });
    });
}

/* --- remote-control navigation --- */

var buttons = ['btn-enable', 'btn-disable', 'btn-refresh'];
var focusIdx = 0;

function focusBtn(i) {
  focusIdx = (i + buttons.length) % buttons.length;
  document.getElementById(buttons[focusIdx]).focus();
}

document.addEventListener('keydown', function (e) {
  if (e.keyCode === 37) { focusBtn(focusIdx - 1); e.preventDefault(); }      // left
  else if (e.keyCode === 39) { focusBtn(focusIdx + 1); e.preventDefault(); } // right
});

document.getElementById('btn-enable').addEventListener('click', enable);
document.getElementById('btn-disable').addEventListener('click', disable);
document.getElementById('btn-refresh').addEventListener('click', function () {
  if (busy) return;
  lastResult = null;   // an explicit Refresh drops the last report and shows the log
  refresh();
});

window.addEventListener('load', function () {
  focusBtn(0);
  refresh();
});
