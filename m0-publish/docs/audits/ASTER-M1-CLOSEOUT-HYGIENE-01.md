# ASTER-M1-CLOSEOUT-HYGIENE-01 — closeout hygiene (uncommitted)

**Mode:** Small patch — gates, playbook, coverage corrections.  
**Date:** 2026-11-20. No commit, push, or deployment.

## 1. ADJ-02 regression gate

| Gate | Behavior |
|------|----------|
| `companion_medikit_engine_test.exe` | Default suite: wrong-facing adjacent conscious **on**; positive ADJ-02 **off** (commented). |
| `companion_medikit_release_smoke_test.exe` | **`OPENXCOM_MEDIKIT_ADJ02_CERT=1`** runs experimental `runMedikitAdj02AdjacentConsciousCert()`; default smoke runs co-tile + adjacent mis-aim only. |

Evidence path preserved for diagnosis (ADJ-02 still **FAIL** on ruleset open floor at last run).

## 2. Playbook

- **25** supported `command_type` values documented in `companion/docs/ASTER-LIVE-PLAYBOOK.md` (incl. `TURN_FACE`, `HWP_*`).

## 3. Owner HWP live acceptance (2026-11-19 / 2026-11-20)

| Behavior | Command family | Status |
|----------|----------------|--------|
| Movement | `HWP_MOVE` | **LIVE VERIFIED** (owner) |
| Turning (hull / turret) | `HWP_TURN` | **LIVE VERIFIED** (owner) |
| Cannon and laser direct fire | `HWP_FIRE` | **LIVE VERIFIED** (owner) |
| Rocket Tank fire | `HWP_FIRE` | **LIVE VERIFIED** (owner) |
| Fusion Hovertank guided launch | `HWP_GUIDED_LAUNCH` | **LIVE VERIFIED** (owner) |

## 4. Final coverage matrix (corrections)

| Capability | Classification | M1 blocker? | Smallest correction |
|------------|----------------|-------------|---------------------|
| **Mind Probe** | **MISSING** | No (specialist) | Defer or scoped M2 command |
| **Infantry rocket** | **IMPLEMENTED + TEST VERIFIED** (`AIMED`/`SNAP`/`AUTO`) | No | None |
| **Medikit adjacent** | **IMPLEMENTED + UNVERIFIED** (live); co-tile **LIVE VERIFIED**; harness ADJ-02 **FAIL** | No — not a confirmed production defect | Optional live drill; keep `TURN_FACE` → `HEAL` fail-closed |
| **HWP quartet** | **IMPLEMENTED + LIVE VERIFIED** (above) + **TEST VERIFIED** | No | Playbook only |
| **Inventory / reload** | **IMPLEMENTED + LIVE VERIFIED** (prior deploys) + **TEST VERIFIED** | No | None |
| **Reaction / TU reserve remote** | **INTENTIONALLY EXCLUDED** | No | None (squad reaction unchanged) |
| **Mind-controlled roster soldier orders** | **INTENTIONALLY EXCLUDED** (binding / exceptions) | No | None |
| **Mind-controlled hostile (`xcom_controlled_hostile_unit`) assignment** | **OPEN** — observation + exceptions exist; **no** `player_soldiers` / HWP binding path for post-MC hostiles | **Soft** (follow-up fire edge cases) | Product decision: explicit MC-hostile actor list or document human-only follow-up |
| **END_TURN** | **INTENTIONALLY EXCLUDED** | No | None |

## 5. Focused regression (this patch)

```text
companion_medikit_release_smoke_test.exe (default, 2026-11-20) → exit 0, WP9 medikit release smoke: PASS
companion_medikit_engine_test.exe                              → exit 0, All companion medikit engine tests passed
```

Manual: `OPENXCOM_MEDIKIT_ADJ02_CERT=1` + release smoke → reproduces ADJ-02 experimental cert.

**STOP** — hygiene complete pending owner commit when desired.