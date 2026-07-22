#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LaunchLintCloud } from "./cloud.js";
import { createLocalMcpServer } from "./server.js";

const cloud = new LaunchLintCloud();
const server = createLocalMcpServer(cloud);
await server.connect(new StdioServerTransport());

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([server.close(), cloud.close()]);
  process.exit(0);
}

process.stdin.once("end", () => void shutdown());
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
