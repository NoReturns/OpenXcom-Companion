# M1 Battlescape WP8 — Inventory, Equipment, and Item-Action Audit

**Date:** 2026-11-05  
**Mode:** Read-only source audit + documentation (no implementation)  

> **Inventory command status (addendum, 2026-11-06, WP8B1/WP8B2):** The original body of this file was frozen as a **2026-11-05 read-only audit**. As of WP8B1/WP8B2, the Companion also implements remote **`RELOAD`** and **`UNLOAD`** (see `companion/docs/M1-BATTLESCAPE-WP8B1-RELOAD.md` and `companion/docs/M1-BATTLESCAPE-WP8B2-UNLOAD.md`). **Do not overwrite the historical tables below** — use this addendum for current command coverage instead of silently editing the executive-summary numbers in §1.
**Canonical runtime:** `runtime/m0/bin/openxcom.exe` (SHA-256 `10c81ea828e441bc388a0679244336aff5675456df43a44c8743650c1d3e2f8e` — reference hash from project docs; not re-verified in this session)  
**Engine tree:** `engine/OpenXcom`  
**Companion tree:** `companion/m0-publish`  
**Baseline ruleset:** `runtime/m0/bin/standard/xcom1` (UFO Defense) — only mod marked `active: true` in `local/m0/user/options.cfg` and `local/m0/config/options.cfg`

**Verification legend**

| Tag | Meaning |
|-----|---------|
| **CODE** | Read directly from C++/ruleset/Node sources in this repo |
| **CONFIG** | Derived from documented local options files (not live game session) |
| **INFER** | Reasonable inference from engine patterns; needs live battlescape confirmation |
| **N/A** | Not applicable for this item/action |

---

## 1. Executive findings

### Summary

OpenXcom battlescape inventory is a **dual-path system**: (1) **inventory UI** (`InventoryState` / `Inventory`) for drag-drop, reload-by-drag, unload, ground panel, and pre-battle equip; (2) **battle actions** (`BattleAction` + `BattlescapeGame` state queue) for fire, throw, prime, melee, psi, medikit, scanner, and mind probe. There is **no** `BA_RELOAD` enum value — reload is **15 TU** via `BattleUnit::checkAmmo()` or inventory ammo drag (`Inventory::mouseClick`).

The Companion **observes** friendly roster soldier loadouts (`hands`, `inventory`, optional `actionCosts`) and **fair-play ground items** (`groundItems`, schema ≥4). As of **2026-11-06**, it **commands** movement, posture, directed fire, hand-grenade prime/throw, explicit **`RELOAD`**, and magazine **`UNLOAD`** (WP8B1/WP8B2) — still **no** pickup, drop, generic inventory moves, medikit, psi, launch, or END_TURN (policy unchanged).

| Metric | Value |
|--------|------:|
| Concrete `RuleItem` types catalogued (active xcom1) | **145** |
| TFTD (`xcom2`) types present but inactive | 121 |
| Engine `BattleType` categories | 12 |
| Distinct **player-facing action mechanisms** (inventory + battle + fixed TU ops) | **22** (see §4.1) |
| Companion **remote command types** (2026-11-06) | **9** (`MOVE`, `KNEEL`, `SNAP_SHOT`, `AUTO_SHOT`, `AIMED_SHOT`, `PRIME`, `THROW`, `RELOAD`, `UNLOAD`) |
| Of those, inventory-related | **5** (`PRIME`, `THROW` on **active hand**; `RELOAD` on `weapon_battle_item_id` + carried `ammo_battle_item_id`; `UNLOAD` on `weapon_battle_item_id` + `loaded_ammo_battle_item_id` matching `nestedAmmo`) |
| Other inventory manipulation commands (pickup, drop, slot move, swap, medikit, …) | **0** |

### Engine vs Companion (headline)

| Capability | Engine | Companion observability | Companion commands |
|------------|--------|-------------------------|-------------------|
| Body slot layout + hands | **CODE** full | **CODE** `hands` + `inventory[]` (max 24 non-hand entries) | **MISSING** |
| Stable `BattleItem::id` | **CODE** per battle | **MISSING** (only `itemType`) | **MISSING** |
| Slot grid coordinates | **CODE** `_inventoryX/Y` | **MISSING** | **MISSING** |
| Reload / unload | **CODE** | Partial via `loaded`/`empty` on firearms | **MISSING** |
| Ground loot | **CODE** tile inventories | **CODE** `groundItems` (LOS/memory/research filtered) | **MISSING** |
| Grenade prime (battle) | **CODE** `BA_PRIME` | **CODE** `primed`/`fuseTimer` on hands/inventory | **CODE** `PRIME` (hand) |
| Grenade prime (inventory UI) | **CODE** no TU | Same snapshot fields if already primed | **MISSING** (no belt prime command) |
| Fire modes | **CODE** | **CODE** `actionCosts` | **CODE** snap/auto/aimed |
| Medikit / scanner / probe / psi | **CODE** `BA_USE` / psi types | Partial (`actionCosts` use/melee entries when exported) | **MISSING** |
| Research gate on alien gear | **CODE** | **CODE** `usable: false` in `actionCosts`; ground `unidentified_*` | Enforced on fire/prime paths; **INFER** inventory drag may differ |

### Major snapshot gaps (for safe manipulation)

1. **No `battleItemId`** — cannot disambiguate duplicate `STR_RIFLE_CLIP` in backpack.  
2. **No `inventoryX` / `inventoryY`** — cannot specify destination cell in belt/backpack.  
3. **No per-slot move TU matrix export** — costs live in `inventories.rul` (`RuleInventory::getCost`).  
4. **Ground items:** primary + `additional_ground_item` concealment; no stable ground instance id; **no `fuseTimer`** on ground grenades in export.  
5. **Inventory screen open / busy stack** — not exposed; commands require idle `BattlescapeGame`.

