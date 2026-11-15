# ASTER-M1-WP10-PSI-AMP-AUDIT-01

**Mode:** Read-only audit (no implementation, commits, deployment, or gameplay changes)
**Date:** 2026-11-15
**Work package:** M1-WP10 — Psi-Amp integration (`PSI_PANIC` / `PSI_MIND_CONTROL`)
**Stop:** Owner review before any implementation.
**Isolation:** WP9 medikit relay, `CompanionMedikitExecutionCore`, and medikit Node suites are **out of scope** for edits unless a shared helper change is unavoidable (prefer duplication in a new `CompanionPsiExecutionCore`).

**Evidence legend**

| Tag | Meaning |
|-----|---------|
| **VERIFIED** | Confirmed from production ruleset + canonical `engine/OpenXcom/src` and `companion/m0-publish` |
| **INFERRED** | Reasonable from UI flow; no Companion psi command harness yet |
| **LIVE VALIDATION** | Requires controlled engine session |

---

## 1. Executive verdict

**Verdict: FEASIBLE with bounded staging — panic substantially simpler than mind control; both must remain engine-authoritative (no Node RNG, no AI “psychic memory” targeting).**

OpenXcom implements psionics as **`BA_PANIC`** and **`BA_MINDCONTROL`** on a **`BT_PSIAMP`** weapon, resolved through **`PsiAttackBState`** (RNG attack vs defense, distance, MC defense bonus). Human targeting requires a **visible** enemy-unit click, optional **LOS** when `RuleItem::LOSRequired` (default **false** for `STR_PSI_AMP`).

The Companion stack already exports **faction / MC exceptions**, **`visibleHostileObservations`**, and **`classifyCurrentHostileObservation()`** for fair-play hostile IDs. It has **no** psi command types, **no** `actionCosts` rows for panic/MC, **no** `tryExecuteCompanionPsi*`, and **no** structured **success/failure** in relay results. WP9 medikit proves the **instant terminal command** pattern (`tryExecuteCompanion*` → `tu_spent` → optional post-command snapshot).

**Recommended order:** **S1 panic-only** (smaller blast radius), then **S2 mind control** (faction side effects + briefing refresh), with **separate test files** from WP9.

**Primary risks:** (1) **fair-play** if validators reference hidden unit ids/names in rejects; (2) **command authority** if MC’d aliens are mistaken for `player_soldiers`; (3) **weapon resolution** (`getSpecialWeapon(BT_PSIAMP)` vs hand-held psi amp — snapshot only exports **hands/inventory**); (4) reporting **failed psychic attacks that still consume TUs** without leaking unrevealed aliens.

---

## 2. Native engine — psi workflow (**VERIFIED**)

### 2.1 Action entry points

| Path | Behavior | Source |
|------|----------|--------|
| Action menu | When active hand weapon is `BT_PSIAMP` and `psiSkill > 0`, menu adds **Panic Unit** and **Mind Control** | `ActionMenuState` ~146–149 |
| Psi toolbar button | Sets targeting + `BA_PANIC` only, weapon = `getSpecialWeapon(BT_PSIAMP)` | `BattlescapeGame::psiButtonAction` ~1880–1897 |
| AI | Alien `AIModule::psiAction` — may target “known” units without current LOS when `LOSRequired` false | `AIModule.cpp` ~1884–1988 |

**Companion must mirror the human player contract**, not AI psychic memory (see §4).

Hand pickup from ground prefers **`STR_LEFT_HAND`** for `BT_PSIAMP` (`Inventory.cpp` ~587–588).

### 2.2 TU costs and spend timing

| Item | Value / rule | Source |
|------|----------------|--------|
| `STR_PSI_AMP` `tuUse` | **25** | `runtime/m0/bin/standard/xcom1/items.rul` |
| `flatRate` | **true** → not scaled by soldier max TU | same + `BattleUnit::getActionTUs` |
| Cost action types | `BA_PANIC`, `BA_MINDCONTROL` use `getTUUse()` | `BattleUnit::getActionTUs` ~1352–1355 |
| Menu click | Sets `targeting = true`; **TU not spent yet** | `ActionMenuState` ~334–337 |
| Map click | Builds `BattleAction`, pushes `PsiAttackBState` (no `UnitTurnBState` for psi) | `BattlescapeGame` ~1728–1747 |
| TU spend (player) | On state completion: if `action.targeting && !actionFailed`, **`spendTimeUnits(action.TU)`** | `BattlescapeGame::popState` ~1192–1196 |

