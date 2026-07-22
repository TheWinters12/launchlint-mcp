# Security

## Supported version

Only the latest published version of `@launchlint/mcp` receives security updates.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Send a report to `security@launchlint.app` with the affected version, impact, and reproduction steps. Do not include real credentials, access tokens, or private source code.

We aim to acknowledge reports within three business days. Confirmed issues are fixed and released before technical details are published.

## Security boundaries

- The connector reads only the explicitly approved workspace root.
- It never runs project code, package scripts, builds, installers, or shell commands.
- Secret files, dependencies, caches, build output, binaries, and symlinks are excluded.
- A workspace snapshot is uploaded directly to LaunchLint over HTTPS after explicit confirmation. Source files do not pass through the coding model context.
- OAuth tokens are scoped, revocable, and stored in the current user's configuration directory with restrictive file permissions where supported.
- Authentication, subscription access, project ownership, scan limits, and all scanning logic are enforced by the private LaunchLint service.

The public connector does not contain LaunchLint credentials, scanner rules, billing logic, database access, or infrastructure configuration.