### Top five implementation risks

1. **Primed explosive accidents** — inventory prime bypasses battle TU; dropping live grenades; stale snapshot fuse state.  
2. **Duplicate item identity** — type strings alone insufficient for MOVE/RELOAD targets.  
3. **Partial transactions** — engine moves are immediate; failed mid-drag not modeled remotely.  
4. **Fair-play leakage** — exposing hidden tile stacks or off-LOS live ground state.  
5. **Authority / MC** — mind-controlled roster soldiers appear as threats; must stay out of `commandBinding.player_soldiers`.

### Recommended first work package

**WP8A — Observation hardening (Phase A):** export `battleItemId`, slot id + `(x,y)` for every carried item, `carriedWeight` / capacity heuristics, inventory move TU table reference or per-action costs, document ground-item correlation keys (tile + category + optional type). **No new commands** until identity is stable.

### Audit completeness / confidence

| Area | Confidence |
|------|------------|
| Engine architecture & dispatch | **High (CODE)** |
| xcom1 item catalog | **High (CODE)** from `items.rul` + en-US names |
| Active mod merge | **Medium (CONFIG)** — xcom1-only documented; no `companion-rules-reference.json` in repo |
| UI slot model | **High (CODE)** `inventories.rul` + `Inventory.cpp` |
| Live panic-drop inventory behavior | **Medium (INFER)** — needs New Battle test |
| Companion runtime on owner machine | **Not exercised** this audit |

### GO / NO-GO for implementation planning

**GO** for phased implementation **planning** and **Phase A snapshot design**, provided fair-play filters and `snapshot_sha256` binding remain mandatory.  
**NO-GO** for remote inventory **execution** until instance identity and slot coordinates are exported and validated.

---

## 2. Engine architecture and source map

### 2.1 Core types

| Component | Path | Role |
|-----------|------|------|
| `BattleItem` | `engine/OpenXcom/src/Savegame/BattleItem.h`, `.cpp` | Runtime instance: `_id`, owner, tile, `RuleInventory*` slot, `(x,y)`, nested ammo, fuse, medikit charges |
| `RuleItem` | `engine/OpenXcom/src/Mod/RuleItem.h`, `.cpp` | Static definition; `BattleType`, TU fields, `compatibleAmmo`, `requires`, `invWidth/Height`, `flatRate`, etc. |
| `RuleInventory` / `RuleSlot` | `engine/OpenXcom/src/Mod/RuleInventory.h`, `.cpp` | Slot sections (`INV_SLOT`, `INV_HAND`, `INV_GROUND`); `fitItemInSlot`, `getCost(dest)` |
| `BattleUnit` | `engine/OpenXcom/src/Savegame/BattleUnit.h`, `.cpp` | `getInventory()`, `getItem(slot,x,y)`, `getActionTUs`, `checkAmmo()`, weight |
| `Tile` | `engine/OpenXcom/src/Savegame/Tile.h`, `.cpp` | Ground `getInventory()`, `addItem` / `removeItem` |
| `SavedBattleGame` | `engine/OpenXcom/src/Savegame/SavedBattleGame.h`, `.cpp` | Master `_items` list, `getItemUsable`, `removeItem`, `getCurrentItemId()` |
| `BattlescapeGame` | `engine/OpenXcom/src/Battlescape/BattlescapeGame.h`, `.cpp` | `_currentAction`, state queue, `dropItem`, AI pickup, `tryExecuteCompanion*` |
| `BattleAction` | `engine/OpenXcom/src/Battlescape/BattlescapeGame.h` | `BattleActionType` enum (`BA_PRIME`, `BA_THROW`, fire modes, `BA_USE`, psi, …) |
| `InventoryState` | `engine/OpenXcom/src/Battlescape/InventoryState.cpp` | Modal inventory; `_tu` true in battle |
| `Inventory` | `engine/OpenXcom/src/Battlescape/Inventory.cpp` | Drag/drop, `moveItem`, `unload`, `fitItem`, companion mutation gate |
| `ActionMenuState` | `engine/OpenXcom/src/Battlescape/ActionMenuState.cpp` | Hand-item action menu → sets `BattleAction` |
| Mission item spawn | `engine/OpenXcom/src/Battlescape/BattlescapeGenerator.cpp` | Soldier layout, craft stash, alien gear |

### 2.2 `BattleType` enum (**CODE** `RuleItem.h`)

`BT_NONE`, `BT_FIREARM`, `BT_AMMO`, `BT_MELEE`, `BT_GRENADE`, `BT_PROXIMITYGRENADE`, `BT_MEDIKIT`, `BT_SCANNER`, `BT_MINDPROBE`, `BT_PSIAMP`, `BT_FLARE`, `BT_CORPSE`

Mod items may add behaviors via `specialType`, `waypoints`, `attraction`, etc. — see catalog rows.

### 2.3 TU costing (**CODE**)

**`BattleUnit::getActionTUs(BattleActionType, BattleItem*)`** (`BattleUnit.cpp`):

- `BA_PRIME`: base **50** (% of unit TU unless `flatRate` rules say otherwise; throw/prime always %-scaled per `CompanionRulesReferenceExportCore.cpp` comment)
- `BA_THROW`: base **25** (always %-scaled)
- Fire modes: `RuleItem` `tuSnap` / `tuAuto` / `tuAimed`
- `BA_HIT`: `tuMelee`
- `BA_USE`, `BA_MINDCONTROL`, `BA_PANIC`: `tuUse`
- If `!flatRate` OR action is throw/prime: `floor(baseTU * cost / 100)`

