import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectorErrorMessage, createLocalMcpServer } from "../server.js";
import { LaunchLintCloud } from "../cloud.js";
import { createPinnedDiscoveryState, mergeOAuthTokens, normalizeAuthorizationUrl } from "../auth-provider.js";
import { enableWindowsSystemCertificates } from "../system-ca.js";

const workspace = await mkdtemp(path.join(os.tmpdir(), "launchlint-mcp-protocol-"));
const previousWorkspace = process.env.LAUNCHLINT_WORKSPACE;

try {
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({ dependencies: { expo: "54.0.0" } }));
  await writeFile(path.join(workspace, "app.json"), JSON.stringify({ expo: { name: "Protocol Test", slug: "protocol-test" } }));
  process.env.LAUNCHLINT_WORKSPACE = workspace;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createLocalMcpServer();
  const client = new Client({ name: "launchlint-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
    "get_fix_task",
    "get_project_status",
    "get_scan_status",
    "get_submission_checklist",
    "get_usage",
    "list_findings",
    "list_projects",
    "prepare_workspace_scan",
    "start_rescan",
    "start_workspace_scan",
    "update_finding_status"
  ]);
  const toolsByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(toolsByName.get("prepare_workspace_scan")?.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  });
  assert.equal(toolsByName.get("list_projects")?.annotations?.readOnlyHint, true);
  assert.equal(toolsByName.get("start_workspace_scan")?.annotations?.readOnlyHint, false);
  assert.equal(toolsByName.get("update_finding_status")?.annotations?.readOnlyHint, false);

  const prepared = await client.callTool({ name: "prepare_workspace_scan", arguments: { platforms: ["apple", "google"] } });
  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent?.fileCount, 2);
  assert.equal(typeof prepared.structuredContent?.confirmationToken, "string");
  assert.equal("root" in (prepared.structuredContent ?? {}), false);

  assert.throws(() => new LaunchLintCloud("https://example.com"), /HTTPS endpoint on launchlint\.app/);
  assert.throws(() => new LaunchLintCloud("http://launchlint.app"), /HTTPS endpoint on launchlint\.app/);

  const fallbackAuthorizationUrl = new URL("https://launchlint.app/authorize?response_type=code&code_challenge=test&state=stable");
  const normalizedAuthorizationUrl = normalizeAuthorizationUrl(fallbackAuthorizationUrl, new URL("https://launchlint.app/mcp"));
  assert.equal(normalizedAuthorizationUrl.pathname, "/api/auth/mcp/authorize");
  assert.equal(normalizedAuthorizationUrl.search, fallbackAuthorizationUrl.search);
  assert.throws(
    () => normalizeAuthorizationUrl(new URL("https://example.com/authorize"), new URL("https://launchlint.app/mcp")),
    /untrusted origin/
  );
  const discoveryState = createPinnedDiscoveryState(new URL("https://launchlint.app/mcp"));
  assert.equal(discoveryState.authorizationServerMetadata?.authorization_endpoint, "https://launchlint.app/api/auth/mcp/authorize");
  assert.equal(discoveryState.authorizationServerMetadata?.token_endpoint, "https://launchlint.app/api/auth/mcp/token");
  assert.equal(discoveryState.authorizationServerMetadata?.registration_endpoint, "https://launchlint.app/api/auth/mcp/register");
  assert.equal(discoveryState.resourceMetadata?.resource, "https://launchlint.app/mcp");
  const refreshedTokens = mergeOAuthTokens(
    { access_token: "old-access", token_type: "bearer", refresh_token: "stable-refresh" },
    { access_token: "new-access", token_type: "bearer" }
  );
  assert.equal(refreshedTokens.access_token, "new-access");
  assert.equal(refreshedTokens.refresh_token, "stable-refresh");
  assert.equal(
    connectorErrorMessage(new Error("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND launchlint.app") })),
    "fetch failed (getaddrinfo ENOTFOUND launchlint.app)"
  );
  assert.equal(typeof enableWindowsSystemCertificates(), "boolean");

  const foreignUploadCloud = new LaunchLintCloud();
  const foreignUpload = foreignUploadCloud.uploadWorkspace({
    uploadUrl: "https://example.com/collect",
    archive: Buffer.from("not-uploaded"),
    appName: "Blocked upload"
  });
  await assert.rejects(foreignUpload, /outside the configured service origin/);

  await Promise.all([client.close(), server.close()]);
} finally {
  if (previousWorkspace === undefined) delete process.env.LAUNCHLINT_WORKSPACE;
  else process.env.LAUNCHLINT_WORKSPACE = previousWorkspace;
  await rm(workspace, { recursive: true, force: true });
}

console.log("MCP protocol tests passed.");
