"""Trusted QGA action: install QA hooks and restart only the guest browser.

Input is bounded JSON data from the main process, never renderer-supplied code.
No host mounts, browser debugging ports, or guest network listeners are used.
"""
import json
import hashlib
import base64
import os
import pathlib
import subprocess
import sys
import time
import socket
import pwd

payload = json.loads(sys.argv[1])
if len(sys.argv[1]) > 65536:
    raise ValueError("Oversized telemetry deployment")
state_path = pathlib.Path("/run/platypus/workspace.json")
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    if state_path.exists() and subprocess.run(["pgrep", "-u", "workspace", "-x", "chromium"], stdout=subprocess.DEVNULL).returncode == 0:
        break
    time.sleep(1)
else:
    raise RuntimeError("The guest desktop did not become ready")
state = json.loads(state_path.read_text())
if state["workspaceId"] != payload["workspaceId"]:
    raise ValueError("Workspace identity mismatch")
runtime = payload.get("runtime") or {}
# Stop the extension host before replacing its files. Updating an unpacked
# extension while Chromium is watching it can invalidate the loaded extension.
subprocess.run(["pkill", "-TERM", "-u", "workspace", "-x", "chromium"], check=False)
for _ in range(100):
    if subprocess.run(["pgrep", "-u", "workspace", "-x", "chromium"], stdout=subprocess.DEVNULL).returncode != 0:
        break
    time.sleep(0.1)
else:
    raise RuntimeError("Chromium did not close; refusing to overlap browser instances")
extension = pathlib.Path("/opt/platypus/runtime-extension")
extension.mkdir(parents=True, exist_ok=True)
source_name = "runtime-" + hashlib.sha256(payload["source"].encode()).hexdigest()[:24] + ".js"
(extension / source_name).write_text(payload["source"])
nonce = os.urandom(16).hex()
cookie_import = pathlib.Path("/run/platypus-session-import.json")
if payload.get("hydrateCookies"):
    cookies = json.loads(cookie_import.read_text())
    if not isinstance(cookies, list) or len(cookies) > 3000:
        raise ValueError("Invalid guest cookie import")
    cookie_import.write_text(json.dumps({"nonce": nonce, "cookies": cookies}))
    cookie_import.chmod(0o600)
    account = pwd.getpwnam("workspace")
    os.chown(cookie_import, account.pw_uid, account.pw_gid)
ready_name = "ready-" + nonce + ".js"
(extension / ready_name).write_text("""
let started=false;
async function signal(){
 if(started)return;started=true;
 try {
  const nonce=NONCE;
  if(HYDRATE){
   let offset=0;
   while(true){
    const batch=await chrome.runtime.sendNativeMessage('org.platypus.qa_ready',{nonce,action:'cookies',offset});
    if(!batch || !Array.isArray(batch.cookies))throw new Error('Cookie transfer failed');
    for(const cookie of batch.cookies){
     if(cookie.expirationDate !== undefined && cookie.expirationDate <= Date.now()/1000)continue;
     await chrome.cookies.set(cookie);
    }
    offset+=batch.cookies.length;
    if(batch.done)break;
    if(!batch.cookies.length)throw new Error('Cookie transfer stalled');
   }
  }
  await chrome.runtime.sendNativeMessage('org.platypus.qa_ready',{nonce});
 }catch(e){console.error('Workspace cookie hydration failed');}
}
chrome.runtime.onInstalled.addListener(signal);chrome.runtime.onStartup.addListener(signal);signal();
""".replace("NONCE", json.dumps(nonce)).replace("HYDRATE", json.dumps(bool(payload.get("hydrateCookies")))))
# Public key pins an unpacked extension ID, not a secret signing credential.
public_key = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAm+AikptM0BqM4zZG8ht0IIIAsclS1997gsAqw74iuYmqgayZvqfPmGDOEG6lPuoFqPZgFJxit2tHlrLdIs0V2+V6JHuvK5NhyKRmLic0d7QfL/NkfQvzWYQ3aVjHN6rbCeTYb0GxX5Gs3f3q0EFdSwZgCq6g2Gx6XsIOirCkEaw/BTpZ0a7fgKxAjCcpY+kqnqxy75CNzMSOkpwf2+MeivdYZkz0NZ+fSF+dbqcLMlsgXwGvaevEx05FtClpcFXoGFM+cwbz5xKT/+HGxAg+CEfbBTnu8jodhBlOdRt7LdLP89+TO0wYtAWAyJ8dVgc15euKZV3PoT78xIlcFDwrGwIDAQAB"
extension_id = "".join(chr(97 + int(c, 16)) for c in hashlib.sha256(base64.b64decode(public_key)).hexdigest()[:32])
native_host = pathlib.Path("/usr/local/lib/platypus/qa-ready.py")
native_host.write_text(payload["readyHost"])
native_host.chmod(0o755)
native_directory = pathlib.Path("/etc/chromium/native-messaging-hosts")
native_directory.mkdir(parents=True, exist_ok=True)
(native_directory / "org.platypus.qa_ready.json").write_text(json.dumps({"name": "org.platypus.qa_ready", "description": "QA extension readiness only",
    "path": str(native_host), "type": "stdio", "allowed_origins": ["chrome-extension://" + extension_id + "/"]}))
