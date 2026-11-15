# ASTER-M1-WP9-MEDIKIT-AUDIT-01

**Mode:** Read-only audit (no implementation, commits, deployment, or gameplay changes)
**Date:** 2026-11-15
**Work package:** M1-WP9 — Remote Medikit via tactical relay
**Stop:** Owner review before any implementation.

**Evidence legend**

| Tag | Meaning |
|-----|---------|
| **VERIFIED** | Confirmed from production ruleset + canonical `engine/OpenXcom/src` and `companion/m0-publish` |
| **INFERRED** | Reasonable conclusion from UI flow without dedicated Companion medikit command tests |
| **LIVE VALIDATION** | Requires controlled engine session (not run in this audit) |

---

## 1. Executive verdict

**Verdict: FEASIBLE — engine medikit behavior is mature, complete, and UI-local; Companion lacks observation affordances, schema, validation, and execution.**

Production OpenXcom in this fork implements medikit use as **`BA_USE` on a wielded `BT_MEDIKIT`**, automatic **target resolution** (same-tile unconscious ally or **facing-direction melee-range** `isWoundable()` unit), then **`MedikitState`** for **one TU-charged application per button** of **painkiller**, **stimulant**, or **heal** (per-body-part for heal). Ruleset defaults for XCOM1 `STR_MEDI_KIT` are **10 TU per application** (`flatRate: true`), with per-kit charge pools copied into `BattleItem` at creation.

The Companion relay stack **observes** `medikitCharges` on inventory rows and rules-reference **`medikit.{heal,painKiller,stimulant,tuUse,woundRecovery,…}`**, but has **no** `HEAL` / `STIMULANT` / `PAINKILLER` command types, **no** `actionCosts` row for `BA_USE`, **no** exported **`fatalWounds[]`**, and **no** `tryExecuteCompanionMedikit*`. Closest pattern: instantaneous commands (`DROP`, `RELOAD`) → `tryExecuteCompanion*` → terminal **`COMPLETED`** result → optional post-command snapshot.

**Recommended minimal schema:** three atomic command types — **`HEAL`**, **`STIMULANT`**, **`PAINKILLER`** — each performing **exactly one** engine-equivalent application (mirror one `MedikitState` button click), not a persistent medikit UI session.

**Primary risks:** (1) target geometry vs **carried unconscious** bodies (engine cannot treat inventory-carried units); (2) **heal** still depletes a heal charge when the selected body part has **zero** fatal wounds (**VERIFIED** engine quirk); (3) stale snapshot / binding race; (4) fair-play if validators echo hidden unit stats in reject messages.

---

## 2. Native engine — medikit workflow (**VERIFIED**)

### 2.1 End-to-end player flow

| Step | Behavior | Source |
|------|----------|--------|
| 1 | Actor holds medikit in **left or right hand**; action menu built from `_action->weapon` | `BattlescapeState` → `ActionMenuState` |
| 2 | Menu offers **`BA_USE`** / `STR_USE_MEDI_KIT` when `weapon->getBattleType() == BT_MEDIKIT` | `ActionMenuState` constructor (~137–139) |
| 3 | TU shown in menu = `getActionTUs(BA_USE, weapon)` → `RuleItem::getTUUse()` with percentage rule unless `flatRate` | `BattleUnit::getActionTUs` (`BA_USE` branch), `items.rul` |
| 4 | On **Use**: **no TU spent yet**; engine resolves **target unit** (see §2.3), opens `MedikitState`, or sets `STR_THERE_IS_NO_ONE_THERE` | `ActionMenuState::btnActionMenuItemClick` (~264–300) |
| 5 | In `MedikitState`, each **Painkiller / Stimulant / Heal** click spends **one** `action->TU` application worth via `spendTimeUnits(_tu)`, mutates target + item charges, may auto-close UI on revive | `MedikitState::on*Click` |
| 6 | Medikit UI respects **human vs AI-owned** orders via `warnIfHumanPlayerOrderDenied` on mutations | `MedikitState::_warnIfMedikitMutationDenied` → `BattlescapeGame::warnIfHumanPlayerOrderDenied` |
| 7 | After player-ordered `BA_USE` mutations, snapshot freshness may be noted on battle-state pop | `BattlescapeGame::popState` (`BA_USE` → `notePlayerTacticalMutationIfSnapshotConfigured`) |

