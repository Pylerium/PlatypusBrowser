import type { BrowserProfile } from "../shared/types";
import { normalizeBypassRules } from "../shared/sessionConfig";
import type { ProxyCredentialStore } from "./credentialStore";
import { ProxyGateway } from "./qemu/proxyGateway";

/** Application-wide routing coordinator. Every profile retains its own gateway. */
export class ProxyDispatcher {
  private readonly local = new Map<string, ProxyGateway>();
  constructor(private readonly vault: ProxyCredentialStore) {}
  async createGateway(profile: BrowserProfile, rules = normalizeBypassRules()): Promise<ProxyGateway | undefined> {
    if (!profile.proxy) return undefined;
    const credentials = await this.vault.getProxyCredentials(profile.id) ?? undefined;
    if (profile.proxy.hasCredentials && !credentials) throw new Error("Saved proxy credentials are unavailable.");
    return ProxyGateway.create(profile.proxy, credentials, rules);
  }
  async localRules(profile: BrowserProfile, rules: string[]): Promise<string> {
    if (!profile.proxy) { this.release(profile.id); return "direct://"; }
    let gateway = this.local.get(profile.id);
    if (!gateway) { gateway = (await this.createGateway(profile, rules))!; this.local.set(profile.id, gateway); }
    return `socks5://127.0.0.1:${gateway.port}`;
  }
  expectedLocalRoute(profileId: string): string {
    const gateway = this.local.get(profileId);
    if (!gateway) throw new Error("The profile proxy gateway is unavailable.");
    return `socks5 127.0.0.1:${gateway.port}`;
  }
  release(id: string): void { this.local.get(id)?.close(); this.local.delete(id); }
  close(): void { for (const id of this.local.keys()) this.release(id); }
}
