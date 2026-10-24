const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!process.versions.electron) {
  require("esbuild").buildSync({ entryPoints: ["tests/electron-keys-entry.ts"], outfile: "out/tests/electron-keys.mjs", bundle: true,
    platform: "node", format: "esm", packages: "external" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platypus-ipc-test-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, directory], { env, stdio: "inherit", timeout: 120000 });
  const recovered = result.status === 0 ? require("node:child_process").spawnSync(require("electron"), [__filename, directory, "recover"], { env, stdio: "inherit", timeout: 60000 }) : result;
  assert.equal(path.resolve(directory).startsWith(path.resolve(os.tmpdir())), true);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (result.error) throw result.error;
  if (recovered.error) throw recovered.error;
  process.exit(recovered.status ?? 1);
}

const { app, BrowserWindow, safeStorage } = require("electron");
const directory = process.argv[2];
assert.ok(directory && path.isAbsolute(directory));
app.setPath("userData", directory);
process.env.PLATYPUS_QEMU_CONFIG = path.join(directory, "missing-qemu.json");
const windows = [];
let testServer;
let exitCode = 0;

async function until(predicate) {
  const end = Date.now() + 15000;
  while (!(await predicate())) { if (Date.now() > end) throw new Error("Electron manager did not become ready."); await new Promise((resolve) => setTimeout(resolve, 25)); }
}

