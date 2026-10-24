import type { Session } from "electron";
import type { RuntimeSimulation } from "../shared/types";

const policies = new WeakMap<Session, RuntimeSimulation | null>();
const installed = new WeakSet<Session>();

/** One header hook per session; reads current settings for frames and workers. */
export function updateNetworkTelemetry(session: Session, runtime: RuntimeSimulation | null): void {
  policies.set(session, runtime);
  if (installed.has(session)) return;
  installed.add(session);
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const current = policies.get(session);
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) {
      if ((current?.userAgent && /^user-agent$/i.test(name)) ||
        (current?.languages && /^accept-language$/i.test(name)) ||
        (current?.hideClientHints && /^sec-ch-ua(?:-|$)/i.test(name))) delete headers[name];
    }
    if (current?.userAgent) headers["User-Agent"] = current.userAgent;
    if (current?.languages) headers["Accept-Language"] = current.languages;
    callback({ requestHeaders: headers });
  });
}