**Fixed inventory/battlescape ops (not in enum):**

| Operation | TU | Source |
|-----------|---:|--------|
| Reload (`checkAmmo`, drag ammo to gun, reload button) | 15 | `BattleUnit::checkAmmo`, `Inventory::mouseClick`, `BattlescapeState::btnReloadClick` |
| Unload | 8 | `Inventory::unload` |
| Ground pickup (AI / `takeItemFromGround`) | 6 | `BattlescapeGame::takeItemFromGround` |
| Inventory section move | `RuleInventory::getCost(dest)` | `Inventory.cpp`, `runtime/m0/bin/standard/xcom1/inventories.rul` |

### 2.4 Dispatch and validation paths

| Flow | Entry | Validation | Execution |
|------|-------|------------|-----------|
| Hand fire/throw/use | `BattlescapeState::handleItemClick` → `ActionMenuState` | Research (`isResearched(requirements)`), `getItemUsable`, companion human-order denial, TU | `primaryAction` / `handleNonTargetAction` → `*BState` queue |
| Prime (battle) | `ActionMenuState` → `PrimeGrenadeState` | Fuse UI | `handleNonTargetAction`: spend TU, `setFuseTimer` |
| Prime (inventory) | `Inventory` right-click grenade | Companion gate | `setFuseTimer` **without** `BA_PRIME` TU (`PrimeGrenadeState` inventory mode) |
| Inventory drag | `Inventory::mouseClick` | Fit/overlap, TU if `_tu`, fixed items, `warnCompanionInventoryMutationDenied` | `moveItem`, `setAmmoItem` |
| AI pickup | `BattlescapeGame::surveyItems` / `takeItemFromGround` | Space, TU 6 | `takeItem` |
| Death drops | `UnitDieBState` | `hasInventory()` | `dropItem` to tile |
| Companion prime/throw | `CompanionCommandRuntime.cpp` | Same as `tryExecuteCompanionPrime/Throw` | Direct engine API |

### 2.5 Companion integration (**CODE**)

| File | Role |
|------|------|
| `engine/OpenXcom/src/Engine/CompanionSnapshot.cpp` | YAML: `hands`, `inventory`, `actionCosts`, friendly filter |
| `engine/OpenXcom/src/Engine/CompanionSnapshotGroundItems.cpp` | `groundItems` fair-play export |
| `engine/OpenXcom/src/Engine/CompanionGroundItemMemory.cpp` | Off-LOS memory |
| `engine/OpenXcom/src/Engine/CompanionCommandRuntime.cpp` | Command executor |
| `companion/m0-publish/lib/tactical-publish.cjs` | Schema validation, relay |
| `companion/m0-publish/lib/tactical-command.cjs` | Command types and preflight |
| `companion/m0-publish/lib/command-binding.cjs` | `player_soldiers`, compose helpers |

Inventory UI mutation gate: `Inventory.cpp::warnCompanionInventoryMutationDenied`, `InventoryState::_warnIfInventoryMutationDenied`.

---

## 3. Item catalog

### 3.1 Scope and rulesets

| Source | Status in audit |
|--------|-----------------|
| **Vanilla UFO (`xcom1/items.rul`)** | **145** types — **full tables below** |
| **TFTD (`xcom2/items.rul`)** | 121 types — **not active**; engine supports same `BattleType` set |
| **Bundled optional mods** (`runtime/m0/bin/standard/*.rul`) | Documented **inactive** in `local/m0/*/options.cfg` — patch-only deltas in §3.4 |
| **Engine categories without xcom1 instance** | All 12 `BattleType` values appear at least once in xcom1 |

Display names from `runtime/m0/bin/standard/xcom1/Language/en-US.yml`. Stats from `items.rul`. **TU** column uses S=snap, A=auto, Z=aimed, M=melee, U=use (% unless `flat: true`).

### 3.2 Category counts (active xcom1)

| battleType | Count |
|------------|------:|
| none | 66 |
| corpse | 23 |
| firearm | 21 |
| ammo | 19 |
| melee | 5 |
| grenade | 4 |
| psiamp | 2 |
| proximity_grenade | 1 |
| medikit | 1 |
| scanner | 1 |
| mindprobe | 1 |
| flare | 1 |

### 3.3 Full xcom1 catalog tables


