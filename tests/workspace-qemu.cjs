// Opt-in Windows integration: the real Electron IPC path, installed guest,
// hardware accelerator and visible display. Uses a temporary app data directory.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!process.versions.electron) {
  const configPath = process.env.QEMU_TEST_CONFIG ?? path.join(process.env.APPDATA, "platypus-browser", "qemu.json");
  assert.ok(fs.existsSync(configPath), "Prepare a guest and host configuration first.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platypus-electron-qemu-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, directory, path.resolve(configPath)], { env, stdio: "inherit", timeout: 240000 });
  assert.equal(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep), true);
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.argv[2]);
process.env.PLATYPUS_QEMU_CONFIG = process.argv[3];
let manager;
let profile;
let exitCode = 0;
let server;
const reports = [];
const nativeCores = JSON.parse(fs.readFileSync(process.argv[3],'utf8')).cpus ?? 2;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const invoke = (source) => manager.webContents.executeJavaScript(source);
const workspace = (method) => invoke(`window.platypus.workspace.${method}(${JSON.stringify(profile.id)})`);

async function assertVisibleVm() {
  if (process.platform !== "win32") return;
  const script = `$vms=@(Get-CimInstance Win32_Process -Filter "Name='qemu-system-x86_64.exe'" | Where-Object { $_.CommandLine.Contains($env:QEMU_WINDOW_TEST_DATA) }); if($vms.Count -ne 1){throw 'Expected one test VM'}; $vm=Get-Process -Id $vms[0].ProcessId; if($vm.MainWindowHandle -eq 0){throw 'QEMU desktop window is hidden'}; $vm.MainWindowTitle`;
  const { stdout } = await require("node:util").promisify(require("node:child_process").execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, timeout: 15000, env: { ...process.env, QEMU_WINDOW_TEST_DATA: process.argv[2] },
  });
  assert.match(stdout, /QEMU/);
}

app.whenReady().then(async () => {
  server = require("node:http").createServer((request,response)=>{
    response.setHeader('Content-Type','text/html');
    if(request.method==='POST') { let body='';request.on('data',chunk=>{body+=chunk;if(body.length>4096)request.destroy()});request.on('end',()=>{reports.push({...JSON.parse(body),header:request.headers['user-agent'],cookie:request.headers.cookie});response.end('ok')});return; }
    response.end(`<!doctype html><title>Platypus guest telemetry QA</title><h1>Guest telemetry verified</h1><script>let blocked=false;try{const peer=new RTCPeerConnection();peer.close()}catch(e){blocked=e.name==='NotAllowedError'};const report={cpu:navigator.hardwareConcurrency,memory:navigator.deviceMemory,platform:navigator.platform,screen:screen.width,blocked,simulated:window.__platypusQa?.simulated};document.body.append(JSON.stringify(report));fetch('/report',{method:'POST',body:JSON.stringify(report)});</script>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  await import(pathToFileURL(path.resolve("out/main/index.js")).href);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    manager = BrowserWindow.getAllWindows().find(window => window.getTitle() === "Platypus Browser");
    if (manager && !manager.webContents.isLoadingMainFrame() && await invoke("Boolean(window.platypus)")) break;
    await sleep(50);
  }
  assert.ok(manager);
  const runtime = {hardwareConcurrency:6,deviceMemory:2,platform:'QA Guest',screenWidth:1600,webrtcPolicy:'blocked',userAgent:'Platypus-QA-VM/1.0'};
  profile = await invoke(`window.platypus.profiles.save({name:'Real QEMU Electron test',startUrl:'http://localhost:${server.address().port}/',proxy:{protocol:'http',host:'127.0.0.1',port:9},runtime:${JSON.stringify(runtime)}})`);
  const cookies=JSON.stringify([{url:`http://localhost:${server.address().port}/`,name:'vm_session',value:'private-vm-cookie',httpOnly:true}]);
  await invoke(`window.platypus.profiles.importCookies(${JSON.stringify(profile.id)},${JSON.stringify(cookies)})`);
  await invoke("window.runtimeStates=[];void window.platypus.workspace.onStatus(status=>window.runtimeStates.push(status))");
  await workspace("launch");
  console.log('Real guest booted; waiting for the Chromium telemetry report.');
  async function reported(cpu) {
    const deadline=Date.now()+15000;
    while(!reports.some(report=>report.cpu===cpu)){if(Date.now()>deadline)throw new Error('Missing Chromium report: '+JSON.stringify(reports));await sleep(100)}
    return reports.findLast(report=>report.cpu===cpu);
  }
  const first=await reported(6);
  assert.deepEqual(first,{cpu:6,memory:2,platform:'QA Guest',screen:1600,blocked:true,simulated:true,header:'Platypus-QA-VM/1.0',cookie:'vm_session=private-vm-cookie'});
  let state=await invoke(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`);
  state=await invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},${JSON.stringify({...runtime,hardwareConcurrency:7})},${state.revision})`);
  assert.equal(state.application,'workspace-pending');
  await invoke(`window.platypus.telemetry.applyToWorkspace(${JSON.stringify(profile.id)})`);
  await reported(7);
  assert.ok(reports.every(report=>report.simulated===true && report.blocked===true && [6,7].includes(report.cpu)),'a page must not load before its configured QA extension');
  console.log('Guest update passed: Adios save while running, Chromium restart, changed document-start properties, HTTP user-agent, and blocked WebRTC.');
  state=await invoke(`window.platypus.telemetry.get(${JSON.stringify(profile.id)})`);
  await invoke(`window.platypus.telemetry.save(${JSON.stringify(profile.id)},null,${state.revision})`);
  reports.length=0;
  await invoke(`window.platypus.telemetry.applyToWorkspace(${JSON.stringify(profile.id)})`);
  const native=await reported(nativeCores);
  assert.equal(native.simulated,true); // Proxy profiles retain the mandatory WebRTC restriction.
  assert.equal(native.blocked,true);
  console.log('Guest cookie hydration and local proxy bypass passed; checking heartbeat, visibility, and persisted relaunch.');
  // Allow the OS and Chromium to boot while checking heartbeat-backed status.
  for (let i = 0; i < 4; i++) {
    await sleep(5000);
    const statuses = await invoke("window.platypus.workspace.statuses()");
    assert.equal(statuses[0].state, "running", JSON.stringify(statuses));
    assert.equal(statuses[0].processRunning, true);
    if (i === 0) await assertVisibleVm();
  }
  await workspace("close");
  assert.equal((await invoke("window.platypus.workspace.statuses()"))[0].state, "terminated");
  reports.length=0;
  await workspace("launch");
  await sleep(5000);
  assert.equal((await invoke("window.platypus.workspace.statuses()"))[0].state, "running");
  await assertVisibleVm();
  assert.equal((await reported(nativeCores)).simulated,true);
  await workspace("close");
  await invoke(`window.platypus.profiles.remove(${JSON.stringify(profile.id)})`);
  const states = (await invoke("window.runtimeStates")).map(status => status.state);
  assert.ok(states.includes("booting") && states.includes("running") && states.includes("terminated"));
  assert.equal(states.includes("error"), false, JSON.stringify(states));
  console.log("Real Electron/QEMU integration passed: visible guest launch, 20-second heartbeat monitoring, shutdown, persistent relaunch, and purge through the secure renderer bridge.");
}).catch(error => { console.error(error); exitCode = 1; }).finally(async () => {
  if (profile && manager && !manager.isDestroyed()) {
    try { await workspace("close"); } catch (error) { console.error(error); exitCode = 1; }
  }
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  server?.close();
  app.exit(exitCode);
});
