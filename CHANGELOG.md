# Changelog

## 2.1.0

- Five new tools: live editability, typed application preview/commit, answer verification and private Markdown export.
- Current edit forms determine writable fields; no full-edit permission is inferred.
- Expected-value checks, precommit concurrency/permission checks, exact diffs and automatic read-back.
- Financial answers protected by default; dedicated workflows retained for uploads and structured data.
- Guarded commits remain protected even when invoked through the generic mutation tool.
- Desktop MCPB packaging with official schema validation and an actual extracted-install test.
- Official registry metadata and GitHub OIDC publishing workflow, plus directory maintainership metadata.

## 2.0.0

First public release of the Distributed Systems YC GraphQL MCP server.

- Direct authenticated GraphQL HTTP by default; a browser is used for manual sign-in.
- Seventeen tools, source-observed application/profile reads, resources and prompts.
- Private session capture, validated headers, atomic cookie rotation and local diagnostics.
- Immutable mutation previews, final session checks and durable receipt deduplication.
- Explicit rejection, unverified and uncertain outcomes; HTTP 200 alone never proves a save.
- Crash recovery, shutdown draining, journal validation and compaction retaining every key.
- Finite request, response, script, registry and receipt limits, plus cancellation and deadlines.
- Structured redacted diagnostics, typed ESM exports and tested production-only tarballs.
- Optional authenticated loopback Chrome extension transport.
- Node 22/24/26 validation and an isolated Chromium integration test.

Version 1 receipt histories remain intact. A legacy `succeeded` receipt does not prove persistence; replay reports `MUTATION_UNVERIFIED` without dispatch. Read back historical changes before making new ones. See the [contract](docs/tool-contract.md) and [operations guide](docs/operations.md).
