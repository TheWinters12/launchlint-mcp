import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts"], {
  cwd: process.cwd(),
  stdio: ["pipe", "pipe", "pipe"]
});

const initialized = new Promise<void>((resolve, reject) => {
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    if (!output.includes('"id":1')) return;
    child.stdin.end();
    resolve();
  });
  child.once("error", reject);
});

child.stdin.write(`${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lifecycle-test", version: "1.0.0" }
  }
})}\n`);

await Promise.race([
  initialized,
  new Promise((_, reject) => setTimeout(() => reject(new Error("CLI did not initialize in time.")), 5_000))
]);

const [exitCode] = await Promise.race([
  once(child, "exit"),
  new Promise<never>((_, reject) => setTimeout(() => {
    child.kill();
    reject(new Error("CLI did not stop after stdin closed."));
  }, 5_000))
]);

assert.equal(exitCode, 0);
console.log("MCP CLI lifecycle test passed.");