#### ammo (19 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_HWP_CANNON_SHELLS | "HWP Cannon Shells" | 0.1 | 1 | -×- | 30 | AP | — | — | — | false | — |
| STR_HWP_ROCKETS | "HWP Rockets" | 0.6 | 1 | -×- | 8 | HE | — | — | — | false | — |
| STR_HWP_FUSION_BOMB | "HWP Fusion Bomb" | 0.6 | 1 | -×- | 8 | HE | — | — | — | false | — |
| STR_PISTOL_CLIP | "Pistol Clip" | 0.1 | 3 | -×- | 12 | AP | — | — | — | false | — |
| STR_RIFLE_CLIP | "Rifle Clip" | 0.1 | 3 | -×- | 20 | AP | — | — | — | false | — |
| STR_HC_AP_AMMO | "HC-AP Ammo" | 0.1 | 6 | 2×1 | 6 | AP | — | — | — | false | — |
| STR_HC_HE_AMMO | "HC-HE Ammo" | 0.1 | 6 | 2×1 | 6 | HE | — | — | — | false | — |
| STR_HC_I_AMMO | "HC-I Ammo" | 0.1 | 6 | 2×1 | 6 | IN | — | — | — | false | — |
| STR_AC_AP_AMMO | "AC-AP Ammo" | 0.1 | 5 | 2×1 | 14 | AP | — | — | — | false | — |
| STR_AC_HE_AMMO | "AC-HE Ammo" | 0.1 | 5 | 2×1 | 14 | HE | — | — | — | false | — |
| STR_AC_I_AMMO | "AC-I Ammo" | 0.1 | 5 | 2×1 | 14 | IN | — | — | — | false | — |
| STR_SMALL_ROCKET | "Small Rocket" | 0.2 | 6 | 1×3 | 1 | HE | — | — | — | false | — |
| STR_LARGE_ROCKET | "Large Rocket" | 0.2 | 8 | 1×3 | 1 | HE | — | — | — | false | — |
| STR_INCENDIARY_ROCKET | "Incendiary Rocket" | 0.2 | 8 | 1×3 | 1 | IN | — | — | — | false | — |
| STR_HEAVY_PLASMA_CLIP | "Heavy Plasma Clip" | 0.3 | 3 | -×- | 35 | PLASMA | — | — | — | false | — |
| STR_PLASMA_RIFLE_CLIP | "Plasma Rifle Clip" | 0.1 | 3 | -×- | 28 | PLASMA | — | — | — | false | — |
| STR_PLASMA_PISTOL_CLIP | "Plasma Pistol Clip" | 0.1 | 3 | -×- | 26 | PLASMA | — | — | — | false | — |
| STR_BLASTER_BOMB | "Blaster Bomb" | 0.2 | 3 | 1×2 | 1 | HE | — | — | — | false | — |
| STR_STUN_BOMB | "Stun Bomb" | 0.1 | 3 | -×- | 1 | STUN | — | — | — | false | — |

#### corpse (23 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_SECTOID_CORPSE | "Sectoid Corpse" | 0.4 | 30 | 2×3 | - | - | — | — | — | false | — |
| STR_SNAKEMAN_CORPSE | "Snakeman Corpse" | 0.4 | 40 | 2×3 | - | - | — | — | — | false | — |
| STR_ETHEREAL_CORPSE | "Ethereal Corpse" | 0.4 | 25 | 2×3 | - | - | — | — | — | false | — |
| STR_MUTON_CORPSE | "Muton Corpse" | 0.4 | 40 | 2×3 | - | - | — | — | — | false | — |
| STR_FLOATER_CORPSE | "Floater Corpse" | 0.4 | 20 | 2×3 | - | - | — | — | — | false | — |
| STR_CELATID_CORPSE | "Celatid Corpse" | 0.4 | 35 | 2×3 | - | - | — | — | — | false | — |
| STR_SILACOID_CORPSE | "Silacoid Corpse" | 0.4 | 40 | 2×3 | - | - | — | — | — | false | — |
| STR_CHRYSSALID_CORPSE | "Chryssalid Corpse" | 0.4 | 40 | 2×3 | - | - | — | — | — | false | — |
| STR_REAPER_CORPSE | "Reaper Corpse" | 1 | 3 | -×- | - | - | — | — | — | false | — |
| REAPER_CORPSE_1 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| REAPER_CORPSE_2 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| REAPER_CORPSE_3 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| REAPER_CORPSE_4 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| STR_SECTOPOD_CORPSE | "Sectopod Corpse" | 1 | 3 | -×- | - | - | — | — | — | false | — |
| SECTOPOD_CORPSE_1 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| SECTOPOD_CORPSE_2 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| SECTOPOD_CORPSE_3 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| SECTOPOD_CORPSE_4 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| STR_CYBERDISC_CORPSE | "Cyberdisc Corpse" | 1 | 3 | -×- | - | - | — | — | — | false | — |
| CYBERDISC_CORPSE_1 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| CYBERDISC_CORPSE_2 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| CYBERDISC_CORPSE_3 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| CYBERDISC_CORPSE_4 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |

#### firearm (21 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_TANK_CANNON | "Tank/Cannon" | 6 | 1 | 2×3 | - | - | — | — | S33 Z80 | false | fixedWeapon |
| STR_TANK_ROCKET_LAUNCHER | "Tank/Rocket Launcher" | 6 | 1 | 2×3 | - | - | — | — | S45 Z75 | false | fixedWeapon |
| STR_TANK_LASER_CANNON | "Tank/Laser Cannon" | 6 | 1 | 2×3 | -1 | LASER | — | — | S33 Z75 | false | fixedWeapon |
| STR_HOVERTANK_PLASMA | "Hovertank/Plasma" | 6 | 1 | 2×3 | -1 | PLASMA | — | — | S30 Z60 | false | fixedWeapon |
| STR_HOVERTANK_LAUNCHER | "Hovertank/Launcher" | 6 | 1 | 2×3 | - | - | — | — | Z66 | false | fixedWeapon; wp:9 |
| STR_PISTOL | "Pistol" | 0.1 | 5 | 1×2 | - | - | — | — | S18 Z30 | false | — |
| STR_RIFLE | "Rifle" | 0.2 | 8 | 1×3 | - | - | — | — | S25 A35 Z80 | false | twoHanded |
| STR_HEAVY_CANNON | "Heavy Cannon" | 0.3 | 18 | 2×3 | - | - | — | — | S33 Z80 | false | twoHanded |
| STR_AUTO_CANNON | "Auto-Cannon" | 0.3 | 19 | 2×3 | - | - | — | — | S33 A40 Z80 | false | twoHanded |
| STR_ROCKET_LAUNCHER | "Rocket Launcher" | 0.4 | 10 | 2×3 | - | - | — | — | S45 Z75 | false | twoHanded |
| STR_LASER_PISTOL | "Laser Pistol" | 0.1 | 7 | 1×2 | -1 | LASER | — | — | S20 A25 Z55 | false | — |
| STR_LASER_RIFLE | "Laser Rifle" | 0.2 | 8 | 1×3 | -1 | LASER | — | — | S25 A34 Z50 | false | twoHanded |
| STR_HEAVY_LASER | "Heavy Laser" | 0.3 | 18 | 2×3 | -1 | LASER | — | — | S33 Z75 | false | twoHanded |
| STR_HEAVY_PLASMA | "Heavy Plasma" | 0.2 | 8 | 2×3 | - | - | — | — | S30 A35 Z60 | false | twoHanded |
| STR_PLASMA_RIFLE | "Plasma Rifle" | 0.2 | 5 | 1×3 | - | - | — | — | S30 A36 Z60 | false | twoHanded |
| STR_PLASMA_PISTOL | "Plasma Pistol" | 0.1 | 3 | 1×2 | - | - | — | — | S30 A30 Z60 | false | — |
| STR_BLASTER_LAUNCHER | "Blaster Launcher" | 0.3 | 16 | 2×3 | - | - | — | — | Z66 | false | twoHanded; wp:9 |
| STR_SMALL_LAUNCHER | "Small Launcher" | 0.2 | 10 | 2×2 | - | - | — | — | S40 Z75 | false | twoHanded |
| CYBERDISC_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | PLASMA | — | — | S30 Z60 | false | fixedWeapon |
| CELATID_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | ACID | — | — | S30 Z60 | false | fixedWeapon |
| SECTOPOD_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | LASER | — | — | S30 A35 Z60 | false | fixedWeapon |

#### flare (1 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_ELECTRO_FLARE | "Electro-flare" | 0.1 | 3 | -×- | - | - | — | — | — | false | — |

#### grenade (4 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_GRENADE | "Grenade" | 0.1 | 3 | -×- | - | HE | — | — | — | false | — |
| STR_SMOKE_GRENADE | "Smoke Grenade" | 0.1 | 3 | -×- | - | SMOKE | — | — | — | false | — |
| STR_HIGH_EXPLOSIVE | "High Explosive" | 0.2 | 6 | 2×1 | - | HE | — | — | — | false | — |
| STR_ALIEN_GRENADE | "Alien Grenade" | 0.1 | 3 | -×- | - | HE | — | — | — | false | — |

#### medikit (1 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_MEDI_KIT | "Medi-Kit" | 0.1 | 5 | 1×2 | - | - | — | — | U10 | true | — |

#### melee (5 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_STUN_ROD | "Stun Rod" | 0.1 | 6 | 1×3 | -1 | STUN | — | — | M30 | false | twoHanded |
| REAPER_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | MELEE | — | — | M15 | true | fixedWeapon |
| CHRYSSALID_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | MELEE | — | — | M15 | true | fixedWeapon |
| SILACOID_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | MELEE | — | — | M15 | true | fixedWeapon |
| ZOMBIE_WEAPON | N/A | 0.0 | 3 | 2×3 | -1 | MELEE | — | — | M15 | true | fixedWeapon |

#### mindprobe (1 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_MIND_PROBE | "Mind Probe" | 0.1 | 5 | 2×2 | - | - | — | — | U50 | false | — |

