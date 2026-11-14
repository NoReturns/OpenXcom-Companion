# ASTER-M1-PREFIRE-ACCURACY-ADVISORY-AUDIT-01

**Date:** 2026-11-14  
**Mode:** Read-only — no production changes, builds, commits, or pushes.  
**References:** [ASTER-M1-HIGH-MAINTENANCE-ACCURACY-AUDIT-01](./ASTER-M1-HIGH-MAINTENANCE-ACCURACY-AUDIT-01.md), [ASTER-M1-ACCURACY-PIN-DIFF-01](./ASTER-M1-ACCURACY-PIN-DIFF-01.md) (B8 incident; pin `cf82d030…` at fight time).

---

## Executive summary

Aster **can** warn about avoidable penalties (e.g. HM’s **grenade in off-hand** on a **two-handed** laser rifle) using **today’s** `hands`, `kneeled`, and `health` exports, but only after **replicating engine rules in advisory logic** or **exporting engine-computed `getFiringAccuracy` per mode**.

**Cannot** reliably promise “≥75% chance to strike the target” pre-fire without either **consuming battle RNG** (forbidden) or building a **full trajectory Monte Carlo / engine harness** (out of scope per owner constraints).

**Smallest reliable path:** Export **`displayedFiringAccuracy`** (integer, same as battlescape `getFiringAccuracy`) on each **usable firearm action** in `actionCosts`, plus a **`twoHandedPenaltyActive`** flag and **`firingSkill`** on friendly units. Layer a **qualitative `shotQuality` advisory** in Node (or briefing text) that explicitly separates **displayed accuracy**, **tight-cloud probability**, and **unknown true hit** — never a single misleading “hit %”.

---

## 1. Engine accuracy path (`getFiringAccuracy`)

**Location:** `engine/OpenXcom/src/Savegame/BattleUnit.cpp`

| Step | Rule |
|------|------|
| Weapon mode | `accuracySnap` / `accuracyAuto` / `accuracyAimed` from `RuleItem` |
| Base | `firing × weaponAcc / 100` (integer division) |
| Kneeling | `× 115 / 100` if kneeled |
| Two-handed | `× 80 / 100` if `twoHanded` **and** **both** `STR_RIGHT_HAND` and `STR_LEFT_HAND` occupied |
| Wounds / health | `× getAccuracyModifier(item) / 100` (`max(10, 25×health/maxHealth + 75 − 10×relevantFatalWounds)`) |

**Trajectory input:** `ProjectileFlyBState::createNewProjectile` passes `getFiringAccuracy(...) / 100.0` into `Projectile::applyAccuracy` (uniform spread + RNG — **not** determined by displayed % alone).

**Range dropoff** (`Projectile::applyAccuracy`): uses `dropoff`, `minRange`, default **`aimRange`** unless `Options::battleUFOExtenderAccuracy` (default **false**), then per-mode `autoRange`/`snapRange`. UI crosshair adjustment mirrors this only when extender accuracy is **on** (`Map.cpp`).

**HM lesson:** `firing 52`, laser auto `46`, two-hand penalty → displayed auto **18**, snap **26** ([ACCURACY-PIN-DIFF-01](./ASTER-M1-ACCURACY-PIN-DIFF-01.md)). Grenade in left hand is **visible** in export; penalty is **not** surfaced numerically.

---

## 2. Current snapshot and binding coverage

### 2.1 `tactical.units[]` (friendly roster on map)

| Field | Present? | Pre-fire use |
|-------|----------|--------------|
| `position`, `facing`, `kneeled`, `activeHand` | Yes | Bearing, kneel bonus |
| `health` | Yes | Health modifier (max health **not** exported) |
| `hands.right/left` (`itemType`, ammo, etc.) | Yes | **Infer** two-hand penalty if both hands non-empty and active weapon is `twoHanded` (needs mod metadata or engine flag) |
| `inventory` | Yes | Indirect (items not in hands don’t affect two-hand rule) |
| `actionCosts.hands.*.actions[]` | Yes | `id` (`auto`/`snap`/`aimed`), `tuCost`, `canAffordTu`, reservation advisories |
| `condition.morale`, `readiness` | Yes | Panic/berserk → **do not command** |
| `strength`, `encumbranceRatio` | Yes | TU only — **not** in `getFiringAccuracy` |
| `movementTuAdvisory`, per-action facing TU notes | Yes | Composite fire TU (existing `tu-composite-advisory.cjs`) |
| **`firing` skill** | **No** | Cannot recompute accuracy in Node without export |
| **Fatal wounds** | **No** | Modifier incomplete |
| **`displayedFiringAccuracy` per mode** | **No** | Core gap |
| **Line of fire to target** | **No** | Engine validates at execution (`STR_NO_LINE_OF_FIRE`) |
| **Range-adjusted accuracy to target** | **No** | Requires target tile + rules mirror |

