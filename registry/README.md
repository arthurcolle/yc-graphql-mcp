# Registry distribution

`npm run bundle` constructs a desktop MCPB from a fresh production-only package installation. It validates `manifest.json` using Anthropic's published MCPB 0.3 JSON Schema, unpacks the ZIP, and launches the extracted MCP CLI before writing release metadata. File counts and hashes are reported; local sessions and application data never enter the payload.

The vendored schema is from `anthropics/mcpb`, release `v2.1.2`, at `schemas/mcpb-manifest-v0.3.schema.json`. Its original license is preserved in `MCPB-SCHEMA-LICENSE`. Schema validation uses AJV with format validators. The bundle builder uses pinned fflate for standard ZIP serialization.

`server.template.json` is build input, not a published listing. The builder generates `artifacts/server.json` with the exact release URL and SHA-256 of the actual bundle. The official registry publisher validates this result again.

The manually dispatched `Publish MCP Registry` GitHub workflow checks an existing version tag, reruns verification, builds the bundle, uploads it to that release, authenticates using GitHub Actions OIDC, and publishes the metadata. It verifies the public record and matching bundle hash afterward. The publisher binary is pinned to v1.8.8 and a checked SHA-256. No reusable registry credential is committed or required.

Registry versions and release artifacts are immutable once published. Upload collisions stop the workflow; inspect existing artifacts and the registry before retrying after a partial failure. Never replace a published bundle under the same URL. The public registry contains metadata and installation artifacts, not a hosted YC session or live MCP HTTP endpoint.

npm publication is separate; the package remains private to prevent accidental npm publication. The MCPB route does not require npm publisher credentials. `glama.json` declares repository maintainership for directory discovery; it does not itself prove a directory listing exists.

The root `server.json` is the verified public metadata for the latest published release. It includes the actual immutable bundle URL and SHA-256. The generated artifact remains the input to publishing; update the root copy only after successful publication and anonymous read-back.
