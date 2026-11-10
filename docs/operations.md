# Operations guide

## Runtime and deployment model

Run the server as the same ordinary OS user who owns its private state and auth files. Node 22.13+ is supported; the CI matrix targets Node 22, 24 and 26. The MCP host owns a stdio process. No public listener is started in direct mode, and no hosted OAuth/HTTP MCP deployment is claimed.

Use explicit absolute `--auth-file` and `--state-dir` paths in host configuration. The default state directory is `$XDG_STATE_HOME/yc-graphql-mcp` or `~/.local/state/yc-graphql-mcp`. The default auth path is `<state-dir>/auth.json`; existing source checkouts with `.yc-graphql-mcp/auth.json` retain that location. CLI flags override `YC_AUTH_FILE`, `YC_MCP_STATE_DIR`, `YC_TRANSPORT`, and `YC_BRIDGE_PORT` defaults.

The optional browser bridge binds 127.0.0.1. It validates the exact Host, `/bridge` path, Chrome extension Origin, protocol version and 256-bit token. There can be one paired browser, eight total sockets, and one pending task. Unauthenticated connections expire after five seconds; authenticated peers exchange heartbeats and are disconnected when stale. Tokens are not put in URLs.

## Authentication lifecycle

`yc-graphql-mcp login` opens a temporary Chromium profile. The user enters their own credentials and handles authentication prompts. The helper reads the resulting YC cookie header and CSRF meta value, verifies a direct account query, atomically saves the private auth file, closes the browser and removes the temporary profile. Failed sign-in leaves existing saved authentication intact. A SIGKILL can leave a private temporary profile; do not share temporary directories.

Only the required auth headers and capture timestamp are saved. No password, full cookie database, browser storage export, or application response is saved by the login helper. Application content explicitly fetched through tools is visible to the host/model.

Auth reads use an owned, single-link, regular file opened without following a leaf symlink. Permissions must be 0600 or stricter. Directory writes require an owned 0700 directory. A changed credential digest invalidates pending previews. The final transport check verifies that the dispatch still uses the preview's session.

Cookie rotations from successful YC-origin responses use RFC cookie parsing and atomic private-file replacement. A response associated with an older credential snapshot cannot overwrite a newer manual login. Redirects are not followed. Cookie/CSRF headers are removed from static-origin requests. Authentication failures and CSRF rejection are terminal for the request; no retry or automatic login is attempted.

`yc_status.authentication` is `configured`, `verified`, `expired` or `unavailable` based on local configuration and observed request outcomes. `connected: true` means a usable local file exists, not that YC was just contacted. `lastVerifiedAt` is local evidence of a completed request, not a perpetual authorization guarantee. `doctor` inspects only local files and lock state.

## Request and resource bounds

| Resource                                         | Bound                                                  |
| ------------------------------------------------ | ------------------------------------------------------ |
| MCP stdin buffer                                 | 1,000,000 bytes                                        |
| GraphQL document, before and after normalization | 100,000 characters                                     |
| Parser tokens                                    | 15,000                                                 |
| Expanded AST visits                              | 20,000                                                 |
| AST / root-selection depth                       | 128                                                    |
| Fragment chain                                   | 64                                                     |
| Variables                                        | 100,000 UTF-8 bytes, depth 20, 10,000 nodes            |
| GraphQL response                                 | 2,000,000 decompressed bytes, depth 100, 100,000 nodes |
| Query or mutation deadline                       | 20 seconds, including body reads                       |
| Initial direct script HTML                       | 2 MB, ten-second deadline                              |
| Referenced script inspection                     | 25-second overall fetch deadline                       |
| Scripts / terms / hits per term                  | 30 / 10 / 5                                            |
| Individual / total script bytes                  | 5 MB / 15 MB                                           |
| Script excerpt content                           | 500,000 UTF-8 bytes total, plus bounded metadata       |
| Browser request deadline                         | 35 seconds                                             |
| Registered documents                             | 100, 2 MB total                                        |
| Outstanding previews                             | 100, ten-minute lifetime                               |
| Receipt record                                   | 128 KB                                                 |
| Receipt keys                                     | 10,000 per state directory                             |
| Receipt snapshot admission budget                | 8 MB with reserved terminal metadata space             |
| Receipt journal                                  | Read cap 20 MB; compacted near 10 MB                   |

No request is retried automatically. `RATE_LIMITED` exposes a bounded `retryAfterSeconds` when supplied by YC. A second upstream task returns `BRIDGE_BUSY` immediately. The caller decides whether and when to repeat a read. A mutation timeout or cancellation can conceal a committed change and must not be retried blindly.

## Receipt semantics and recovery

The exclusively locked state directory is the idempotency namespace. A UUID key binds one normalized document, operation name and canonical JSON variable digest. The in-memory preview and returned preview are separate copies. Commit rechecks the digest and target, flushes `dispatched`, then calls the transport. No response body or mutation variable values are written to the journal.

