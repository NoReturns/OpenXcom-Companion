# ASTER-M1-TACTICAL-COMMAND-COVERAGE-AUDIT-01

**Mode:** Read-only audit (no implementation or deployment)  
**Date:** 2026-11-18  
**Scope:** Complete Aster tactical command surface vs native OpenXcom  
**Evidence:** Engine source (`engine/OpenXcom/src`), Node relay (`companion/m0-publish/lib`), prior live-deploy audits, Release regression gates run today

**Status legend (matrix columns)**

| Status | Meaning |
|--------|---------|
| **COMPLETE** | Layer supports the operation for AI-bound roster soldiers with fair-play constraints |
| **PARTIAL** | Implemented but incomplete snapshot, validation, feedback, live proof, or edge coverage |
| **MISSING** | No intentional Companion support at this layer |
| **NOT APPLICABLE** | Native exists but outside Aster command authority (human-only, UI-only, or non-cooperative unit class) |
| **UNVERIFIED** | Source suggests support; no automated or live evidence in-repo |

---

## B5 preview — Executive verdict

| Area | Status |
|------|--------|
| **Audit completeness** | **COMPLETE** (read-only; no code changes) |
| **Companion tactical interface feature-complete?** | **NO** — melee live acceptance pending; several native affordances intentionally absent |

**Proven in live Battle Mode (owner drills / deploy audits):** MOVE, KNEEL, STAND, SNAP/AUTO/AIMED fire, PRIME/THROW grenades, GUIDED_LAUNCH, inventory (RELOAD, UNLOAD, INVENTORY_MOVE, PICKUP, DROP), WP9 medikit trio, WP10 PSI_PANIC and PSI_MIND_CONTROL.

**Implemented, not live-accepted:** `MELEE_ATTACK` (S3 deployed tonight; gate off by default).

**Major intentional gaps (P1):** standalone `BA_USE` (scanner, mind probe), reaction-shot mode / TU reserve settings, END_TURN, mind-controlled roster soldier orders, HWP-as-actor parity.

---

## B1. Native action surface (discovery)

### B1.1 Relay command types (authoritative executor list)

`CompanionCommandRuntime.cpp` accepts exactly these `command_type` values; all others → `UNSUPPORTED_COMMAND_TYPE`:

`MOVE`, `KNEEL`, `STAND`, `SNAP_SHOT`, `AUTO_SHOT`, `AIMED_SHOT`, `PRIME`, `THROW`, `GUIDED_LAUNCH`, `RELOAD`, `UNLOAD`, `INVENTORY_MOVE`, `PICKUP`, `DROP`, `HEAL`, `STIMULANT`, `PAINKILLER`, `PSI_PANIC`, `PSI_MIND_CONTROL`, `MELEE_ATTACK`.

Node mirror: `companion/m0-publish/lib/tactical-command.cjs` constants + `parseTacticalCommand` dispatch; `command-binding.cjs` compose helpers for each.

### B1.2 Native battlescape actions without relay commands

| Native / UI action | Engine entry | Companion today |
|--------------------|--------------|-----------------|
| End turn | `BattlescapeState` / hotkey | **NOT APPLICABLE** — human-only per cooperative policy (`AGENTS.md`) |
| Reaction fire off / snap only / aimed | unit reaction level UI | **MISSING** — no export of reaction mode; no command |
| Reserve TU for reaction | `BattleUnit::reserveTimeUnits` | **PARTIAL** — engine honors reserves on execute; no remote setter |
| Turn in place (facing only) | `UnitTurnBState` | **PARTIAL** — folded into MOVE path segments and fire/melee/medikit pre-turn |
| Open / close door | `TileEngine`, walk adjacency | **MISSING** — side effect of MOVE only |
| `BA_USE` (scanner, mind probe, misc) | `BattlescapeGame::useAction` | **MISSING** — `actionCosts` may list `use` but no command |
| Abort / cancel current UI mode | `BattlescapeState` | **NOT APPLICABLE** — no remote UI state |
| Select soldier / camera | UI | **NOT APPLICABLE** |
| Melee menu (human, no target id) | `handleNonTargetAction` | **PARTIAL** — `MELEE_ATTACK` requires `target_unit_id` |
| Alien intrinsic melee | AI | **NOT APPLICABLE** for Aster orders |
| HWP / tank movement & fire | same BA_* as units | **PARTIAL** — if listed in `commandBinding.player_soldiers` (uncommon); no HWP-specific command |
| Order mind-controlled alien | faction flip | **MISSING** — MC roster in `exceptions`, not `player_soldiers` |
| Order XCOM-controlled hostile (post-MC alien) | engine flag | **PARTIAL** — MC changes faction; follow-up fire may work **INFERRED**; squad assignment **MISSING** |
| Blaster non-guided misuse | blocked from directed fire | **VERIFIED** — waypoint weapons excluded from SNAP/AIM/AUTO commands |

