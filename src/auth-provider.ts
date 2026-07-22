import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import open from "open";

const callbackUrl = "http://127.0.0.1:47831/callback";
const scopes = "openid profile email offline_access projects:read scans:read scans:create exports:read findings:write";
const scopeList = scopes.split(" ");

type StoredAuth = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
};

export class LaunchLintOAuth {
  private readonly provider: PersistentProvider;
  private readonly resourceMetadataUrl: URL;

  constructor(private readonly serverUrl: URL) {
    this.resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", serverUrl);
    this.provider = new PersistentProvider(createPinnedDiscoveryState(serverUrl), async (url) => {
      const callback = waitForCallback(this.provider.expectedState);
      const authorizationUrl = normalizeAuthorizationUrl(url, this.serverUrl);
      await open(authorizationUrl.toString(), { wait: false });
      const code = await callback;
      await auth(this.provider, {
        serverUrl: this.serverUrl,
        authorizationCode: code,
        scope: scopes,
        resourceMetadataUrl: this.resourceMetadataUrl
      });
    });
  }

  get authProvider() {
    return this.provider;
  }

  async accessToken() {
    const configured = process.env.LAUNCHLINT_ACCESS_TOKEN?.trim();
    if (configured) return configured;
    const existing = await this.provider.tokens();
    if (existing?.access_token) return existing.access_token;
    const result = await auth(this.provider, {
      serverUrl: this.serverUrl,
      scope: scopes,
      resourceMetadataUrl: this.resourceMetadataUrl
    });
    if (result === "REDIRECT") {
      await this.provider.pendingAuthorization;
    }
    const tokens = await this.provider.tokens();
    if (!tokens?.access_token) throw new Error("LaunchLint authorization did not return an access token.");
    return tokens.access_token;
  }
}

class PersistentProvider implements OAuthClientProvider {
  readonly expectedState = randomBytes(24).toString("base64url");
  pendingAuthorization: Promise<void> = Promise.resolve();
  private data: StoredAuth | null = null;
  private readonly filePath = authFilePath();

  constructor(
    private readonly pinnedDiscoveryState: OAuthDiscoveryState,
    private readonly onRedirect: (url: URL) => Promise<void>
  ) {}

  get redirectUrl() { return callbackUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "LaunchLint Workspace Connector",
      client_uri: "https://launchlint.app",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: scopes
    };
  }
  state() { return this.expectedState; }
  async clientInformation() { return (await this.load()).clientInformation; }
  async saveClientInformation(clientInformation: OAuthClientInformationMixed) { await this.save({ ...(await this.load()), clientInformation }); }
  async tokens() { return (await this.load()).tokens; }
  async saveTokens(tokens: OAuthTokens) {
    const current = await this.load();
    await this.save({ ...current, tokens: mergeOAuthTokens(current.tokens, tokens) });
  }
  async discoveryState() { return this.pinnedDiscoveryState; }
  async saveDiscoveryState(_discoveryState: OAuthDiscoveryState) {
    await this.save({ ...(await this.load()), discoveryState: this.pinnedDiscoveryState });
  }
  redirectToAuthorization(url: URL) { this.pendingAuthorization = this.onRedirect(url); }
  async saveCodeVerifier(codeVerifier: string) { await this.save({ ...(await this.load()), codeVerifier }); }
  async codeVerifier() {
    const verifier = (await this.load()).codeVerifier;
    if (!verifier) throw new Error("No PKCE verifier is available.");
    return verifier;
  }
  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    const current = await this.load();
    if (scope === "all") return this.save({});
    if (scope === "client") delete current.clientInformation;
    if (scope === "tokens") delete current.tokens;
    if (scope === "verifier") delete current.codeVerifier;
    if (scope === "discovery") delete current.discoveryState;
    await this.save(current);
  }

  private async load() {
    if (this.data) return this.data;
    try { this.data = JSON.parse(await readFile(this.filePath, "utf8")) as StoredAuth; } catch { this.data = {}; }
    return this.data;
  }

  private async save(data: StoredAuth) {
    this.data = data;
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

export function normalizeAuthorizationUrl(url: URL, serverUrl: URL) {
  const normalized = new URL(url);
  if (normalized.origin !== serverUrl.origin) {
    throw new Error("LaunchLint authorization was redirected to an untrusted origin.");
  }
  if (normalized.pathname === "/authorize") {
    normalized.pathname = "/api/auth/mcp/authorize";
  }
  return normalized;
}

export function createPinnedDiscoveryState(serverUrl: URL): OAuthDiscoveryState {
  const origin = serverUrl.origin;
  return {
    authorizationServerUrl: origin,
    resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", origin).toString(),
    authorizationServerMetadata: {
      issuer: origin,
      authorization_endpoint: new URL("/api/auth/mcp/authorize", origin).toString(),
      token_endpoint: new URL("/api/auth/mcp/token", origin).toString(),
      registration_endpoint: new URL("/api/auth/mcp/register", origin).toString(),
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      scopes_supported: scopeList
    },
    resourceMetadata: {
      resource: new URL("/mcp", origin).toString(),
      authorization_servers: [origin],
      scopes_supported: scopeList
    }
  };
}

export function mergeOAuthTokens(current: OAuthTokens | undefined, next: OAuthTokens): OAuthTokens {
  if (next.refresh_token || !current?.refresh_token) return next;
  return { ...next, refresh_token: current.refresh_token };
}

function authFilePath() {
  const base = process.env.XDG_CONFIG_HOME || (process.platform === "win32" ? process.env.APPDATA : path.join(os.homedir(), ".config")) || path.join(os.homedir(), ".config");
  return path.join(base, "launchlint", "mcp-auth.json");
}

function waitForCallback(expectedState: string) {
  return new Promise<string>((resolve, reject) => {
    let server: Server;
    const timeout = setTimeout(() => { server?.close(); reject(new Error("LaunchLint authorization timed out.")); }, 5 * 60 * 1000);
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", callbackUrl);
      if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");
      if (error || !code || state !== expectedState) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end("<h1>Verbindung fehlgeschlagen</h1><p>Du kannst dieses Fenster schließen und den Vorgang erneut starten.</p>");
        clearTimeout(timeout); server.close(); reject(new Error(error ?? "OAuth callback validation failed.")); return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<h1>LaunchLint ist verbunden</h1><p>Du kannst dieses Fenster schließen und zum Coding-Assistenten zurückkehren.</p>");
      clearTimeout(timeout); server.close(); resolve(code);
    });
    server.on("error", (error) => { clearTimeout(timeout); reject(error); });
    server.listen(47831, "127.0.0.1");
  });
}
