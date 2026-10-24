// Opt-in real Electron/HTTP/SOCKS5 check. Only the private input filename enters argv.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

if (!process.versions.electron) {
  assert.ok(process.argv[2], 'Usage: npm run test:proxy-electron -- "proxy-list.txt"');
  require("esbuild").buildSync({ entryPoints: ["src/shared/proxyList.ts"], outfile: "out/tests/proxy-list.mjs", bundle: true, platform: "node", format: "esm" });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "platypus-proxy-electron-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require("node:child_process").spawnSync(require("electron"), [__filename, directory, path.resolve(process.argv[2])], { env, stdio: "inherit", timeout: 180000 });
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const { app, BrowserWindow } = require("electron");
app.setPath("userData", process.argv[2]);
let exitCode = 0, manager;
app.whenReady().then(async () => {
  const { parseProxyList } = await import(pathToFileURL(path.resolve("out/tests/proxy-list.mjs")).href);
  const endpoint = parseProxyList(fs.readFileSync(process.argv[3], "utf8"))[0];
  await import(pathToFileURL(path.resolve("out/main/index.js")).href);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    manager = BrowserWindow.getAllWindows().find(window => window.getTitle() === "Platypus Browser");
    if (manager && !manager.webContents.isLoadingMainFrame() && await manager.webContents.executeJavaScript("Boolean(window.platypus)")) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(manager);
  const invoke = source => manager.webContents.executeJavaScript(source);
  for (const protocol of ["http", "socks5"]) {
    const input = { name: `Live ${protocol}`, tenantId: "proxy-qa", startUrl: "https://ipv4.webshare.io/", proxy: { ...endpoint, protocol }, runtime: { hardwareConcurrency: 8, platform: "QA proxy platform", screenWidth: 1440, canvasSeed: 0 } };
    const profile = await invoke(`window.platypus.profiles.save(${JSON.stringify(input)})`);
    await invoke(`window.platypus.browser.launch(${JSON.stringify(profile.id)})`);
    const browser = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === input.startUrl);
    assert.ok(browser);
    assert.ok((await browser.webContents.executeJavaScript("document.body.innerText")).includes(endpoint.host));
    assert.deepEqual(await browser.webContents.executeJavaScript("({cpu:navigator.hardwareConcurrency,platform:navigator.platform,width:screen.width})"), { cpu: 8, platform: "QA proxy platform", width: 1440 });
    assert.equal(await browser.webContents.session.resolveProxy("http://localhost:5000/"), "DIRECT");
    const exported = JSON.parse(await invoke(`window.platypus.profiles.exportMetadata(${JSON.stringify(profile.id)})`));
    assert.deepEqual(Object.keys(exported.proxy).sort(), ["host", "port", "protocol", "requiresCredentials"]);
    await invoke(`window.platypus.browser.close(${JSON.stringify(profile.id)})`);
    await invoke(`window.platypus.profiles.remove(${JSON.stringify(profile.id)})`);
    console.log(`Real Electron ${protocol.toUpperCase()} passed: authenticated egress, expected exit IP, runtime overrides, direct localhost, metadata redaction.`);
  }
}).catch(error => { console.error(error); exitCode = 1; }).finally(() => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  app.exit(exitCode);
});