**Not used for medikit:** map click targeting (`primaryAction` handles `BA_USE` only for **`BT_MINDPROBE`**, not medikit). Medikit never enters `_currentAction.targeting` cursor mode.

### 2.2 Items, charges, and ruleset (production XCOM1)

From `runtime/m0/bin/standard/xcom1/items.rul` (`STR_MEDI_KIT`):

| Rule field | Value | Runtime use |
|------------|-------|-------------|
| `battleType` | 6 (`BT_MEDIKIT`) | Menu + snapshots |
| `tuUse` | 10 | Per **application** (PK / stim / heal click) |
| `flatRate` | true | TU not scaled by soldier max TU |
| `painKiller` / `heal` / `stimulant` | 10 each | Initial **charge pools** on `BattleItem` |
| `woundRecovery` | 1 | Fatal wounds removed on heal click |
| `healthRecovery` | 3 | HP restored on heal click |
| `stunRecovery` | 4 | Stun reduced on stimulant click |
| `energyRecovery` | 10 | Energy restored on stimulant click |

`BattleItem` constructor copies ruleset pools into instance fields (`setHealQuantity`, etc.). Save YAML persists `painKiller` / `heal` / `stimulant` on kit items.

Pickup placement: `BattlescapeGame::takeItem` prefers **`STR_BACK_PACK`** for `BT_MEDIKIT` when picked from ground.

Environment gating: `SavedBattleGame::getItemUsable` — land/water equipment only (medikit not special-cased).

### 2.3 Target selection (engine-enforced)

On **Use Medi-kit** (`ActionMenuState`):

1. **Same position**, `STATUS_UNCONSCIOUS`, `isWoundable()`, **not the actor** — first match in `getUnits()` iteration order.
2. Else **`TileEngine::validMeleeRange`**(actor pos, facing, actor, target=0, dest, **preferEnemy=false**) — pick woundable unit on reached tile; when multiple friends in range, prefer **higher `getFatalWounds()`** sum (`TileEngine` ~2952–2954).
3. Target must `isWoundable()` on tile (`ActionMenuState` ~285–286).

`isWoundable()` (**VERIFIED**): `type == "SOLDIER"` OR (`Options::alienBleeding` && non-player original faction && armor size 1).

**Implications:**

- **No conscious self-treatment** on a lone tile — actor excluded from same-tile unconscious scan; melee pick requires **another** woundable unit (`INFERRED` from code paths).
- **No explicit faction check** on target — engine allows treating **woundable non-soldiers** (e.g. bleeding aliens if option enabled) when in range.
- **Carried unconscious** roster bodies (`carried_in_inventory` in Companion export) are **not** `BattleUnit` map occupants — **medikit cannot target them** until dropped (**INFERRED**, consistent with target loop).

Melee geometry follows standard **1-tile facing** melee validation (large units expand footprint). Medikit does **not** require LOS like mind probe.

### 2.4 `MedikitState` — three applications

Shared preconditions per click:

- `warnIfHumanPlayerOrderDenied` on actor (Companion AI-owned soldiers allowed when `humanPlayerOrderPermitted`).
- Respective charge pool **> 0** (else silent return — no TU spent).
- `actor->spendTimeUnits(_tu)` — on failure sets `STR_NOT_ENOUGH_TIME_UNITS` and closes UI.

#### HEAL (`onHealClick`)

