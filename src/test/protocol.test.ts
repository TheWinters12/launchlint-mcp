import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalMcpServer } from "../server.js";
import { LaunchLintCloud } from "../cloud.js";

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

  const prepared = await client.callTool({ name: "prepare_workspace_scan", arguments: { platforms: ["apple", "google"] } });
  assert.equal(prepared.isError, undefined);
  assert.equal(prepared.structuredContent?.fileCount, 2);
  assert.equal(typeof prepared.structuredContent?.confirmationToken, "string");
  assert.equal("root" in (prepared.structuredContent ?? {}), false);

  assert.throws(() => new LaunchLintCloud("https://example.com"), /HTTPS endpoint on launchlint\.app/);
  assert.throws(() => new LaunchLintCloud("http://launchlint.app"), /HTTPS endpoint on launchlint\.app/);

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
