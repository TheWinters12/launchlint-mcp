import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import ignore from "ignore";

const allowedExtensions = new Set([".json", ".js", ".jsx", ".ts", ".tsx", ".plist", ".xml", ".yaml", ".yml", ".example", ".lock"]);
const allowedNames = new Set(["package.json", "app.json", "app.config.js", "app.config.ts", "capacitor.config.json", "capacitor.config.js", "capacitor.config.ts", "eas.json", "androidmanifest.xml", "info.plist", "privacyinfo.xcprivacy", "podfile", "pubspec.yaml", "pubspec.lock", "build.gradle", "settings.gradle", "firebase.json", ".env.example"]);
const builtInExclusions = [".git/", "node_modules/", "dist/", "build/", ".next/", ".expo/", ".turbo/", "coverage/", "ios/Pods/", "android/.gradle/"];
const secretName = /(^|\/)(\.env($|\.(?!example$))|\.npmrc$|\.pypirc$|\.netrc$|credentials?(\.|$)|service[-_]?account|.*\.(pem|key|p12|pfx|jks|keystore)$)/i;

export type WorkspaceFile = { absolutePath: string; relativePath: string; sizeBytes: number; sha256: string };
export type WorkspaceSnapshot = { root: string; files: WorkspaceFile[]; excludedCount: number; totalSizeBytes: number; workspaceFingerprint: string; contentFingerprint: string; confirmationToken: string };

export async function collectWorkspace(rootInput: string): Promise<WorkspaceSnapshot> {
  const root = await realpath(path.resolve(rootInput));
  const matcher = ignore().add(builtInExclusions);
  for (const name of [".gitignore", ".launchlintignore"]) {
    try { matcher.add(await readFile(path.join(root, name), "utf8")); } catch {}
  }
  const files: WorkspaceFile[] = [];
  let excludedCount = 0;
  let totalSizeBytes = 0;

  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");
      if (!relativePath || matcher.ignores(relativePath + (entry.isDirectory() ? "/" : ""))) { excludedCount += 1; continue; }
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) { excludedCount += 1; continue; }
      if (stat.isDirectory()) { await walk(absolutePath); continue; }
      const normalizedName = entry.name.toLowerCase();
      if (!stat.isFile() || secretName.test(relativePath) || (!allowedNames.has(normalizedName) && !allowedExtensions.has(path.extname(normalizedName)))) { excludedCount += 1; continue; }
      if (stat.size > 2 * 1024 * 1024) throw new Error(`File exceeds the 2 MB limit: ${relativePath}`);
      totalSizeBytes += stat.size;
      if (files.length >= 2000 || totalSizeBytes > 50 * 1024 * 1024) throw new Error("Workspace exceeds LaunchLint's safe upload limits.");
      const content = await readFile(absolutePath);
      files.push({ absolutePath, relativePath, sizeBytes: stat.size, sha256: createHash("sha256").update(content).digest("hex") });
    }
  }

  await walk(root);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  if (!files.length) throw new Error("No supported mobile app files were found in the approved workspace.");
  const workspaceFingerprint = createHash("sha256").update(`launchlint-workspace\0${root}`).digest("hex");
  const contentFingerprint = createHash("sha256").update(files.map((file) => `${file.relativePath}\0${file.sha256}\0${file.sizeBytes}`).join("\n")).digest("hex");
  return { root, files, excludedCount, totalSizeBytes, workspaceFingerprint, contentFingerprint, confirmationToken: randomUUID() };
}