- Calls `BattleUnit::heal(part, rule->getWoundRecovery(), rule->getHealthRecovery())`.
- Decrements `BattleItem` heal quantity **unconditionally** after spend (even if `heal()` no-ops).
- `BattleUnit::heal`: **no effect** if `part < 0 || part > 5 || !_fatalWounds[part]` (**VERIFIED**).
- Body part from `MedikitView::getSelectedPart()` (0–5 = `UnitBodyPart`); UI auto-selects **first part with `getFatalWound(i) > 0`** on open/update.
- **Revive:** if after heal target is unconscious but `stunlevel < health` and `health > 0`, sets target TU to 0, awards revive statistics once; **auto-closes** UI if `getFatalWounds() == 0` after heal revive path.

#### STIMULANT (`onStimulantClick`)

- `BattleUnit::stimulant(energyRecovery, stunRecovery)` → adds energy (capped at max stamina) + `healStun(s)`.
- Decrements stimulant charge; awards `appliedStimulant` stat.
- **Revive:** same unconscious/stun/health test as heal; on success sets TU 0, revive stats, **always** `onEndClick` (close UI).

#### PAINKILLER (`onPainKillerClick`)

- `BattleUnit::painKillers()` — raises morale toward 100 based on **lost HP** vs `_moraleRestored` tracking (`lostHealth = baseHealth - currentHealth`).
- Decrements painkiller charge; **does not** close UI automatically.

### 2.5 TU accounting

| Event | TU |
|-------|-----|
| Open medikit UI | **0** |
| Each PK / stim / heal click | `getActionTUs(BA_USE, item)` → **10** flat for stock kit |
| Failed spend | UI closes with warning string on action object |

Medikit mutations are **not** deferred via `popState` TU spend for targeting actions (unlike snap shot) — spend happens inside `MedikitState` (**VERIFIED** comment in `BattlescapeGame::popState` ~1191–1192).

### 2.6 Hand / slot requirements

- **Engine requires medikit as active hand item** for the action menu path (`_action->weapon`).
- Backpack/belt medikit requires **inventory equip to hand** first (player UI or future `INVENTORY_MOVE` + command).

---

## 3. Observation & AI decision surface

### 3.1 What the tactical snapshot exports today (**VERIFIED**)