### 2.2 `commandBinding.player_soldiers[]`

Minimal row: `id`, `position`, `kneeled`, `name`, `timeUnits` (or null if not command-applicable). **No** equipment or accuracy.

Authoring uses **`tactical.units`** + binding identity/TU freshness (`snapshot_sha256`, `state_version`).

### 2.3 Post-fire only today

| Source | Pre-fire? |
|--------|-----------|
| `eventLog.weapon_fired` (mode, target tile) | After shot |
| `perceptionLog` impacts | After shot |
| `tuReservation` on snapshot root | UI reserve state; not accuracy |

---

## 3. True hit probability vs displayed accuracy

| Concept | Definition | Pre-firecomputable? |
|---------|------------|---------------------|
| **Displayed firing accuracy** | `getFiringAccuracy` integer (HUD / extender crosshair base) | **Yes** — call at export |
| **Tight-cloud probability** | `P(RNG(0,100) < displayedAcc)` in `applyAccuracy` | **Yes** — advisory only; ≠ hitting a unit voxel |
| **True P(hit target)** | RNG + spread + extended line + `TileEngine::calculateLine` collisions | **No** — needs live RNG sequence or heavy simulation |

**Owner “≥75% genuine hit”:** Must **not** be mapped to `displayedAccuracy ≥ 75` or `firing ≥ 75`. With HM auto **18**, tight-cloud ≈ **18%**; three auto misses are unsurprising.

**Without RNG consumption:** Do **not** add a fake “hit %”. Use **qualitative `shotQuality`** (below).

---

## 4. Two-handed and equipment warnings (B8)

**Rule (engine):** two-handed firearm + **any** item in the other hand → **80%** penalty.

**Snapshot sufficiency:**

| Check | Data |
|-------|------|
| Both hands occupied | `hands.right` and `hands.left` non-null |
| Active weapon two-handed | `itemType` → rules lookup; today **not** in snapshot (only `battleType`) |

**Smallest fix:** Engine sets on export:

- `hands.<side>.twoHanded: true` from `RuleItem::isTwoHanded()`, and/or  
- `unit.fireAccuracyAdvisory.twoHandedPenaltyActive: true` when penalty **would** apply to weapon in active hand.

**Actionable Aster text (example):** “Two-handed laser rifle penalized while left hand holds STR_GRENADE — consider stow/drop/swap hand before routine shots.”

---

## 5. Target geometry, LOS, obstruction (fair play)

| Need | Available pre-fire | Limitation |
|------|-------------------|------------|
| Target tile (for directed fire) | Proposed by planner / `AUTO_SHOT` command | Must match binding map bounds |
| Hostile position (current) | `hostile-intelligence-consumer`: units with `facing` in snapshot | Absent units → no live tile |
| Terrain LOS to tile | `terrain` tiles `inLos` | **Tile** LOS ≠ **unit** line of fire |
| Walls/doors blocking shot | Partial via terrain semantics | No guaranteed projectile path export |
| Ctrl-fire valid tile | **Not** exported | Engine-only at click time |

**Recommendation:** Pre-fire advisory states **`lineOfFireUnknownUntilExecution: true`**. Optional **advisory** “target in observed LOS” from hostile intelligence **only** — never infer hidden aliens.

**Do not** ship a Node trajectory simulator unless owner opts in; engine already owns collision.

---

## 6. Proposed advisory contract (smallest reliable)

### 6.1 Engine export (authoritative numbers)

