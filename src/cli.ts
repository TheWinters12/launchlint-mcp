#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLocalMcpServer } from "./server.js";

const server = createLocalMcpServer();
await server.connect(new StdioServerTransport());

process.on("SIGINT", async () => {
  await server.close();
  process.exit(0);
});
