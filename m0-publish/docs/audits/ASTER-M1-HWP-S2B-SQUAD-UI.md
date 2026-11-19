# ASTER-M1-HWP-S2B — Friendly HWP squad control UI

**Status:** Implementation complete (local only — no commit, push, or runtime deploy)  
**Bases:** Engine `6e5749dc331e01336237964d0511fbc2f1b64e38` + S2B deltas, Companion `71709a47006139df39b1fc27407a94ed354ea5e4` (unchanged)  
**Scope:** Battlescape inventory **Squad** panel rows + ownership toggle for friendly HWPs only. No HWP tactical commands (`commandExecutionSupported` remains **false**).

---

## HWP numbering and identity (findings)

| Topic | Finding |
|-------|---------|
| Engine unit id | Stable `BattleUnit::getId()` for the battle; squad **ID** column shows this value (≥ `1_000_000` for HWPs). |
| Native type label | `BattleUnit::getName(lang, false)` for non-roster units resolves the **unit type** string (e.g. `STR_TANK_CANNON`), same as HUD/minimap naming — no custom vehicle names. |
| Display `#n` | Per **unit type**, ordinals count surviving friendly HWPs of that type with **lower** engine ids (`Type #1`, `#2`, …). Casualties do **not** renumber survivors. |
| Position | Tactical `x,y,z` from `getPosition()` shown in the **Status** column when no psych/status string is present. |
| Eligibility | Player faction, no `geoscapeSoldier`, `id ≥ MAX_SOLDIER_ID`, not `isOut()`. |
| Ownership store | Battle-scoped `_companionTacticalAiHwpIds` (S2A); default **human**; independent of roster `assignments`. |

---

## UI implementation

### Panel: `CompanionSquadOwnershipState` (inventory → Squad)

Unchanged layout: **Name | ID | Owner | Status** + Assign / Reclaim.

| Column | Soldiers (unchanged) | Friendly HWP (new) |
|--------|----------------------|---------------------|
| Name | Roster name + Aster colour | `{localized type} #{ordinal}` + Aster colour when AI |
| ID | Roster id | Engine HWP unit id |
| Owner | Human / Aster (+ `*` if unsaved geoscape) | Human / Aster (no `*` — tactical only) |
| Status | Psych / casualty strings | Position `x,y,z` if no status note |
| Toggle | Campaign + tactical soldier APIs | `assignCompanionTacticalHwpToAi` / `reclaimCompanionTacticalHwpForHuman` only |

Rows sort **soldiers first** (by id), then **HWPs** (by id). Toggle keys off unit id for both row kinds.

### Core: `CompanionBattlescapeOwnershipCore`

- `SquadOwnershipRow`: `isFriendlyHwp`, `positionLabel`.
- `buildSquadOwnershipRows`: merges roster soldiers + live friendly HWPs.
- `tryApplyOwnershipToggle`: `id < MAX_SOLDIER_ID` → existing soldier path; else HWP tactical set (no `SavedGame` soldier assignment).
- Publish on successful toggle still `CompanionSnapshot::tryPublishSoldierControl` when snapshot path configured (schema **2** + `hwp_assignments` from S2A).

### Safety: `SavedBattleGame` HWP assign/reclaim

- Assign requires a **live** friendly HWP unit on the battlescape.
- Reclaim refuses unknown destroyed ids unless they were already in the AI set (cleanup).
- Destroyed / `isOut()` HWPs never appear in squad rows and cannot be toggled.

---

## Files changed

| File | Change |
|------|--------|
| `engine/OpenXcom/src/Engine/CompanionBattlescapeOwnershipCore.h` | HWP row fields; `isDeployedFriendlyHwpUnit`, `effectiveTacticalHwpOwner`, `hwpEligibleForOwnershipToggle` |
| `engine/OpenXcom/src/Engine/CompanionBattlescapeOwnershipCore.cpp` | HWP row build, display naming, toggle branch |
| `engine/OpenXcom/src/Battlescape/CompanionSquadOwnershipState.cpp` | Show `positionLabel` in status column |
| `engine/OpenXcom/src/Savegame/SavedBattleGame.cpp` | Validate HWP ids on assign/reclaim |
| `engine/OpenXcom/src/test/companion_battlescape_hwp_squad_test.cpp` | **New** — focused UI/ownership scenarios |
| `engine/OpenXcom/src/test/companion_battlescape_hwp_squad_test_main.cpp` | **New** — console `main` (SDL link workaround) |
| `engine/OpenXcom/src/CMakeLists.txt` | `companion_battlescape_hwp_squad_test` target |

**Companion repo:** no changes (S2A relay/bindings sufficient).

---

## Tests run (`build-s4j-rc`, Release)

| Gate | Result |
|------|--------|
| `companion_battlescape_hwp_squad_test.exe` | **PASS** — one HWP; two same-type ordinals; two types; mixed soldier/HWP; destroyed excluded; assign/reclaim persistence; stale id rejected; soldier toggle regression |
| `companion_battlescape_ownership_test.exe` | **PASS** (handoff / Squad button policy) |
| `companion_soldier_control_publish_test.exe` | **PASS** (S2A publish; unrelated export replace warning) |

### Scenarios covered in `companion_battlescape_hwp_squad_test`

1. Single friendly HWP row (human default, position, `#1`).
2. Two identical types → `#1` / `#2` by engine id order.
3. Two different unit types → distinct type labels.
4. Mixed roster + HWP (soldiers listed before HWPs).
5. Tank destroyed → not listed; assign to missing id fails.
6. Assign Aster → reclaim Human → row flags match (`buildSquadOwnershipRows` reopen).
7. Soldier assign to Aster still uses campaign ownership.

**Not automated here:** full interactive inventory reopen animation; manual F6 publish with HWP assignments (covered by S2A gates).

---

## Remaining limitations

- **No HWP command execution** — relay `commandExecutionSupported: false`; UI is ownership-only.
- **Ordinal `#n`** is a UI convenience among same **type** on the current battlescape, not geoscape garage numbering.
- **Position** in the status column is snapshot at panel refresh (not live while panel open unless toggled/scroll refresh).
- **Language:** type strings need mod strings loaded; fallback in tests uses raw type id when `Language*` is null.
- **Runtime:** pinned `openxcom.exe` not updated (per mission constraints).

---

## Owner review checklist

- [ ] HWP rows appear on existing Squad screen with expected columns  
- [ ] Per-tank Human/Aster toggles persist for the battle and publish `hwp_assignments` when relay configured  
- [ ] Soldiers unchanged; no HWP ids in roster assignments  
- [ ] Destroyed tanks disappear from list  

**STOP** — await owner acceptance before commit/push/deploy.