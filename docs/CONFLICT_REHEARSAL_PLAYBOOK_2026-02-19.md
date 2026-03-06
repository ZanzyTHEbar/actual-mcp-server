# Conflict Rehearsal Playbook (2026-02-19)

## Rehearsal Context

- Rehearsal branch: `reconcile-rehearsal-20260219`
- Snapshot commit (remediation patch applied): `2092d85`
- Merge attempted: `upstream/main` into remediation snapshot with `--no-commit --no-ff`
- Result: **merge conflicts detected**

## Conflict Summary

- Total conflicted paths (`diff-filter=U`): **107**
- Unmerged status mix:
  - `AA` (add/add): **70**
  - `UU` (content/content): **31**
  - `UD` (deleted by them): **6**
- Conflict concentration:
  - `src/tools`: 53
  - `src/lib`: 7
  - `tests`: 7
  - `.github`: 5
  - `docs`: 5
  - `docker`: 5
  - `scripts`: 5

## High-Impact Overlap (Remediation Scope)

| File | Merge state | Resolution intent |
|---|---|---|
| `src/actualToolsManager.ts` | `UU` | Manual merge: preserve normalization/coverage fixes, union with upstream added tools/APIs. |
| `src/config.ts` | `UU` | Manual merge: keep search/session/auth extensions from remediation; add upstream OIDC extras where compatible. |
| `src/server/httpServer.ts` | `UU` | Manual merge: keep `ensureCallToolResult` and dispatch safety behavior. |
| `src/server/sseServer.ts` | `UD` | Keep local SSE implementation (upstream deleted file). |
| `src/tools/session_list.ts` | `AA` | Keep SessionWorkerManager version; preserve full-session-id semantics. |
| `src/tools/session_close.ts` | `AA` | Keep SessionWorkerManager close flow + strict current-session guard. |
| `.github/workflows/ci-cd.yml` | `AA` | Keep local mandatory gates; adapt upstream release dependency fixes selectively. |
| `.github/PULL_REQUEST_TEMPLATE.md` | `AA` | Merge local test gate instructions with upstream stale-reference cleanup. |
| `tests/unit/generated_tools.smoke.test.js` | `UU` | Union smoke examples/assertions from both branches; keep meta-tool skip policy. |
| `package-lock.json` | `UU` | Defer line-level merge; regenerate lockfile after functional merges settle. |

### Remediation Files That Merged Cleanly in Rehearsal

- `src/lib/SessionWorkerManager.ts`
- `src/lib/search/SearchIndex.ts`
- `src/lib/search/syncState.ts`
- `src/lib/search/queries.ts`
- `src/tools/meta_tool_call.ts`

These should be treated as **merge invariants** and re-verified after final reconcile.

## Conflict Resolution Procedure (Execution Order)

1. **Resolve architectural fork points first**
   - Keep local transport split (`http` + `sse`) and worker-manager session architecture.
   - Explicitly keep `src/server/sseServer.ts` from local branch.

2. **Resolve core runtime conflicts manually**
   - `src/actualToolsManager.ts`: union tool lists and API map; keep canonical tool normalization and corrected coverage math.
   - `src/config.ts`: keep `SESSION_TOOL_TIMEOUT_MS`, search config, auth provider enum with `ldap`; merge upstream `OIDC_RESOURCE`/`OIDC_SCOPES` if needed.
   - `src/server/httpServer.ts`: keep safe result wrapping and global tool dispatch rules.

3. **Resolve session tool conflicts**
   - Favor local `sessionWorkerManager` implementation in both `session_list` and `session_close`.
   - Retain strict `===` current-session protection.

4. **Resolve CI/test workflow conflicts**
   - Keep local gate policy: `build`, `test:unit`, `test:adapter`, generated-tools smoke, branch-aware security gating.
   - Merge in upstream release-job dependency fixes only if they do not weaken protected-branch enforcement.

5. **Handle churn-heavy non-functional conflicts**
   - For docs/version/release metadata and lockfiles, resolve after runtime/tooling conflicts.
   - Prefer deterministic regeneration (`npm install`/`npm ci` + test matrix) over hand-merging lockfile hunks.

6. **Validation after conflict resolution**
   - `npm run build`
   - `npm run test:unit`
   - `npm run test:adapter`
   - `node tests/unit/generated_tools.smoke.test.js` (with dummy env vars)
   - `npm run test:e2e:docker:smoke`

## Suggested Mechanical Merge Tactics

- Use `--ours` for remediation invariants if conflict appears unexpectedly:
  - `src/lib/SessionWorkerManager.ts`
  - `src/lib/search/*`
  - `src/tools/meta_tool_call.ts`
- Use manual 3-way merge for the high-impact overlap list above.
- Defer `package-lock.json` to regeneration pass.

## Go/No-Go for Completing Reconcile Branch

- Go only when:
  - all high-impact files above are resolved with intended semantics,
  - no protected-branch CI gate regresses,
  - full validation matrix passes.
- No-go if:
  - session/transport architecture regresses to pre-worker-manager path,
  - search sync generation semantics are lost,
  - CI publish jobs can bypass mandatory tests on protected refs.
