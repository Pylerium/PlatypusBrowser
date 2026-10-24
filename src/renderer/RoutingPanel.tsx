import { useEffect, useState } from "react";
import type { BrowserProfile, ProxyProtocol } from "../shared/types";
import { localProxyBypassRules } from "../shared/sessionConfig";
import { Modal } from "./Modal";

export function RoutingPanel({ profiles, initialId, running, onUpdated, onClose }: {
  profiles: BrowserProfile[]; initialId?: string; running(id: string): boolean; onUpdated(): Promise<void>; onClose(): void;
}) {
  const [targetId, setTargetId] = useState(initialId ?? profiles[0]?.id ?? "");
  const profile = profiles.find(item => item.id === targetId);
  const [tenant, setTenant] = useState(profile?.tenantId ?? "default");
  const [protocol, setProtocol] = useState<ProxyProtocol>("http");
  const [text, setText] = useState("");
  const [rules, setRules] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => { setRules((profile?.session?.proxyBypassRules ?? []).filter(rule => !localProxyBypassRules.includes(rule)).join(", ")); }, [targetId, profile?.session?.revision]);
  async function action(task: () => Promise<string>) {
    setBusy(true); setError(""); setNotice("");
    try { setNotice(await task()); await onUpdated(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Routing action failed."); }
    finally { setBusy(false); }
  }
  async function importText(contents: string) {
    const result = await window.platypus.profiles.importProxies(contents, protocol, tenant);
    setText(""); return `Imported ${result.created} proxy profiles. Skipped ${result.skipped} existing endpoints.`;
  }
  return <Modal title="Proxies & Routing" onClose={() => { if (!busy) onClose(); }}>
    <p className="muted">Endpoints and credentials are saved encrypted. External traffic uses the assigned proxy; local exceptions remain accessible.</p>
    {(error || notice) && <div className={`notice ${error ? "notice-error" : "notice-success"}`} role={error ? "alert" : "status"}>{error || notice}</div>}
    <fieldset disabled={busy} className="routing-fieldset">
      <section className="routing-section"><h3>Bulk endpoint ingestion</h3>
        <div className="form-columns"><label className="field-label">Import tenant<input className="text-input" aria-label="Proxy import tenant" maxLength={64} value={tenant} onChange={event => setTenant(event.target.value)} /></label>
          <label className="field-label">Default protocol<select className="text-input" value={protocol} onChange={event => setProtocol(event.target.value as ProxyProtocol)}><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></label></div>
        <label className="field-label" htmlFor="proxy-list-input">Endpoint list</label><textarea id="proxy-list-input" className="text-input routing-textarea" rows={4} value={text} onChange={event => setText(event.target.value)} placeholder="socks5://username:password@proxy.example.com:1080" />
        <p className="field-help">HTTP/SOCKS5 URLs, JSON arrays, or host:port:user:password. Up to 100 endpoints.</p>
        <div className="button-row"><button className="primary-button" disabled={!text.trim()} onClick={() => void action(() => importText(text))}>Import proxy list</button>
          <label className="file-button secondary-button">Choose proxy file<input type="file" accept=".txt,.json" onChange={event => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (file) void action(async () => { if (file.size > 200000) throw new Error("Proxy file is too large."); return importText(await file.text()); });
          }} /></label></div>
      </section>
      <section className="routing-section"><h3>Profile routing & session hydration</h3>
        <label className="field-label" htmlFor="routing-profile">Target profile</label><select id="routing-profile" className="text-input" value={targetId} onChange={event => setTargetId(event.target.value)}>
          {!profiles.length && <option value="">Create a profile first</option>}{profiles.map(item => <option key={item.id} value={item.id}>{item.name} · {item.tenantId ?? "default"}</option>)}</select>
        <div className="bypass-chips">{localProxyBypassRules.map(rule => <code key={rule}>{rule}</code>)}</div>
        <p className="field-help">Mandatory local exceptions are always included.</p>
        <label className="field-label" htmlFor="routing-bypass">Additional bypass hosts</label><input id="routing-bypass" className="text-input" value={rules} onChange={event => setRules(event.target.value)} placeholder="*.lab.internal, telemetry.internal" />
        <div className="button-row"><button className="secondary-button" disabled={!profile || running(profile.id)} onClick={() => void action(async () => {
          await window.platypus.profiles.configureSession(targetId, rules.split(",").map(item => item.trim()).filter(Boolean)); return "Routing exceptions saved.";
        })}>Save routing rules</button>
          <label className={`file-button secondary-button ${!profile || running(profile.id) ? "is-disabled" : ""}`}>Import cookies<input type="file" aria-label="Routing cookie import" accept=".json,.txt,.cookies" disabled={!profile || running(profile.id)} onChange={event => {
            const file = event.target.files?.[0]; event.target.value = "";
            if (file) void action(async () => { if (file.size > 4 * 1024 * 1024) throw new Error("Cookie file exceeds 4 MiB."); const result = await window.platypus.profiles.importCookies(targetId, await file.text()); return `Saved ${result.cookieCount} imported cookies for startup hydration.`; });
          }} /></label></div>
        <p className="field-help">{profile?.session?.cookieCount ?? 0} saved cookie entries. JSON and Netscape formats supported. Close the profile before changing routing or cookies.</p>
      </section>
    </fieldset>
    <div className="button-row" style={{ justifyContent: "flex-end", marginTop: 18 }}><button className="primary-button" disabled={busy} onClick={onClose}>Done</button></div>
  </Modal>;
}
