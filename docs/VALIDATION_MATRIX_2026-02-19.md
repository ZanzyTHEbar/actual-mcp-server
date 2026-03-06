# Validation Matrix (2026-02-19)

This run validates the remediation batches through the CI-aligned command set.

## Command Results

| Command | Subsystem(s) | Result | Notes |
|---|---|---|---|
| `npm run build` | TypeScript compile / core server | PASS | No compile errors. |
| `npm run test:unit` | Auth, logger, session/runtime behavior | PASS | 8 files, 50 tests passed. |
| `npm run test:adapter` | Adapter normalization + retry/concurrency | PASS | Adapter runner reports both suites passing. |
| `node tests/unit/generated_tools.smoke.test.js` (with dummy env) | Tool wiring / schema-call smoke | PASS | All tools passed; `meta_tool_call` intentionally skipped in this harness because it requires initialized registry/session context. |
| `npm run test:e2e:docker:smoke` | End-to-end MCP + Docker stack | PASS | 10 passed, 1 skipped (SSE check skipped under HTTP transport). |
| `npm run test:e2e:docker:full` | Full end-to-end MCP + Docker tool surface | PASS | 71 passed, 3 skipped (74 total). |

## Observed Non-Blocking Warnings

- Playwright emitted a reporter config warning during Docker E2E runs (smoke/full):
  - `Configuration Error: HTML reporter output folder clashes with the tests output folder`
  - Tests still completed successfully (exit code 0). This should be cleaned up to reduce CI noise.

## Failure Capture by Subsystem

- Adapter: no failures
- Search runtime/indexing: no failures in smoke/E2E path
- Session management: no failures in unit/E2E path
- Tool dispatch: no failures in smoke/E2E path
- CI/workflow config: no runtime failures in this matrix

## Gate Status for Current Batch

- Build gate: PASS
- Unit gate: PASS
- Adapter gate: PASS
- Smoke gate: PASS
- Docker E2E smoke gate: PASS
- Docker E2E full gate: PASS
