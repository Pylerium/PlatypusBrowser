import type { RuntimeSimulation } from "./types";
import { telemetrySchema } from "./telemetrySchema";
export const runtimeArgumentPrefix = "--platypus-runtime=";

export function validateRuntime(value: unknown): RuntimeSimulation | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > telemetrySchema.length) throw new Error("Invalid runtime configuration.");
  const output: Record<string, unknown> = {};
  for (const [key, setting] of Object.entries(value)) {
    const schema = telemetrySchema.find((item) => item.key === key);
    if (!schema) throw new Error(`Unknown telemetry vector: ${key}`);
    if (setting === null) { output[key] = null; continue; }
    if (schema.control === "toggle") {
      if (typeof setting !== "boolean") throw new Error(`${schema.label} must be a boolean.`);
    } else if (schema.control === "select") {
      if (!schema.options?.includes(setting as never) && !(schema.custom && typeof setting === "string" && setting.trim() && setting.length <= schema.max! && !/[\u0000-\u001f\u007f]/.test(setting))) throw new Error(`Invalid ${schema.label}.`);
    } else if (schema.control === "text") {
      if (typeof setting !== "string" || !setting.trim() || setting.length > schema.max! || /[\u0000-\u001f\u007f]/.test(setting)) throw new Error(`Invalid ${schema.label}.`);
      if (key === "languages" && !setting.split(",").every((language) => /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(language.trim()))) throw new Error("Use comma separated language tags.");
    } else {
      if (typeof setting !== "number" || !Number.isFinite(setting) || setting < schema.min! || setting > schema.max! ||
        (schema.step === 1 && !Number.isInteger(setting)) || (schema.options && !schema.options.includes(setting))) throw new Error(`Invalid ${schema.label}.`);
    }
    output[key] = typeof setting === "string" ? setting.trim() : setting;
  }
  return output as RuntimeSimulation;
}