ready_path = pathlib.Path("/home/workspace/.cache/platypus-qa/ready")
ready_path.unlink(missing_ok=True)
stamp = int(time.time())
(extension / "manifest.json").write_text(json.dumps({"manifest_version": 3, "name": "Platypus QA telemetry simulation",
    "key": public_key, "permissions": ["nativeMessaging", "cookies"], "host_permissions": ["http://*/*", "https://*/*"], "background": {"service_worker": ready_name},
    "version": "2.%d.%d.%d" % ((stamp // 65536) % 65536, stamp % 65536, int.from_bytes(os.urandom(2))),
    "content_scripts": [{"matches": ["<all_urls>"], "js": [source_name], "run_at": "document_start", "world": "MAIN", "all_frames": True, "match_about_blank": True}]}))
policy_dir = pathlib.Path("/etc/chromium/policies/managed")
policy_dir.mkdir(parents=True, exist_ok=True)
(policy_dir / "platypus.json").write_text(json.dumps({"WebRtcIPHandling": "disable_non_proxied_udp", "QuicAllowed": False,
    "DnsOverHttpsMode": "off", "NetworkPredictionOptions": 2, "AudioCaptureAllowed": False, "VideoCaptureAllowed": False,
    "RestoreOnStartup": 5, "BackgroundModeEnabled": False}))
state["browser"].update({"runtime": payload.get("runtime"), "startUrl": payload["startUrl"]})
state_path.write_text(json.dumps(state))
args = ["/usr/bin/chromium", "--no-first-run", "--no-default-browser-check", "--start-maximized", "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--user-data-dir=/home/workspace/.config/chromium",
    "--load-extension=/opt/platypus/runtime-extension", "--disable-extensions-except=/opt/platypus/runtime-extension"]
if payload.get("proxy"):
    def proxy_ready():
        try:
            with socket.create_connection(("127.0.0.1", 1080), timeout=1):
                return True
        except OSError:
            return False
    if not proxy_ready():
        proxy_path = pathlib.Path("/usr/local/lib/platypus/proxy-mux.py")
        proxy_path.write_text(payload["proxyMux"])
        proxy_path.chmod(0o755)
        with open("/run/platypus/proxy.log", "wb", buffering=0) as log:
            subprocess.Popen(["runuser", "-u", "workspace", "--", "/usr/bin/python3", str(proxy_path)],
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        for _ in range(100):
            if proxy_ready():
                break
            time.sleep(0.1)
        else:
            raise RuntimeError("Workspace proxy gateway did not become ready")
    args.extend(["--proxy-server=socks5://127.0.0.1:1080", "--proxy-bypass-list=<-loopback>",
                 "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"])
if runtime.get("userAgent"):
    args.append("--user-agent=" + runtime["userAgent"])
if runtime.get("languages"):
    args.append("--accept-lang=" + runtime["languages"])
args.append("about:blank")
environment = ["runuser", "-u", "workspace", "--", "env", "DISPLAY=:0", "XAUTHORITY=/home/workspace/.Xauthority",
               "no_proxy=" + payload.get("noProxy", "127.0.0.1,localhost,.local,::1"),
               "NO_PROXY=" + payload.get("noProxy", "127.0.0.1,localhost,.local,::1")]
with open("/run/platypus/browser.log", "wb", buffering=0) as log:
    process = subprocess.Popen([*environment, *args],
        stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
ready_deadline = time.monotonic() + 30
while time.monotonic() < ready_deadline:
    if process.poll() is not None:
        raise RuntimeError("Chromium failed to start; inspect /run/platypus/browser.log")
    if ready_path.exists() and not ready_path.is_symlink() and ready_path.stat().st_size == 32 and ready_path.read_text() == nonce:
        break
    time.sleep(0.1)
else:
    raise RuntimeError("QA extension did not acknowledge startup: " + pathlib.Path("/run/platypus/browser.log").read_text(errors="replace")[-2048:])
cookie_import.unlink(missing_ok=True)
subprocess.run([*environment, "/usr/bin/chromium", "--user-data-dir=/home/workspace/.config/chromium", payload["startUrl"]],
    check=True, timeout=15, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
print(json.dumps({"applied": True, "pid": process.pid}))
