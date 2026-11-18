# ASTER-M1-MELEE-STUN-AUDIT-01

**Mode:** Read-only audit (no implementation, commits, deployment, or gameplay changes)  
**Date:** 2026-11-18  
**Scope:** Native OpenXcom melee / stun rod mechanics and Companion M1 tactical relay coverage  
**Stop:** Owner review before any implementation.

**Evidence legend**

| Tag | Meaning |
|-----|---------|
| **VERIFIED** | Confirmed from engine source, ruleset on disk, or automated tests in this repository |
| **INFERRED** | Reasonable conclusion from UI/engine flow without dedicated Companion melee command tests |
| **LIVE VALIDATION** | Requires controlled Battle Mode session (not run in this audit) |
| **UNCERTAIN** | Source suggests behavior but Companion-specific binding was not exercised |

---

## 1. Executive verdict

| Layer | Stun rod / player melee | General melee command path |
|-------|-------------------------|----------------------------|
| Native OpenXcom engine | **VERIFIED** complete (`BA_HIT`) | **VERIFIED** (same `BA_HIT`; alien built-ins via `getMeleeWeapon()`) |
| Tactical snapshot export | **PARTIAL** (`melee` in `actionCosts`; equipment `battleType`; no hostile stun state) | **PARTIAL** (same export row for any hand item with `tuMelee > 0`) |
| Node `tactical-command.cjs` | **MISSING** | **MISSING** |
| Engine inbox executor | **MISSING** | **MISSING** |
| Relay result / outcome fields | **MISSING** (no melee-specific `tactical-result.json`) | **MISSING** |

**Overall Companion relay verdict: PARTIAL** — observation and planning data exist for roster soldiers holding melee weapons; **remote execution is entirely absent**. Aster can **inventory-identify** a stun rod and read **TU affordance** from a fresh F6 export, but **cannot** lawfully order a stun/melee attack through the GitHub inbox today.

Stock XCOM1 player-usable melee in `items.rul`: **`STR_STUN_ROD` only** (`tuMelee` entries elsewhere are alien/HWP fixed weapons). Implementation should still use a **single generic `MELEE_ATTACK`** command keyed off `BA_HIT`, not a stun-rod-specific type.

---

## 2. Native OpenXcom melee mechanics (confirmed)

### 2.1 Action model and weapon taxonomy

