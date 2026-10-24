import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Cockpit } from "./Cockpit";
import { Modal } from "./Modal";
import { RoutingPanel } from "./RoutingPanel";
import { TelemetryControls, TelemetryPanel } from "./TelemetryPanel";
import type {
  BrowserProfile,
  BrowserStatus,
  ProfileInput,
  ProxyProtocol,
  WorkspaceStatus,
} from "../shared/types";

const blankProfile: ProfileInput = {
  tenantId: "default",
  name: "",
  startUrl: "https://example.com",
  proxy: null,
};

function App() {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [statuses, setStatuses] = useState<Record<string, BrowserStatus>>({});
  const [workspaceStatuses, setWorkspaceStatuses] = useState<Record<string, WorkspaceStatus>>({});
  const [form, setForm] = useState<ProfileInput>(blankProfile);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [telemetryProfile, setTelemetryProfile] = useState<BrowserProfile | null>(null);
  const [importing, setImporting] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [routingOpen, setRoutingOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [entries, setEntries] = useState<Array<{at:number;profileId?:string;kind:string;message:string}>>([]);
  const revisions = useRef(new Map<string, number>());
  function record(kind: string, message: string, profileId?: string) {
    setEntries(current => [...current, { at: Date.now(), kind, message, profileId }].slice(-200));
  }


  async function importProxies(file: File) {
    setImporting(true); setError(""); setNotice("");
    try {
      if (file.size > 200000) throw new Error("Proxy file is too large.");
      const result = await window.platypus.profiles.importProxies(await file.text(), "http", form.tenantId ?? "default");
      setNotice(`Imported ${result.created} proxy profiles. Skipped ${result.skipped} existing endpoints.`);
      await refreshProfiles();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Proxy import failed."); }
    finally { setImporting(false); }
  }

  async function exportMetadata(profile: BrowserProfile) {
    const contents = await window.platypus.profiles.exportMetadata(profile.id);
    const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `${profile.id}.profile.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("Metadata exported. Cookies and proxy credentials are excluded.");
  }

  async function refreshProfiles() {
    setProfiles(await window.platypus.profiles.list());
  }

  useEffect(() => {
    const acceptWorkspaceStatus = (status: WorkspaceStatus, announce = true) => {
      if ((revisions.current.get(status.profileId) ?? -1) >= status.revision) return;
      revisions.current.set(status.profileId, status.revision);
      record("WORKSPACE", status.message ?? `Workspace ${status.state}.`, status.profileId);
      setWorkspaceStatuses((current) => (current[status.profileId]?.revision ?? -1) > status.revision
        ? current : { ...current, [status.profileId]: status });
      if (announce && status.state === "error" && status.message) setError(status.message);
    };
    const unsubscribeWorkspace = window.platypus.workspace.onStatus(acceptWorkspaceStatus);
    void Promise.all([
      refreshProfiles(),
      window.platypus.browser.statuses().then(items => setStatuses(current => ({ ...Object.fromEntries(items.map(item => [item.profileId, item])), ...current }))),
      window.platypus.workspace.statuses().then((items) => items.forEach(status => acceptWorkspaceStatus(status, false))),
      window.platypus.profiles.hasPendingCleanup().then((pending) => {
        if (pending) {
          setNotice("Workspace cleanup is queued. Fully quit Platypus Browser and reopen it to retry removing its vault entry, VM overlays, and browser data.");
        }
      }),
    ]).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not load saved profiles.");
    });
    const unsubscribeBrowser = window.platypus.browser.onStatus((status) => {
      record("LOCAL", status.message ?? `Local browser ${status.state}.`, status.profileId);
      setStatuses((current) => ({ ...current, [status.profileId]: status }));
      if (status.state === "error" && status.message) setError(status.message);
    });
    return () => { unsubscribeWorkspace(); unsubscribeBrowser(); };
  }, []);

  function beginCreate() {
    setRoutingOpen(false); setEditorOpen(true);
    setEditingId(null);
    setForm(blankProfile);
    setError("");
    setNotice("");
  }

  function beginEdit(profile: BrowserProfile) {
    setSelectedId(profile.id); setRoutingOpen(false); setEditorOpen(true);
    setEditingId(profile.id);
    setForm({
      tenantId: profile.tenantId ?? "default",
      name: profile.name,
      startUrl: profile.startUrl,
      runtime: profile.runtime ?? null,
      proxyBypassRules: profile.session?.proxyBypassRules ?? [],
      proxy: profile.proxy
        ? { ...profile.proxy, username: "", password: "", clearCredentials: false }
        : null,
    });
    setError("");
    setNotice("");
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await window.platypus.profiles.save(form, editingId ?? undefined);
      record("PROFILE", editingId ? "Profile configuration saved." : "Profile created.", saved.id);
      await refreshProfiles();
      setSelectedId(saved.id); setEditorOpen(false);
      setEditingId(null);
      setForm(blankProfile);
      setNotice(editingId ? "Profile changes saved." : "Profile created.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not save the profile.");
    } finally { setSaving(false); }
  }

  async function removeProfile(profile: BrowserProfile) {
    if (!window.confirm(`Purge "${profile.name}", its hardware vault entry, VM disks, and browser data? This cannot be undone.`)) {
      return;
    }
    setError("");
    setBusyId(profile.id);
    try {
      const result = await window.platypus.profiles.remove(profile.id);
      record("PROFILE", "Profile purge requested.", profile.id);
      setProfiles((current) => current.filter((item) => item.id !== profile.id));
      setNotice(
        result.cleanupPending
          ? "Profile removed. Workspace cleanup is queued for the next full app restart. Physical erasure depends on the OS and storage hardware."
          : "Profile, hardware vault entry, VM disks, and browser data removed.",
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete the profile.");
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(profileId: string, action: () => Promise<unknown>, success: string) {
    setBusyId(profileId);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) { setNotice(success); record("ACTION", success, profileId); }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The requested action failed.");
    } finally {
      setBusyId(null);
    }
  }

  function updateProxy(
    field: "protocol" | "host" | "port" | "username" | "password",
    value: string,
  ) {
    const current = form.proxy ?? {
      protocol: "http" as ProxyProtocol,
      host: "",
      port: 8080,
      username: "",
      password: "",
    };
    if (field === "protocol") {
      if (value === "http" || value === "https" || value === "socks5") {
        setForm({
          ...form,
          proxy: {
            ...current,
            protocol: value,
            clearCredentials: current.clearCredentials,
          },
        });
      }
      return;
    }
    setForm({
      ...form,
      proxy: field === "port"
        ? { ...current, port: Number(value) }
        : { ...current, [field]: value, clearCredentials: false },
    });
  }

  return <>
    <Cockpit profiles={profiles} statuses={statuses} workspaces={workspaceStatuses} selectedId={selectedId} onSelect={setSelectedId}
      busyId={busyId} importing={importing} onNew={beginCreate} onEdit={beginEdit} onRemove={removeProfile}
      onTelemetry={profile => { setEditorOpen(false); setRoutingOpen(false); setTelemetryProfile(profile); }}
      onRouting={() => { setEditorOpen(false); setTelemetryProfile(null); setRoutingOpen(true); }} onExport={exportMetadata}
      onProxyFile={importProxies} onMetadataFile={file => runAction("metadata-import", async () => {
        if (file.size > 65536) throw new Error("Metadata exceeds 64 KiB.");
        const imported = await window.platypus.profiles.importMetadata(await file.text()); setSelectedId(imported.id); await refreshProfiles();
      }, "Profile metadata imported. Add cookies and proxy credentials separately.")}
      act={runAction} entries={entries} onClear={() => setEntries([])} />
    {(error || notice) && <div className={`cockpit-notice notice ${error ? "notice-error" : "notice-success"}`} role={error ? "alert" : "status"}>
      <span>{error || notice}</span><button aria-label="Dismiss notification" onClick={() => { setError(""); setNotice(""); }}>×</button>
    </div>}
    {editorOpen && <Modal wide title={editingId ? "Edit profile" : "Create a profile"} onClose={() => { if (!busyId && !saving) setEditorOpen(false); }}>
        <aside className="form-panel">
          <div className="form-heading">
            <div className="form-icon" aria-hidden="true">{editingId ? "✎" : "+"}</div>
            <div>
              <h3>{editingId ? "Edit profile" : "Create a profile"}</h3>
              <p>Settings are saved locally.</p>
            </div>
          </div>
          <form onSubmit={(event) => void saveProfile(event)}>
            <fieldset disabled={saving} className="profile-form-fields">
            <label className="field-label" htmlFor="tenant-id">Tenant ID</label>
            <input id="tenant-id" className="text-input" required maxLength={64} value={form.tenantId ?? "default"} onChange={event => setForm({ ...form, tenantId: event.target.value })} />
            <p className="field-help">Proxy list imports use this tenant. Search profiles by tenant ID or name.</p>
            <label className="field-label" htmlFor="profile-name">Profile name</label>
            <input
              id="profile-name"
              className="text-input"
              required
              maxLength={64}
              placeholder="e.g. Research workspace"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />

            <label className="field-label" htmlFor="start-url">Starting page</label>
            <input
              id="start-url"
              className="text-input"
              required
              type="url"
              placeholder="https://example.com"
              value={form.startUrl}
              onChange={(event) => setForm({ ...form, startUrl: event.target.value })}
            />

            <TelemetryControls value={form.runtime ?? null} onChange={runtime => setForm({ ...form, runtime })} />
            <label className="field-label" htmlFor="proxy-bypass">Additional proxy bypass hosts</label>
            <input id="proxy-bypass" className="text-input" placeholder="telemetry.example.internal, *.lab.internal"
              value={(form.proxyBypassRules ?? []).join(", ")}
              onChange={event => setForm({ ...form, proxyBypassRules: event.target.value.split(",").map(value => value.trim()).filter(Boolean) })} />
            <p className="field-help">Loopback, localhost and *.local always connect locally.</p>
            {editingId && <div>
              <label className="field-label" htmlFor="cookie-import">Import cookie profile (JSON or Netscape)</label>
              <input id="cookie-import" type="file" accept=".json,.txt,.cookies,text/plain,application/json" onChange={event => {
                const file = event.target.files?.[0]; event.target.value = "";
                if (file) void runAction(editingId, async () => {
                  if (file.size > 4 * 1024 * 1024) throw new Error("Cookie file exceeds 4 MiB.");
                  const state = await window.platypus.profiles.importCookies(editingId, await file.text());
                  await refreshProfiles(); setNotice(`Saved ${state.cookieCount} imported cookies. They will load at profile startup.`);
                }, "");
              }} />
              <p className="field-help">Replaces the saved import. Close the profile before importing. Cookie values stay hidden.</p>
            </div>}

            <div className="proxy-heading">
              <div>
                <label className="field-label" htmlFor="proxy-enabled">Use a proxy</label>
                <p className="field-help">Applies to the local browser and VM workspace. VM traffic uses an isolated proxy gateway.</p>
              </div>
              <input
                id="proxy-enabled"
                className="toggle-input"
                type="checkbox"
                checked={form.proxy !== null}
                onChange={(event) => setForm({
                  ...form,
                  proxy: event.target.checked
                    ? { protocol: "http", host: "", port: 8080, username: "", password: "" }
                    : null,
                })}
              />
            </div>

            {form.proxy && (
              <div className="proxy-fields">
                <label className="field-label" htmlFor="proxy-protocol">Protocol</label>
                <select
                  id="proxy-protocol"
                  className="text-input"
                  value={form.proxy.protocol}
                  onChange={(event) => updateProxy("protocol", event.target.value)}
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks5">SOCKS5</option>
                </select>
                <div className="host-port">
                  <div>
                    <label className="field-label" htmlFor="proxy-host">Host</label>
                    <input
                      id="proxy-host"
                      className="text-input"
                      required
                      placeholder="proxy.example.com"
                      value={form.proxy.host}
                      onChange={(event) => updateProxy("host", event.target.value)}
                    />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="proxy-port">Port</label>
                    <input
                      id="proxy-port"
                      className="text-input"
                      required
                      type="number"
                      min="1"
                      max="65535"
                      value={form.proxy.port}
                      onChange={(event) => updateProxy("port", event.target.value)}
                    />
                  </div>
                </div>
                {(
                  <>
                    <label className="field-label" htmlFor="proxy-username">Proxy username</label>
                    <input
                      id="proxy-username"
                      className="text-input"
                      autoComplete="off"
                      placeholder={form.proxy.hasCredentials ? "Saved securely; leave blank to keep" : "Optional"}
                      value={form.proxy.username ?? ""}
                      onChange={(event) => updateProxy("username", event.target.value)}
                    />
                    <label className="field-label" htmlFor="proxy-password">Proxy password</label>
                    <input
                      id="proxy-password"
                      className="text-input"
                      type="password"
                      autoComplete="new-password"
                      placeholder={form.proxy.hasCredentials ? "Saved securely; leave blank to keep" : "Optional"}
                      value={form.proxy.password ?? ""}
                      onChange={(event) => updateProxy("password", event.target.value)}
                    />
                    {form.proxy.hasCredentials && (
                      <label className="credential-clear">
                        <input
                          type="checkbox"
                          checked={form.proxy.clearCredentials ?? false}
                          onChange={(event) => setForm({
                            ...form,
                            proxy: {
                              ...form.proxy!,
                              clearCredentials: event.target.checked,
                              username: "",
                              password: "",
                            },
                          })}
                        />
                        Remove saved credentials
                      </label>
                    )}
                    <p className="proxy-note">Credentials use OS secure storage. Changing the proxy endpoint clears saved credentials.</p>
                    {form.proxy.protocol === "http" && <p className="proxy-note">HTTP proxy authentication travels unencrypted to the proxy. HTTPS websites retain their TLS encryption.</p>}
                  </>
                )}
              </div>
            )}

            <div className="form-actions">
              <button className="primary-button full-button" type="submit">
                {saving ? "Saving…" : editingId ? "Save changes" : "Create profile"}
              </button>
              {editingId && <button className="secondary-button full-button" type="button" onClick={() => setEditorOpen(false)}>Cancel editing</button>}
            </div>
            </fieldset>
          </form>
          <div className="privacy-note">
            <span aria-hidden="true">◈</span>
            <p>Profile settings and proxy credentials are encrypted with the operating system's secure storage. Browser session data follows Chromium's platform protections.</p>
          </div>
        </aside>
    </Modal>}
    {routingOpen && <RoutingPanel profiles={profiles} initialId={selectedId ?? profiles[0]?.id}
      running={id => Boolean(statuses[id]?.windowOpen || workspaceStatuses[id]?.processRunning || workspaceStatuses[id]?.state === "booting")}
      onUpdated={refreshProfiles} onClose={() => setRoutingOpen(false)} />}
    {telemetryProfile && <TelemetryPanel key={telemetryProfile.id} profile={telemetryProfile} onClose={() => setTelemetryProfile(null)} onSaved={profile => {
      setProfiles(current => current.map(item => item.id === profile.id ? { ...item, runtime: profile.runtime } : item));
      if (editingId === profile.id) setForm(current => ({ ...current, runtime: profile.runtime }));
      record("TELEMETRY", "Runtime configuration saved encrypted.", profile.id);
    }} />}
  </>;
}

export default App;
