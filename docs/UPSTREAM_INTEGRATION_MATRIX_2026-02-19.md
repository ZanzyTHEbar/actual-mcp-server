# Upstream Integration Matrix (2026-02-19)

This matrix maps reconciliation actions by subsystem using `upstream/main` fetched on 2026-02-19.

## Baseline

- `fork HEAD`: `099b577e79c6d9ce45ff003f0b6a819e9a8d6755`
- `upstream/main`: `8ffeb8aaac70f36ad7fe33b15e32a89fd8852290`
- `merge-base`: `a8a5b6fa44585a8550605e4a3c97d26c4e39ccb3`

## Decision Matrix

| Subsystem | Local evidence | Upstream evidence | Decision | Integration action |
|---|---|---|---|---|
| Search runtime/indexing (`src/lib/search/*`, `src/tools/hybrid_search.ts`, `src/tools/search_similar.ts`, `src/tools/search_index_info.ts`, `src/workers/actualSessionWorker.ts`) | Remediation tasks `A17-A23` + validation pass in `docs/VALIDATION_MATRIX_2026-02-19.md` | No direct upstream edits on these paths since merge-base | **KEEP** | Keep local implementation as authoritative; do not downgrade generation-guard or retryability behavior. |
| Session worker lifecycle (`src/lib/SessionWorkerManager.ts`, `src/tools/session_list.ts`, `src/tools/session_close.ts`) | `A10-A14`, `A17` (pending rejection, timeout, dirty-broadcast, worker-manager migration) | `318cc66` (session tool foundation), `edbd1ed` (full session ID fix) | **ADAPT** | Keep local worker-manager architecture; adapt upstream semantics where needed (full session ID interoperability checks). |
| Tool dispatch/registry (`src/actualToolsManager.ts`, `src/tools/meta_tool_call.ts`, `src/lib/toolNameNormalization.ts`) | `A03-A06`, `A15-A16` (canonical naming + recursion/write-classification guards) | `0023f2d` (multi-budget tool additions touching manager/config) | **CHERRY-PICK/ADAPT** | Port upstream multi-budget feature slices into the normalized-dispatch layer; preserve alias normalization and coverage math fixes. |
| Transport (`src/server/httpServer.ts`, `src/server/sseServer.ts`) | `A16` (contract-safe direct path for global tools), MCP result normalization hardening | `318cc66`, `cabbe3d`, `4555534` touched transport/auth docs/release-era server changes | **ADAPT** | Three-way merge manually; preserve `ensureCallToolResult` contract and global tool routing behavior. |
| CI/Test gates (`.github/workflows/ci-cd.yml`, `vitest.config.ts`, tests) | `A24-A29` + matrix pass in `docs/VALIDATION_MATRIX_2026-02-19.md` | `389c961` release dependency fix, `43605c8` smoke-test ecosystem updates | **CHERRY-PICK/ADAPT** | Keep local mandatory test gates; selectively adapt upstream release-job dependencies and any compatible smoke harness updates. |
| Templates/docs (`.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/README.md`) | `A29` (CI gate docs alignment) | `e300a68` template reference fixes | **ADAPT** | Merge both: retain local gate instructions and bring in upstream stale-reference cleanup if non-conflicting. |
| Dependency lockfile (`package-lock.json`) | Local lockfile drift from remediation/test execution | `7d33315`, `43605c8` both mutate lockfile | **DEFER** | Do not cherry-pick lockfile blobs directly; regenerate lockfile after functional merge settles, then run full test matrix. |
| Release/version churn (`VERSION`, release-only bumps) | N/A in remediation scope | `4555534` and other release bump commits | **REJECT** | Do not import release bump commits during functional reconcile; handle versioning in a dedicated release pass. |

## Action Order

1. Keep search/session correctness patches intact (`A10-A23`) as merge invariants.
2. Adapt overlapping upstream commits in order: `0023f2d` -> `318cc66`/`edbd1ed` -> `389c961` -> `e300a68`.
3. Defer lockfile and release bump reconciliation until all functional merges are green.
