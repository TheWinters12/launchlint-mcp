import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LaunchLintOAuth } from "./auth-provider.js";

export class LaunchLintCloud {
  readonly baseUrl: URL;
  private readonly oauth: LaunchLintOAuth;
  private clientPromise: Promise<Client> | null = null;

  constructor(baseUrl = "https://launchlint.app") {
    const parsed = new URL(baseUrl);
    const trustedHost = parsed.hostname === "launchlint.app" || parsed.hostname.endsWith(".launchlint.app");
    if (parsed.protocol !== "https:" || !trustedHost || parsed.username || parsed.password) {
      throw new Error("LaunchLint requires an authenticated HTTPS endpoint on launchlint.app.");
    }
    this.baseUrl = parsed;
    this.oauth = new LaunchLintOAuth(new URL("/mcp", this.baseUrl));
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const client = await this.getClient();
    return client.callTool({ name, arguments: args });
  }

  async createWorkspaceSession(input: { workspaceFingerprint: string; projectKey?: string; idempotencyKey: string; sha256: string; fileCount: number; sizeBytes: number }) {
    return this.request<{ uploadSessionId: string; uploadUrl: string; expiresAt: string; projectKey: string }>("/api/mcp/workspace-sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  }

  async uploadWorkspace(input: { uploadUrl: string; archive: Buffer; appName: string; storeMetadata?: Record<string, unknown> }) {
    const formData = new FormData();
    const archiveBytes = new Uint8Array(input.archive.byteLength);
    archiveBytes.set(input.archive);
    formData.set("archive", new Blob([archiveBytes], { type: "application/zip" }), "launchlint-workspace.zip");
    formData.set("appName", input.appName);
    if (input.storeMetadata) formData.set("storeMetadata", JSON.stringify(input.storeMetadata));
    return this.request<{ scanJobId: string; projectKey: string; status: string; created: boolean }>(input.uploadUrl, { method: "POST", body: formData });
  }

  async close() {
    const pending = this.clientPromise;
    this.clientPromise = null;
    if (!pending) return;
    const client = await pending.catch(() => null);
    await client?.close().catch(() => undefined);
  }

  private async request<T>(pathname: string, init: RequestInit) {
    const target = new URL(pathname, this.baseUrl);
    if (target.origin !== this.baseUrl.origin) {
      throw new Error("LaunchLint refused an upload URL outside the configured service origin.");
    }
    const token = await this.oauth.accessToken();
    const response = await fetch(target, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: `Bearer ${token}` } });
    const payload = await response.json().catch(() => null) as T | { error?: string; message?: string } | null;
    if (!response.ok) {
      const details = payload && typeof payload === "object" ? payload as { error?: string; message?: string } : null;
      throw new Error(details?.message ?? details?.error ?? `LaunchLint request failed with HTTP ${response.status}.`);
    }
    return payload as T;
  }

  private getClient() {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        await this.oauth.accessToken();
        const client = new Client({ name: "launchlint-local-connector", version: "0.1.4" }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.baseUrl), { authProvider: this.oauth.authProvider });
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        return client;
      })().catch((error) => { this.clientPromise = null; throw error; });
    }
    return this.clientPromise;
  }
}