| Topic | Finding | Source |
|-------|---------|--------|
| Battle action enum | `BA_HIT` is the sole melee strike action (alongside move, fire modes, throw, use, psi, launch) | `engine/OpenXcom/src/Battlescape/BattlescapeGame.h` L44 |
| Player menu activation | If held weapon has `getTUMelee() > 0`: `BT_MELEE` + `DT_STUN` → menu id `STR_STUN`; else `STR_HIT_MELEE`. Same `BA_HIT` either way | `ActionMenuState.cpp` L124–135 |
| Stun rod ruleset (XCOM1) | `battleType: 3` (`BT_MELEE`), `damageType: 6` (`DT_STUN`), `tuMelee: 30`, `accuracyMelee: 100`, `power: 65`, `twoHanded: true`, `skillApplied: false` | `runtime/m0/bin/standard/xcom1/items.rul` L628–646 |
| Other `tuMelee` items in stock ruleset | `REAPER_WEAPON`, `CHRYSSALID_WEAPON`, `SILACOID_WEAPON`, `ZOMBIE_WEAPON` — alien `fixedWeapon: true`, not player inventory | same file L1230–1340 |
| Weapon resolution at swing | Before `MeleeAttackBState`, engine sets `action.weapon = unit->getMeleeWeapon()` (right hand, then left, then `getSpecialWeapon(BT_MELEE)`) | `BattlescapeGame.cpp` L374–377; `BattleUnit.cpp` L3034–3051 |
| Alien melee pathway | **VERIFIED** same `BA_HIT` + `MeleeAttackBState`; AI chooses `getMeleeWeapon()` / `BT_MELEE` specials | `TileEngine.cpp` L1007–1018; `AIModule.cpp` (melee attack setup) |
| TU cost | `getActionTUs(BA_HIT, item)` → `item->getTUMelee()`, percentage of soldier base TU unless `flatRate` (stun rod uses percentage — 30% of base TU) | `BattleUnit.cpp` L1345–1367 |
| Accuracy / miss | Hit roll: `RNG::percent(getFiringAccuracy(BA_HIT, weapon))`; stun rod uses flat `accuracyMelee` (100) when `skillApplied: false` | `MeleeAttackBState.cpp` L242–243; `BattleUnit.cpp` L1514–1520 |
| Damage | Default `DT_STUN` + `getMeleePower()`; `BT_MELEE` + ammo rules override type/power; `isStrengthApplied` adds strength (alien bites) | `MeleeAttackBState.cpp` L264–278 |
| Unconsciousness | Stun-type damage raises `stunlevel` via `TileEngine::hit`; unit becomes unconscious when `stunlevel >= health` (standard OpenXcom damage pipeline) | `TileEngine.cpp` L1120–1204; stun handling in `BattleUnit::damage` (not re-audited line-by-line) |
| Reaction fire | Aliens/units may reaction-melee (`tryReaction` → `BA_HIT` → `MeleeAttackBState`); **player-initiated melee does not trigger reactions** (check commented out) | `TileEngine.cpp` L1049–1107; `MeleeAttackBState.cpp` L172–176 |
| Friendly targets | Melee range scan can pick units of either faction; medikit path uses `preferEnemy=false`. Combat melee menu pre-selects via `validMeleeRange(..., target=0)` which **prefers enemy faction** when multiple units qualify | `TileEngine.cpp` L2889–2969 |
| Facing / turning | Menu “Stun”: validates **current facing** only, fills `action.target`, does **not** set `targeting`. Full attack pipeline uses `UnitTurnBState` before melee when entered via `attack()` | `ActionMenuState.cpp` L311–332; `BattlescapeGame.cpp` L361–377 |
| Range geometry | One step along facing vector (8 directions); large units iterate footprint; elevation: may redirect target tile to above/below per floor holes (`aboveTargetTile` / `belowTargetTile`) | `TileEngine.cpp` L2889–2918 |
| Obstructions | `validMeleeRange` requires `canTargetUnit` voxel line (walls/doors) | `TileEngine.cpp` L2923–2927; `canTargetUnit` L544+ |
| Diagonal adjacency | **VERIFIED** — direction 0–7; `Projectile.cpp` notes melee range up to 2 tiles diagonal for large units | `TileEngine.cpp` L2891–2899; `Projectile.cpp` L342 |
| Interruption / fail | Invalid tile/unit, dead attacker → state pops without attack; insufficient TU → warning; melee **can miss** (no damage on failed roll) | `MeleeAttackBState.cpp` L59–88, L240–296; `ActionMenuState.cpp` L314–316 |
| TU spend timing | Menu-initiated: `spendTimeUnits` in `handleNonTargetAction` before pushing `MeleeAttackBState`. Fire-like paths spend after state completes when `targeting` (melee menu path is **non-targeting**) | `BattlescapeGame.cpp` L962–975, L1194–1198 |

**UNCERTAIN (document for executor design):** Companion should not invent a third TU path; executor must mirror whichever native entry path it uses (`handleNonTargetAction` vs `attack()` + `UnitTurnBState`) and respect `checkReservedTU` like `tryExecuteCompanionDirectedFire` (`BattlescapeGame.cpp` L2900–2907).

### 2.2 Player UX vs programmatic target

For human players choosing “Stun” / “Hit”:

1. `ActionMenuState` checks TU and `validMeleeRange(actor pos, actor direction, actor, 0, &target)`.
2. On success, `handleNonTargetAction` spends melee TU and pushes `MeleeAttackBState`.