#### none (66 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_STINGRAY_LAUNCHER | "Stingray Launcher" | 0.8 | 3 | -×- | - | - | — | — | — | false | — |
| STR_STINGRAY_MISSILES | "Stingray Missiles" | 0.4 | 3 | -×- | 1 | - | — | — | — | false | — |
| STR_AVALANCHE_LAUNCHER | "Avalanche Launcher" | 1 | 3 | -×- | - | - | — | — | — | false | — |
| STR_AVALANCHE_MISSILES | "Avalanche Missiles" | 1.5 | 3 | -×- | 1 | - | — | — | — | false | — |
| STR_CANNON | "Cannon" | 1.5 | 3 | -×- | - | - | — | — | — | false | — |
| STR_CANNON_ROUNDS_X50 | "Cannon Rounds(x50)" | 0.1 | 3 | -×- | 50 | - | — | — | — | false | — |
| STR_FUSION_BALL_LAUNCHER | "Fusion Ball Launcher" | 2.0 | 3 | -×- | - | - | — | — | — | false | — |
| STR_FUSION_BALL | "Fusion Ball" | 0.6 | 3 | -×- | 1 | - | — | — | — | false | — |
| STR_LASER_CANNON | "Laser Cannon" | 2.0 | 3 | -×- | - | - | — | — | — | false | — |
| STR_PLASMA_BEAM | "Plasma Beam" | 1.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_CORPSE | "Corpse" | 0.0 | 22 | 2×3 | - | - | — | — | — | false | — |
| STR_CORPSE_ARMOR | N/A | 0.0 | 24 | 2×3 | - | - | — | — | — | false | — |
| STR_CORPSE_SUIT | N/A | 0.0 | 26 | 2×3 | - | - | — | — | — | false | — |
| STR_ELERIUM_115 | "Elerium-115" | 0.1 | 3 | 1×1 | - | - | — | — | — | false | — |
| HOVERTANK_CORPSE_1 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| HOVERTANK_CORPSE_2 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| HOVERTANK_CORPSE_3 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| HOVERTANK_CORPSE_4 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| TANK_CORPSE_1 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| TANK_CORPSE_2 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| TANK_CORPSE_3 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| TANK_CORPSE_4 | N/A | 0.0 | 3 | 0×0 | - | - | — | — | — | false | — |
| CIVM_CORPSE | N/A | 0.0 | 30 | 2×3 | - | - | — | — | — | false | — |
| CIVF_CORPSE | N/A | 0.0 | 50 | 2×3 | - | - | — | — | — | false | — |
| STR_UFO_POWER_SOURCE | "UFO Power Source" | 0.7 | 3 | -×- | - | - | — | — | — | false | — |
| STR_UFO_NAVIGATION | "UFO Navigation" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_UFO_CONSTRUCTION | "UFO Construction" | 0.1 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_FOOD | "Alien Food" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_REPRODUCTION | "Alien Reproduction" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_ENTERTAINMENT | "Alien Entertainment" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_SURGERY | "Alien Surgery" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_EXAMINATION_ROOM | "Examination Room" | 0.2 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_ALLOYS | "Alien Alloys" | 0.1 | 3 | -×- | - | - | — | — | — | false | — |
| STR_ALIEN_HABITAT | "Alien Habitat" | 0.1 | 3 | -×- | - | - | — | — | — | false | — |
| STR_PERSONAL_ARMOR | "Personal Armor" | 0.8 | 3 | -×- | - | - | — | — | — | false | — |
| STR_POWER_SUIT | "Power Suit" | 0.8 | 3 | -×- | - | - | — | — | — | false | — |
| STR_FLYING_SUIT | "Flying Suit" | 0.8 | 3 | -×- | - | - | — | — | — | false | — |
| STR_SECTOID_COMMANDER | "Sectoid Commander" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOID_LEADER | "Sectoid Leader" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOID_ENGINEER | "Sectoid Engineer" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOID_MEDIC | "Sectoid Medic" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOID_NAVIGATOR | "Sectoid Navigator" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOID_SOLDIER | "Sectoid Soldier" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SNAKEMAN_COMMANDER | "Snakeman Commander" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SNAKEMAN_LEADER | "Snakeman Leader" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SNAKEMAN_ENGINEER | "Snakeman Engineer" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SNAKEMAN_NAVIGATOR | "Snakeman Navigator" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SNAKEMAN_SOLDIER | "Snakeman Soldier" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_ETHEREAL_COMMANDER | "Ethereal Commander" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_ETHEREAL_LEADER | "Ethereal Leader" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_ETHEREAL_SOLDIER | "Ethereal Soldier" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_MUTON_ENGINEER | "Muton Engineer" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_MUTON_NAVIGATOR | "Muton Navigator" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_MUTON_SOLDIER | "Muton Soldier" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_COMMANDER | "Floater Commander" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_LEADER | "Floater Leader" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_ENGINEER | "Floater Engineer" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_MEDIC | "Floater Medic" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_NAVIGATOR | "Floater Navigator" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_FLOATER_SOLDIER | "Floater Soldier" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_CELATID_TERRORIST | "Celatid Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SILACOID_TERRORIST | "Silacoid Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_CHRYSSALID_TERRORIST | "Chryssalid Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_REAPER_TERRORIST | "Reaper Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_SECTOPOD_TERRORIST | "Sectopod Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |
| STR_CYBERDISC_TERRORIST | "Cyberdisc Terrorist" | 0.0 | 3 | -×- | - | - | — | — | — | false | liveAlien |

#### proximity_grenade (1 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_PROXIMITY_GRENADE | "Proximity Grenade" | 0.1 | 3 | -×- | - | HE | — | — | — | false | — |

#### psiamp (2 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_PSI_AMP | "Psi-Amp" | 0.1 | 10 | 1×3 | - | - | — | — | U25 | true | twoHanded |
| ALIEN_PSI_WEAPON | N/A | 0.0 | 3 | -×- | - | - | — | — | U25 | true | — |

#### scanner (1 entries)

| id | display | sz | wt | grid | clip | dmg | compatibleAmmo | requires | TU | flat | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| STR_MOTION_SCANNER | "Motion Scanner" | 0.1 | 3 | -×- | - | - | — | — | U25 | false | — |


### 3.4 Items with research `requires` (**CODE**)

Non-throw battle menu actions on original-X-COM player units fail when `!SavedGame::isResearched(weapon->getRequirements())` (`ActionMenuState.cpp`). Items with non-empty `requires` in xcom1:

| Item id |
|---------|
| `STR_PSI_AMP` |
| `STR_HEAVY_PLASMA`, `STR_HEAVY_PLASMA_CLIP` |
| `STR_PLASMA_RIFLE`, `STR_PLASMA_RIFLE_CLIP` |
| `STR_PLASMA_PISTOL`, `STR_PLASMA_PISTOL_CLIP` |
| `STR_BLASTER_LAUNCHER`, `STR_BLASTER_BOMB` |
| `STR_SMALL_LAUNCHER`, `STR_STUN_BOMB` |
| `STR_ALIEN_GRENADE` |
| `STR_MIND_PROBE` |

Exact research ids are listed under each type in `items.rul`. **Throw** is exempt (`ActionMenuState`, `CompanionSnapshot::companionResearchUsable`).

### 3.5 Bundled inactive mod patches (items only)

| Mod | Effect |
|-----|--------|
| `XcomUtil_Pistol_Auto_Shot` | `STR_PISTOL` gains auto shot |
| `XcomUtil_Improved_Heavy_Laser` | Heavy laser power/TU |
| `XcomUtil_High_Explosive_Damage` | HE damage/radius |
| `XcomUtil_No_Psionics` | Deletes psi items/facilities |
| `UFOextender_Gun_Melee` | Melee stats on human weapons |
| `UFOextender_Psionic_Line_Of_Fire` | LOS on psi gear |
| `Aliens_Pick_Up_Weapons` | `attraction` on alien tech |
| `OpenXCom_Unlimited_Waypoints` | Blaster/HWP launcher waypoints |