// Self-contained for contextBridge and the guest extension. Overrides are
// intentionally inspectable. Originals are retained once per realm and restored
// on every update; wrappers never stack or rewrite Function.prototype.toString.
export function applyRuntimeSimulation(runtime: RuntimeSimulation | null): void {
  type Saved = { target: object; key: PropertyKey; descriptor?: PropertyDescriptor };
  type State = { originals: Saved[]; peers: Set<RTCPeerConnection>; current: RuntimeSimulation | null; skipped: string[] };
  const realm = globalThis as typeof globalThis & { __platypusQaState?: State; __platypusQa?: object };
  let state = realm.__platypusQaState;
  if (!state) {
    state = { originals: [], peers: new Set(), current: null, skipped: [] };
    Object.defineProperty(realm, "__platypusQaState", { value: state, configurable: false });
  }
  const oldPolicy = state.current?.webrtcPolicy;
  for (const item of state.originals.splice(0).reverse()) {
    try { if (item.descriptor) Object.defineProperty(item.target, item.key, item.descriptor); else Reflect.deleteProperty(item.target, item.key); } catch { state.skipped.push(String(item.key)); }
  }
  state.current = runtime;
  state.skipped = [];
  if (oldPolicy !== runtime?.webrtcPolicy) for (const peer of state.peers) { peer.close(); state.peers.delete(peer); }
  const config = runtime ?? {};
  const active = (key: keyof RuntimeSimulation) => config[key] !== undefined && config[key] !== null;
  function define(target: object | undefined, key: PropertyKey, descriptor: PropertyDescriptor): void {
    if (!target) return;
    const original = Object.getOwnPropertyDescriptor(target, key);
    if (original && !original.configurable) { state!.skipped.push(String(key)); return; }
    try {
      Object.defineProperty(target, key, { configurable: true, enumerable: original?.enumerable ?? true, ...descriptor });
      state!.originals.push({ target, key, descriptor: original });
    } catch { state!.skipped.push(String(key)); }
  }
  const getter = (target: object | undefined, key: string, value: unknown) => define(target, key, { get: () => value });
  const method = (target: object | undefined, key: string, value: unknown) => define(target, key, { writable: true, value });
  const denied = () => new DOMException("Disabled by the Platypus QA profile.", "NotAllowedError");
  const nav = typeof Navigator !== "undefined" ? Navigator.prototype : undefined;
  for (const key of ["hardwareConcurrency", "deviceMemory", "platform", "userAgent", "appVersion", "vendor", "maxTouchPoints", "pdfViewerEnabled"] as const) {
    if (active(key)) getter(nav, key, config[key]);
  }
  if (active("languages")) {
    const languages = Object.freeze(config.languages!.split(",").map((item) => item.trim()));
    getter(nav, "languages", languages); getter(nav, "language", languages[0]);
  }
  if (active("doNotTrack")) getter(nav, "doNotTrack", config.doNotTrack === "unspecified" ? null : config.doNotTrack);
  if (config.hideClientHints) getter(nav, "userAgentData", undefined);
  if (typeof Screen !== "undefined") {
    for (const [key, property, available] of [["screenWidth", "width", "availWidth"], ["screenHeight", "height", "availHeight"], ["colorDepth", "colorDepth", "pixelDepth"]] as const) {
      if (active(key)) { getter(Screen.prototype, property, config[key]); getter(Screen.prototype, available, config[key]); }
    }
  }
  if (active("devicePixelRatio")) getter(realm, "devicePixelRatio", config.devicePixelRatio);
  if (active("canvasSeed") && typeof CanvasRenderingContext2D !== "undefined") {
    let seed = config.canvasSeed! >>> 0;
    seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0;
    const dx = ((seed & 255) / 255 - 0.5) / 5;
    const dy = (((seed >>> 8) & 255) / 255 - 0.5) / 5;
    const prototype = CanvasRenderingContext2D.prototype;
    const { save, restore, translate } = prototype;
    for (const key of ["fillText", "strokeText"] as const) {
      const original = prototype[key];
      method(prototype, key, function (this: CanvasRenderingContext2D, ...args: Parameters<typeof original>) {
        save.call(this);
        try { translate.call(this, dx, dy); return original.apply(this, args); }
        finally { restore.call(this); }
      });
    }
  }
  for (const Context of [typeof WebGLRenderingContext === "undefined" ? undefined : WebGLRenderingContext, typeof WebGL2RenderingContext === "undefined" ? undefined : WebGL2RenderingContext]) {
    if (!Context || (!active("webglVendor") && !active("webglRenderer"))) continue;
    const original = Context.prototype.getParameter;
    method(Context.prototype, "getParameter", function (this: WebGLRenderingContext, parameter: number) {
      const result = original.call(this, parameter); // Preserve receiver checks.
      if (result !== null && parameter === 37445 && active("webglVendor")) return config.webglVendor;
      if (result !== null && parameter === 37446 && active("webglRenderer")) return config.webglRenderer;
      return result;
    });
  }
  if (active("audioSeed") && typeof OfflineAudioContext !== "undefined") {
    const original = OfflineAudioContext.prototype.startRendering;
    const delta = ((Math.imul(config.audioSeed! ^ 0x9e3779b9, 0x45d9f3b) >>> 0) / 4294967295 - 0.5) * 1e-7;
    method(OfflineAudioContext.prototype, "startRendering", function (this: OfflineAudioContext) {
      return original.call(this).then((buffer) => {
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
          const samples = buffer.getChannelData(channel);
          for (let i = 0; i < samples.length; i++) samples[i] += delta;
        }
        return buffer;
      });
    });
  }
  if (config.mediaBlocked && typeof MediaDevices !== "undefined") {
    method(MediaDevices.prototype, "enumerateDevices", async () => []);
    for (const key of ["getUserMedia", "getDisplayMedia"]) method(MediaDevices.prototype, key, async () => { throw denied(); });
  }
  if (config.sensorsBlocked) for (const key of ["Accelerometer", "Gyroscope", "Magnetometer", "AbsoluteOrientationSensor", "RelativeOrientationSensor", "AmbientLightSensor", "GravitySensor", "LinearAccelerationSensor"]) {
    if (key in realm) method(realm, key, function () { throw denied(); });
  }
  if (active("batteryLevel") || active("batteryCharging")) {
    const battery = new EventTarget();
    Object.defineProperties(battery, { level: { value: config.batteryLevel ?? 1 }, charging: { value: config.batteryCharging ?? true },
      chargingTime: { value: (config.batteryCharging ?? true) ? 0 : Infinity }, dischargingTime: { value: Infinity },
      onlevelchange: { writable: true, value: null }, onchargingchange: { writable: true, value: null },
      onchargingtimechange: { writable: true, value: null }, ondischargingtimechange: { writable: true, value: null } });
    method(nav, "getBattery", async () => battery);
  }
  if (config.emptyVoices && typeof SpeechSynthesis !== "undefined") method(SpeechSynthesis.prototype, "getVoices", () => []);
  if (config.emptyGamepads) method(nav, "getGamepads", () => []);
  if (config.localFontsBlocked && "queryLocalFonts" in realm) method(realm, "queryLocalFonts", async () => { throw denied(); });
  const connection = (navigator as Navigator & { connection?: object }).connection;
  if (connection) for (const [key, property] of [["connectionType", "effectiveType"], ["connectionRtt", "rtt"], ["connectionDownlink", "downlink"], ["saveData", "saveData"]] as const) {
    if (active(key)) getter(connection, property, config[key]);
  }
  if (active("storageQuotaMiB") && typeof StorageManager !== "undefined") method(StorageManager.prototype, "estimate", async () => ({ quota: config.storageQuotaMiB! * 1048576, usage: 0 }));
  if (config.hidePerformanceMemory) getter(performance, "memory", undefined);
  if (active("webrtcPolicy")) {
    for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection"] as const) {
      const Native = (realm as unknown as Record<string, typeof RTCPeerConnection>)[key];
      if (!Native) continue;
      const wrapped = new Proxy(Native, { construct(target, args, newTarget) {
        if (config.webrtcPolicy === "blocked") throw denied();
        const peer = Reflect.construct(target, [{ ...(args[0] ?? {}), iceTransportPolicy: "relay" }, ...args.slice(1)], newTarget) as RTCPeerConnection;
        state!.peers.add(peer);
        peer.addEventListener("connectionstatechange", () => { if (peer.connectionState === "closed") state!.peers.delete(peer); });
        return peer;
      } });
      method(realm, key, wrapped);
      method(Native.prototype, "constructor", wrapped);
    }
    if (config.webrtcPolicy === "relay" && typeof RTCPeerConnection !== "undefined") {
      const original = RTCPeerConnection.prototype.setConfiguration;
      method(RTCPeerConnection.prototype, "setConfiguration", function (this: RTCPeerConnection, configuration: RTCConfiguration) {
        return original.call(this, { ...configuration, iceTransportPolicy: "relay" });
      });
    }
  }
  Object.defineProperty(realm, "__platypusQa", { configurable: true, value: Object.freeze({ version: 1, simulated: Boolean(runtime), configured: Object.keys(config), skipped: [...state.skipped] }) });
}
