# ASTER-M1-HWP-S2B-01A — Stable HWP tank numbering

**Status:** Corrected (local only — no commit, push, or runtime deploy)  
**Parent:** ASTER-M1-HWP-S2B squad UI  
**Issue:** S2B audit described ordinals as counting **surviving** same-type tanks — that would renumber after casualties.

---

## Step 1 — Inspection

### Prior behavior (defective)

`friendlyHwpDisplayName` received `collectFriendlyHwps()` output, which only includes `isDeployedFriendlyHwpUnit()` entries (`!isOut()`).

Ordinal = `1 + count(live peers of same type with lower id)`.

**Effect:** With tanks `1000001` (#1) and `1000002` (#2), destroying #1 removed it from the peer set, so #2 became `#1` on the next squad row build.

Destroyed HWPs **remain** in `SavedBattleGame::getUnits()` (not removed on death); only the squad **listing** excluded them. The ordinal logic ignored those rows.

### Required behavior

- Display `#n` fixed for the battle once established at deployment.
- Casualties do not renumber survivors.
- Types numbered independently.
- Assign/toggle still uses engine unit id only.

---

## Step 2 — Correction (minimal)

| Addition | Purpose |
|----------|---------|
| `isBattleScopedFriendlyHwpUnit()` | Player HWP identity on this battle: original player faction, no geoscape soldier, `id ≥ MAX_SOLDIER_ID`, **includes destroyed** (`isOut()` allowed). |
| `friendlyHwpStableOrdinal()` | Count peers via full `battle->getUnits()` using battle-scoped identity + same `getType()` + lower `getId()`. |
| `friendlyHwpDisplayName()` | Uses battle-wide ordinal; **not** the live-only HWP vector. |

**Unchanged:** Squad rows still list only live HWPs (`isDeployedFriendlyHwpUnit`). No new persistence, no custom names, no cross-battle ordinal carryover.

If a unit were removed from `getUnits()` entirely, ordinal could still drift; engine retains dead units in the collection for this mission.

---

## Files changed

| File | Change |
|------|--------|
| `Engine/CompanionBattlescapeOwnershipCore.h` | `isBattleScopedFriendlyHwpUnit()` |
| `Engine/CompanionBattlescapeOwnershipCore.cpp` | Stable ordinal from full battle unit list |
| `test/companion_battlescape_hwp_squad_test.cpp` | `testStableOrdinalSurvivesEarlierCasualty` |

---

## Step 3 — Regression tests

**Target:** `companion_battlescape_hwp_squad_test.exe` (Release, `build-s4j-rc`)

| Scenario | Result |
|----------|--------|
| Two identical tanks → #1 / #2 by id | PASS (existing) |
| Destroy #1 → rebuild rows → survivor still **#2** | PASS (**new**) |
| Reopen/rebuild + assign Aster on `1000002` → still **#2**, `CONTROL_AI` | PASS (**new**) |
| Mixed soldier/HWP, two types, stale id, soldier toggle | PASS (existing) |

Command run (post-fix, Release `build-s4j-rc`):

```
companion_battlescape_hwp_squad_test.exe
→ companion_battlescape_hwp_squad_test: all tests passed.
```

(Test harness keeps each `buildSquadOwnershipRows` result in a named vector before `findRow` to avoid dangling references.)

---

## Audit correction

**S2B report** text implying ordinals count **surviving** tanks was accurate for the **shipped S2B code** but **incorrect for intended product behavior**. After 01A:

- **Listing:** live friendly HWPs only.
- **Label `#n`:** all battle-scoped friendly HWPs of that type still in `getUnits()`, including destroyed.

---

## Limitations

- Ordinals reset on a **new** tactical battle (battle-scoped membership only).
- Alien/neutral vehicles never affect player HWP ordinals.
- Mind-controlled roster soldiers are unrelated; HWP rows use the HWP identity rules above.

**STOP** — owner review.