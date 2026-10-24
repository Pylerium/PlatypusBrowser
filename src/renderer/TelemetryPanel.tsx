import { useEffect, useId, useRef, useState } from "react";
import { telemetryBoundaries, telemetryGroups, telemetrySchema } from "../shared/telemetrySchema";
import { validateRuntime } from "../shared/runtime";
import type { BrowserProfile, RuntimeSimulation, TelemetryState, TelemetryTemplate } from "../shared/types";

export function TelemetryControls({ value, onChange }: { value: RuntimeSimulation | null; onChange(value: RuntimeSimulation | null): void }) {
  const [group, setGroup] = useState<typeof telemetryGroups[number]>(telemetryGroups[0]);
  const id = useId();
  function update(key: keyof RuntimeSimulation, next: unknown) {
    const copy = { ...value };
    if (next === null) delete copy[key]; else Object.assign(copy, { [key]: next });
    onChange(Object.keys(copy).length ? copy : null);
  }
  return <section className="telemetry-controls" aria-label="Telemetry vectors">
    <div className="telemetry-tabs" role="tablist" aria-label="Telemetry categories">
      {telemetryGroups.map((item, index) => <button key={item} id={`${id}-tab-${index}`} aria-controls={`${id}-vectors`} type="button" role="tab"
        aria-selected={item === group} tabIndex={item === group ? 0 : -1} onClick={() => setGroup(item)} onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault(); const next = (index + (event.key === "ArrowRight" ? 1 : -1) + telemetryGroups.length) % telemetryGroups.length;
          setGroup(telemetryGroups[next]!); document.getElementById(`${id}-tab-${next}`)?.focus();
        }}>{item}</button>)}
    </div>
    <div className="telemetry-vector-grid" role="tabpanel" id={`${id}-vectors`} aria-labelledby={`${id}-tab-${telemetryGroups.indexOf(group)}`}>
      {telemetrySchema.filter(item => item.group === group).map(vector => {
        const enabled = value?.[vector.key] !== undefined && value[vector.key] !== null;
        const current = value?.[vector.key] ?? vector.initial;
        const inputId = `${id}-${vector.key}`;
        return <div className={`telemetry-vector ${enabled ? "is-custom" : ""}`} key={vector.key}>
          <div className="telemetry-vector-heading"><label htmlFor={inputId}>{vector.label}</label>
            <label className="telemetry-mode"><input type="checkbox" checked={enabled} aria-label={`Customize ${vector.label}`}
              onChange={event => update(vector.key, event.target.checked ? vector.initial : null)} />{enabled ? "Custom" : "Native"}</label></div>
          {vector.control === "toggle" ? <label className="telemetry-toggle"><input id={inputId} type="checkbox" disabled={!enabled} checked={enabled && Boolean(current)}
            onChange={event => update(vector.key, event.target.checked)} />{!enabled ? "Native default" : current ? "Enabled" : "Disabled"}</label>
            : vector.control === "select" && vector.custom ? <><input className="text-input" id={inputId} disabled={!enabled} value={String(current)} list={`${inputId}-choices`} maxLength={vector.max}
              onChange={event => update(vector.key, event.target.value)} /><datalist id={`${inputId}-choices`}>{vector.options!.map(option => <option key={option} value={option} />)}</datalist></>
            : vector.control === "select" ? <select className="text-input" id={inputId} disabled={!enabled} value={String(current)}
              onChange={event => update(vector.key, typeof vector.initial === "number" ? Number(event.target.value) : event.target.value)}>
              {vector.options!.map(option => <option key={option} value={option}>{option}</option>)}
            </select> : <div className="telemetry-value"><input className={vector.control === "range" ? "telemetry-slider" : "text-input"} id={inputId}
              type={vector.control === "text" ? "text" : vector.control === "range" ? "range" : "number"} disabled={!enabled}
              min={vector.control === "range" && vector.options ? 0 : vector.min} max={vector.control === "range" && vector.options ? vector.options.length - 1 : vector.max}
              step={vector.control === "range" && vector.options ? 1 : vector.step} maxLength={vector.control === "text" ? vector.max : undefined}
              value={vector.control === "range" && vector.options ? vector.options.indexOf(current as number) : typeof current === "boolean" ? String(current) : current}
              onChange={event => update(vector.key, vector.control === "text" ? event.target.value : vector.control === "range" && vector.options ? vector.options[Number(event.target.value)] : Number(event.target.value))} />
              {vector.control === "range" && <output htmlFor={inputId}>{String(current)}</output>}</div>}
          {vector.note && <p>{vector.note}</p>}
          {enabled && <button type="button" className="text-button vector-reset" onClick={() => update(vector.key, null)}>Reset to native</button>}
        </div>;
      })}
    </div>
  </section>;
}