Add to **friendly** units at snapshot time (`CompanionSnapshot.cpp`), advisory-only:

```yaml
fireAccuracyAdvisory:
  schemaVersion: 1
  observationNote: >
    displayedFiringAccuracy matches BattleUnit::getFiringAccuracy at export.
    Not hit probability. Uniform spread and voxel collision apply at fire time.
  firingSkill: 52                    # getBaseStats()->firing
  accuracyModifierPercent: 100       # getAccuracyModifier(activeWeapon)
  kneeled: false
  activeHand: STR_RIGHT_HAND
  twoHandedPenaltyActive: true       # engine-evaluated for active weapon
  offHandOccupied: true
  offHandItemType: STR_GRENADE       # when penalty relevant
  modes:                             # active hand firearm only
    snap:  { displayedFiringAccuracy: 26, tuCost: 14 }
    auto:  { displayedFiringAccuracy: 18, tuCost: 20 }
    aimed: { displayedFiringAccuracy: 40, tuCost: 29 }
```

**Alternative minimal diff:** Add only `displayedFiringAccuracy` + `twoHandedPenaltyActive` on each `actionCosts.hands.*.actions[]` entry where `id ∈ {snap, auto, aimed}` (reuses existing structure; avoids new top-level block). Prefer **one** approach, not both.

### 6.2 Target-dependent overlay (Node, optional)

When Aster has **`actor.position`** and **`target` `{x,y,z}`** from a draft command:

1. Read `displayedFiringAccuracy` for chosen mode (from export).  
2. Compute **grid distance** (match engine: prefer documenting `TileEngine::distanceUnitToPositionSq` semantics or export distance on command validation only).  
3. If mirroring **default** rules (`battleUFOExtenderAccuracy: false`), apply **aimRange** dropoff only (same as `Projectile::applyAccuracy`, not extender crosshair).  
4. Emit **`rangeAdjustedDisplayedAccuracy`** or `rangePenaltyTiles` — still **not** hit probability.

Pattern: existing `tu-composite-advisory.cjs` (non-authoritative, explicit `advisory: true`).

### 6.3 Qualitative `shotQuality` (for “high-confidence when practical”)

**Do not** use threshold `displayedFiringAccuracy >= 75`.

Suggested bands (on **range-adjusted displayed** value, tight-cloud side channel in prose):

| `shotQuality` | Conditions (all advisory) | Aster posture |
|---------------|---------------------------|---------------|
| `high_displayed` | adjusted ≥ **60**, no `twoHandedPenaltyActive`, mode **snap/aimed** | Suitable for **routine** aimed fire if LOS acceptable |
| `routine_marginal` | adjusted **35–59** or auto with adjusted ≥ **45** | Prefer **snap/aimed** over auto; consider kneel |
| `low_displayed` | adjusted **&lt; 35** or auto **&lt; 25** | Avoid routine shots; reposition, kneel, clear off-hand, or aimed only if mission-critical |
| `penalty_equipment` | `twoHandedPenaltyActive` | **Equipment fix** before blaming RNG |
| `blocked_readiness` | panic/berserk/MC | No fire commands |

Separate field: **`tightCloudProbabilityEstimate`** = `(displayedFiringAccuracy + 1) / 101` — label **“deviation roll only”**.

**Mapping user intent:** “≥75% genuine hit” → treat as **operational policy**: only issue **routine** `SNAP_SHOT`/`AIMED_SHOT` when `shotQuality` is `high_displayed` **and** composite TU/LOS checks pass — **not** a numeric guarantee.

---

## 7. Pre-fire vs post-fire (B8 proposals)

| Concern | Pre-fire (this audit) | Post-fire ([HIGH-MAINTENANCE audit](./ASTER-M1-HIGH-MAINTENANCE-ACCURACY-AUDIT-01.md)) |
|---------|------------------------|----------------------------------------------------------------------------------------|
| Displayed accuracy | `fireAccuracyAdvisory` / `actionCosts` | `weapon_fired.displayedFiringAccuracy` (proposed) |
| Hit vs miss | `shotQuality` + policy | `impact_observed` / `visible_unit_hit` |
| Shot ↔ impact | N/A | `companionFireId` correlation |
| Two-hand lesson | **Pre** — avoid bad orders | **Post** — explain outcome |
| TU / facing | Existing composite TU hints | `tu_accounting` on result |