For a relay command with **`target_unit_id`**, the engine must **turn toward** that unit and validate `validMeleeRange(..., specificTarget)` — the menu shortcut is insufficient. **INFERRED:** reuse `UnitTurnBState` + `MeleeAttackBState` with `action.target = target->getPosition()`, `playerOrdered = true`, matching the `attack()` branch (`BattlescapeGame.cpp` L361–377).

---

## 3. Current relay coverage (capability matrix)

| Capability | Native engine | Snapshot / export | Node command | Engine executor | Relay feedback | Automated tests |
|------------|---------------|-------------------|--------------|-----------------|----------------|-----------------|
| Identify `STR_STUN_ROD` in inventory | **VERIFIED** | **VERIFIED** (`inventory` / hands, `itemType`, `battleType` 3) | N/A (observe only) | — | — | Equipment brief tests |
| Know which hand holds rod | **VERIFIED** | **VERIFIED** (`hands.right` / `hands.left`) | **VERIFIED** via existing `INVENTORY_MOVE` / `PICKUP` / `DROP` only | **VERIFIED** inventory commands | — | Inventory relay tests |
| `melee` TU / usability row | **VERIFIED** | **VERIFIED** when `tuMelee > 0` on wielded item | — | — | — | Snapshot serialization tests |
| Select wielded hand for attack | **VERIFIED** UI | **VERIFIED** `active_hand` pattern on other commands | **MISSING** | **MISSING** | — | — |
| Validate visible hostile target | **VERIFIED** | **PARTIAL** (position + facing for visible hostiles; no health/stun) | **MISSING** (no melee validator) | **MISSING** | — | Psi validator pattern reusable |
| Order melee / stun attack | **VERIFIED** | — | **MISSING** | **MISSING** | — | — |
| Detect hit / miss | **VERIFIED** engine | **MISSING** in command result | — | — | **MISSING** | — |
| Detect unconscious hostile | **VERIFIED** engine | **MISSING** on hostile rows (no `condition`) | — | — | **PARTIAL** next F6 only | — |
| Detect dead hostile | **VERIFIED** | Unit absent from `units[]` after kill; **INFERRED** same for unconscious until next export | — | — | Perception / LOS policies | Hostile intel consumer |
| Reaction melee observed | **VERIFIED** | **PARTIAL** `perceptionLog` `reaction_attack_executed` with `actionType: melee` | — | — | Historical only | `companion-perception-log-m1-reaction-attack-executed.test.cjs` |

### 3.1 Relay path trace (today)

| Step | Melee / stun status | Primary files |
|------|---------------------|---------------|
| 1. Snapshot generation | Exports `actionCosts.hands.*.actions[]` id `"melee"` (`actionType` 8 = `BA_HIT`) when `rules->getTUMelee() > 0` | `CompanionSnapshot.cpp` L727–780, L703–724 |
| 2. Publish / validate snapshot | `ALLOWED_ACTION_IDS` includes `'melee'` | `tactical-publish.cjs` L210, L304 |
| 3. Equipment brief | Classifies `BT_MELEE` as category `melee` | `tactical-equipment-brief.cjs` L31, L98–99 |
| 4. Command parse | `parseTacticalCommand` → **`unsupported command_type`** for any melee type | `tactical-command.cjs` L1224–1283 |
| 5. Command compose | No `composeMeleeCommand` | `command-binding.cjs` (fire/medikit/psi only) |
| 6. CLI dry-run / publish | Cannot validate unpublished type | `publish-tactical-command-once.cjs` |
| 7. Engine inbox | `CompanionCommandRuntime.cpp` dispatches MOVE, fire, throw, launch, inventory, medikit, psi — **no melee branch** | `CompanionCommandRuntime.cpp` (e.g. L58–64 kinds; medikit ~5332+) |
| 8. Engine parse JSON | `CompanionCommandCore` — medikit/psi parsers; **no melee struct** | `CompanionCommandCore.h` |
| 9. Execution | **No** `tryExecuteCompanionMelee*` in `BattlescapeGame` | `BattlescapeGame.h` / `.cpp` |
| 10. Result / journal | Medikit/psi result templates exist; **none for melee** | `CompanionCommandRuntime.cpp` |
| 11. Fresh snapshot after mutation | `BA_HIT` listed in player mutation switch → would publish after successful melee | `BattlescapeGame.cpp` L1175 |