**Failed psychic attacks still consume TUs** when the attack state runs to completion (**VERIFIED**): `PsiAttackBState::psiAttack()` does not refund TU on RNG failure; spend happens in `popState` after `PsiAttackBState` pops.

`PsiAttackBState::init` can abort early (invalid tile, no target unit, insufficient TU before animation) — in those cases the attack may not reach the `popState` spend path (**INFERRED** — treat as preflight reject in Companion executor).

### 2.3 Targeting and environment gates (human UI)

On map click for panic/MC (`BattlescapeGame` ~1728–1751):

1. Unit at tile must exist.
2. **`getFaction()` ≠ actor faction** (enemy from actor’s perspective).
3. **`getVisible()`** must be true.
4. If `weapon->getRules()->isLOSRequired()`: target must appear in **`actor->getVisibleUnits()`**.
5. Default `LOSRequired` for items is **false** (`RuleItem` ctor); `STR_PSI_AMP` ruleset does not set `LOSRequired: true` (**VERIFIED**).

No `canPanic` / `canBeMindControlled` unit-rule gates in this fork’s player click path (contrast Meridian OXC audit snapshots).

### 2.4 Resolution (`PsiAttackBState::psiAttack`)

**Formula (simplified):**

- `attackStrength = psiStrength * psiSkill / 50 - distance + RNG(0..55)`
- `defenseStrength = target.psiStrength + (psiSkill-based term or flat 10)`
- **Mind control:** `defenseStrength += 20`
- Success when `attackStrength > defenseStrength`

**Panic success:**

- Morale loss `(110 - bravery)` if positive
- `setMindControllerId(attacker)`
- Player-side infobox + `perceptionLog` event **`psi_morale_attack_observed`** (not the same as `*_panicked_observed` from morale collapse)
- Panic **status** (`STATUS_PANICKING`) follows morale engine elsewhere — success line does not directly set status in `PsiAttackBState`

**Mind control success:**

- `convertToFaction(attacker faction)` — **`originalFaction` preserved**
- FOV + lighting refresh; target `recoverTimeUnits()`, `allowReselect()`, `abortTurn()`
- `perceptionLog`: **`alien_mind_controlled_observed`** or **`soldier_mind_controlled_observed`** (MC’d roster)
- Optional **`autoEndBattle()`** if `Options::allowPsionicCapture`

**Failure:**

- Optional target psi-strength XP; **no failure infobox**
- TU still spent when attack animation path completes (§2.2)

### 2.5 MC persistence and release (**INFERRED** from engine model)

- Control is **`faction` flip** + **`mindControllerID`**; no separate “duration” counter in battle.
- Reversal is not handled in `PsiAttackBState` — typically death of controller, mission end, or new MC (**LIVE VALIDATION** for edge cases).
- Kill credit can route to controller via `getMindControllerId()` (`BattlescapeGame` MC kill credit path).

---

## 3. What the relay already has (reuse map)

| Capability | Status | Notes |
|------------|--------|-------|
| `commandBinding` + stale binding guards | **VERIFIED** | `command-binding.cjs`, `CompanionCommandCore` |
| Actor = `player_soldiers` AI-owned roster | **VERIFIED** | Excludes MC roster soldiers |
| Hostile target discovery (fair play) | **VERIFIED** | `visibleHostileObservations`, `classifyCurrentHostileObservation()`, hostile-intelligence consumer |
| MC state in briefing | **VERIFIED** | `mind_controlled_roster_soldier`, `xcom_controlled_hostile_unit` |
| Psych **history** | **VERIFIED** | `perceptionLog` `*_observed` — **not** live readiness |
| Hand item + `actionCosts` pattern | **Partial** | Medikit exports `BA_USE`; **no** panic/MC rows for `BT_PSIAMP` |
| Instant command execution pattern | **VERIFIED** | WP9 `tryExecuteCompanionMedikit*`, `buildMedikitResultJson` (`tu_spent`) |
| Map-targeted command pattern | **VERIFIED** | Directed fire / snap use `target` position — psi needs **unit on tile** |
| `psiSkill` on snapshot unit rows | **MISSING** | Not in `CompanionSnapshot.cpp` grep |
| Special weapon without inventory row | **MISSING** | `getSpecialWeapon(BT_PSIAMP)` not exported; hands/inventory only |