const presets: TelemetryTemplate[] = [
  { id: "native", name: "Native environment", runtime: null },
  { id: "desktop", name: "QA desktop", runtime: { hardwareConcurrency: 8, deviceMemory: 8, platform: "Linux x86_64", screenWidth: 1920, screenHeight: 1080, canvasSeed: 42, webrtcPolicy: "blocked" } },
  { id: "compact", name: "QA compact device", runtime: { hardwareConcurrency: 2, deviceMemory: 2, platform: "Linux aarch64", screenWidth: 390, screenHeight: 844, devicePixelRatio: 2, maxTouchPoints: 5, connectionType: "3g", webrtcPolicy: "blocked" } },
];

export function TelemetryPanel({ profile, onClose, onSaved }: { profile: BrowserProfile; onClose(): void; onSaved(profile: BrowserProfile): void }) {
  const [runtime, setRuntime] = useState<RuntimeSimulation | null>(null);
  const [templates, setTemplates] = useState<TelemetryTemplate[]>([]);
  const [selected, setSelected] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [status, setStatus] = useState("Loading encrypted settings…");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [committedRevision, setCommittedRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const revision = useRef(0);
  const saved = useRef("");
  const draft = useRef(runtime); draft.current = runtime;
  const pending = useRef(Promise.resolve());
  const alive = useRef(true);
  const file = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onSavedRef = useRef(onSaved); onSavedRef.current = onSaved;
  useEffect(() => {
    alive.current = true; closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    void Promise.all([window.platypus.telemetry.get(profile.id), window.platypus.telemetry.templates()]).then(([state, items]) => {
      if (!alive.current) return;
      revision.current = state.revision; saved.current = JSON.stringify(state.runtime);
      setRuntime(state.runtime); setTemplates(items); setLoaded(true); setCommittedRevision(state.revision); setStatus("Saved · encrypted with Adios");
    }).catch(reason => setError(String(reason)));
    return () => { alive.current = false; document.body.style.overflow = previousOverflow; };
  }, [profile.id]);
  function message(state: TelemetryState): string {
    if (state.application === "local-reloaded") return "Saved · local browser reloaded for the network policy";
    return state.application === "local-live" ? "Saved · applied to the local browser" : state.application === "workspace-pending"
      ? "Saved · apply to update the workspace browser" : "Saved · applies on next launch";
  }
  function flush(): Promise<void> {
    const snapshot = validateRuntime(draft.current);
    const encoded = JSON.stringify(snapshot);
    const task = pending.current.catch(() => undefined).then(async () => {
      if (encoded === saved.current) return;
      if (alive.current) { setError(""); setStatus("Saving encrypted settings…"); }
      const state = await window.platypus.telemetry.save(profile.id, snapshot, revision.current);
      revision.current = state.revision; saved.current = encoded;
      if (alive.current) { setCommittedRevision(state.revision); setStatus(message(state)); }
      onSavedRef.current({ ...profile, runtime: snapshot });
    });
    pending.current = task;
    return task;
  }
  useEffect(() => {
    if (!loaded || JSON.stringify(runtime) === saved.current) return;
    setStatus("Unsaved changes…");
    const timer = window.setTimeout(() => { void Promise.resolve().then(flush).catch(reason => { if (alive.current) { setError(String(reason)); setStatus("Changes have not been saved"); } }); }, 350);
    return () => window.clearTimeout(timer);
  }, [runtime, loaded, committedRevision]);
  async function action(task: () => Promise<void>) {
    setBusy(true); setError("");
    try { await task(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  function exportJson() {
    const value = { format: "platypus-telemetry", version: 1, runtime: validateRuntime(runtime), schema: telemetrySchema };
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "platypus-telemetry.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="telemetry-backdrop"><section className="telemetry-panel" role="dialog" aria-modal="true" aria-labelledby="telemetry-title" onKeyDown={event => {
    if (event.key === "Escape" && loaded && !busy) { event.preventDefault(); void action(async () => { await flush(); onClose(); }); }
    if (event.key === "Tab") {
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(element => element.offsetParent !== null);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}>
    <header className="telemetry-header"><div><p className="eyebrow">WORKSPACE TELEMETRY</p><h2 id="telemetry-title">{profile.name}</h2><p role="status" aria-live="polite">{status}</p></div>
      <button ref={closeButton} type="button" className="secondary-button" disabled={busy} onClick={() => void action(async () => { if (loaded) await flush(); onClose(); })}>Save & close</button></header>
    {error && <div className="notice notice-error" role="alert"><span>{error}</span><button type="button" onClick={() => void action(async () => {
      await pending.current.catch(() => undefined); const current = await window.platypus.telemetry.get(profile.id);
      revision.current = current.revision; saved.current = JSON.stringify(current.runtime); setRuntime(current.runtime); setCommittedRevision(current.revision); setStatus("Reloaded saved settings");
    })}>Reload saved</button><button type="button" onClick={() => { void pending.current.finally(onClose).catch(() => undefined); }}>Discard & close</button></div>}
    <fieldset disabled={!loaded || busy} className="telemetry-fieldset">
      <div className="telemetry-toolbar"><label>Preset or template<select className="text-input" value={selected} onChange={event => {
        setSelected(event.target.value); const item = [...presets, ...templates].find(template => template.id === event.target.value); if (item) setRuntime(item.runtime);
      }}><option value="">Custom configuration</option><optgroup label="Built in">{presets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
        <optgroup label="My encrypted templates">{templates.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup></select></label>
        <button type="button" className="secondary-button" onClick={() => setRuntime(null)}>Reset all to native</button>
        <button type="button" className="secondary-button" onClick={() => { try { exportJson(); } catch (reason) { setError(String(reason)); } }}>Export JSON</button>
        <button type="button" className="secondary-button" onClick={() => file.current?.click()}>Import JSON</button>
        <input ref={file} hidden type="file" accept="application/json,.json" onChange={event => { const input = event.currentTarget; const chosen = input.files?.[0]; input.value = "";
          if (chosen) void action(async () => { if (chosen.size > 65536) throw new Error("Telemetry files must be smaller than 64 KiB.");
            const data = JSON.parse(await chosen.text()); if (data?.format !== "platypus-telemetry" || data.version !== 1 || !("runtime" in data)) throw new Error("Unsupported telemetry file.");
            setRuntime(validateRuntime(data.runtime)); setSelected(""); });
        }} />
      </div>
      <TelemetryControls value={runtime} onChange={value => { setRuntime(value); setSelected(""); }} />
      <div className="telemetry-template-actions"><label className="sr-only" htmlFor="template-name">Template name</label><input id="template-name" className="text-input" maxLength={64} placeholder="Name this configuration…" value={templateName} onChange={event => setTemplateName(event.target.value)} />
        <button type="button" className="secondary-button" disabled={!templateName.trim()} onClick={() => void action(async () => { setTemplates(await window.platypus.telemetry.saveTemplate(templateName, validateRuntime(runtime))); setTemplateName(""); })}>Save template</button>
        {templates.some(item => item.id === selected) && <button type="button" className="icon-button danger-text" onClick={() => void action(async () => { setTemplates(await window.platypus.telemetry.removeTemplate(selected)); setSelected(""); })}>Delete template</button>}
      </div>
      <div className="telemetry-apply"><p>Local properties update live; WebRTC policy changes reload the local page. New documents receive the saved settings. Applying to a running VM closes and reopens Chromium; open tabs may close. The VM and manager stay running.</p>
        <button type="button" className="primary-button" onClick={() => void action(async () => { await flush(); await window.platypus.telemetry.applyToWorkspace(profile.id); setStatus("Saved · applied to the workspace browser"); })}>Apply to workspace</button></div>
    </fieldset>
    <details className="telemetry-boundaries"><summary>Runtime coverage and boundaries</summary><dl>{telemetryBoundaries.map(item => <div key={item.label}><dt>{item.label}<span>{item.value}</span></dt><dd>{item.reason}</dd></div>)}</dl>
      <p>Simulation is inspectable through <code>window.__platypusQa</code>. Local preload covers the main document; the VM extension covers document frames. Proxy endpoints are configured on the profile. Proxied sessions block peer connections and non-proxied UDP. VM proxy profiles use a dedicated gateway with direct outbound connections blocked.</p></details>
  </section></div>;
}
