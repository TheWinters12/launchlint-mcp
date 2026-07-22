# @launchlint/mcp

Secure local MCP connector for [LaunchLint](https://launchlint.app). It reads only supported files from the explicitly approved workspace, respects `.gitignore` and `.launchlintignore`, never executes project code, and sends a controlled snapshot directly to LaunchLint over HTTPS.

## Codex

```bash
codex mcp add launchlint -- npx -y @launchlint/mcp@0.1.2
```

## Claude Code

```bash
claude mcp add launchlint -- npx -y @launchlint/mcp@0.1.2
```

## Cursor or JSON configuration

```json
{
  "mcpServers": {
    "launchlint": {
      "command": "npx",
      "args": ["-y", "@launchlint/mcp@0.1.2"],
      "env": {
        "LAUNCHLINT_WORKSPACE": "/absolute/path/to/app"
      }
    }
  }
}
```

`LAUNCHLINT_WORKSPACE` is optional when the MCP client provides exactly one filesystem root.

The first tool call opens a browser for OAuth sign-in and consent. `prepare_workspace_scan` only reports the selected file count, size, exclusions, and a one-time confirmation token. A paid app check is consumed only after an explicit `start_workspace_scan` confirmation.

The connector excludes local credential files, dependencies, caches, build outputs, binary files, and symlinks. It does not install dependencies, invoke a shell, run package scripts, or send source files through the model context. Unsaved editor changes cannot be checked.

## Security

The connector is public so its local file handling and network boundary can be audited. LaunchLint's scanner, authorization, billing, database, and infrastructure remain in the private service. Installing this package does not grant a LaunchLint plan or access to another user's projects.

Please report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).