**Reusable infrastructure (VERIFIED):**

- Binding envelope (`snapshot_sha256`, `session_id`, `turn`, `state_version`) — all command families.
- `active_hand` + hand equipment resolution — directed fire, grenades, medikit, psi.
- `validatePsiHostileTargetAgainstSnapshot` / `isGenuineHostileUnit` — fair-play hostile targeting (psi).
- `tryExecuteCompanionDirectedFire` — busy guard, authority, TU preflight pattern.
- `tryExecuteCompanionMedikitShared` / `tryExecuteCompanionPsiAmpAttack` — weapon-in-hand validation pattern.
- Animated completion — `KIND_THROW` / `KIND_GUIDED_LAUNCH` in `CompanionCommandRuntime.cpp` (melee likely similar, not instant like medikit).

---

## 4. Stun rod–specific audit (Aster today)

| Question | Answer | Evidence |
|----------|--------|----------|
| Identify stun rod in inventory? | **Yes** (export) | `itemType: STR_STUN_ROD`, `battleType: 3` in tactical units |
| Which hand? | **Yes** (export) | Hand slots in `appendFriendlyEquipment` |
| Equip via relay? | **Yes** (inventory commands only) | `INVENTORY_MOVE`, `PICKUP`, `DROP` — stun rod uses normal `BT_MELEE` pickup rules (`BattlescapeGame.cpp` L2341–2348) |
| Valid targets in range? | **PARTIAL** — Aster can compute adjacency from actor `facing` + hostile `position`, but Node has **no** `validMeleeRange` mirror; elevation/obstruction may diverge | `TileEngine.cpp` L2889+; medikit S1 advisory-only geometry |
| TU cost? | **Yes** when rod wielded: `actionCosts` row `melee` (`tuCost`, `canAffordTu`, `usable`) | `CompanionSnapshot.cpp` L777–779 |
| Execute stun attack? | **No** | No command type |
| Know attack succeeded? | **No** command result; **INFERRED** TU drop + later snapshot only | — |
| Unconscious vs dead enemy? | **Hostile export lacks** `condition.conscious`, `stunLevel`, `readiness` — only `kneeled`, `facing` on visible hostiles | `CompanionSnapshotUnitState.cpp` L284–300 |
| Enemy still able to act? | **INFERRED** from next snapshot: unit missing = dead; visible unit with unchanged posture ≠ proof of stun; **LIVE VALIDATION** needed for sprite/status cues | Fair-play hostile policy |
| Outcome via subsequent snapshots? | **PARTIAL** — new F6 after mutation; no guaranteed stun metadata on aliens | M1-WP5 hostile intel rules |

**Fair-play note:** Melee validation must not leak hidden unit stats in reject messages (mirror psi/medikit). Targeting should require `confirmed_current_los` hostile observation at export, with engine re-checking visibility/faction at execution (psi pattern).

---

## 5. General melee support

| Weapon class | Same `BA_HIT`? | Player `player_soldiers` scope? | Distinct command needed? |
|--------------|----------------|----------------------------------|---------------------------|
| Stun rod (`STR_STUN_ROD`) | Yes | Yes | No — generic `MELEE_ATTACK` |
| Hypothetical mod `BT_MELEE` firearms | Yes | Yes if held | No — damage/TU from ruleset |
| Alien built-in melee | Yes | **No** (not roster soldiers) | N/A for Aster M1 actor model |

**VERIFIED:** UI does not split command types per melee item; only menu label differs (`STR_STUN` vs `STR_HIT_MELEE`). One relay `command_type` with engine `BA_HIT` is sufficient.

