# Reconcile Baseline (2026-02-19)

This document freezes the fork-vs-upstream state used by the remediation batches.

## Git Baseline

- `branch`: `main`
- `fork head (local)`: `099b577e79c6d9ce45ff003f0b6a819e9a8d6755`
- `upstream/main`: `8ffeb8aaac70f36ad7fe33b15e32a89fd8852290`
- `merge-base`: `a8a5b6fa44585a8550605e4a3c97d26c4e39ccb3`
- `divergence (upstream/main...HEAD, left/right)`: `446 / 305`

## Compare References

- Upstream vs fork branch: <https://github.com/agigante80/actual-mcp-server/compare/main...ZanzyTHEbar:main>
- Merge-base vs local head (fork repo): <https://github.com/ZanzyTHEbar/actual-mcp-server/compare/a8a5b6fa44585a8550605e4a3c97d26c4e39ccb3...099b577e79c6d9ce45ff003f0b6a819e9a8d6755>

## Subsystem Scope Map

| Subsystem | Scope | Risk | Why |
|---|---|---|---|
| Adapter | `src/lib/actual-adapter.ts` | High | Write queue sync behavior can hide failures and create consistency drift. |
| Search | `src/lib/search/*` | High | Sync freshness, invalidation coverage, and runtime edge-cases affect correctness. |
| Session | `src/lib/SessionWorkerManager.ts`, workers | High | Pending-request lifecycle and worker exits can cause hung calls. |
| Auth | `src/auth/*` + server bindings | Medium | Session identity binding is sensitive to transport/session edge-cases. |
| Transport | `src/server/httpServer.ts`, `src/server/sseServer.ts` | High | Tool dispatch paths and session ops behavior differ across transports. |
| Tools | `src/tools/*`, `src/actualToolsManager.ts` | High | Name drift and registry/coverage mismatches break invocation semantics. |
| CI/Test | `.github/workflows/*`, `vitest.config.ts`, `tests/*` | High | Current test gate does not reliably fail for missing/invalid unit suites. |
| Docs | `docs/*`, templates | Medium | Mismatch between docs and enforced checks leads to operator confusion. |

## Batch Execution Contract

Remediation executes in strict priority order:

1. Tool naming + cache invalidation consistency
2. Session/worker reliability
3. Search correctness + freshness
4. Test/CI enforcement hardening
5. Upstream merge rehearsal + final go/no-go ledger
