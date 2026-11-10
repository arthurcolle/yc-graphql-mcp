# Security policy

Version 2 is the maintained release line. This is a local stdio server for your own authenticated YC account. It does not expose an internet-facing MCP service.

Report a suspected vulnerability through [GitHub private vulnerability reporting](https://github.com/arthurcolle/yc-graphql-mcp/security/advisories/new). Include the affected version, a minimal synthetic reproduction, the expected boundary and observed behavior. Omit live credentials and private application data.

Security-sensitive boundaries include fixed-origin session handling, mutation authorization and session binding, receipt durability and replay, local file ownership/permissions, bridge authentication, request bounds and package contents. The [operations guide](docs/operations.md) documents the deployment model, limits and deliberate recovery procedures.

If a real session was exposed, revoke or refresh it before sharing a report. Public issues are appropriate for ordinary bugs that contain no sensitive data.
