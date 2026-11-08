# M1 Battlescape WP8B2 — Completion report (UNLOAD)

**Date:** 2026-11-06  
**Scope:** **`UNLOAD`** tactical command + Node/C++ regression coverage (no runtime deployment, no GitHub publish).

## 1. Executive summary

Implemented **`UNLOAD`** end-to-end: JSON parsing and validation in `CompanionCommandCore`, execution in `BattlescapeGame::tryExecuteCompanionUnload` mirroring `Inventory::unload` (8 TU, magazine to left hand, weapon to right hand, `setAmmoItem(0)`), inbox handling in `CompanionCommandRuntime`, plus Node `tactical-command.cjs` / `composeUnloadCommand` and tests.

## 2. Files modified (key paths)

- `engine/OpenXcom/src/Engine/CompanionCommandCore.h` / `.cpp` — `UnloadCommandParsed`, `validateUnloadCommand`, `parseUnloadCommandJson`
- `engine/OpenXcom/src/Battlescape/BattlescapeGame.h` / `.cpp` — `tryExecuteCompanionUnload`
- `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` — inbox allow-list, result JSON, `fillUnloadValidationInput`, UNLOAD handler, journal/duplicate template extension
- `engine/OpenXcom/src/test/companion_command_test.cpp` — unload validation + parse tests
- `companion/m0-publish/lib/tactical-command.cjs` — parse, validate, dispatch
- `companion/m0-publish/lib/command-binding.cjs` — `composeUnloadCommand`
- `companion/m0-publish/test/tactical-command-m1-wp8b2-unload.test.cjs` — Node tests
- `companion/docs/M1-BATTLESCAPE-WP8B2-UNLOAD.md` — contract + engine notes
- `companion/docs/M1-BATTLESCAPE-INVENTORY-AUDIT.md` — **addendum** (historical tables preserved)
- `companion/docs/M1-BATTLESCAPE-WP8A-INVENTORY-OBSERVATION.md` — historical non-goals clarified
- `companion/docs/M1-TACTICAL-PLAN-FOUNDATION.md` — UNLOAD reference
- `companion/docs/M1-BATTLESCAPE-WP8B1-RELOAD.md` — cross-link to UNLOAD

## 3. Verified unload mechanics (source)

- **TU:** 8 — `Inventory::unload` (`spendTimeUnits(8)`).
- **Hands:** only the firearm may occupy either hand; other hand must be empty.
- **Placement:** magazine → `STR_LEFT_HAND`, weapon → `STR_RIGHT_HAND`, then `setAmmoItem(0)`.
- **Research:** `isResearched` on weapon and magazine rules (aligned with reload path).

## 4. Final command schema

See §1 of `M1-BATTLESCAPE-WP8B2-UNLOAD.md` (includes `loaded_ammo_battle_item_id`).

## 5. Magazine identity

Command **`loaded_ammo_battle_item_id`** must match `weapon->getAmmoItem()->getId()` at execution; Node preflight matches WP8A **`nestedAmmo.battleItemId`** when present.

## 6. Destination / hands

Post-success: magazine instance id **unchanged**; weapon has no inserted ammo; typical export shows **magazine in left hand**, **rifle in right hand** (engine-final pose matches `Inventory::unload`).

## 7. Atomicity

No TU spent on validation-only rejection. On `setAmmoItem(0)` failure after TU spend, implementation restores TU (same pattern as `tryExecuteCompanionReload`).

## 8. TU semantics

**8 TU** per unload when successful; **0** on parse/validation rejection.

## 9. RELOAD compatibility

After successful UNLOAD + fresh export, RELOAD sees **empty chamber** (`noMagazineInserted`) and can load a **different** carried clip by id (WP8B1). A full magazine swap often needs **`INVENTORY_MOVE`** (WP8B3) between unload and reload when belt/hand layout blocks the next command; each step uses a **new** binding — see `M1-BATTLESCAPE-WP8B2-UNLOAD.md` §5.

## 10. Engine C++ tests

Ran from `engine/OpenXcom/build-wp8-isolated/bin/Release/` after MSBuild:

| Binary | Result |
|--------|--------|
| `companion_command_test.exe` | **All tests passed** (includes new `parseUnloadCommandJson` + `validateUnloadCommand` cases; not a full battlescape integration harness). |
| `companion_snapshot_serialization_test.exe` | **All tests passed** |
| `companion_rules_reference_export_test.exe` | **All tests passed** |

**Note:** `tryExecuteCompanionUnload` is validated against the original **`Inventory::unload`** sequencing and TU (8). Dedicated isolated fixtures covering every combined equipment edge case (§17 of the WP8B2 charter) are **not** added as separate `BattlescapeGame` integration tests in this work package; live confirmation remains operator-side.

## 11. Node tests

`node companion/m0-publish/scripts/run-all-node-tests.cjs`:

| Metric | Value |
|--------|------:|
| **Tests** | **597** |
| **Pass** | **597** |
| **Fail** | **0** |

(Baseline before this change: **589**; **+8** from the new `tactical-command-m1-wp8b2-unload.test.cjs` suite.)

## 12. Win32 Release build

MSBuild:  
`"C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\MSBuild\Current\Bin\MSBuild.exe" "E:\Open X-Com Companion\engine\OpenXcom\build-wp8-isolated\OpenXcom.sln" /p:Configuration=Release /p:Platform=Win32 /t:"companion_command_test;companion_snapshot_serialization_test;companion_rules_reference_export_test;openxcom" /m`

| Outcome | Value |
|---------|--------|
| **Errors** | **0** |
| **Warnings** | 230 (pre-existing project warnings; e.g. `getenv`/`fopen` C4996, `LNK4075`) |
| **Elapsed** | ~2m 05s |
| **`openxcom.exe`** | Built under `build-wp8-isolated/bin/Release/` (canonical `runtime/m0/bin/openxcom.exe` **not** replaced per deployment policy). |

## 13. Snapshot compatibility

Requires WP8A-style **`nestedAmmo.battleItemId`** for strict Node preflight; engine can still reject bad identity without snapshot hints.

## 14. Research / fair-play

Unload uses the same **`SavedGame::isResearched`** gating as reload for **weapon and magazine**; no hidden inventory leaks beyond established snapshot rules.

## 15. Remaining limitations

See `M1-BATTLESCAPE-WP8B2-UNLOAD.md` §7.

## 16. Canonical runtime deployment

**Not deployed** — `runtime/m0/bin/openxcom.exe` unchanged by policy.

## 17. GO / NO-GO for live testing

**GO for controlled live test** when a build containing this code is installed, executor enabled per operator runbook, and **`publish-tactical-command-once.cjs`** is used (not raw GitHub PUT).

## 18. Next inventory work package suggestion

**WP8B3** candidates: `INVENTORY_MOVE` / PICKUP / DROP only after explicit narrow contracts, or extended snapshot validation for belt capacity — **out of scope for WP8B2.**