**INFERRED:** Lethal melee mods using `DT_MELEE` / non-stun share pathway; outcome fields should report damage class generically without special-casing stun rod in the command schema.

---

## 6. Validation and safety (failure behaviour)

| Condition | Recommended Node (advisory / hard) | Engine (authoritative) |
|-----------|----------------------------------|-------------------------|
| Insufficient TUs | Hard if `melee.canAffordTu === false` | `checkReservedTU`, `spendTimeUnits` |
| No melee weapon / wrong item | Hard: hand must be `BT_MELEE` with `melee` action row | `getMeleeWeapon()` / weapon id match |
| Invalid hand | Hard | Slot / owner checks |
| Target too far / wrong Z | Advisory (geometry) | `validMeleeRange` + `canTargetUnit` |
| Obstructed | Advisory | `canTargetUnit` |
| Target not in snapshot | Hard | Unit id lookup |
| Target not genuine hostile | Hard (psi pattern) | `companionIsGenuineHostileTarget` (`BattlescapeGame.cpp` L4707–4711) |
| Target not visible (fair-play) | Hard at export; engine revalidates | `getVisible()` / visible-unit list |
| Stale binding | Hard | `CompanionCommandCore` binding validators |
| Wrong actor ownership | Hard | `commandBinding.player_soldiers`, tactical AI ids |
| Battle busy | — | `isBusy()` |
| Missed attack | — | **No reject** — report in result / post-snapshot |
| Friendly fire stun | **Policy:** allow iff engine allows; Node may warn | `validMeleeRange` faction rules |

Existing fire, psi, medikit, and movement commands must remain unchanged (no shared parser edits beyond additive dispatch).

---

## 7. Recommended design — minimal `MELEE_ATTACK` contract

**Do not implement in this audit.** Proposal follows medikit (S1→S3) and psi (S1→S2a) patterns.

### 7.1 Command payload (`schema_version: 1`)

```json
{
  "command_type": "MELEE_ATTACK",
  "command_id": "<uuid>",
  "actor_unit_id": 1,
  "target_unit_id": 1000042,
  "melee_weapon_battle_item_id": 515,
  "active_hand": "STR_RIGHT_HAND",
  "snapshot_sha256": "<64-hex>",
  "session_id": "<eventLog.sessionId>",
  "turn": 3,
  "state_version": 42
}
```

| Field | Purpose |
|-------|---------|
| `melee_weapon_battle_item_id` | Disambiguate hand item (stun rod vs future melee); must match wielded `BT_MELEE` |
| `target_unit_id` | Prefer over raw tile — aligns with `PSI_*` / medikit and fair-play hostile checks |
| `active_hand` | Parity with other weapon commands; required when two-handed rules matter |

**Alternative rejected:** `target: {x,y,z}` without unit id — worse for fair-play and stale-target detection.

### 7.2 Snapshot fields required

| Field | Already exported? | Notes |
|-------|-------------------|-------|
| Actor `actionCosts.hands.*.actions[id=melee]` | Yes when wielding | `usable`, `tuCost`, `canAffordTu` |
| Actor `facing` | Yes | Planning adjacency |
| Hostile `position`, `facing`, LOS classification | Partial | Use `classifyCurrentHostileObservation` |
| Target `condition.*` for hostiles | **No** | Outcome must use result object + later export |
| Rules reference `STR_STUN_ROD` | Yes (`companion-rules-reference.json`) | Planning damage type stun — not for hidden targets |

Optional **post-implementation** export (owner decision): `meleeAccuracyAdvisory` on friendly actors only — **not required** for minimal contract.

### 7.3 Engine execution binding

Add (names illustrative):

- `CompanionCommandCore::parseMeleeAttackCommandJson`
- `BattlescapeGame::tryExecuteCompanionMeleeAttack` → `CompanionMeleeExecutionCore::execute` (new file mirroring `CompanionPsiExecutionCore.cpp`)
- Build `BattleAction`: `type = BA_HIT`, `weapon` = validated hand item, `target` = target position, `playerOrdered = true`
- Push `UnitTurnBState` then `MeleeAttackBState` (same as `BattlescapeGame::attack` L373–377)
- Set `g_active.kind = KIND_MELEE` in runtime; terminal when battle stack idle (pattern `KIND_THROW`)

