import type { RuntimeSimulation } from "./types";

export const telemetryGroups = ["Core Hardware", "Rasterization & Graphics", "Audio & Sensors", "Network & Isolation"] as const;
export interface TelemetryVector {
  key: keyof RuntimeSimulation;
  label: string;
  group: typeof telemetryGroups[number];
  control: "range" | "number" | "text" | "toggle" | "select";
  initial: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly (number | string)[];
  custom?: boolean;
  note?: string;
}
export const telemetrySchema: readonly TelemetryVector[] = [
  { key: "hardwareConcurrency", label: "CPU threads", group: "Core Hardware", control: "range", min: 1, max: 256, step: 1, initial: 4 },
  { key: "deviceMemory", label: "Device memory (GiB)", group: "Core Hardware", control: "range", min: 0.25, max: 8, options: [0.25, 0.5, 1, 2, 4, 8], initial: 4 },
  { key: "platform", label: "Navigator platform", group: "Core Hardware", control: "text", initial: "Linux x86_64", max: 64 },
  { key: "userAgent", label: "User agent", group: "Core Hardware", control: "text", initial: "Platypus-QA/1.0", max: 512, note: "Local browser also updates the HTTP user-agent. VM browser changes require Apply." },
  { key: "appVersion", label: "App version", group: "Core Hardware", control: "text", initial: "5.0 (QA)", max: 512 },
  { key: "vendor", label: "Navigator vendor", group: "Core Hardware", control: "text", initial: "QA Vendor", max: 128 },
  { key: "languages", label: "Languages (ordered, comma separated)", group: "Core Hardware", control: "text", initial: "en-US,en", max: 128, note: "Local browser also normalizes Accept-Language. VM changes require Apply." },
  { key: "maxTouchPoints", label: "Touch points", group: "Core Hardware", control: "range", min: 0, max: 20, step: 1, initial: 0 },
  { key: "doNotTrack", label: "Do Not Track", group: "Core Hardware", control: "select", options: ["1", "0", "unspecified"], initial: "1" },
  { key: "pdfViewerEnabled", label: "Report PDF viewer support", group: "Core Hardware", control: "toggle", initial: true },
  { key: "hideClientHints", label: "Hide JavaScript client hints", group: "Core Hardware", control: "toggle", initial: true, note: "Local sessions also remove Sec-CH-UA headers. VM headers and worker JavaScript remain browser-controlled." },
  { key: "screenWidth", label: "Reported screen width", group: "Rasterization & Graphics", control: "number", min: 320, max: 16384, step: 1, initial: 1920 },
  { key: "screenHeight", label: "Reported screen height", group: "Rasterization & Graphics", control: "number", min: 200, max: 16384, step: 1, initial: 1080 },
  { key: "colorDepth", label: "Reported color depth", group: "Rasterization & Graphics", control: "select", options: [16, 24, 30, 32], initial: 24 },
  { key: "devicePixelRatio", label: "Reported pixel ratio", group: "Rasterization & Graphics", control: "range", min: 0.5, max: 4, step: 0.25, initial: 1, note: "Reporting only; viewport geometry and CSS layout remain real." },
  { key: "webglVendor", label: "Reported WebGL vendor", group: "Rasterization & Graphics", control: "text", initial: "Platypus QA", max: 128 },
  { key: "webglRenderer", label: "Reported WebGL renderer", group: "Rasterization & Graphics", control: "select", options: ["QA integrated renderer", "QA discrete renderer", "QA software renderer"], custom: true, max: 256, initial: "QA software renderer", note: "Choose a renderer or enter a custom label. Does not add GPU capabilities." },
  { key: "canvasSeed", label: "Canvas text variation seed", group: "Rasterization & Graphics", control: "number", min: 0, max: 4294967295, step: 1, initial: 0 },
  { key: "audioSeed", label: "Offline audio variation seed", group: "Audio & Sensors", control: "number", min: 0, max: 4294967295, step: 1, initial: 0 },
  { key: "mediaBlocked", label: "Block media enumeration and capture", group: "Audio & Sensors", control: "toggle", initial: true },
  { key: "sensorsBlocked", label: "Block sensor constructors", group: "Audio & Sensors", control: "toggle", initial: true },
  { key: "batteryLevel", label: "Battery level", group: "Audio & Sensors", control: "range", min: 0, max: 1, step: 0.01, initial: 1 },
  { key: "batteryCharging", label: "Battery charging", group: "Audio & Sensors", control: "toggle", initial: true },
  { key: "emptyVoices", label: "Return an empty speech voice list", group: "Audio & Sensors", control: "toggle", initial: true },
  { key: "emptyGamepads", label: "Return an empty gamepad list", group: "Audio & Sensors", control: "toggle", initial: true },
  { key: "localFontsBlocked", label: "Block local font enumeration", group: "Audio & Sensors", control: "toggle", initial: true, note: "Installed fonts and text measurements remain real." },
  { key: "connectionType", label: "Effective connection type", group: "Network & Isolation", control: "select", options: ["slow-2g", "2g", "3g", "4g"], initial: "4g" },
  { key: "connectionRtt", label: "Reported RTT (ms)", group: "Network & Isolation", control: "range", min: 0, max: 2000, step: 1, initial: 100 },
  { key: "connectionDownlink", label: "Reported downlink (Mbps)", group: "Network & Isolation", control: "number", min: 0, max: 10000, step: 0.05, initial: 10 },
  { key: "saveData", label: "Report data saver", group: "Network & Isolation", control: "toggle", initial: false },
  { key: "storageQuotaMiB", label: "Reported storage quota (MiB)", group: "Network & Isolation", control: "number", min: 1, max: 1048576, step: 1, initial: 1024, note: "Mock estimate only; actual storage limits are unchanged." },
  { key: "hidePerformanceMemory", label: "Hide nonstandard performance.memory", group: "Network & Isolation", control: "toggle", initial: true },
  { key: "webrtcPolicy", label: "WebRTC restriction", group: "Network & Isolation", control: "select", options: ["blocked", "relay"], initial: "blocked", note: "Relay requires application-provided TURN. Existing peers close when the policy changes." },
];

export const telemetryBoundaries = [
  { label: "Automation state, product and engine identity", value: "Native", reason: "Integrity and Function.toString are not disguised." },
  { label: "Viewport, orientation and window position", value: "Native", reason: "Use real browser or VM display sizing for layout tests." },
  { label: "Cookie storage and permissions", value: "Browser policy", reason: "Reported cookie state is retained; permission grants are never fabricated." },
  { label: "Fonts, GPU capabilities and device availability", value: "Guest resources", reason: "Install actual assets and drivers to change capabilities." },
  { label: "Clocks, heap counters and navigation timing", value: "Native", reason: "Timing stays monotonic; the nonstandard heap object can be hidden." },
  { label: "Client IP, TLS and transport client hints", value: "Network / browser", reason: "JavaScript cannot virtualize the server-observed connection." },
  { label: "Workers and service workers", value: "Native", reason: "Document preload interception does not cover worker globals." },
] as const;
