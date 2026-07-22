# Contributing

## Local verification

Use Node.js 22 or newer and install the exact lockfile without lifecycle scripts:

```bash
npm ci --ignore-scripts
npm run release:check
```

Pull requests must keep the connector deterministic, must not execute workspace code, and must not broaden file or network access without tests and an explicit security rationale.

## Test data

Use synthetic fixtures only. Never commit real application source, credentials, OAuth tokens, customer data, private repository names, or production responses.

## Security reports

Do not disclose vulnerabilities in public issues. Follow [SECURITY.md](./SECURITY.md).