---

## B2. Full coverage matrix

Columns: **Native** | **Snapshot** | **Node** | **Engine** | **Relay** | **Tested**

### Movement, posture, facing

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| Walk / path MOVE | COMPLETE | COMPLETE (`position`, terrain brief) | COMPLETE | COMPLETE | COMPLETE (`tu_spent`, interrupt) | COMPLETE (engine + Node + live) |
| KNEEL | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| STAND | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Facing change en route | COMPLETE | PARTIAL (facing on units) | PARTIAL (MOVE waypoints) | COMPLETE | COMPLETE | PARTIAL |
| Run / climb / fly modes | COMPLETE | PARTIAL | MISSING | MISSING | MISSING | MISSING |
| Reaction interrupt on move | COMPLETE | PARTIAL (`perceptionLog`) | PARTIAL (advisory) | COMPLETE (result tokens) | COMPLETE | PARTIAL |

### Directed fire

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| SNAP_SHOT | COMPLETE | COMPLETE (`actionCosts`) | COMPLETE | COMPLETE | COMPLETE (EXECUTING→COMPLETED) | COMPLETE |
| AUTO_SHOT | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| AIMED_SHOT | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Reaction fire (defensive) | COMPLETE | PARTIAL (events only) | MISSING | MISSING | MISSING | UNVERIFIED |
| TU reserve for reactions | COMPLETE | MISSING | MISSING | PARTIAL (enforced) | PARTIAL | UNVERIFIED |

### Grenades & explosives

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| PRIME | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| THROW | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| GUIDED_LAUNCH (BA_LAUNCH) | COMPLETE | PARTIAL (no waypoint preview) | COMPLETE | COMPLETE | COMPLETE | COMPLETE (engine); live per WP8E deploy |
| Proximity / timed detonation feedback | COMPLETE | PARTIAL (`perceptionLog` explosions) | PARTIAL | COMPLETE | PARTIAL | PARTIAL |

### Inventory & equipment

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| RELOAD | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| UNLOAD | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| INVENTORY_MOVE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| PICKUP (ground) | COMPLETE | COMPLETE (`groundItems`) | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| DROP | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Active hand only via command field | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Standalone “swap hands” command | COMPLETE (UI) | COMPLETE (observe) | MISSING | MISSING | MISSING | N/A |

### Medikit (WP9)

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| HEAL | COMPLETE | COMPLETE (`medikitCharges`, wounds) | COMPLETE | COMPLETE | COMPLETE (`target_revived`) | COMPLETE + live deploy |
| STIMULANT | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| PAINKILLER | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Adjacent facing-sensitive heal | COMPLETE | PARTIAL | PARTIAL (advisory) | COMPLETE | COMPLETE | PARTIAL (sparse-map gap documented) |

### Psi-Amp (WP10)

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| PSI_PANIC | COMPLETE | PARTIAL (no amp in all exports) | COMPLETE | COMPLETE | COMPLETE | COMPLETE + live deploy |
| PSI_MIND_CONTROL | COMPLETE | PARTIAL | COMPLETE | COMPLETE | COMPLETE | COMPLETE + live drill |
| MC alien as Aster actor | COMPLETE | PARTIAL (`exceptions`) | NOT APPLICABLE | NOT APPLICABLE | NOT APPLICABLE | N/A |
| Panic/MC outcome on next turn | COMPLETE | PARTIAL (`readiness`, exceptions) | PARTIAL | COMPLETE | PARTIAL (F6 refresh) | LIVE for MC |