**WP10 should add new symbols/files**, not extend medikit parse tables, unless a truly shared JSON helper is neutral.

---

## 4. Fair-play target policy (Companion / Node advisory + engine enforce)

### 4.1 What the human engine allows

Visible hostile at clicked tile, opposing faction, optional LOS list membership.

### 4.2 What the Companion may use to **propose** targets

| Source | Allowed? |
|--------|----------|
| `tactical.units[]` with **`facing`** + `classifyCurrentHostileObservation` → **`confirmed_current_los`** | **Yes** — genuine hostile |
| Same with **`confirmed_current_los_xcom_controlled_hostile`** | **Policy** — not a panic/MC target (already friendly-controlled) |
| `visibleHostileObservations` | **Yes** — subset of above |
| `perceptionLog` / `unit_last_seen` | **No** — historical only |
| AI “exposed” / previously spotted but not visible | **No** — human player does not get this |
| Hidden unit ids from engine rejects | **No** — sanitize `public_reason` |

**Engine remains authoritative:** Node may advisory-reject `target_unit_id` not in the confirmed-visible hostile set at export time; execution must re-check visibility/faction/LOS on live battle.

### 4.3 Mind control and command authority (**VERIFIED** M1 policy)

| Unit state | `player_soldiers` | Companion may order? |
|------------|-------------------|----------------------|
| Roster soldier, player factions | Yes | Yes (if AI-owned) |
| Roster soldier, MC’d by aliens | No (`mind_controlled_roster_soldier`) | **No** |
| Alien, genuine hostile | No | **No** (target only) |
| Alien, MC’d to X-COM | No | **No** — `xcom_controlled_hostile_unit`; briefing marks asset, **not** `player_soldiers` |

**Do not** add MC’d aliens to `commandBinding.player_soldiers` without an explicit owner policy change — avoids granting orders on hidden or newly revealed enemies.

Post-success MC: next F6 should show faction flip + exception row; **still no** Companion fire/MOVE for that alien unless scope expands.

---

## 5. Failed attacks and relay reporting

### 5.1 Engine truth

| Outcome | TU consumed? | Structured signal today |
|---------|----------------|-------------------------|
| Preflight fail (no visible target, busy, no psi weapon) | No | UI warning / early `popState` |
| Attack attempted, RNG fail | **Yes** (25 TU typical) | None — silent |
| Attack success | **Yes** | Infobox + psych `perceptionLog` on **next export** |

### 5.2 Proposed terminal result (implementation — not built)

Mirror medikit `COMPLETED` with:

```json
{
  "status": "COMPLETED",
  "tu_spent": 25,
  "psycho_mode": "panic",
  "psychic_attack_succeeded": false,
  "target_unit_id": 1000042
}
```

- **`psychic_attack_succeeded`:** engine-determined only (never Node RNG).
- **Do not** include defender psi stats, morale, or hidden type strings in reject/result.
- On success, optional fields: `target_faction_after`, `observation_note` pointing to refresh F6 (MC).

**Gap:** `popState` mutation freshness switch does **not** list `BA_PANIC` / `BA_MINDCONTROL` — post-command snapshot may rely on explicit freshness call in new executor (**INFERRED** parity gap vs medikit mutations).

---

## 6. Proposed command shape (minimal, owner review)

### 6.1 Shared fields

Same binding envelope as WP9: `schema_version`, `command_id`, `actor_unit_id`, `snapshot_sha256`, `session_id`, `turn`, `state_version`.

**Actor:** `commandBinding.player_soldiers`, `psiSkill > 0` at execution (**engine**), not panicking/unconscious per existing readiness gates.

**Weapon (MVP recommendation):** Hand-equipped psi amp only — mirror medikit:

```json
"active_hand": "STR_LEFT_HAND",
"psi_amp_battle_item_id": 17
```

**Alternative deferred:** `getSpecialWeapon(BT_PSIAMP)` when no inventory row exists (snapshot gap today).

**Target:**

```json
"target_unit_id": 1000042,
"psycho_mode": "panic"
```

or `command_type`: `PSI_PANIC` | `PSI_MIND_CONTROL` (two types — clearer than medikit’s three).

