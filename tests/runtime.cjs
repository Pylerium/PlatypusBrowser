const assert = require("node:assert/strict");
const path = require("node:path");

if (!process.versions.electron) {
  const compiled = require("esbuild").buildSync({ entryPoints: [path.resolve(__dirname, "../src/shared/runtime.ts")], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
  const bundled = { exports: {} };
  new Function("module", "exports", "require", compiled)(bundled, bundled.exports, require);
  const exported = bundled.exports;
  const valid = { hardwareConcurrency: 4, deviceMemory: 4, platform: "Win32", canvasSeed: 0 };
  assert.equal(exported.validateRuntime(undefined), null);
  assert.deepEqual(exported.validateRuntime(valid), valid);
  for (const invalid of [
    { hardwareConcurrency: 0 }, { hardwareConcurrency: 1.5 }, { hardwareConcurrency: 257 },
    { deviceMemory: 3 }, { deviceMemory: "4" }, { platform: " " }, { platform: "bad\nplatform" },
    { canvasSeed: -1 }, { canvasSeed: 4294967296 }, { canvasSeed: 1.5 },
  ]) assert.throws(() => exported.validateRuntime({ ...valid, ...invalid }));
  for (const invalid of [[], { surprise: 1 }, { mediaBlocked: 'yes' }, { languages: 'en\r\nInjected' }, { userAgent: 'bad\r\nheader' }, { webrtcPolicy: 'direct' }, { screenWidth: 0 }, { audioSeed: -1 }]) assert.throws(() => exported.validateRuntime(invalid));
  assert.deepEqual(exported.validateRuntime({ platform: null, mediaBlocked: true, webrtcPolicy: 'relay' }), { platform: null, mediaBlocked: true, webrtcPolicy: 'relay' });
  assert.deepEqual(exported.validateRuntime({webglRenderer:'QA custom renderer'}),{webglRenderer:'QA custom renderer'});
  const { spawnSync } = require("node:child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], { env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const directory = mkdtempSync(path.join(tmpdir(), "platypus-runtime-test-"));
app.setPath("userData", directory);
const windows = [];
let exitCode = 0;
const documentUrl = "data:text/html," + encodeURIComponent(`<!doctype html><script>
window.early = { cpu: navigator.hardwareConcurrency, memory: navigator.deviceMemory, platform: navigator.platform,
  node: typeof require, manager: typeof window.platypus };
window.render = () => {
  const canvas = document.createElement('canvas'); canvas.width = 240; canvas.height = 80;
  const ctx = canvas.getContext('2d'); ctx.font = '24px sans-serif';
  ctx.fillText('QA canvas sample', 12, 32); ctx.strokeText('test', 12, 64);
  const transform = ctx.getTransform();
  const pixels = Array.from(ctx.getImageData(0, 0, 240, 80).data);
  let invalidReceiver = false;
  try { CanvasRenderingContext2D.prototype.fillText.call({}, 'x', 0, 0); } catch { invalidReceiver = true; }
  return { pixels, png: canvas.toDataURL(), state: [transform.a, transform.b, transform.c, transform.d, transform.e, transform.f], invalidReceiver };
};
</script>`);

async function open(runtime) {
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    ...(runtime ? {
      preload: path.resolve(__dirname, "../out/preload/runtime.cjs"),
      additionalArguments: ["--platypus-runtime=" + encodeURIComponent(JSON.stringify(runtime))],
    } : {}),
  } });
  windows.push(window);
  await window.loadURL(documentUrl);
  return window;
}

app.whenReady().then(async () => {
  const runtime = { hardwareConcurrency: 3, deviceMemory: 2, platform: "QA Test Platform", canvasSeed: 0 };
  const native = await open();
  const simulated = await open(runtime);
  const early = await simulated.webContents.executeJavaScript("window.early");
  assert.deepEqual(early, { cpu: 3, memory: 2, platform: "QA Test Platform", node: "undefined", manager: "undefined" });
  const first = await simulated.webContents.executeJavaScript("render()");
  assert.deepEqual(first, await simulated.webContents.executeJavaScript("render()"), "same seed and drawing must repeat exactly");
  assert.deepEqual(first.state, [1, 0, 0, 1, 0, 0], "text calls must restore transforms");
  assert.equal(first.invalidReceiver, true);
  const baseline = await native.webContents.executeJavaScript("render()");
  assert.notDeepEqual(first.pixels, baseline.pixels, "simulation must affect rendered pixels");
  assert.notEqual(first.png, baseline.png, "exports must include the rendering change");
  await simulated.loadURL(documentUrl + encodeURIComponent("<p>Next document</p>"));
  assert.deepEqual(await simulated.webContents.executeJavaScript("window.early"), early, "navigation must retain initialization");
  const noCanvas = await open({ ...runtime, canvasSeed: null });
  assert.deepEqual(await noCanvas.webContents.executeJavaScript("render()"), baseline, "null seed must preserve native canvas");
  const other = await open({ ...runtime, hardwareConcurrency: 7, canvasSeed: 3 });
  assert.equal(await other.webContents.executeJavaScript("navigator.hardwareConcurrency"), 7);
  assert.deepEqual(await other.webContents.executeJavaScript("render()"), await other.webContents.executeJavaScript("render()"));
  assert.notEqual(await native.webContents.executeJavaScript("navigator.platform"), runtime.platform, "native windows must remain isolated");
  const expanded = await open({ hardwareConcurrency: 6, languages: 'fr-FR,fr', screenWidth: 1600, screenHeight: 900, devicePixelRatio: 2, maxTouchPoints: 5,
    mediaBlocked: true, webrtcPolicy: 'blocked', batteryLevel: 0.5, batteryCharging: false, emptyVoices: true, emptyGamepads: true, hidePerformanceMemory: true });
  assert.deepEqual(await expanded.webContents.executeJavaScript(`(async()=>{let blocked=false;try{new RTCPeerConnection()}catch(e){blocked=e.name==='NotAllowedError'};const battery=await navigator.getBattery();return {cpu:navigator.hardwareConcurrency,languages:[...navigator.languages],screen:[screen.width,screen.height],ratio:devicePixelRatio,touch:navigator.maxTouchPoints,blocked,battery:[battery.level,battery.charging],gamepads:navigator.getGamepads().length,voices:speechSynthesis.getVoices().length,memory:typeof performance.memory,marker:window.__platypusQa.simulated}})()`),
    { cpu:6,languages:['fr-FR','fr'],screen:[1600,900],ratio:2,touch:5,blocked:true,battery:[0.5,false],gamepads:0,voices:0,memory:'undefined',marker:true });
  const audio = await open({ audioSeed: 42 });
  const audioSample = `(async()=>{const context=new OfflineAudioContext(1,256,44100);const oscillator=context.createOscillator();oscillator.connect(context.destination);oscillator.start();const buffer=await context.startRendering();return Array.from(buffer.getChannelData(0))})()`;
  const sample = await audio.webContents.executeJavaScript(audioSample);
  assert.deepEqual(sample,await audio.webContents.executeJavaScript(audioSample),'audio simulation must repeat for the same seed');
  assert.notDeepEqual(sample,await native.webContents.executeJavaScript(audioSample),'audio simulation changes rendered samples');
  assert.equal(await expanded.webContents.executeJavaScript(`(()=>{try{new RTCPeerConnection.prototype.constructor();return false}catch(error){return error.name==='NotAllowedError'}})()`),true);
  console.log("Runtime integration checks passed: document-start properties, navigation, isolation, deterministic rendering, exports, native mode, and canvas state.");
}).catch((error) => {
  console.error(error.message.slice(0, 500));
  exitCode = 1;
}).finally(() => {
  for (const window of windows) window.destroy();
  app.exit(exitCode);
});
app.on("quit", () => {
  // Only remove the unique directory created for this test run.
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* Chromium may still hold files on Windows. */ }
});