Pre-fire prevents HM-style **preventable** penalties; post-fire explains **RNG/spread** after the fact.

---

## 8. Smallest implementation plan (owner review; not executed)

| Priority | Change | Layer | Acceptance |
|----------|--------|-------|------------|
| **P0** | `displayedFiringAccuracy` + `twoHandedPenaltyActive` on firearm `actionCosts` entries | `CompanionSnapshot.cpp` | `companion_snapshot_serialization_test.cpp` fixture with rifle+grenade |
| **P0** | `firingSkill` + `accuracyModifierPercent` on friendly units (or inside advisory block) | Same | Validator optional fields in `tactical-publish.cjs` |
| **P1** | `lib/fire-accuracy-advisory.cjs`: `classifyShotQuality(unit, mode, target?)` | Node | Unit tests: HM B8 fixture → `penalty_equipment`, auto `low_displayed` |
| **P1** | `getAiBriefingInstructionsMarkdown()` paragraph: displayed vs hit vs tight-cloud | `tactical-briefing-ai-workflow.cjs` | Doc/snapshot test if present |
| **P2** | Range-adjusted overlay using rules catalog (`items.rul` mirror in Node or tiny export table) | Node | Only if extender-off dropoff needed for planning |
| **P2** | `weapon_fired` post-fire fields (correlation with pre-export) | Engine + publish | Golden B8 relay slice |

**Explicitly out of scope:** RNG hooks, accuracy buffs, hidden alien data, full trajectory sim, applying **75** to raw `firing`.

**Pin provenance:** Accuracy export code in current tree matches pins through `f8d27f4a` ([ACCURACY-PIN-DIFF-01](./ASTER-M1-ACCURACY-PIN-DIFF-01.md)); B8 fight likely **`cf82d030…`** — deploy records lack engine SHA. Treat advisory export as **forward-looking**; backtest HM using relay unit row + **inferred** penalty.

---

## 9. Test scope (existing + proposed)

| Test | Role |
|------|------|
| `companion_uniform_shooting_spread_test` | Spread math unchanged |
| `companion_inventory_move_engine_test` (`getInventoryDisplayedFiringAccuracy`) | **Not** equal to combat mode accuracy — don’t use inventory display for fire advisory |
| `tactical-composite-tu-m1.test.cjs` | Pattern for non-authoritative composite hints |
| **New (when implemented):** snapshot fixture HM hands → snap 26 / auto 18 with penalty | Regression for B8 |
| **New:** `classifyShotQuality` Node tests | Policy bands without fake hit % |
| `companion-perception-log-m1-reaction-attack-executed` **6/7** | Orthogonal; fix validator separately |

---

## 10. Limitations (mandatory)

1. **No true hit %** pre-fire without RNG or simulator.  
2. **`shotQuality` is policy on engine displayed accuracy**, not a guarantee.  
3. **Line of fire** remains engine-authoritative at execution.  
4. **`firing` from campaign save** was used in B8 audits when missing from export — **not** acceptable for live authoring; must export from engine.  
5. **Max health** not exported — full wound modifier may be approximate if health lowered without fatal wounds.  
6. **Incident binary** may be `cf82d030…`; equivalence to current source on accuracy paths is **high** on scoped files, **not** byte-proven.

---

## 11. Final recommendation

Ship **engine-exported `getFiringAccuracy` per mode** plus **`twoHandedPenaltyActive`** as the **smallest authoritative** pre-fire layer. Teach Aster (briefing + Node classifier) to:

1. **Block routine auto** when `twoHandedPenaltyActive` or `shotQuality === low_displayed`.  
2. Prefer **snap/aimed** and **kneel** when marginal.  
3. **Never** label displayed accuracy as “chance to hit.”  
4. Use post-fire logs to **calibrate intuition**, not to retroactively change pre-fire math.

That addresses the HM grenade case **before** orders and respects the no-RNG, no-buff, fair-play constraints.

---

*End of ASTER-M1-PREFIRE-ACCURACY-ADVISORY-AUDIT-01.*