### 6.2 Validation layers

| Layer | Panic | Mind control |
|-------|-------|----------------|
| Node advisory | Target in confirmed hostile LOS set; actor TU ≥ 25 advisory | Same + warn MC faction side effects |
| Engine preflight | Visible enemy, faction, LOS, hand weapon, TU, busy | Same |
| Engine execute | Call shared headless `psiAttack()` equivalent | Same + post-MC FOV (no reimplementation of formula) |

---

## 7. Recommended implementation stages (bounded)

| Stage | Scope | WP9 medikit touch? |
|-------|--------|---------------------|
| **S0** | This audit | None |
| **S1 — Node contract** | `PSI_PANIC` parse/validate/compose/dry-run | None |
| **S2a — Engine panic** | `CompanionPsiExecutionCore` + `tryExecuteCompanionPsiPanic` | None (new files) |
| **S2b — Engine MC** | `tryExecuteCompanionPsiMindControl` | None |
| **S3 — Runtime relay** | `CompanionCommandRuntime` dispatch + result JSON | Parallel to medikit branch only |
| **S4 — Observation optional** | Export `panic`/`mindcontrol` in `actionCosts` when hand holds psi amp | **Additive** snapshot only |
| **S5 — Focused tests** | C++ harness + Node fixtures | **New** `wp10` test names |

**Do not** run full-mission regression marathons; use `companion_*_test.exe` + Node `--test` slices like WP9 S4.

---

## 8. Focused test recommendations (no full mission)

| Test | Proves |
|------|--------|
| Node: reject `target_unit_id` absent from snapshot / no facing | Fair-play |
| Node: reject actor without psi amp in declared hand | Binding |
| Engine: panic success/fail both debit **25 TU** | TU parity |
| Engine: reject invisible hostile | Visibility |
| Engine: MC success flips `faction`, leaves `originalFaction` | Ownership |
| Snapshot brief: MC alien → `xcom_controlled_hostile_unit`, not in `visibleHostileObservations` | Briefing |
| Relay: `psychic_attack_succeeded: false` + `tu_spent: 25` | Failure reporting |
| Regression: WP9 medikit Node + engine suites unchanged | Isolation |

---

## 9. Unresolved questions (owner)

1. **MVP weapon rule:** Hand-held `psi_amp_battle_item_id` only, or also armor/special-weapon path?
2. **MC command scope:** Confirm MC’d aliens remain **non-commandable** forever in M1?
3. **Target_id vs tile:** Prefer `target_unit_id` (stronger fair-play) or `target_position` (matches UI click)?
4. **Export psi stats:** Export `psiSkill` on friendly roster rows for AI planning, or gate commands at engine only?
5. **Panic vs MC sequencing:** Single WP10 PR or panic-shipped-first with MC behind feature flag?

---

## 10. Evidence index (canonical paths)

| Topic | Location |
|-------|----------|
| Psi attack state | `engine/OpenXcom/src/Battlescape/PsiAttackBState.cpp` |
| Player targeting | `engine/OpenXcom/src/Battlescape/BattlescapeGame.cpp` (~1728, ~1192) |
| Menu / TU display | `engine/OpenXcom/src/Battlescape/ActionMenuState.cpp` |
| TU costs | `engine/OpenXcom/src/Savegame/BattleUnit.cpp` (`getActionTUs`) |
| Ruleset psi amp | `runtime/m0/bin/standard/xcom1/items.rul` (`STR_PSI_AMP`) |
| MC briefing | `companion/m0-publish/lib/unit-state-brief.cjs` |
| Hostile fair play | `companion/m0-publish/lib/hostile-intelligence-consumer.cjs` |
| Equipment audit (psi row) | `companion/m0-publish/docs/audits/ASTER-M1-TACTICAL-EQUIPMENT-AUDIT-01.md` §4.E |
| Medikit pattern (do not mix) | `engine/OpenXcom/src/Engine/CompanionMedikitExecutionCore.h` |
| Prior WP9 S0 pattern | `companion/m0-publish/docs/audits/ASTER-M1-WP9-MEDIKIT-AUDIT-01.md` |

---

## 11. What this audit did not do

- No code changes, builds, or live relay psi attempts.
- No edits to WP9 medikit tests or production medikit relay path.
- No Meridian / AI psychic-memory semantics as Companion policy.