### Melee / stun (S1–S3)

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| MELEE_ATTACK (`BA_HIT`) | COMPLETE | PARTIAL (no target stun state) | COMPLETE | COMPLETE (gated) | PARTIAL (`melee_hit`, gate OFF default) | COMPLETE automated; **UNVERIFIED live** |
| Animated strike lifecycle | COMPLETE | MISSING mid-flight | PARTIAL | COMPLETE | PARTIAL (`EXECUTING`) | UNVERIFIED live |
| Disabled gate reject | COMPLETE | N/A | PARTIAL (preflight only) | COMPLETE | COMPLETE | COMPLETE (`companion_command_test`) |
| Non-stun BT_MELEE | COMPLETE | COMPLETE (`actionCosts.melee`) | COMPLETE | COMPLETE | PARTIAL | UNVERIFIED |

### Environmental & specialist

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| Motion scanner `BA_USE` | COMPLETE | PARTIAL (`use` row) | MISSING | MISSING | MISSING | MISSING |
| Mind probe `BA_USE` | COMPLETE | MISSING | MISSING | MISSING | MISSING | MISSING |
| Door open | COMPLETE | PARTIAL (terrain) | MISSING | MISSING | MISSING | N/A |
| HWP turret rotate-only TU | COMPLETE | PARTIAL | MISSING | PARTIAL | MISSING | MISSING |

### Battle control

| Capability | Native | Snapshot | Node | Engine | Relay | Tested |
|------------|--------|----------|------|--------|-------|--------|
| END_TURN | COMPLETE | COMPLETE (turn in binding) | MISSING | MISSING | NOT APPLICABLE | N/A |
| Soldier selection | COMPLETE | COMPLETE (`commandBinding`) | N/A | N/A | N/A | N/A |
| Tactical cancel / abort | COMPLETE | MISSING | MISSING | MISSING | NOT APPLICABLE | N/A |

---

## B3. Operational usability (per command family)

| Family | 1 Recognize | 2 Costs/target | 3 Validate publish | 4 Accept/reject | 5 Outcome | 6 After failure | 7 Fair-play |
|--------|-----------|----------------|--------------------|-----------------|-----------|-----------------|-------------|
| MOVE/KNEEL/STAND | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Fire modes | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE (hit flags) | COMPLETE | COMPLETE |
| Grenades / launch | COMPLETE | PARTIAL (launch TU) | COMPLETE | COMPLETE | PARTIAL (busy stack) | COMPLETE | COMPLETE |
| Inventory | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Medikit | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Psi | COMPLETE | PARTIAL (skill gaps) | COMPLETE | COMPLETE | COMPLETE | COMPLETE | COMPLETE |
| Melee | COMPLETE | PARTIAL (geometry advisory) | COMPLETE | COMPLETE | PARTIAL (hit ≠ complete) | COMPLETE | COMPLETE |
| Missing USE/scanner | PARTIAL (export `use`) | MISSING | MISSING | MISSING | MISSING | N/A | N/A |

**Hidden-information risks (low today):** Node psi/melee validators use confirmed LOS hostiles only; medikit blocks hostile wound details; fire uses visible targets. Mind probe would be **high risk** if added without strict fair-play spec.

---

## B4. Prioritized gaps

### P0 — Safety / state integrity

| ID | Issue | Layer | Smallest fix |
|----|-------|-------|--------------|
| P0-1 | Live animated melee `EXECUTING` orphan on reload | Engine relay | Port directed-fire rehydrate pattern to `KIND_MELEE` (`CompanionCommandRuntime.cpp`) |
| P0-2 | Mis-aim medikit on adjacent tile (documented sparse-map gap) | Engine preflight | Live-certify or harden facing check (`CompanionCommandCore` medikit path) |

*No new P0 identified beyond known melee/orphan and documented medikit adjacent bounds.*

### P1 — Material cooperative limits

