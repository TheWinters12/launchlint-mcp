import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceArchive } from "../archive.js";
import { collectWorkspace } from "../workspace.js";

const root = await mkdtemp(path.join(os.tmpdir(), "launchlint-mcp-"));
try {
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { expo: "1.0.0" } }));
  await writeFile(path.join(root, "src", "app.ts"), "export const app = true;\n");
  await writeFile(path.join(root, ".env"), "SECRET=do-not-upload\n");
  await writeFile(path.join(root, ".env.example"), "SECRET=example\n");
  await writeFile(path.join(root, ".launchlintignore"), "src/ignored.ts\n");
  await writeFile(path.join(root, "src", "ignored.ts"), "ignored\n");
  await writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n");
  await symlink(path.join(root, "src"), path.join(root, "linked-src"), "junction");
  const snapshot = await collectWorkspace(root);
  assert.deepEqual(snapshot.files.map((file) => file.relativePath), [".env.example", "package.json", "src/app.ts"]);
  assert.equal(snapshot.workspaceFingerprint.length, 64);
  assert.equal(snapshot.contentFingerprint.length, 64);
  assert.ok(snapshot.excludedCount >= 4);
  const archive = await createWorkspaceArchive(snapshot);
  assert.ok(archive.buffer.length > 0);
  assert.equal(archive.sha256.length, 64);

  const secondArchive = await createWorkspaceArchive(snapshot);
  assert.equal(secondArchive.sha256, archive.sha256);

  await writeFile(path.join(root, "src", "app.ts"), "export const app = false;\n");
  await assert.rejects(() => createWorkspaceArchive(snapshot), /changed after preparation/);
  const changed = await collectWorkspace(root);
  assert.equal(changed.workspaceFingerprint, snapshot.workspaceFingerprint);
  assert.notEqual(changed.contentFingerprint, snapshot.contentFingerprint);

  await writeFile(path.join(root, "src", "too-large.ts"), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(() => collectWorkspace(root), /2 MB limit/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Workspace connector tests passed.");