---

## 4. Action capability matrix

### 4.1 Distinct mechanisms (22)

**Inventory UI / fixed-TU (not `BattleActionType`):** PICK_UP_GROUND, DROP_TO_GROUND, MOVE_SLOT, SWAP_HANDS (via moves), EQUIP_AUTO (Ctrl+click), RELOAD_DRAG, RELOAD_BUTTON, UNLOAD_BUTTON, INVENTORY_PRIME, INVENTORY_ARRANGE_GROUND, PREBATTLE_EQUIP (`_tu=false`).

**Battle actions (`BattleActionType`):** BA_SNAPSHOT, BA_AUTOSHOT, BA_AIMEDSHOT, BA_LAUNCH, BA_THROW, BA_PRIME, BA_HIT, BA_USE, BA_MINDCONTROL, BA_PANIC, BA_WALK, BA_TURN.

**Not distinct OpenXcom actions:** `CHANGE_AMMUNITION` (reload drag only), `UNPRIME` (no engine unprime), generic `FIRE` (mode-specific), `TRANSFER_GROUND` (same as slot move with `STR_GROUND`).

### 4.2 Matrix

| Action | Engine behavior | Preconditions | TU | Failure | Source | Snapshot | Command | Fair-play |
|--------|-----------------|---------------|-----|---------|--------|----------|---------|-----------|
| **PICK UP** | `moveItem` from tile | Space, TU, companion allow | 6 + `getCost` | No space/TU | `Inventory.cpp`, `takeItemFromGround` | `groundItems` tile | None | Unseen items |
| **DROP** | `moveItem` → ground | TU, tile space | slot→ground | No space | `Inventory.cpp` | After refresh | None | Live grenade |
| **MOVE SLOT** | `moveItem` | Overlap fit | `getCost(dest)` | Overlap | `Inventory.cpp` | slot id only | None | Wrong duplicate |
| **RELOAD** | `setAmmoItem` | Compatible ammo | **15** | Wrong ammo | `checkAmmo`, `Inventory` | `loaded`/`empty` | None | — |
| **UNLOAD** | clip/gun split | Hand layout | **8** | Blocked | `Inventory::unload` | Partial | None | — |
| **INV PRIME** | `setFuseTimer` | Grenade | **0** | — | `PrimeGrenadeState` inv | `primed` | None | Hidden prime |
| **BA_PRIME** | fuse + TU | Hand grenade | 50% base | Already primed | `handleNonTargetAction` | Yes | **PRIME** | Stale fuse |
| **BA_THROW** | projectile | Arc/range | 25% base | Blocked | `validateThrow` | `actionCosts` | **THROW** | — |
| **Fire modes** | projectile | Ammo, research, LOS | RuleItem | Many | `ActionMenuState` | `actionCosts` | Snap/auto/aimed | — |
| **BA_LAUNCH** | waypoints | Blaster item | Aimed TU | WP limit | `launchAction` | launch row | **INFER** partial | — |
| **BA_USE** medikit | `MedikitState` | Target adjacency | `tuUse`/click | No target | `ActionMenuState` | use row | None | — |
| **BA_USE** scanner | `ScannerState` | — | `tuUse` upfront | — | `ActionMenuState` | use row | None | Scanner intel |
| **Mind probe** | `UnitInfoState` | LOS enemy | `tuUse` | Invalid | `primaryAction` | use row | None | Hidden stats |
| **Melee / psi** | `*BState` | Range/skill | `tuMelee`/`tuUse` | — | Various | costs | None | — |
| **Two-handed** | off-hand rules | `isTwoHanded` | — | Placement | `Inventory` | Not explicit | None | — |
| **Death** | drop all | `hasInventory` | — | — | `UnitDieBState` | groundItems | None | — |
| **Panic/MC** | faction/AI | status | — | — | `UnitPanicBState` | brief | Blocked actors | Wrong orders |
| **Unconscious carry** | `BattleItem`→unit | corpse rules | — | — | `BattleItem::_unit` | **MISSING** | None | — |
| **Kneel/fly** | modifiers | posture | 4/8 kneel | — | `BattleUnit` | `kneeled` | **KNEEL** | — |
| **Busy stack** | reject cmd | `isBusy()` | — | Busy | `CompanionCommandRuntime` | Not exported | All | Race |

### 4.3 Companion-executable today (**CODE** `tactical-command.cjs`)

| Mechanism | Remote command |
|-----------|----------------|
| MOVE, KNEEL | Yes |
| SNAP_SHOT, AUTO_SHOT, AIMED_SHOT | Yes |
| PRIME, THROW | Yes (active hand only) |
| RELOAD (15 TU, empty chamber, carried clip by id) | Yes — WP8B1 |
| UNLOAD (8 TU, nested magazine id guard, both hands free except firearm — see WP8B2 doc) | Yes — WP8B2 |
| Other inventory UI operations | **No** |
| BA_USE, psi, melee, launch (except fire overlap) | **No** |
| END_TURN | **Human only** (policy) |

---

## 5. Inventory slots and UI mechanics

### 5.1 Ruleset layout (**CODE** `runtime/m0/bin/standard/xcom1/inventories.rul`)