async function captureSnapshot(window, name) {
  for (let attempt=0;attempt<5;attempt++) {
    try {
      const image=await window.webContents.capturePage();
      if(image.isEmpty())throw new Error('Empty cockpit screenshot');
      fs.writeFileSync(path.resolve('out/tests',name),image.toPNG());return;
    } catch(error) {
      if(attempt===4)throw error;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
  }
}

async function bootManager() {
  await import(pathToFileURL(path.resolve("out/main/index.js")).href);
  let manager;
  await until(async () => {
    manager = BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Platypus Browser");
    return manager && !manager.webContents.isLoadingMainFrame() && await manager.webContents.executeJavaScript("Boolean(window.platypus)");
  });
  windows.push(manager);
  return manager;
}

app.whenReady().then(async () => {
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true, "OS-backed secure storage is required for this test");
  if (process.argv[3] === "recover") {
    const manager = await bootManager();
    assert.equal(await manager.webContents.executeJavaScript("window.platypus.profiles.hasPendingCleanup()"), false);
    assert.deepEqual(await manager.webContents.executeJavaScript("window.platypus.profiles.list()"), []);
    const templates = await manager.webContents.executeJavaScript("window.platypus.telemetry.templates()");
    assert.equal(templates[0]?.name, "QA encrypted template");
    const partitions = path.join(directory, "session-data", "Partitions");
    assert.equal(fs.existsSync(partitions) ? fs.readdirSync(partitions).some((name) => name.startsWith("profile-")) : false, false);
    console.log("Electron restart recovery passed: pending Chromium cleanup completed without reopening the deleted session.");
    return;
  }
  const { HardwareProfileManager, MemoryKeyring } = await import("@adios/hwid-profile-manager");
  const { ElectronAdiosKeys } = await import(pathToFileURL(path.resolve("out/tests/electron-keys.mjs")).href);
  const keyPath = path.join(directory, "keys", "test.dat");
  const vaultPath = path.join(directory, "key-test-vault");
  const provider = new ElectronAdiosKeys(keyPath, vaultPath);
  await assert.rejects(provider.keyById("electron-v1"), /missing/);
  const first = await provider.activeKey();
  const next = await new ElectronAdiosKeys(keyPath, vaultPath).keyById(first.id);
  assert.deepEqual(first.bytes, next.bytes);
  assert.equal(fs.readFileSync(keyPath).includes(first.bytes), false);
  const secured = new HardwareProfileManager({ directory: vaultPath, keys: provider });
  const hardware = await secured.create("key-test");
  assert.deepEqual(await secured.load("key-test"), hardware);
  fs.unlinkSync(keyPath);
  await assert.rejects(provider.activeKey(), /missing/);
  await assert.rejects(secured.load("key-test"), /missing/);
  assert.equal(fs.existsSync(keyPath), false);
  first.bytes.fill(0); next.bytes.fill(0);

  const manager = await bootManager();
  manager.webContents.on('console-message', (_event, level, message) => { if (level === 3) console.error('Renderer:',message); });
  const invoke = (source) => manager.webContents.executeJavaScript(source).catch(error => { throw new Error(error.message+' · Renderer test action: '+source.slice(0,100), {cause:error}); });
  // Exercise the actual file input, encrypted HTTP credentials, and duplicate import handling.
  const importFixture = () => invoke(`(() => {
    const input=document.querySelector('input[type=file]');
    const transfer=new DataTransfer();
    transfer.items.add(new File(['127.0.0.1:8123:qa-proxy-user:qa-private-password\\r\\n127.0.0.2:8124:qa-proxy-user:qa-private-password'], 'proxies.txt', {type:'text/plain'}));
    input.files=transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  })()`);
  await importFixture();
  await until(async () => await invoke("document.body.textContent.includes('Imported 2 proxy profiles.')"));
  const imported = await invoke("window.platypus.profiles.list()");
  assert.equal(imported.length,2);
  assert.ok(imported.every(item=>item.proxy.protocol==='http' && item.proxy.hasCredentials && !('password' in item.proxy) && !('username' in item.proxy)));
  const storedProfiles=fs.readFileSync(path.join(directory,'profiles.dat'),'utf8');
  assert.ok(storedProfiles.startsWith('PLATYPUS_ENCRYPTED_V1\n'));
  assert.equal(storedProfiles.includes('qa-private-password'),false);
  await importFixture();
  await until(async () => await invoke("document.body.textContent.includes('Imported 0 proxy profiles. Skipped 2 existing endpoints.')"));
  assert.equal((await invoke("window.platypus.profiles.list()")).length,2);
  for (const item of imported) await invoke(`window.platypus.profiles.remove(${JSON.stringify(item.id)})`);
  const mixed='http://qa-user:qa-http-secret@127.0.0.1:8231\nsocks5://qa-user:qa-socks-secret@127.0.0.1:8232';
  assert.deepEqual(await invoke(`window.platypus.profiles.importProxies(${JSON.stringify(mixed)},'http','tenant-a')`),{created:2,skipped:0});
  assert.deepEqual(await invoke(`window.platypus.profiles.importProxies(${JSON.stringify(mixed)},'http','tenant-a')`),{created:0,skipped:2});
  assert.deepEqual(await invoke(`window.platypus.profiles.importProxies(${JSON.stringify(mixed)},'http','tenant-b')`),{created:2,skipped:0});
  const tenantA=await invoke("window.platypus.profiles.list('tenant-a')");
  const tenantB=await invoke("window.platypus.profiles.list('tenant-b')");
  assert.equal(tenantA.length,2); assert.equal(tenantB.length,2);
  assert.ok(tenantA.every(item=>item.tenantId==='tenant-a' && !tenantB.some(other=>other.id===item.id)));
  const beforeInvalid=(await invoke('window.platypus.profiles.list()')).length;
  await assert.rejects(invoke(`window.platypus.profiles.importProxies('127.0.0.1:8233:u:secret\\nbad-private','http','tenant-a')`),/invalid/);
  assert.equal((await invoke('window.platypus.profiles.list()')).length,beforeInvalid);
  const exported=await invoke(`window.platypus.profiles.exportMetadata(${JSON.stringify(tenantA[0].id)})`);
  assert.ok(!exported.includes('qa-user') && !exported.includes('qa-http-secret') && !exported.includes('qa-socks-secret'));
  const cloned=await invoke(`window.platypus.profiles.importMetadata(${JSON.stringify(exported)})`);
  assert.notEqual(cloned.id,tenantA[0].id); assert.equal(cloned.tenantId,'tenant-a'); assert.equal(cloned.proxy.hasCredentials,false);
  assert.equal(cloned.session.cookieCount,0);
  await invoke(`window.platypus.profiles.save({name:'Preserved tenant',startUrl:'https://example.com/',proxy:null},${JSON.stringify(cloned.id)})`);
  assert.equal((await invoke("window.platypus.profiles.list('tenant-a')")).find(item=>item.id===cloned.id).tenantId,'tenant-a');
  for(const item of [...tenantA,...tenantB,cloned]) await invoke(`window.platypus.profiles.remove(${JSON.stringify(item.id)})`);
  let observedUserAgent;
  let observedLanguages;
  let observedHints;
  let observedCookie;
  let targetRequests = 0;
  testServer = require("node:http").createServer((request, response) => { if(request.url==='/proxy-target')targetRequests++; observedUserAgent = request.headers['user-agent']; observedLanguages=request.headers['accept-language']; observedHints=request.headers['sec-ch-ua']; observedCookie=request.headers.cookie; response.setHeader('Content-Type','text/html'); response.end('<!doctype html><script>window.early={cpu:navigator.hardwareConcurrency,platform:navigator.platform};</script>'); });
  await new Promise(resolve => testServer.listen(0, '127.0.0.1', resolve));
  const testUrl = `http://127.0.0.1:${testServer.address().port}/`;
  const profile = await invoke(`window.platypus.profiles.save({ name: 'IPC fixture', startUrl: ${JSON.stringify(testUrl)}, proxy: null })`);
  const cookieImport=JSON.stringify([{url:testUrl,name:'enterprise_session',value:'private-cookie-fixture',httpOnly:true},{url:testUrl,name:'expired_session',value:'expired-private-fixture',expirationDate:1}]);
  const cookieSummary=await invoke(`window.platypus.profiles.importCookies(${JSON.stringify(profile.id)},${JSON.stringify(cookieImport)})`);
  assert.equal(cookieSummary.cookieCount,2);
  assert.equal(JSON.stringify(await invoke('window.platypus.profiles.list()')).includes('private-cookie-fixture'),false);
  const encryptedSessionPath=path.join(directory,'session-vault','workspaces',require('node:crypto').createHash('sha256').update(profile.id).digest('hex'),'settings.enc');
  assert.equal(fs.readFileSync(encryptedSessionPath,'utf8').includes('private-cookie-fixture'),false);
  const sessionBefore=JSON.stringify(await invoke('window.platypus.profiles.list()'));
  await assert.rejects(invoke(`window.platypus.profiles.importCookies(${JSON.stringify(profile.id)},'[broken-secret-json')`),/malformed/);
  assert.equal(JSON.stringify(await invoke('window.platypus.profiles.list()')),sessionBefore);
  await invoke(`window.ipcStatuses = []; void window.platypus.workspace.onStatus(status => window.ipcStatuses.push(status));`);
  await assert.rejects(invoke(`window.platypus.workspace.launch(${JSON.stringify(profile.id)})`), /configuration/);
  const statuses = await invoke("window.ipcStatuses");
  assert.equal(statuses[0].state, "booting");
  assert.equal(statuses.at(-1).state, "error");
  assert.equal(statuses.at(-1).processRunning, false);
  assert.ok(statuses.at(-1).revision > statuses[0].revision);
  await assert.rejects(invoke("window.platypus.workspace.launch('../escape')"), /Invalid profile/);

  const attacker = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve("out/preload/index.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  windows.push(attacker);
  await attacker.loadFile(path.resolve("out/renderer/index.html"));
  await assert.rejects(attacker.webContents.executeJavaScript("window.platypus.workspace.statuses()"), /trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`), /trusted profile manager/);

  await assert.rejects(attacker.webContents.executeJavaScript(`window.platypus.profiles.importCookies(${JSON.stringify(profile.id)},'[]')`), /trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript(`window.platypus.profiles.configureSession(${JSON.stringify(profile.id)},[])`), /trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript("window.platypus.profiles.importProxies('127.0.0.1:8080')"),/trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript(`window.platypus.profiles.exportMetadata(${JSON.stringify(profile.id)})`),/trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript("window.platypus.profiles.importMetadata('{}')"),/trusted profile manager/);
  const initial = await invoke(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`);
  const configuration = {hardwareConcurrency:6,platform:'QA private platform',userAgent:'Platypus-QA-Test/1.0',languages:'fr-FR,fr',hideClientHints:true,webrtcPolicy:'blocked',canvasSeed:0};
  const updated = await invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},${JSON.stringify(configuration)},${initial.revision})`);
  await assert.rejects(invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},null,${initial.revision})`), /another editor/);
  await assert.rejects(invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},{hardwareConcurrency:-1},${updated.revision})`), /Invalid/);
  await invoke(`window.platypus.browser.launch(${JSON.stringify(profile.id)})`);
  const local = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === testUrl);
  assert.ok(local);
  assert.deepEqual(await local.webContents.executeJavaScript('window.early'),{cpu:6,platform:'QA private platform'});
  assert.equal(observedCookie,'enterprise_session=private-cookie-fixture');
  assert.deepEqual(await require('electron').session.defaultSession.cookies.get({name:'enterprise_session'}),[]);
  await assert.rejects(invoke(`window.platypus.profiles.importCookies(${JSON.stringify(profile.id)},'[]')`),/Close/);
  assert.equal(observedUserAgent,'Platypus-QA-Test/1.0');
  assert.equal(observedLanguages,'fr-FR,fr');
  assert.equal(observedHints,undefined);
  assert.equal(local.webContents.getWebRTCIPHandlingPolicy(),'disable_non_proxied_udp');
  const live = await invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},{hardwareConcurrency:7},${updated.revision})`);
  assert.equal(live.application,'local-reloaded');
  assert.notEqual(observedLanguages,'fr-FR,fr');
  await until(async()=>await local.webContents.executeJavaScript('navigator.hardwareConcurrency')===7);
  const reset = await invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},null,${live.revision})`);
  assert.equal(reset.application,'local-live');
  await until(async()=>await local.webContents.executeJavaScript('navigator.hardwareConcurrency')!==7);
  await local.reload();
  await until(async()=>!local.webContents.isLoadingMainFrame() && await local.webContents.executeJavaScript('window.early?.cpu !== 7'));
  await invoke(`window.platypus.browser.close(${JSON.stringify(profile.id)})`);
  const unused = require('node:net').createServer();
  await new Promise(resolve=>unused.listen(0,'127.0.0.1',resolve));
  const unavailablePort = unused.address().port;
  await new Promise(resolve=>unused.close(resolve));
  const proxied = await invoke(`window.platypus.profiles.save({name:'Proxy failure fixture',startUrl:'https://example.com/',proxy:{protocol:'http',host:'127.0.0.1',port:${unavailablePort}}})`);
  const beforeFailure = targetRequests;
  await assert.rejects(invoke(`window.platypus.browser.launch(${JSON.stringify(proxied.id)})`),/proxy|Proxy|ERR_/);
  assert.equal(targetRequests,beforeFailure,'a failed proxy must never fall back to the direct target');
  const diagnostic=await invoke(`window.platypus.profiles.save({name:'Local bypass fixture',startUrl:${JSON.stringify(testUrl+'proxy-target')},proxy:{protocol:'http',host:'127.0.0.1',port:${unavailablePort}},proxyBypassRules:['*.lab.internal']})`);
  await invoke(`window.platypus.browser.launch(${JSON.stringify(diagnostic.id)})`);
  const diagnosticWindow=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===testUrl+'proxy-target');
  assert.ok(diagnosticWindow);
  for(const address of ['http://127.0.0.1:5000/','http://localhost:5000/','http://telemetry.local/','http://test.lab.internal/']) assert.equal(await diagnosticWindow.webContents.session.resolveProxy(address),'DIRECT');
  assert.match(await diagnosticWindow.webContents.session.resolveProxy('https://example.com/'),/^SOCKS5 127\.0\.0\.1:/);
  assert.equal(targetRequests,beforeFailure+1);
  await invoke(`window.platypus.browser.close(${JSON.stringify(diagnostic.id)})`);
  await invoke(`window.platypus.profiles.remove(${JSON.stringify(diagnostic.id)})`);
  await invoke(`window.platypus.profiles.remove(${JSON.stringify(proxied.id)})`);
  await invoke(`window.platypus.telemetry.saveTemplate('QA encrypted template',${JSON.stringify(configuration)})`);
  const telemetryRoot = path.join(directory,'telemetry-vault','workspaces');
  for(const folder of fs.readdirSync(telemetryRoot)) assert.equal(fs.readFileSync(path.join(telemetryRoot,folder,'settings.enc'),'utf8').includes('QA private platform'),false);

  // Exercise the actual cockpit rather than the reference HTML's simulated handlers.
  assert.equal(await invoke("document.querySelectorAll('script[src^=https]').length"),0);
  assert.equal(await invoke("Boolean(document.querySelector('.cockpit-header'))"),true);
  await assert.rejects(attacker.webContents.executeJavaScript("window.platypus.browser.statuses()"),/trusted profile manager/);
  await assert.rejects(attacker.webContents.executeJavaScript("window.platypus.diagnostics.localBackend()"),/trusted profile manager/);
  const inputValue=async(selector,value)=>invoke(`(() => {const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await invoke("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.includes('New profile')).click()");
  await until(async()=>await invoke("Boolean(document.querySelector('[role=dialog][aria-label=\"Create a profile\"]'))"));
  await inputValue('#tenant-id','ui-fixture'); await inputValue('#profile-name','UI cockpit fixture'); await inputValue('#start-url',testUrl+'ui-cockpit');
  await invoke("document.querySelector('[role=dialog] form').requestSubmit()");
  await until(async()=>(await invoke("window.platypus.profiles.list('ui-fixture')")).length===1);
  await until(async()=>await invoke("!document.querySelector('[role=dialog]')"));
  const uiProfile=(await invoke("window.platypus.profiles.list('ui-fixture')"))[0];
  await until(async()=>await invoke("Array.from(document.querySelectorAll('.profile-select')).some(button=>button.textContent.includes('UI cockpit fixture'))"));
  await invoke("Array.from(document.querySelectorAll('.profile-select')).find(button=>button.textContent.includes('UI cockpit fixture')).click()");
  await until(async()=>await invoke("document.querySelector('.workspace-heading h2').textContent==='UI cockpit fixture'"));
  await invoke("Array.from(document.querySelectorAll('.header-actions button')).find(button=>button.textContent.includes('Proxies & Routing')).focus();Array.from(document.querySelectorAll('.header-actions button')).find(button=>button.textContent.includes('Proxies & Routing')).click()");
  await until(async()=>await invoke("Boolean(document.querySelector('#routing-bypass'))"));
  await inputValue('#routing-bypass','*.cockpit.internal');
  await invoke("Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent==='Save routing rules').click()");
  await until(async()=>(await invoke("window.platypus.profiles.list('ui-fixture')"))[0].session.proxyBypassRules.includes('*.cockpit.internal'));
  const uiCookies=JSON.stringify([{url:testUrl,name:'ui_seed',value:'ui-private-seed',httpOnly:true}]);
  await invoke(`(() => {const input=document.querySelector('[aria-label="Routing cookie import"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(uiCookies)}],'cookies.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(async()=>(await invoke("window.platypus.profiles.list('ui-fixture')"))[0].session.cookieCount===1);
  manager.setSize(1440,920); manager.show(); manager.focus();
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.mkdirSync(path.resolve('out/tests'),{recursive:true});
  await captureSnapshot(manager,'cockpit-routing.png');
  await invoke("document.querySelector('[role=dialog]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await until(async()=>await invoke("!document.querySelector('[role=dialog]')"));
  await invoke("document.querySelector('.engine-switch button').click()");
  await invoke("document.querySelector('.launch-button').click()");
  await until(()=>BrowserWindow.getAllWindows().some(window=>window.webContents.getURL()===testUrl+'ui-cockpit'));
  const uiBrowser=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===testUrl+'ui-cockpit');
  assert.equal((await uiBrowser.webContents.session.cookies.get({name:'ui_seed'}))[0].httpOnly,true);
  manager.reload();
  await until(async()=>!manager.webContents.isLoadingMainFrame() && await invoke("Boolean(document.querySelector('.profile-select'))"));
  await until(async()=>await invoke("Array.from(document.querySelectorAll('.workspace-card')).some(card=>card.textContent.includes('UI cockpit fixture') && card.textContent.includes('Local running'))"));
  await invoke("Array.from(document.querySelectorAll('.profile-select')).find(button=>button.textContent.includes('UI cockpit fixture')).click()");
  await until(async()=>await invoke("document.querySelector('.workspace-heading h2').textContent==='UI cockpit fixture'"));
  await invoke("document.querySelector('[aria-label=\"Dismiss notification\"]')?.click()");
  await captureSnapshot(manager,'cockpit-dashboard.png');
  manager.setSize(900,760);await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(await invoke("document.querySelector('.cockpit').scrollWidth<=window.innerWidth"),true);
  await captureSnapshot(manager,'cockpit-compact.png');
  await invoke("Array.from(document.querySelectorAll('.execution-toolbar button')).find(button=>button.textContent.startsWith('Close browser')).click()");
  await until(()=>uiBrowser.isDestroyed());
  await invoke(`window.platypus.profiles.remove(${JSON.stringify(uiProfile.id)})`);
  manager.setSize(1440,920);

  // Exercise the schema-generated dashboard itself, including its debounced save.
  manager.reload();
  await until(async()=>!manager.webContents.isLoadingMainFrame() && await invoke(`Boolean(document.querySelector('[aria-label="Telemetry for IPC fixture"]'))`));
  await invoke(`document.querySelector('[aria-label="Telemetry for IPC fixture"]').click()`);
  await until(async()=>await invoke(`Boolean(document.querySelector('[role="dialog"] fieldset:not(:disabled)'))`));
  assert.equal(await invoke(`document.querySelectorAll('[role="dialog"] [role="tab"]').length`),4);
  await invoke(`Array.from(document.querySelectorAll('[role="dialog"] [role="tab"]')).find(button=>button.textContent==='Audio & Sensors').click()`);
  manager.show(); manager.focus();
  await new Promise(resolve=>setTimeout(resolve,150));
  fs.mkdirSync(path.resolve('out/tests'),{recursive:true});
  await captureSnapshot(manager,'telemetry-dashboard.png');
  await invoke(`document.querySelector('[role="dialog"] [aria-label="Customize Offline audio variation seed"]').click()`);
  await until(async()=>(await invoke(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`)).runtime?.audioSeed===0);
  await invoke(`document.querySelector('[role="dialog"] [aria-label="Customize Offline audio variation seed"]').click()`);
  await until(async()=>(await invoke(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`)).runtime===null);
  await invoke(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button=>button.textContent==='Save & close').click()`);

  const fixtureKeys = new MemoryKeyring("fixture", { fixture: Buffer.alloc(32, 61) });
  const fakeAdios = new HardwareProfileManager({ directory: path.join(directory, "adios-vault"), keys: fixtureKeys });
  await fakeAdios.create(profile.id);
  const digest = require("node:crypto").createHash("sha256").update(profile.id).digest("hex");
  const overlay = path.join(directory, "qemu-workspaces", digest);
  fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(overlay, "binding.json"), "{}");
  fs.writeFileSync(path.join(overlay, "disk-0.qcow2"), "test overlay bytes");
  const purged = await invoke(`window.platypus.profiles.remove(${JSON.stringify(profile.id)})`);
  assert.equal(typeof purged.cleanupPending, "boolean");
  assert.equal(fs.existsSync(overlay), false);
  assert.equal(fs.existsSync(path.join(telemetryRoot,digest)),false);
  await assert.rejects(fakeAdios.load(profile.id), /does not exist/);
  assert.equal(await invoke("window.platypus.profiles.hasPendingCleanup()"), purged.cleanupPending);
  fixtureKeys.destroy();
  console.log("Electron workspace checks passed: OS-backed keys, telemetry encryption/CAS, real HTTP UA, live updates/native reset, reactive schema UI, templates, sender authorization, and journaled purge.");
}).catch((error) => { console.error(error); exitCode = 1; }).finally(() => {
  testServer?.close();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  app.exit(exitCode);
});
