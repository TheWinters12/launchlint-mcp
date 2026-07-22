import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createWorkspaceArchive } from "./archive.js";
import { LaunchLintCloud } from "./cloud.js";
import { collectWorkspace, type WorkspaceSnapshot } from "./workspace.js";

const localeSchema = z.enum(["de", "en", "es", "fr", "it"]).default("en");
const platformsSchema = z.array(z.enum(["apple", "google"])).min(1).max(2).default(["apple", "google"]);
const localReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const cloudReadAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const cloudActionAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export function createLocalMcpServer(cloud = new LaunchLintCloud()) {
  const server = new McpServer({ name: "LaunchLint Workspace Connector", version: "0.1.3" });
  let prepared: WorkspaceSnapshot | null = null;

  server.registerTool("prepare_workspace_scan", {
    title: "Prepare local app check",
    description: "Inspect the approved workspace without uploading it. Returns counts, exclusions, size, and a one-time confirmation token.",
    inputSchema: z.object({ platforms: platformsSchema }),
    annotations: localReadAnnotations
  }, async ({ platforms }) => {
    try {
      const root = await resolveApprovedRoot(server);
      prepared = await collectWorkspace(root);
      return result({ workspace: root.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace", fileCount: prepared.files.length, excludedCount: prepared.excludedCount, totalSizeBytes: prepared.totalSizeBytes, contentFingerprint: prepared.contentFingerprint, platforms, confirmationToken: prepared.confirmationToken, safety: "No project code was executed. Secret files, dependencies, build outputs, caches, and symlinks were excluded." });
    } catch (error) { return failure(error); }
  });

  server.registerTool("start_workspace_scan", {
    title: "Start local app check",
    description: "Upload the previously prepared workspace snapshot directly to LaunchLint. Requires explicit confirmation and consumes one app check.",
    inputSchema: z.object({ confirmationToken: z.string().uuid(), confirm: z.literal(true), appName: z.string().min(1).max(160).optional(), projectKey: z.string().min(1).max(300).optional(), platforms: platformsSchema }),
    annotations: cloudActionAnnotations
  }, async ({ confirmationToken, confirm, appName, projectKey, platforms }) => {
    try {
      if (!confirm || !prepared || prepared.confirmationToken !== confirmationToken) throw new Error("Run prepare_workspace_scan and confirm its current token before starting the app check.");
      const current = await collectWorkspace(prepared.root);
      if (current.contentFingerprint !== prepared.contentFingerprint) { prepared = null; throw new Error("The workspace changed after preparation. Prepare it again before starting the check."); }
      const archive = await createWorkspaceArchive(current);
      const idempotencyKey = createHash("sha256").update(`${current.contentFingerprint}:${confirmationToken}`).digest("hex");
      const upload = await cloud.createWorkspaceSession({
        workspaceFingerprint: current.workspaceFingerprint,
        ...(projectKey ? { projectKey } : {}),
        idempotencyKey,
        sha256: archive.sha256,
        fileCount: current.files.length,
        sizeBytes: archive.buffer.length
      });
      const scan = await cloud.uploadWorkspace({ uploadUrl: upload.uploadUrl, archive: archive.buffer, appName: appName ?? current.root.split(/[\\/]/).filter(Boolean).at(-1) ?? "Workspace App", storeMetadata: { platforms } });
      prepared = null;
      return result({ ...scan, nextStep: "Use get_scan_status with scanJobId. Once completed, use list_findings and get_fix_task." });
    } catch (error) { return failure(error); }
  });

  proxy(server, cloud, "list_projects", z.object({}));
  proxy(server, cloud, "get_project_status", z.object({ projectKey: z.string().min(1).max(300) }));
  proxy(server, cloud, "list_findings", z.object({ scanId: z.string().uuid(), domain: z.enum(["store", "security", "listing"]).optional(), severity: z.enum(["critical", "high", "medium", "low", "info"]).optional() }));
  proxy(server, cloud, "get_fix_task", z.object({ scanId: z.string().uuid(), findingId: z.string().min(1).max(200), locale: localeSchema }));
  proxy(server, cloud, "start_rescan", z.object({ appId: z.string().uuid(), confirm: z.literal(true) }));
  proxy(server, cloud, "get_scan_status", z.object({ scanId: z.string().uuid() }));
  proxy(server, cloud, "get_submission_checklist", z.object({ scanId: z.string().uuid(), limit: z.number().int().min(1).max(25).default(10) }));
  proxy(server, cloud, "get_usage", z.object({}));
  proxy(server, cloud, "update_finding_status", z.object({ scanId: z.string().uuid(), findingId: z.string().min(1).max(200), status: z.enum(["open", "in_progress", "resolved", "ignored"]), note: z.string().max(500).optional(), confirm: z.literal(true) }));
  return server;
}

function proxy<T extends z.ZodRawShape>(server: McpServer, cloud: LaunchLintCloud, name: string, schema: z.ZodObject<T>) {
  type ProxyResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
  const register = server.registerTool.bind(server) as unknown as (
    toolName: string,
    config: { description: string; inputSchema: z.ZodType; annotations: typeof cloudReadAnnotations | typeof cloudActionAnnotations },
    callback: (args: Record<string, unknown>) => Promise<ProxyResult>
  ) => unknown;
  const annotations = name === "start_rescan" || name === "update_finding_status" ? cloudActionAnnotations : cloudReadAnnotations;
  register(name, { description: `Use the authenticated LaunchLint cloud tool ${name}.`, inputSchema: schema, annotations }, async (args) => {
    try {
      const response = await cloud.callTool(name, args as Record<string, unknown>);
      const value = response.structuredContent && typeof response.structuredContent === "object"
        ? response.structuredContent as Record<string, unknown>
        : { content: response.content };
      const proxied = { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
      return response.isError ? { ...proxied, isError: true } : proxied;
    } catch (error) { return failure(error); }
  });
}

async function resolveApprovedRoot(server: McpServer) {
  const configured = process.env.LAUNCHLINT_WORKSPACE?.trim();
  if (configured) return configured;
  const response = await server.server.listRoots();
  const roots = response.roots.filter((root) => root.uri.startsWith("file:"));
  if (roots.length !== 1) throw new Error("Configure LAUNCHLINT_WORKSPACE or expose exactly one MCP workspace root.");
  return fileURLToPath(roots[0]!.uri);
}

function result(value: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function failure(error: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : "The LaunchLint connector could not complete this request." }] };
}
