import type { ProxyCredentials } from "../shared/types";

/** Main-process-only vault boundary. Credentials never enter public profile DTOs. */
export interface ProxyCredentialStore {
  getProxyCredentials(profileId: string): Promise<ProxyCredentials | null>;
}
