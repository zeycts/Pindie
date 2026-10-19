# Phase 1 historical production-Learning cases

These are exact case bodies extracted from `fe1d9fa:tests/<file>`, not a runnable suite. Original shared helpers remain in Git history and, where still needed, in active tests. `.test.ts.txt` is intentionally historical text, outside the unchanged `tests/*.test.ts` active glob.

- `manifest.json`: 78 top-level registrations, source line/title/reason. The first archived native Trial loop generates 4 cases; total retired cases = **81**.
- `ci624-classification.json`: all **87 actual testCodeFailure** results individually classified: 37 production-only retired cases archived here; 50 mixed Core cases adapted and still active. All 172 cancellations were propagation inside Extension, not standalone Core failures.
- Archive by file (registration blocks): Extension 60; F1 6; F2 1; Discovery 2; scope trust integration 1; native Trial 8 (11 generated cases).
- No file-level skip, skip wrapper, name filter or new test exclusion is used. Mixed Core files remain active; standalone artifact/store/contract tests remain active. Full check after repair: **1600 pass / 0 fail / 0 cancelled / 0 skipped** (1681 minus exactly 81 historical cases).

This archive retires production activation assertions only. It does not delete historical production implementations or user data. See `docs/al-retirement-phase1.md` for preserved Core contracts and remaining Phase 2 scope.
