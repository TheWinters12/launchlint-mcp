import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { ZipFile } from "yazl";
import type { WorkspaceSnapshot } from "./workspace.js";

export async function createWorkspaceArchive(snapshot: WorkspaceSnapshot) {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const stableZipDate = new Date("1980-01-01T00:00:00.000Z");
  for (const file of snapshot.files) {
    const content = await readFile(file.absolutePath);
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (content.byteLength !== file.sizeBytes || sha256 !== file.sha256) {
      throw new Error(`Workspace file changed after preparation: ${file.relativePath}`);
    }
    zip.addBuffer(content, file.relativePath, { mtime: stableZipDate, mode: 0o100644 });
  }
  zip.end();
  await once(zip.outputStream, "end");
  const buffer = Buffer.concat(chunks);
  return { buffer, sha256: createHash("sha256").update(buffer).digest("hex") };
}
