# ASTER-M1-HWP-S5-1CH–1CJ — Certification completion record

**Status:** **Accepted** (S5-1CK commit pass)  
**Date:** 2026-11-19  
**Scope:** Engine HWP `HWP_FIRE` relay certification, cancel/redraw safety, TURN relay ownership harness  
**Repos:** `engine/OpenXcom` (implementation + harnesses); this note is companion-side audit trail only.

---

## Executive verdict

| Area | Verdict |
|------|---------|
| HWP FIRE relay (`companion_hwp_fire_relay_test`) | **PASS** |
| HWP FIRE engine (`companion_hwp_fire_engine_test`) | **PASS** |
| HWP MOVE relay + terminal | **PASS** |
| HWP TURN body + turret relay | **PASS** |
| HWP TURN engine | **PASS** |
| AI / human ownership (`NOT_AI_CONTROLLED`) | **PASS** |
| Mid-flight projectile cancel (BattlescapeState path) | **PASS** |
| Renderable floor + cancel redraw | **PASS** |
| Headless multi-iteration cancel AV | **DEFERRED** (harness lifecycle; not gameplay-blocking) |

Production HWP tactical gate remains **off** until a separate owner review (post S5-1CK).

---

## S5-1CH — Cancel redraw / floor surfaces

**Problem:** `ProjectileFlyBState::cancel()` → camera redraw → `Map::draw()` → first floor `Tile::getSprite()` dereferenced `MapDataSet` with no loaded `SurfaceSet` in relay harness maps.

**Fixes:**

- Relay harness `renderableFloorTile` / `wireFloor` uses mod-backed terrain with assertable PCK load.
- `Map::drawTerrain` cursor paths null-check `getBattleState()` before `getMouseOverIcons()` (headless / relay-safe redraw).

---

## S5-1CI — Cancellation probe and forensics split

- In-matrix mid-flight `cancelCurrentAction()` probe after terrain fix — no `0xC0000409` on relay path.
- Optional env splits: `OPENXCOM_COMPANION_HWP_CANCEL_FORENSICS`, `OPENXCOM_COMPANION_HWP_HEADLESS_FORENSICS` (certification-only; default matrix does not require them).
- Headless `BattlescapeGame(parent=0)` multi-iteration process exit AV tracked separately; does not invalidate production-style relay cancel certification.

---

## S5-1CJ — TURN relay `NOT_AI_CONTROLLED` (harness)

**Finding:** Production dual gate (`tacticalAiHwpAssigned` + `relayAiHwpAssigned`) is correct. Failures were **stale or CWD-relative** `companion-soldier-control.json` beside relay fixtures.

**Harness hardening (`companion_hwp_turn_relay_test`):**

- Exe-relative relay directory (parity with FIRE/MOVE).
- Reset removes `companion-soldier-control.json`.
- Pre-publish ownership assertions; human path asserts `reject_code == NOT_AI_CONTROLLED`.

---

## Related engine deliverables (S5 FIRE execution)

Committed with this tranche in `engine/OpenXcom`:

- `CompanionHwpFireExecutionCore` + runtime/command wiring for `HWP_FIRE`.
- Relay and engine certification harnesses registered in `src/CMakeLists.txt`.

---

## Out of scope for this commit

- `local/s5-1cf-*` diagnostic binaries and logs.
- CMake build tree directories under `build-*`.
- Companion `m0-publish` Node publisher changes (separate tranches).