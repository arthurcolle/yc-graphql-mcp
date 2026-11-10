# Desktop bundle

This MCPB contains the compiled Node server and production dependencies. It contains no account session or application records. The launch image is illustrative artwork.

Use Node 22.13 or newer on macOS or Linux. Set a private state directory in your MCP host. Sign in manually using the extracted package's CLI before calling account tools:

```sh
node /path/to/extracted-bundle/server/node_modules/yc-graphql-mcp/dist/cli.js login --state-dir /private/path/yc-state
```

Install the matching Chromium build first if needed:

```sh
npx playwright@1.65.0 install chromium
```

The login helper saves `auth.json` in the selected state directory. Use that same directory in the bundle settings. Credentials stay on your machine; account answers returned through tools are visible to the MCP host. Mutations default to disabled. Enabling reviewed changes allows preview/commit tools; it does not authorize arbitrary application changes.

One process owns each state directory. Close another MCP host using it before switching hosts. Do not delete receipts to clear a lock. See the repository's operations guide for recovery. The bundle is an unofficial YC client; YC controls account access and update permissions.