**Critical:** Call `notePlayerTacticalMutationIfSnapshotConfigured` on completed player melee (already in mutation switch for `BA_HIT`).

### 7.4 Success / failure acknowledgement

Recommend medikit-style synchronous result **after** animation completes (like THROW, not like one-click medikit):

```json
{
  "status": "COMPLETED",
  "command_type": "MELEE_ATTACK",
  "tu_spent": 30,
  "melee_hit": true,
  "target_unit_id": 1000042,
  "target_incapacitated": true,
  "target_status": "unconscious"
}
```

| Outcome | `melee_hit` | `target_incapacitated` | Notes |
|---------|-------------|------------------------|-------|
| Miss | `false` | `false` | Still spend TU (native menu path) |
| Hit, no stun KO | `true` | `false` | Stun rod may accumulate stun |
| Unconscious | `true` | `true` | `target_status: unconscious` |
| Dead | `true` | `true` | `target_status: dead` (lethal melee mods) |

Sanitize result: no hidden unit types; do not expose pre-existing unrevealed stats.

**UNCERTAIN:** Whether first slice can return `melee_hit` without reading `MeleeAttackBState::resolveHit` internals — may require small companion hook in `MeleeAttackBState` (implementation detail for S2a).

---

## 8. Missing functionality (exact gaps)

| Gap | Files to extend |
|-----|-----------------|
| `COMMAND_TYPE_MELEE_ATTACK` + parse/validate/compose | `companion/m0-publish/lib/tactical-command.cjs`, `command-binding.cjs` |
| `validateTacticalCommandAgainstSnapshot` dispatch | `tactical-command.cjs` L1640+ |
| Relay publish tests | `companion/m0-publish/test/tactical-command-m1-*-melee-*.test.cjs` (new) |
| JSON parse / validate | `engine/OpenXcom/src/Engine/CompanionCommandCore.h`, `.cpp` |
| Inbox dispatch + result templates | `CompanionCommandRuntime.cpp` |
| `ActiveCommand::KIND_MELEE` lifecycle | `CompanionCommandRuntime.cpp` |
| Executor | `BattlescapeGame.h`, `BattlescapeGame.cpp`, new `CompanionMeleeExecutionCore.{h,cpp}` |
| Harness tests | `companion_melee_engine_test.cpp`, `companion_command_test.cpp` |
| Hostile stun visibility (optional) | `CompanionSnapshotUnitState.cpp` — **policy decision**, not blocker for MVP |

No changes needed to `MeleeAttackBState` damage rules for relay support (executor-only).

---

## 9. Implementation stages (independent verification)

| Stage | Deliverable | Verification |
|-------|-------------|--------------|
| **S0** | This audit | Owner sign-off |
| **S1** | Node `MELEE_ATTACK` parse + `validateMeleeAgainstSnapshot` + `composeMeleeAttackCommand` | `node --test …-melee-s1.test.cjs` |
| **S2a** | C++ parse/validate/preflight + `tryExecuteCompanionMeleeAttack` + execution core | `companion_melee_engine_test.exe` |
| **S2b** | `companion_command_test.cpp` parse/busy/binding cases | MSBuild test target |
| **S3** | Wire `parseTacticalCommand`, runtime dispatch, journal/result | `…-melee-s3-relay.test.cjs` + `companion_command_test.exe` |
| **S4** | Live Battle Mode smoke (stun rod on visible alien) | Owner LIVE VALIDATION checklist below |

Order matches prior WP8F-B recommendation (`ASTER-M1-TACTICAL-EQUIPMENT-AUDIT-01.md` §8): melee before broader specialist polish.

---

## 10. Regression risks