| Data | Exported? | Location |
|------|-----------|----------|
| Medikit on soldier / ground | Yes | `hands`, `inventory`, `groundInventory`, `groundItems` |
| Per-kit charge pools | Yes | `medikitCharges.{heal,painKiller,stimulant}` on `BT_MEDIKIT` rows (`CompanionSnapshot::appendMedikitConsumables`) |
| Actor/target **current HP** | Yes (friendlies) | `tactical.units[].health` |
| Energy, morale, stun | Yes | `condition.{energy,maxEnergy,morale,stunLevel,conscious,...}` |
| **Fatal wounds per body part** | **No** | Not in `CompanionSnapshot` / `CompanionSnapshotUnitState` |
| **Max HP** | **No** on unit row | Only `health`; `maxEnergy` exported but not max health |
| `BA_USE` / medikit TU & usability | **No** | `appendHandActionCosts` exports throw/prime/fire/melee/**launch** only — **not** `BT_MEDIKIT` |
| Medikit effect magnitudes | Partial | Rules reference sidecar (`CompanionRulesReferenceExport`) not always bound in relay |
| Target adjacency / melee legality | Partial | Positions + facing; no dedicated “medikit range” hint |
| `isWoundable` / alien bleeding | **No** | Engine option + unit type |
| `_moraleRestored` (PK diminishing returns) | **No** | Hidden BattleUnit field |

**Node validation** (`tactical-publish.cjs`): `medikitCharges` schema enforced on medikit items (`BT_MEDIKIT = 6`).

**Equipment brief** (`tactical-equipment-brief.cjs`): classifies medikits and charge summary for AI markdown.

**`unitStateBrief`**: exceptions / readiness — **no** medikit-specific fields; use `tactical.units` + binding.

### 3.2 Missing fields for fair, reliable AI decisions

| Need | Observed / hidden | Recommendation |
|------|-------------------|----------------|
| Choose heal body part | Fatal wounds **hidden** | Export `fatalWounds: [6]` for **live roster friendlies** at minimum; optional `fatalWoundsTotal` |
| Know if heal will do anything | Hidden | Same export + validator warning (advisory) that engine still spends charge on no-op heal |
| PK value | Need current + max HP | Export `condition.maxHealth` or `baseHealth` on friendlies |
| TU cost per application | Hidden | Export `actionCosts` entry `id: "use"` / `actionType: BA_USE` when hand holds medikit |
| Effect sizes | Mod-dependent | Rules-reference `medikit.*` already supported — wire into `buildSidecarTacticalValidationOptions` hints |
| Target eligibility | Partial | **Advisory** composite: actor position + facing + target position (melee), unconscious co-tile; **engine authoritative** |
| Carried unconscious | `carried_in_inventory` | Document **not healable** until `DROP` / placement on map |
| Mind-controlled roster | `exceptions` | Actor not commandable; target policy = **mirror engine** unless owner forbids healing MC units |

### 3.3 Current vs required capability

| Capability | Native engine | Snapshot export | Node `tactical-command.cjs` | Engine `tryExecuteCompanion*` | Relay result / post-snapshot |
|------------|---------------|-----------------|------------------------------|------------------------------|------------------------------|
| Painkiller application | **VERIFIED** | Charges only | **MISSING** | **MISSING** | **MISSING** |
| Stimulant application | **VERIFIED** | Charges + condition | **MISSING** | **MISSING** | **MISSING** |
| Heal application | **VERIFIED** | Charges + HP (no wounds) | **MISSING** | **MISSING** | **MISSING** |
| Target pick | **VERIFIED** | Positions/status | **MISSING** explicit `target_unit_id` | **MISSING** | — |
| TU / charge verify (advisory) | **VERIFIED** | Partial TU data | **MISSING** | Engine-enforced | `tu_spent` pattern exists on other commands |
| Multi-apply in one UI session | **VERIFIED** | — | N/A (use **one command = one click**) | — | — |
| Test coverage | Stock OXC | `testWp8MedikitChargesAndCarriedWeight` | `tactical-equipment-brief`, inventory tests | No medikit harness | — |

---

## 4. Relay validation and execution layers

### 4.1 Current stack (medikit touchpoints)

| Layer | Medikit status | Notes |
|-------|----------------|-------|
| `tactical-command.cjs` | Unsupported `command_type` | Through `GUIDED_LAUNCH` + inventory; `parseTacticalCommand` throws |
| `command-binding.cjs` | No composers | Pattern: `composeDropCommand`, etc. |
| `command-relay-watcher.cjs` | Generic | `parseTacticalCommand` + `validateTacticalCommandAgainstSnapshotFile` |
| `CompanionCommandCore.cpp` | No parse helpers | Mirrors JSON for MOVE…DROP, GUIDED_LAUNCH |
| `CompanionCommandRuntime.cpp` | No `KIND_MEDIKIT*` | Instant commands complete synchronously in `tick` |
| `BattlescapeGame.cpp` | No `tryExecuteCompanionMedikit*` | Extend next to `tryExecuteCompanionDrop` pattern |
| `companion-relay-notify.cjs` / playbook | No medikit notifications | Optional `notificationFrom*Command` |
| Post-command snapshot | Works for any terminal result | `post-command-tactical-publish.cjs` |

### 4.2 Smallest compatible extension (**proposal — not implemented**)

**Principle:** One relay command = **one** `MedikitState` button action, **without** pushing UI states.

1. **Shared engine helper** (new): `resolveMedikitTarget(actor, facing, explicitTargetId?)` — extract logic from `ActionMenuState` + optional explicit ID match when provided and legal.
2. **Three executors** (or one with mode enum internal only):
   - `tryExecuteCompanionMedikitPainKiller`
   - `tryExecuteCompanionMedikitStimulant`
   - `tryExecuteCompanionMedikitHeal` (+ `bodyPart` 0–5)
3. Each executor: preflight (busy, actor, item in hand, charge > 0, target, TU), apply same mutations as `MedikitState`**,** call `CompanionRelayPublicationFreshnessCore::notePlayerTacticalMutationIfSnapshotConfigured`, return `tuSpent` + charge deltas.
4. **Node:** parse/validate/bind + snapshot cross-checks mirroring other WP8 commands.
5. **Runtime:** dispatch in `tick` like `DROP` → immediate `COMPLETED` or `REJECTED` JSON.

**Do not** push `MedikitState` on the state stack for Companion — headless + no SDL dependency.

**Alternative rejected for MVP:** Single `MEDIKIT_USE` with `mode` — fewer command types but worse symmetry with result consumers and playbook; owner requested **`HEAL` / `STIMULANT` / `PAINKILLER`** unless engine dictates otherwise — engine uses **three distinct effects**, so **three command types** is the minimal faithful mapping.

---

## 5. Proposed command contracts

### 5.1 Common binding fields

All commands use existing `schema_version: 1` + `command_id`, `actor_unit_id`, `snapshot_sha256`, `session_id`, `turn`, `state_version`.

**Actor:** Must appear in `commandBinding.player_soldiers` with matching binding (existing policy). AI-owned only in cooperative sessions.

**Item identification:**

```json
"medikit_battle_item_id": 42,
"active_hand": "STR_RIGHT_HAND"
```

- **Engine-enforced:** Item is `BT_MEDIKIT`, owned by actor, located in declared hand (battle item id must match snapshot hand row).
- **Advisory (Node):** `medikitCharges.* > 0` for the relevant mode; `actionCosts` `use` TU ≤ `timeUnits` when export present.

**Target:**

```json
"target_unit_id": 7
```

- **Engine-enforced:** Same rules as §2.3 when resolved with actor’s **current** facing and positions at execution time.
- **Advisory:** Target in snapshot as friendly roster, conscious/unconscious consistent with intent; visible HP/morale from export.

### 5.2 `PAINKILLER`

| Field | Required | Notes |
|-------|----------|-------|
| `command_type` | `"PAINKILLER"` | |
| `target_unit_id` | yes | |
| `medikit_battle_item_id` + `active_hand` | yes | |

**Effects:** One `painKillers()` + one PK charge + TU spend.

**Result `COMPLETED` fields (proposed):** `tu_spent`, `target_unit_id`, `morale_after` (if cheap), `medikit_charges_after.painKiller`, `snapshot_sha256_after` (existing pattern).

### 5.3 `STIMULANT`

Same shape as `PAINKILLER`; engine calls `stimulant(energyRecovery, stunRecovery)`.

**Post-check:** `condition.conscious` / `stunLevel` / `energy` for revival detection.

### 5.4 `HEAL`

| Field | Required | Notes |
|-------|----------|-------|
| `body_part` | yes | Integer 0–5 (`UnitBodyPart`) |

**Advisory:** `fatalWounds[body_part] > 0` when export available.

**Engine:** If part has no wound, **charge still consumed** if TU spent (**VERIFIED** quirk) — document in playbook.

**Revive:** Expose `target_revived: true` in result when engine would set TU 0 and exit UI after stim/heal revive paths.

### 5.5 Failure statuses

| Status | When |
|--------|------|
| `REJECTED` | Preflight failed before mutation (binding, busy, no target, no charge, insufficient TU, item not in hand, actor `isOut`) |
| `COMPLETED` | Mutation applied |
| `FAILED` | Reserved for unexpected internal error (mirror other commands) |

**Reject reasons:** Sanitized `public_reason` only — **no** hidden alien stats.

Duplicate delivery / stale snapshot: existing journal + binding mismatch → `REJECTED` (same as MOVE/DROP).

---

## 6. Edge cases

| Case | Engine-enforced | Advisory (Node / AI) |
|------|-----------------|----------------------|
| No woundable target in range | Reject / no UI (`STR_THERE_IS_NO_ONE_THERE`) | Pre-check positions + status |
| Target wrong faction / MC hostile | **Not rejected by engine** if woundable | Policy: limit `target_unit_id` to `originalFaction` player roster? **Owner decision** |
| Actor unconscious / panicking / berserk | `isOut` / status gates on companion actors | `unitStateBrief.exceptions` |
| Medikit in backpack | Cannot use until in hand | `INVENTORY_MOVE` first |
| Zero charges | Click no-op in UI; **no TU** | Validator rejects command |
| Heal on unwounded part | TU + charge spent, **no HP/wound change** | Warn in planning hint |
| Insufficient TU | UI closes, `STR_NOT_ENOUGH_TIME_UNITS` | `canAffordTu` when `use` exported |
| Battle busy (`isBusy`) | Companion move rejects | Same |
| Underwater / land equipment | `getItemUsable` string | Rules + depth on snapshot |
| Treatment interrupted | N/A for atomic command | — |
| Duplicate command id | Journal idempotency | **VERIFIED** relay pattern |
| Stale `snapshot_sha256` / `state_version` | Binding reject | **VERIFIED** |
| State changes after accept | Execution uses live battle | Fresh F6 before chained orders |
| Carried unconscious body | **Cannot target** | Require `DROP` to ground tile first |
| Self-treat conscious | **Not supported** by target resolver | Do not issue |
| Heal until auto-close | Player UI may continue after PK | One command = one click only |

---

## 7. Test plan (focused — no full mission)

### 7.1 C++ unit / fixture (`companion_*_test.exe`)

| Test | Assert |
|------|--------|
| `tryExecuteCompanionMedikitPainKiller` adjacent wounded soldier | Morale ↑, PK charge ↓, TU ↓ 10 |
| `tryExecuteCompanionMedikitStimulant` unconscious friend | Stun ↓, may revive, TU 0 on target |
| `tryExecuteCompanionMedikitHeal` part with wound | Wound ↓, HP ↑, heal charge ↓ |
| Heal on part with 0 wounds | Charge still ↓ (**regression guard for engine parity**) |
| No target in range | Reject before mutation |
| Medikit in backpack only | Reject |
| `humanPlayerOrderDenied` actor | Reject (human-controlled soldier) |
| Busy battle queue | Reject |

Reuse patterns from `companion_pickup_drop_engine_test.cpp`, `companion_inventory_move_engine_test.cpp`.

### 7.2 Snapshot serialization

- Extend or sibling to `testWp8MedikitChargesAndCarriedWeight`: optional `fatalWounds` + `use` action row when implemented.
- `companion_rules_reference_export_test.cpp` `testMedikitFields` already covers rules JSON.

### 7.3 Node (`companion/m0-publish/test`)

| Suite | Coverage |
|-------|----------|
| `tactical-command-m1-wp9-medikit.test.cjs` (new) | parse/validate/bind for three types |
| `command-binding` composers | `composeHealCommand`, etc. |
| `command-relay-watcher.test.cjs` | One happy path + binding reject |
| `tactical-equipment-brief.test.cjs` | Medikit classification unchanged |

### 7.4 Integration

- Bounded relay dry-run: draft → `validateTacticalCommandAgainstSnapshotFile` on fixture YAML with wounded soldier.
- **No** live GitHub + game session in CI.

---

## 8. Recommended implementation stages

| Stage | Scope | Files (primary) | Risk |
|-------|--------|-----------------|------|
| **S0 — Observation** | Export `fatalWounds[]`, `condition.maxHealth`, `actionCosts` `use` for medikit hands | `CompanionSnapshot.cpp`, `tactical-publish.cjs`, tests | Low — additive |
| **S1 — Node contract** | `HEAL`, `STIMULANT`, `PAINKILLER` parse/validate/hints | `tactical-command.cjs`, `command-binding.cjs`, tests | Low |
| **S2 — Engine core** | Target resolver + three `tryExecuteCompanionMedikit*` | `BattlescapeGame.{h,cpp}`, shared helper from `ActionMenuState` logic | **Med** — parity with UI |
| **S3 — Runtime relay** | `CompanionCommandCore` + `CompanionCommandRuntime` dispatch + result JSON | `CompanionCommandCore.cpp`, `CompanionCommandRuntime.cpp` | Med |
| **S4 — Feedback** | Optional `medikit-result` fields in result; playbook + `ASTER-LIVE-PLAYBOOK.md` | `companion-relay-notify.cjs`, docs | Low |
| **S5 — E2E** | Relay watcher fixture test + one engine harness happy path | tests only | Low |

**Dependencies:** S2 depends on S0 only for **AI quality**, not execution correctness. S1 can ship before S2 for dry-run publishing.

---

## 9. Unresolved questions (owner)

1. **Target policy:** Mirror engine (any `isWoundable()` in range) or restrict to **player roster** / exclude mind-controlled roster soldiers as targets?
2. **Observation:** Is exporting per-part `fatalWounds[]` acceptable for fair-play, or should AI only see aggregate `health` until post-command snapshot?
3. **Heal no-op:** Should Node **reject** heal when `fatalWounds[body_part]==0`, or allow engine-identical charge waste?
4. **Multi-kit:** Require `medikit_battle_item_id` always, or infer sole medikit in hand?
5. **Results:** Minimum terminal payload — charges only vs full `condition` block for target?

---

## 10. Acceptance criteria (for implementation PR)

1. AI-owned soldier with medikit in hand can **`PAINKILLER` / `STIMULANT` / `HEAL`** on a legal adjacent/co-tile target via GitHub relay with fresh binding.
2. **Engine parity:** TU spend, charge depletion, HP/wound/morale/stun effects match `MedikitState` for stock `STR_MEDI_KIT` rules.
3. **Preflight reject** leaves battle state unchanged (charges, TU, wounds).
4. Terminal `tactical-result.json` with `COMPLETED` or `REJECTED`; post-command snapshot optional refresh works.
5. Node dry-run validates binding + actor in `player_soldiers` + hand medikit id + snapshot charges (advisory).
6. No new hidden-unit data in reject messages.
7. Automated tests in §7 pass in CI without launching full mission.

---

## 11. Evidence index (canonical paths)

| Topic | File / symbol |
|-------|----------------|
| Medikit UI + mutations | `engine/OpenXcom/src/Battlescape/MedikitState.cpp` |
| Body part selection | `engine/OpenXcom/src/Battlescape/MedikitView.cpp` |
| Use action + target pick | `engine/OpenXcom/src/Battlescape/ActionMenuState.cpp` |
| TU cost `BA_USE` | `engine/OpenXcom/src/Savegame/BattleUnit.cpp` `getActionTUs` |
| Heal / PK / stim effects | `engine/OpenXcom/src/Savegame/BattleUnit.cpp` `heal`, `painKillers`, `stimulant` |
| Melee target priority | `engine/OpenXcom/src/Battlescape/TileEngine.cpp` `validMeleeRange` |
| Woundable units | `BattleUnit::isWoundable` |
| Charge export | `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` `appendMedikitConsumables` |
| Missing `BA_USE` in costs | `appendHandActionCosts` |
| Rules reference medikit | `CompanionRulesReferenceExport.cpp` |
| Production ruleset | `runtime/m0/bin/standard/xcom1/items.rul` `STR_MEDI_KIT` |
| Command allowlist | `companion/m0-publish/lib/tactical-command.cjs` |
| Prior WP8F note | `companion/m0-publish/docs/audits/ASTER-M1-TACTICAL-EQUIPMENT-AUDIT-01.md` §4.A |

---

**End of audit — awaiting owner review before implementation.**