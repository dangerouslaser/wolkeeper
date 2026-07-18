/* WoL Keeper — frontend. All privileged work goes through
 * org.webosbrew.hbchannel.service/exec (Homebrew Channel root shell),
 * same pattern as PicCap. */

var APP_DIR = '/media/developer/apps/usr/palm/applications/org.webosbrew.wolkeeper';
var HOOK = '/var/lib/webosbrew/init.d/98-wolkeeper';
var DAEMON = '/home/root/wolkeeper.sh';
var UNIT = 'webosbrew-wolkeeper.service';

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

function setDot(id, cls, text) {
  var d = document.getElementById('dot-' + id);
  d.className = 'dot' + (cls ? ' ' + cls : '');
  document.getElementById('v-' + id).textContent = text;
}

function log(text) {
  document.getElementById('log').textContent = text;
}

function refresh() {
  rootExec('echo ROOT_OK', function (r) {
    if (!r.returnValue || (r.stdoutString || '').indexOf('ROOT_OK') < 0) {
      setDot('root', 'bad', 'unavailable — is Homebrew Channel installed and rooted?');
      setDot('installed', '', 'unknown');
      setDot('unit', '', 'unknown');
      log('Cannot reach org.webosbrew.hbchannel.service/exec.\n' + JSON.stringify(r));
      return;
    }
    setDot('root', 'ok', 'available');
    rootExec(
      '[ -x ' + HOOK + ' ] && echo HOOK_YES || echo HOOK_NO; ' +
      'systemctl is-active ' + UNIT + ' 2>/dev/null || true; ' +
      'tail -n 5 /home/root/wolkeeper.log 2>/dev/null',
      function (s) {
        var out = s.stdoutString || '';
        setDot('installed', out.indexOf('HOOK_YES') >= 0 ? 'ok' : 'warn',
          out.indexOf('HOOK_YES') >= 0 ? 'installed' : 'not installed');
        var active = out.indexOf('\nactive') >= 0;
        setDot('unit', active ? 'ok' : 'warn', active ? 'running' : 'not running');
        var lines = out.split('\n').slice(2).join('\n').trim();
        log(lines || '(no log yet)');
      }
    );
    luna('luna://com.webos.settingsservice/getSystemSettings',
      { category: 'general', keys: ['alwaysOn'] },
      function (s) {
        var on = s.settings && s.settings.alwaysOn === 'on';
        setDot('ar', on ? 'ok' : 'warn', on ? 'on' : 'off');
      });
  });
}

/* Enable = the full verified fix:
 * 1. Always Ready ON with a zero-length nightly disable window — the micom's
 *    sanctioned 24/7 warm standby; prevents the ~4h OFF_BY_WARMWAIT watchdog.
 * 2. Keepalive unit holding a sleepd activity — belt-and-braces against the
 *    ordinary standby->suspend path. */
var AR_ON = '{"category":"general","settings":{"alwaysOn":"on",' +
  '"alwaysOnDisableStartHour":"6","alwaysOnDisableEndHour":"6",' +
  '"alwaysOnDisableStartMinute":"0","alwaysOnDisableEndMinute":"0"}}';
var AR_OFF = '{"category":"general","settings":{"alwaysOn":"off",' +
  '"alwaysOnDisableStartHour":"1","alwaysOnDisableEndHour":"6",' +
  '"alwaysOnDisableStartMinute":"0","alwaysOnDisableEndMinute":"0"}}';

function enable() {
  log('Installing…');
  rootExec(
    "luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings '" + AR_ON + "' && " +
    'cp ' + APP_DIR + '/assets/wolkeeper.sh ' + DAEMON + ' && ' +
    'cp ' + APP_DIR + '/assets/98-wolkeeper ' + HOOK + ' && ' +
    'chmod +x ' + DAEMON + ' ' + HOOK + ' && ' +
    'sh ' + HOOK + ' && echo ENABLE_OK',
    function (r) {
      log((r.stdoutString || '') + (r.stderrString || ''));
      setTimeout(refresh, 1500);
    }
  );
}

function disable() {
  log('Removing…');
  rootExec(
    "luna-send -n 1 luna://com.webos.settingsservice/setSystemSettings '" + AR_OFF + "'; " +
    'systemctl stop ' + UNIT + ' 2>/dev/null; ' +
    'rm -f /run/systemd/system/' + UNIT + ' ' + HOOK + ' ' + DAEMON + '; ' +
    'systemctl daemon-reload; echo DISABLE_OK',
    function (r) {
      log((r.stdoutString || '') + (r.stderrString || ''));
      setTimeout(refresh, 1500);
    }
  );
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
document.getElementById('btn-refresh').addEventListener('click', refresh);

window.addEventListener('load', function () {
  focusBtn(0);
  refresh();
});