| Risk | Mitigation |
|------|------------|
| TU reservation / spend double-count | Unit test: melee TU matches native menu; compare before/after `timeUnits` on actor |
| Enabling player reaction melee | Do not uncomment `MeleeAttackBState` reaction block |
| Treating `melee` perception as player attack telemetry | Only `reaction_attack_executed` today — do not infer player stuns from perception |
| Psi/medikit/fire validation drift | Additive command dispatch only; run existing wp9/wp10 test suites |
| Fair-play leak on reject | Generic reasons; no alien stats in sidecar |
| Hidden target via stale `target_unit_id` | Engine visibility + genuine-hostile checks at execution |
| Two-handed stun rod penalty | Export does not flag melee accuracy on non-firearms — engine authoritative for hit % |

---

## 11. Testing requirements (focused)

| Case | Layer |
|------|-------|
| Successful stun rod attack on visible hostile | S2a engine + S4 live |
| Lethal `BT_MELEE` mod (if fixture added) | S2a |
| Out of range / wrong elevation | S2a + Node advisory |
| Insufficient TUs | S1 hard reject + S2a |
| Wrong hand / non-melee item | S1 + S2a |
| Obstructed `canTargetUnit` | S2a map fixture |
| Miss (RNG) | S2a seeded harness **or LIVE VALIDATION** |
| Unconscious outcome | S2a assert `STATUS_UNCONSCIOUS` + result JSON |
| Dead outcome (lethal melee) | Optional mod fixture |
| Invalid actor / non-`player_soldiers` | S1 + runtime |
| Stale snapshot / `inbox_occupied` | Existing relay tests pattern |
| Busy battle (`BATTLE_BUSY`) | `companion_command_test.cpp` |
| Terminal `COMPLETED` / `REJECTED` / recovery F6 | S3 + live |

No full-mission automation required.

---

## 12. Live acceptance procedure (owner + Aster)

1. Deploy build containing **S3** melee relay (after implementation approval).
2. Load cooperative mission; assign stun rod to an AI-owned soldier via inventory commands if needed.
3. F6 export — confirm `actionCosts` includes `melee` on wielding hand (`tuCost` ≈ 30% base TU for stock rod).
4. Publish `MELEE_ATTACK` against a **visible, genuine hostile** from `units[]` with current LOS classification (not MC roster, not neutral).
5. Confirm `tactical-result.json` → `COMPLETED`, `tu_spent` > 0, `melee_hit` present.
6. F6 again — confirm actor TU decreased; target either still visible or absent if killed; for stun, **LIVE VALIDATION** of unconscious sprite / no reactions.
7. Negative checks: out-of-range target → `REJECTED` without TU mutation; stale `state_version` → hard fail; human-owned soldier → compose/runtime reject.

---

## 13. Related audits and drift

- `ASTER-M1-TACTICAL-EQUIPMENT-AUDIT-01.md` §4.B / §6.B — first PARTIAL matrix; still accurate; medikit/psi rows there are **stale** (those commands are now wired).
- `ASTER-M1-WP9-MEDIKIT-S3-RELAY-01.md` — reference relay integration pattern.
- `ASTER-M1-WP10-PSI-AMP-S1-CONTRACT-01.md` — reference hostile `target_unit_id` validation.

---

## 14. Uncertainties (explicit)

1. **Post-stun hostile observation** — without `condition` on hostile units, Aster may need result JSON `target_status` or owner-approved limited export for visible incapacitated hostiles.
2. **Exact TU timing** with turn-in-place before swing — executor must be validated against in-game Stun menu for same soldier/TU pool (**LIVE VALIDATION**).
3. **Friendly stun** — engine allows in some geometries; policy whether Aster may target neutrals/friendlies is **owner decision** (default: genuine-hostile-only for parity with psi).
4. **`melee_hit` instrumentation** — may need companion hook in `MeleeAttackBState::resolveHit` (implementation-time).

---

**Stop condition met:** audit and recommendations only — no production code, commits, or deployment in this pass.