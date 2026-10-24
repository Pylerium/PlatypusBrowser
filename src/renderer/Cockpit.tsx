import { useEffect, useState } from "react";
import platypusLogo from "../../assets/icons/logo-platypus.png";
import type { BrowserProfile, BrowserStatus, WorkspaceStatus } from "../shared/types";

type Entry = { at: number; profileId?: string; kind: string; message: string };
type Snapshot = { profileId: string; cpu: number | null; memory: number | null; at: number };
type Props = {
  profiles: BrowserProfile[]; statuses: Record<string, BrowserStatus>; workspaces: Record<string, WorkspaceStatus>;
  selectedId: string | null; onSelect(id: string): void; busyId: string | null; importing: boolean;
  onNew(): void; onEdit(profile: BrowserProfile): void; onRemove(profile: BrowserProfile): Promise<void>;
  onTelemetry(profile: BrowserProfile): void; onRouting(): void; onExport(profile: BrowserProfile): Promise<void>;
  onProxyFile(file: File): Promise<void>; onMetadataFile(file: File): Promise<void>;
  act(id: string, action: () => Promise<unknown>, success: string): Promise<void>;
  entries: Entry[]; onClear(): void;
};

function Icon({ kind }: { kind: "shield" | "globe" | "sliders" | "play" | "terminal" | "cpu" }) {
  const paths = { shield: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4Z M8 12l3 3 5-6", globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z", sliders: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6", play: "m8 4 12 8-12 8V4Z", terminal: "m4 5 6 7-6 7M13 19h7", cpu: "M7 7h10v10H7V7ZM9 1v4M15 1v4M9 19v4M15 19v4M1 9h4M1 15h4M19 9h4M19 15h4" };
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function stateFor(profile: BrowserProfile, statuses: Props["statuses"], workspaces: Props["workspaces"]) {
  const vm = workspaces[profile.id], local = statuses[profile.id];
  if (local?.windowOpen) return local.state === "connecting" ? { label: "Local starting", kind: "connecting" } : { label: "Local running", kind: "running" };
  if (vm?.state === "booting") return { label: "Booting", kind: "connecting" };
  if (vm?.processRunning && vm.state === "running") return { label: "VM running", kind: "running" };
  if (vm?.state === "error" || local?.state === "error") return { label: "Error", kind: "error" };
  return { label: "Stopped", kind: "stopped" };
}

export function Cockpit(props: Props) {
  const { profiles, statuses, workspaces, busyId, act } = props;
  const [engine, setEngine] = useState<"qemu" | "electron">("qemu");
  const [search, setSearch] = useState("");
  const [tenant, setTenant] = useState("");
  const [logTab, setLogTab] = useState<"events" | "qemu">("events");
  const [output, setOutput] = useState("");
  const [logError, setLogError] = useState("");
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [backend, setBackend] = useState("Not checked");
  const [checkingBackend, setCheckingBackend] = useState(false);
  const profile = profiles.find(item => item.id === props.selectedId) ?? profiles[0];
  const vm = profile ? workspaces[profile.id] : undefined;
  const local = profile ? statuses[profile.id] : undefined;
  const vmActive = Boolean(vm?.processRunning || vm?.state === "booting");
  const localActive = Boolean(local?.windowOpen);
  useEffect(() => { if (localActive) setEngine("electron"); else if (vmActive) setEngine("qemu"); }, [profile?.id, localActive, vmActive]);
  const runtime = profile?.runtime;
  const state = profile ? stateFor(profile, statuses, workspaces) : { label: "No profile selected", kind: "stopped" };
  const busy = profile && busyId === profile.id;
  const visible = profiles.filter(item => (!tenant || (item.tenantId ?? "default") === tenant) && `${item.name} ${item.tenantId ?? "default"}`.toLowerCase().includes(search.toLowerCase()));
  const tenants = [...new Set(profiles.map(item => item.tenantId ?? "default"))].sort();
  useEffect(() => {
    if (!profile) return;
    const point = { profileId: profile.id, cpu: runtime?.hardwareConcurrency ?? null, memory: runtime?.deviceMemory ?? null, at: Date.now() };
    setHistory(current => {
      const previous = current.filter(item => item.profileId === point.profileId).at(-1);
      return previous?.cpu === point.cpu && previous?.memory === point.memory ? current : [...current, point].slice(-100);
    });
  }, [profile?.id, runtime?.hardwareConcurrency, runtime?.deviceMemory]);
  useEffect(() => {
    if (!profile || logTab !== "qemu") return;
    let alive = true, pending = false;
    setOutput(""); setLogError("");
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const logs = await window.platypus.workspace.logs(profile.id); if (alive) setOutput([logs.stdout, logs.stderr].filter(Boolean).join("\n")); }
      catch { if (alive) setLogError("Could not read QEMU output."); }
      finally { pending = false; }
    };
    void refresh(); const timer = vmActive ? window.setInterval(() => void refresh(), 3000) : undefined;
    return () => { alive = false; if (timer) window.clearInterval(timer); };
  }, [profile?.id, logTab, vmActive]);
  async function checkBackend() {
    setCheckingBackend(true);
    try { const result = await window.platypus.diagnostics.localBackend(); setBackend(result.reachable ? `HTTP ${result.statusCode} · ${result.latencyMs} ms` : "Unavailable"); }
    catch { setBackend("Check failed"); }
    finally { setCheckingBackend(false); }
  }
  const points = history.filter(item => item.profileId === profile?.id).slice(-24);
  const line = (key: "cpu" | "memory", max: number) => points.map((point, i) => point[key] === null ? "" : `${32 + (points.length === 1 ? 0.5 : i / (points.length - 1)) * 476},${150 - (point[key]! / max) * 116}`).filter(Boolean).join(" ");
  const profileEvents = props.entries.filter(entry => !profile || !entry.profileId || entry.profileId === profile.id);
  const clock = (at: number) => new Date(at).toLocaleTimeString("en-AU", { timeZone: "Australia/Perth", hour12: false });
  return <div className="cockpit">
    <header className="cockpit-header"><div className="cockpit-brand"><span className="brand-logo"><img src={platypusLogo} alt="Platypus Browser logo" draggable={false} /></span><div><h1>PLATYPUS BROWSER <span className="version-tag">QA WORKSPACES</span></h1><p>Deterministic testing & telemetry profiling</p></div></div>
      <div className="header-actions"><span className="vault-badge">◆ <span>OS-protected encrypted storage</span></span><button className="secondary-button" onClick={props.onRouting}><Icon kind="globe" />Proxies & Routing</button><button className="primary-button" disabled={!profile} onClick={() => profile && props.onTelemetry(profile)}><Icon kind="sliders" />Telemetry Controls</button></div>
    </header>
    <div className="cockpit-body"><aside className="workspace-sidebar"><div className="sidebar-heading"><h2>Workspace profiles</h2><button className="secondary-button small-button" onClick={props.onNew}>＋ New profile</button></div>
      <div className="sidebar-filters"><input className="text-input" aria-label="Search profiles" placeholder="Search profiles or tenants…" value={search} onChange={event => setSearch(event.target.value)} /><select className="text-input" aria-label="Filter tenant" value={tenant} onChange={event => setTenant(event.target.value)}><option value="">All tenants</option>{tenants.map(item => <option key={item} value={item}>{item}</option>)}</select></div>
      <div className="workspace-list" aria-label="Workspace profiles">{visible.map(item => {
        const current = stateFor(item, statuses, workspaces), active = Boolean(statuses[item.id]?.windowOpen || workspaces[item.id]?.processRunning || workspaces[item.id]?.state === "booting");
        return <article key={item.id} className={`workspace-card ${item.id === profile?.id ? "selected" : ""}`}>
          <button className="profile-select" aria-pressed={item.id === profile?.id} onClick={() => props.onSelect(item.id)}><div className="workspace-card-title"><strong>{item.name}</strong><span className={`state-pill state-${current.kind}`}><span />{current.label}</span></div>
            <dl><div><dt>Tenant</dt><dd>{item.tenantId ?? "default"}</dd></div><div><dt>CPU / memory</dt><dd>{item.runtime?.hardwareConcurrency ?? "Native"} / {item.runtime?.deviceMemory == null ? "Native" : `${item.runtime.deviceMemory} GB`}</dd></div><div><dt>Proxy</dt><dd>{item.proxy ? `${item.proxy.protocol.toUpperCase()} · ${item.proxy.host}` : "Direct connection"}</dd></div></dl>
            <p>{item.session?.cookieCount ?? 0} imported cookies <span>Inspect workspace →</span></p></button>
          <div className="sidebar-card-actions"><button className="icon-button" aria-label={`Edit ${item.name}`} disabled={active || busyId === item.id} onClick={() => props.onEdit(item)}>Edit</button><button className="icon-button" aria-label={`Telemetry for ${item.name}`} onClick={() => props.onTelemetry(item)}>Telemetry</button><button className="icon-button" onClick={() => void act(item.id, () => props.onExport(item), "")}>Export metadata</button><button className="icon-button danger-text" aria-label={`Delete ${item.name}`} disabled={active || busyId === item.id} onClick={() => void props.onRemove(item)}>Purge</button></div>
        </article>;
      })}{!visible.length && <div className="sidebar-empty">{profiles.length ? "No profiles match these filters." : "Create a profile or import your proxy list to get started."}</div>}</div>
      <div className="sidebar-imports"><label className="file-button secondary-button">{props.importing ? "Importing…" : "Import proxy list"}<input type="file" aria-label="Import proxy list" disabled={props.importing} accept=".txt,.json,text/plain,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void props.onProxyFile(file); }} /></label><label className="file-button secondary-button">Import metadata<input type="file" aria-label="Import profile metadata" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void props.onMetadataFile(file); }} /></label></div>
      <div className="sidebar-summary"><div><span>Running workspaces</span><strong>{profiles.filter(item => stateFor(item, statuses, workspaces).kind === "running").length} / {profiles.length}</strong></div><div><span>Local inspector</span><strong>127.0.0.1:5000</strong></div><button className="text-button" disabled={checkingBackend} onClick={() => void checkBackend()}>{checkingBackend ? "Checking…" : `Check inspector · ${backend}`}</button></div>
    </aside>
    <main className="cockpit-workbench"><section className="execution-toolbar"><div className="engine-switch" role="group" aria-label="Execution engine"><button aria-pressed={engine === "electron"} onClick={() => setEngine("electron")}><Icon kind="cpu" />Electron local</button><button aria-pressed={engine === "qemu"} onClick={() => setEngine("qemu")}><Icon kind="shield" />QEMU q35</button></div>
      <button className={`launch-button ${engine === "qemu" && vmActive ? "stop-button" : ""}`} disabled={!profile || (busy && vm?.state !== "booting") || (engine === "qemu" ? localActive : vmActive)} onClick={() => {
        if (!profile) return;
        void act(profile.id, () => engine === "qemu" ? vmActive ? window.platypus.workspace.close(profile.id) : window.platypus.workspace.launch(profile.id) : localActive ? window.platypus.browser.close(profile.id) : window.platypus.browser.launch(profile.id), "");
      }}><Icon kind="play" />{engine === "qemu" ? vmActive ? "CLOSE WORKSPACE" : "LAUNCH WORKSPACE" : localActive ? "CLOSE LOCAL BROWSER" : "LAUNCH LOCAL BROWSER"}</button>
      <button className="secondary-button" disabled={!profile || busy || vmActive} onClick={() => profile && void act(profile.id, () => localActive ? window.platypus.browser.close(profile.id) : window.platypus.browser.launch(profile.id), "")}>{localActive ? "Close browser" : "Open local browser ↗"}</button>
      <span className="egress-label">{profile?.proxy ? `${profile.proxy.protocol.toUpperCase()} gateway · local bypass` : "Direct connection"}</span>
    </section>
    <div className="workbench-scroll">{profile ? <>
      <div className="workspace-heading"><div><span className="eyebrow">ACTIVE SELECTION · {profile.tenantId ?? "default"}</span><h2>{profile.name}</h2><p title={profile.startUrl}>{profile.startUrl}</p></div><span className={`state-pill state-${state.kind}`}><span />{state.label}</span></div>
      <section className="overview-grid" aria-label="Saved profile overview"><div className="overview-card"><span>REPORTED PLATFORM</span><strong>{runtime?.platform ?? "Native platform"}</strong><small>Saved navigator setting</small></div><div className="overview-card emerald"><span>HARDWARE CONCURRENCY</span><strong>{runtime?.hardwareConcurrency == null ? "Native threads" : `${runtime.hardwareConcurrency} threads`}</strong><small>{runtime?.deviceMemory == null ? "Native device memory" : `${runtime.deviceMemory} GB reported memory`}</small></div><div className="overview-card amber"><span>CANVAS RASTER SEED</span><strong>{runtime?.canvasSeed == null ? "Native rendering" : `0x${runtime.canvasSeed.toString(16).padStart(8, "0").toUpperCase()}`}</strong><small>{runtime?.canvasSeed == null ? "No seeded text offset" : "Deterministic text rendering offsets"}</small></div><div className="overview-card"><span>WEBRTC POLICY</span><strong>{profile.proxy || runtime?.webrtcPolicy === "blocked" ? "Blocked" : runtime?.webrtcPolicy === "relay" ? "Relay only" : "Native"}</strong><small>{profile.proxy ? "Required for proxied profiles" : "Saved runtime policy"}</small></div></section>
      <div className="analytics-grid"><section className="dashboard-panel configuration-chart"><div className="panel-title"><h3>Telemetry configuration history</h3><span>Saved settings · this session</span></div><div className="chart-legend"><span>● CPU threads / 256</span><span>● Device memory / 8 GB</span></div><svg viewBox="0 0 540 185" role="img" aria-label="History of saved CPU thread and device memory overrides">
        {[34, 63, 92, 121, 150].map((y, i) => <g key={y}><line x1="32" y1={y} x2="508" y2={y} className="chart-grid" /><text x="5" y={y + 4}>{256 - i * 64}</text></g>)}
        <polyline points={line("cpu", 256)} className="chart-cpu" /><polyline points={line("memory", 8)} className="chart-memory" />
        {points.map((point, i) => <g key={point.at}>{point.cpu !== null && <circle cx={32 + (points.length === 1 ? 0.5 : i / (points.length - 1)) * 476} cy={150 - point.cpu / 256 * 116} r="3" className="chart-cpu-point" />}{point.memory !== null && <circle cx={32 + (points.length === 1 ? 0.5 : i / (points.length - 1)) * 476} cy={150 - point.memory / 8 * 116} r="3" className="chart-memory-point" />}</g>)}
        <text x="32" y="177">{points[0] ? clock(points[0].at) : "No saved overrides"}</text><text x="440" y="177">{points.length > 1 ? clock(points.at(-1)!.at) : "Current"}</text></svg><p className="field-help">Native values are not sampled. This chart records saved overrides, not guest resource usage.</p>
      </section><section className="dashboard-panel identity-panel"><div className="panel-title"><h3>Workspace & guest identity</h3><Icon kind="shield" /></div><dl><div><dt>Execution status</dt><dd>{state.label}</dd></div><div><dt>Hardware model</dt><dd>QEMU q35 / Adios</dd></div><div><dt>Workspace UUID</dt><dd className="uuid">{profile.id}</dd></div><div><dt>Guest adapter</dt><dd>{vm?.state === "running" ? "Startup acknowledged" : vm?.state === "booting" ? "Waiting for guest" : "Available at VM launch"}</dd></div><div><dt>Cookie seed</dt><dd>{profile.session?.cookieCount ?? 0} entries · revision {profile.session?.revision ?? 0}</dd></div><div><dt>Proxy credentials</dt><dd>{profile.proxy?.hasCredentials ? "Saved encrypted" : "None stored"}</dd></div></dl><div className="button-row"><button className="secondary-button small-button" disabled={!profile.proxy || busy} onClick={() => void act(profile.id, async () => { const result = await window.platypus.browser.checkProxy(profile.id); return `Proxy connected in ${result.latencyMs} ms`; }, "Proxy connectivity check passed.")}>Test proxy</button><button className="secondary-button small-button" disabled={vmActive || localActive || busy} onClick={() => props.onEdit(profile)}>Edit configuration</button></div></section></div>
      <section className="dashboard-panel event-terminal"><div className="panel-title"><h3><Icon kind="terminal" /> Workspace event console</h3><div className="button-row"><button className="icon-button" aria-pressed={logTab === "events"} onClick={() => setLogTab("events")}>Manager events</button><button className="icon-button" aria-pressed={logTab === "qemu"} onClick={() => setLogTab("qemu")}>QEMU output</button><button className="icon-button" onClick={() => { props.onClear(); setLogTab("events"); }}>Clear output</button></div></div>
        <div className="terminal-output" role="log" aria-label="Workspace events">{logTab === "qemu" ? <pre>{logError || output || "No QEMU output available for this workspace."}</pre> : profileEvents.length ? profileEvents.map((entry, index) => <div className="event-line" key={`${entry.at}-${index}`}><time>{clock(entry.at)}</time><span className={`event-kind event-${entry.kind.toLowerCase()}`}>{entry.kind}</span><span>{entry.message}</span></div>) : <p className="muted">Lifecycle and manager events appear here as actions occur.</p>}</div>
      </section>
    </> : <section className="cockpit-empty"><span className="brand-logo"><img src={platypusLogo} alt="Platypus Browser logo" draggable={false} /></span><h2>Your workspace cockpit is ready</h2><p>Create an isolated profile or import proxy endpoints to begin. Saved profiles, routing and telemetry appear here.</p><button className="primary-button" onClick={props.onNew}>Create your first profile</button></section>}</div>
    <footer className="cockpit-footer"><span>Adios encrypted settings · profile-isolated sessions</span><span>Electron local / hardware-accelerated q35</span></footer>
    </main></div>
  </div>;
}