| Slot id | Type | Grid |
|---------|------|------|
| `STR_RIGHT_HAND` / `STR_LEFT_HAND` | hand (1) | 2×3 cells (`RuleInventory::HAND_W/H`) |
| `STR_BELT` | slot | 6 defined cells |
| `STR_BACK_PACK` | slot | 3×3 |
| `STR_RIGHT_SHOULDER` / `STR_LEFT_SHOULDER` | slot | 2×1 each |
| `STR_RIGHT_LEG` / `STR_LEFT_LEG` | slot | 2×1 each |
| `STR_GROUND` | ground (2) | Tile-linked; `arrangeGround` pagination |

Cell size: **16×16** px (`RuleInventory::SLOT_W/H`).

### 5.2 Move TU costs

Defined pairwise under each slot’s `costs:` in `inventories.rul` (example: ground → backpack **20**, ground → belt **12**, hand ↔ hand **4**). Applied when `_tu` is true: `spendTimeUnits(item->getSlot()->getCost(newSlot))`.

### 5.3 UI → engine

| Gesture | Engine |
|---------|--------|
| Drag-drop | `Inventory::mouseClick` |
| Ctrl+click quick stow | Auto slot by `battleType` / size |
| R-click grenade | Prox fuse 0 or inventory `PrimeGrenadeState` |
| Unload / ground buttons | `unload`, `arrangeGround` |

### 5.4 Future inventory command identity

| Field | Today | Needed |
|-------|-------|--------|
| Soldier | `player_soldiers[].id` | Same |
| Item | `itemType` only | `BattleItem::getId()` |
| Source/dest | slot string | slot + `(x,y)` |
| Ground | tile in `groundItems` | instance or correlation token |

---

## 6. Research restrictions

**Message:** `STR_UNABLE_TO_USE_ALIEN_ARTIFACT_UNTIL_RESEARCHED` when original player unit selects a non-throw action without `isResearched(RuleItem::requires)` (`ActionMenuState.cpp`).

**UI:** Unresearched items show `STR_ALIEN_ARTIFACT` on mouseover (`InventoryState::invMouseOver`) but naming concealment ≠ use block for drag.

**Companion:** `companionResearchUsable` sets `actionCosts.usable`; ground export uses `unidentified_*` categories when unresearched (`CompanionGroundItemMemory.cpp`).

**Bypass risk:** New inventory executor must mirror `isResearched` and `getItemUsable` on every path.

---

## 7. Existing Companion coverage

| Field | Inventory use |
|-------|----------------|
| `units[].hands` / `inventory` | Layout, ammo, fuse (no id/x/y) |
| `units[].actionCosts` | Fire/grenade preflight (optional) |
| `groundItems` | Intel; insufficient for pickup |
| `unitStateBrief` | Psych/MC; no inventory |
| `commandBinding` | Actors; no loadout |

Fair-play: no hostile/MC inventory; ground LOS/memory; research concealment (**CODE** WP9 ground-item tests in `companion/m0-publish`).

---

## 8. Fair-play and command safety

Extend existing: `snapshot_sha256`, `state_version`, `session_id`, turn, `player_soldiers`, ownership, idle gate, one command, terminal result. **END_TURN** remains human-only.

Treat inventory mutations like movement: invalidate stale SHA/version. Watch primed explosives, MC/panic actors, death drops mid-turn.

---

## 9. Recommended implementation phases

| Phase | Scope | Snapshot | Commands |
|-------|--------|----------|----------|
| **A** | Observe accurately | `battleItemId`, x/y, weight | None |
| **B** | Drop/pickup/slot moves | Ground correlation | `INVENTORY_MOVE`, `DROP`, `PICKUP` |
| **C** | Reload/unload | Ammo instance ids | `RELOAD`, `UNLOAD` |
| **D** | Grenades from belt | Full fuse on all slots | Extend `PRIME`/`THROW` source |
| **E** | Medikit/scanner/probe/psi | Targets, charges | `USE` subtypes |

**WP8A = Phase A.** Tests: extend `companion_snapshot_*_test.cpp`, `tactical-command-m1-*.test.cjs`, New Battle harness.

---

## 10. Test matrix

| Case | Available in xcom1 baseline |
|------|----------------------------|
| Multiple identical magazines | Yes |
| AC AP/HE/I variants | Yes |
| Empty weapon / reload / unload | Yes |
| Grenade prime/throw, alien timer, prox | Yes |
| Blaster waypoints | Yes (research gated) |
| Mind probe, psi amp, medikit, stun rod | Yes |
| Unconscious / full backpack / ground gear | Yes (**INFER** unconscious carry live) |
| MC / panic / ownership reclaim | Scenario |
| Unresearched plasma use block | Yes |
| TFTD-only items | No (xcom2 inactive) |

---

## 11. Open questions and source limitations

1. No `companion-rules-reference.json` in repo — merged runtime not byte-verified.  
2. Inventory modal open state not exported.  
3. Panic inventory drop not fully traced in `UnitPanicBState.cpp`.  
4. Blaster `BA_LAUNCH` vs directed-fire command path — live verify.  
5. Unresearched artifact equip via drag — partial UI-only evidence.  
6. Friendly HWP equipment is **intentionally omitted** in M1: `exportFriendlyTacticalDetails()` requires a geoscape roster soldier; HWPs export only the sparse unit shell (`id`, `faction`, `originalFaction`, `position`) and are excluded from `commandBinding.player_soldiers` and tactical equipment brief — see `m0-publish/docs/M1-wp2-unit-state-schema.md` (Issue #3). Richer HWP loadout observation is **deferred**, not a missing v3 bug.
7. Canonical binary not executed this session.

---

*End of M1 Battlescape WP8 inventory audit.*
