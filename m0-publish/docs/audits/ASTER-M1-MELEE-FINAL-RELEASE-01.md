# ASTER-M1-MELEE-FINAL-RELEASE-01

**Date:** 2026-11-18  
**Authorization:** Owner — live acceptance recorded; permanent production enablement

## Verdict

| Item | Status |
|------|--------|
| Live `MELEE_ATTACK` acceptance | **ACCEPTED** (`ASTER-M1-MELEE-LIVE-ACCEPTANCE-01.md`) |
| P0 orphan `EXECUTING` recovery | **CLOSED** (rehydrate + idle-unresolved → `FAILED`) |
| Production melee gate (canonical launcher) | **ENABLED** (`OPENXCOM_COMPANION_MELEE_EXECUTION=1` process-local) |
| Release deploy | **SUCCESS** |
| Git checkpoint | See § Engine / Companion commits |

---

## 1. Owner acceptance evidence

See **`ASTER-M1-MELEE-LIVE-ACCEPTANCE-01.md`**.

Summary: Kees van der Linden (#28) → Sectoid (#1000001), **COMPLETED**, `melee_hit: true`, `tu_spent: 19`, `remaining_tu: 45`. First relay `target_status: **active**` — **not** interpreted as unconscious. Corroborating MOVE + corpse PICKUP verified in fresh snapshot.

---

## 2. Recovery fix and tests

| Change | Purpose |
|--------|---------|
| `tryRehydrateOrphanedMeleeActive` | Same-session reload: restore in-flight monitor **without** re-executing strike |
| `tryTerminalizePersistedCrossSessionOpenResult` + `MELEE_ATTACK` | Cross-session disk orphan → `INTERRUPTED` |
| `evaluateMeleeTerminalStatus` | When `!battleBusy && !attackResolved` → **`FAILED`** (mirrors directed fire; no infinite `EXECUTING`) |
| `parseMeleeParsedFromOpenResultJson` | Quarantined-inbox open-result binding |

**Tests (Release `companion_command_test.exe`):** all pass including `testMeleeOpenResultParseAfterInboxQuarantine`, orphan lifecycle `FAILED` case.

**Not run:** `companion_melee_engine_test.exe`.

---

## 3. Production activation

| Surface | `OPENXCOM_COMPANION_MELEE_EXECUTION` |
|---------|--------------------------------------|
| `runtime/m0/Start-CompanionOpenXcom.ps1` | **`1`** (child process only) |
| `companion/scripts/workspace/Start-CompanionOpenXcom.example.ps1` | **`1`** (repo template) |
| Native default (no env) | **Off** (safety gate in `CompanionSoldierOwnershipCore`) |
| `Start-CompanionOpenXcom-MeleeBattleModeTest.ps1` | Retained (redundant wrapper; optional) |

---

## 4. Release SHA-256 and rollback

| Artifact | SHA-256 |
|----------|---------|
| **Deployed** `runtime/m0/bin/openxcom.exe` | `69012052542ef4dd32c65dd155e6ccf75b76bef8112dc270812a71b87bdbec66` |
| **Prior** (pre-final deploy) | `6606e49240511ba09abdddb7e7fb8471847cc6a577c64ac0e6063897e3897bbd` |
| `VERIFIED_BUILD_SHA256` pin | **Matches** deployed binary |

**Rollback backup:** `runtime/m0/bin/openxcom.exe.backup-20261118-161645` (hash `6606e492…`).

---

## 5. Regression gates (bounded)

| Gate | Result |
|------|--------|
| `companion_command_test.exe` (Release) | **PASS** |
| Node melee S1 | **11/11** |
| Node WP9 + WP10 suites | **32/32** |
| WP9/WP10 engine tests (Release) | **PASS** (unchanged targets rebuilt with melee object files) |

---

## 6. Git checkpoint

| Repository | Branch | Commit | Remote match |
|------------|--------|--------|--------------|
| OpenXcom (engine) | `aster/m0` | `7b3789da3` | `origin/aster/m0` **==** HEAD (fast-forward push) |
| OpenXcom-Companion | `main` | `a7fa118` | `origin/main` **==** HEAD (fast-forward push) |

---

## 7. Remaining documented issues

- First-hit stun/unconscious not proven from relay `target_status` alone  
- Turret/elevation melee rejects beyond Node advisory (S3 gap list)  
- `companion_melee_engine_test.exe` not exercised  
- Reaction-mode / `BA_USE` / other non-relay actions per `ASTER-M1-TACTICAL-COMMAND-COVERAGE-AUDIT-01.md`

---

**Stop:** No further melee feature work in this order.