| ID | Issue | Smallest implementation |
|----|-------|-------------------------|
| P1-1 | `MELEE_ATTACK` not live-accepted | Owner Battle Mode drill tonight (no code) |
| P1-2 | `BA_USE` scanner / mind probe | Defer separate commands; optional `SCANNER_USE` with **no** intel leak export |
| P1-3 | Reaction mode / TU reserve control | Snapshot `reactionLevel` + optional `SET_REACTION_MODE` (single enum) |
| P1-4 | MC roster soldier cannot be ordered | **NOT APPLICABLE** by design — improve `exceptions` text only |

### P2 — Useful improvements

| ID | Issue | Smallest implementation |
|----|-------|-------------------------|
| P2-1 | Hostile stun/dead state in result without F6 wait | Add bounded `target_status` refresh in result (melee already partial) |
| P2-2 | Launch waypoint preview in snapshot | Export max waypoints + loaded ammo id on hand row |
| P2-3 | `use` actionCosts without command | Document as observe-only in playbook |

### P3 — Low value

| ID | Issue | Notes |
|----|-------|-------|
| P3-1 | Dedicated door command | Use MOVE into door tile |
| P3-2 | END_TURN command | Keep human-only |
| P3-3 | UI camera / select unit | Out of scope |

---

## B5. Final recommendations

### 1. Capability matrix

See **B2** — 19 relay types mapped; native battlescape actions without relays listed in **B1.2**.

### 2. Commands working and proven

MOVE, KNEEL, STAND, SNAP/AUTO/AIMED, PRIME, THROW, GUIDED_LAUNCH, RELOAD, UNLOAD, INVENTORY_MOVE, PICKUP, DROP, HEAL, STIMULANT, PAINKILLER, PSI_PANIC, PSI_MIND_CONTROL (live drills + Release engine tests per S4K/WP8E/WP9/WP10 audits).

### 3. Implemented, not live-tested

**MELEE_ATTACK** — Release binary deployed 2026-11-18; `OPENXCOM_COMPANION_MELEE_EXECUTION` default **off**; automated gates green.

### 4. Missing capabilities (source pointers)

| Gap | Primary location |
|-----|------------------|
| `BA_USE` | `BattlescapeGame::useAction`; no `CompanionCommandRuntime` branch |
| Reaction mode | `BattleUnit` reaction APIs; not in `CompanionSnapshot.cpp` export |
| END_TURN | UI only |
| Melee reload orphan | `CompanionCommandRuntime.cpp` in-flight tick (~`KIND_MELEE`) |

### 5. Prioritized implementation order

1. Owner live melee acceptance (Battle Mode script: `runtime/m0/Start-CompanionOpenXcom-MeleeBattleModeTest.ps1`).  
2. Melee `EXECUTING` rehydrate (P0-1).  
3. Reaction mode export + optional command (P1-3) — only if cooperative play needs it.  
4. Defer scanner/mind-probe until mission need clear (P1-2).

### 6. Suggested regression suite (feature-complete bar)

| Gate | Target |
|------|--------|
| Native Release | `companion_command_test`, medikit + psi engine tests, **add** `companion_melee_engine_test` once owner approves harness |
| Node | existing WP3–WP10 suites + `tactical-command-m1-melee-stun-s1.test.cjs` |
| Live (owner) | One drill per command family + melee acceptance + MC FOV spot-check |

### 7. Feature-complete declaration criteria

Declare the Companion tactical command interface **feature-complete** when:

1. All **P0** closed.  
2. All relay types in **B1.1** have **live** acceptance on production runtime (including **MELEE_ATTACK** with documented gate policy).  
3. Cooperative policy exclusions documented (END_TURN human-only, no MC-roster orders).  
4. `VERIFIED_BUILD_SHA256` committed with owner-signed deploy note.  
5. No open **P1** gap that blocks routine cooperative missions (reaction mode is mission-dependent — explicit owner waiver acceptable).

Until then: status **functionally complete for firearms, grenades, launchers, inventory, medikit, and psi**; **melee pending live acceptance**.

---

## Audit metadata

| Item | Value |
|------|-------|
| Phase B code changes | **None** |
| Cross-refs | `ASTER-M1-MELEE-STUN-AUDIT-01` (pre-S1 baseline), `ASTER-M1-TACTICAL-EQUIPMENT-AUDIT-01` (WP8; superseded for WP9/10/launch), `ASTER-M1-MELEE-PRODUCTION-DEPLOY-01` |