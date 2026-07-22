import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import open from "open";

const callbackUrl = "http://127.0.0.1:47831/callback";
const scopes = "openid profile email offline_access projects:read scans:read scans:create exports:read findings:write";

type StoredAuth = {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
};

export class LaunchLintOAuth {
  private readonly provider: PersistentProvider;

  constructor(private readonly serverUrl: URL) {
    this.provider = new PersistentProvider(async (url) => {
      const callback = waitForCallback(this.provider.expectedState);
      await open(url.toString(), { wait: false });
      const code = await callback;
      await auth(this.provider, { serverUrl: this.serverUrl, authorizationCode: code, scope: scopes });
    });
  }

  get authProvider() {
    return this.provider;
  }

  async accessToken() {
    const configured = process.env.LAUNCHLINT_ACCESS_TOKEN?.trim();
    if (configured) return configured;
    const result = await auth(this.provider, { serverUrl: this.serverUrl, scope: scopes });
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

  constructor(private readonly onRedirect: (url: URL) => Promise<void>) {}

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
  async saveTokens(tokens: OAuthTokens) { await this.save({ ...(await this.load()), tokens }); }
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