An explicit upstream failure, error array or `persisted: false` produces `rejected`. Missing success evidence or a requested null YC entity produces `unverified`. A lost reply, interruption or ambiguous transport failure produces `uncertain`. All terminal results are non-replayable, including rejected and unverified outcomes. `succeeded` means the selected roots explicitly report success; it still requires business postcondition read-back.

Version 1 receipts are retained for deduplication. Their `succeeded` status historically described a successful GraphQL envelope. Version 2 does not reinterpret that as proof of persistence; committing a legacy success returns `MUTATION_UNVERIFIED` without dispatch. New records have `version: 2`.

On restart, `prepared` becomes `expired`, and `dispatched` becomes `uncertain`. Terminal keys remain intact through compaction. New admission stops when the snapshot/key capacity is exhausted; no key is silently evicted. A durable write failure makes the store refuse further writes in the same process. The returned receipt identifies the potentially affected operation.

### Stale lock

1. Run `doctor` against the exact state directory.
2. Stop every server that uses that directory. Check the recorded PID and hostname. An active or unknown PID must not be treated as stale.
3. Copy the complete directory to a private backup location.
4. When the recorded process is confirmed gone, remove only `server.lock`.
5. Restart. Let journal recovery mark dispatched requests uncertain; inspect their receipts and read back the application.

The server does not automatically break locks. PID reuse can make a genuinely old lock look active; manual inspection is safer than deleting a live process's lock. `doctor` never deletes anything or contacts YC.

### Corrupt or torn journal

Stop. Preserve the original bytes and the operation registry. A partial last line can represent a dispatch or completion whose durability is uncertain. Do not truncate, reset or delete the journal to make startup succeed. Use a verified backup and a deliberate reconciliation of each affected receipt. There is no automatic destructive repair or upstream exactly-once guarantee.

### Backup

Stop all writers before copying state. Preserve `operations.json` and `receipts.jsonl` together. Back up auth separately as a credential, or create a new session after restore. Private files remain private in the backup location. Restoring an older receipt history can lose knowledge of newer effects, so reconcile that interval before authorizing further mutations.

## Shutdown and diagnostics

SIGINT, SIGTERM, stdin EOF, protocol closure and broken output trigger shutdown. The transport is closed/aborted, active service work is drained so ambiguous mutations receive an uncertain outcome where storage is available, and only then is state closed and the lock removed. A hard kill is recovered from the already-flushed dispatched record at next start.

`--log-level error|warn|info` controls structured stderr. Events contain request IDs, tool names, durations, fixed error codes and transport/version metadata. Headers, auth values, documents, variables, provider error text and application answers are not logged. Host-provided log capture should be private as well. Stdout remains exclusively MCP protocol in serve mode.

## Package and upstream boundary

`npm run pack:verify` checks the file allowlist, installs the tarball with production dependencies only in a fresh temporary directory, imports the public API, and tests the installed CLI's tools, resources, prompts and diagnostics. The sign-in browser library is a runtime dependency; browser binaries are installed separately. Local application-editing scripts, credentials, backups and journals are excluded.

The package is private and is not automatically published. CI files are supplied, but hosted execution is not implied when the checkout has not been pushed to a repository.

YC's API is not a versioned public integration contract. Built-in read documents are source-observed and can require updates if YC changes the schema. Introspection may be disabled. The generic named-query registry and script inspection provide discovery within the authenticated account; they do not authorize access to other accounts or bypass server restrictions. Application update permissions are enforced by YC, and backend rejection must be respected even when a field is present in a GraphQL input type.

## Typed updates and distribution (2.1)

Live edit discovery makes five fixed-origin HTML reads with a 25-second overall deadline, at most 2 MB per page and 6 MB total. It parses only recognized JSON hydration metadata, returns field labels and required flags, and never executes fetched JavaScript. Unknown or mismatched forms fail closed.

Typed updates contain 1–30 unique text/null fields, each at most 20,000 characters, and remain subject to the existing 100 KB variables limit. The workflow holds at most 100 ten-minute previews. Expected values, current submission state and live form permissions are checked before dispatch. This is not an upstream atomic transaction. Verification failures retain the original terminal receipt and never replay a mutation. Private baseline/verification values are not persisted in receipts; restart expires previews.

`YC_ALLOW_MUTATIONS=true` is an explicit process-level opt-in used by desktop bundle configuration. Other values leave the default disabled. The bundle requires Node 22.13+ and declares macOS/Linux compatibility. It contains Node production dependencies, not a Chromium binary or saved session. Sign in locally and use the same private state directory in your MCP host; see the bundle guide.

Registry metadata is generated from the actual bundle hash and published through a manually dispatched, verified-tag GitHub workflow using OIDC. Do not overwrite artifacts under a published version URL. After partial publishing failure, inspect release assets and the public record before resuming.
