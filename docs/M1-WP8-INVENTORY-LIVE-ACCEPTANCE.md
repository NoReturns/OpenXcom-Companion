# M1 — WP8 inventory live acceptance (grouped session)

**Date:** 2026-11-06  
**Purpose:** Single operator runbook for a **future** grouped live test of **`RELOAD`**, **`UNLOAD`**, **`INVENTORY_MOVE`**, **`PICKUP`**, **`DROP`**, plus **read-only** WP8C **loot awareness** (`groundItems`, `hostile_casualty_tile_observed`).  
**Constraints:** One tactical command per transaction; fresh F6 binding each time; **no** `END_TURN` automation; **no** raw GitHub Contents API PUT — use `companion/m0-publish/publish-tactical-command-once.cjs` only when authorized (`AGENTS.md`).

---

## A. Pre-flight (before starting)

1. **Engine / deployment**  
   - Confirm **canonical** `runtime\m0\bin\openxcom.exe` version matches the branch under test (separate step; **do not** overwrite canonical in this document’s scope).

2. **Relay / executor**  
   - GitHub repo has fresh `m0/state.json` pipeline; executor sidecar can write `tactical-result.json`.  
   - **No** stale `request_in_flight` / inbox lock from a prior session (clear per existing relay runbook).

3. **Session + ownership**  
   - `companion-soldier-control.json` lists **AI-owned** test soldiers only for automation.  
   - Human soldiers remain **NOT_AI_CONTROLLED**.

4. **Snapshot freshness**  
   - Each action: new **F6** export; note `snapshot_sha256`, `eventLog.sessionId`, `eventLog.latestSeq` (= **`state_version`**), `turn`.

5. **Inventory setup (New Battle / skirmish)**  
   - One or two **AI-owned** soldiers.  
   - Per soldier: one loaded firearm, compatible spare ammo (belt/backpack), one extra **droppable** loose item, free **ground** capacity, enough **TUs**, safe firing lane (no friendlies).  
   - Adjust to **vanilla** ruleset if test mod differs.

6. **Item identity**  
   - Record **`battleItemId`** for every manipulated item from **`units[]`** (hands + **inventory** rows + **`groundInventory`** for pickup).

---

## B. Test matrix (each command)

**For every row:** Initial F6 → compose → `publish-tactical-command-once.cjs --dry-run` → `--publish` (when allowed) → wait **`tactical-result.json`** terminal → F6 again.

| Command | Preconditions | Expected transition | TU | Terminal | Snapshot delta | Failure signs | Recovery |
|--------|----------------|---------------------|-----|----------|----------------|---------------|----------|
| **RELOAD** | Spare magazine in carried section; weapon accepts it; enough TUs | Magazine in weapon; spare removed from old slot | Ruleset transfer + reserved TU | **COMPLETED**, `tu_spent` | Hands + inventory rows updated | **REJECTED** / **INSUFFICIENT_TU** | Refresh F6; verify ids; retry new `command_id` |
| **UNLOAD** | Loaded weapon | Magazine becomes carried item | Ruleset unload cost | **COMPLETED** | Nested ammo disappears from `hands` | Wrong hand / nested targeting | See WP8B2 doc |
| **INVENTORY_MOVE** | Item in source slot; destination free | Item at new coords | Section→section costs | **COMPLETED** | `inventory` coords | **PRIMED_EXPLOSIVE_NOT_MOVABLE**, fit errors | Stow grenades first |
| **DROP** | Carried item; ground space on tile | Item on actor tile ground grid (engine-chosen cell) | Section→ground | **COMPLETED** | Item out of carried; appears in **`groundInventory`** if you F6 on tile | **INVALID_GROUND_DESTINATION** | Re-arrange ground |
| **PICKUP** | Actor **on** item tile; item in **`actor.groundInventory`** | Item in destination section | Ground→section | **COMPLETED** | Ground row removed | **GROUND_ITEM_NOT_KNOWN**, mismatch | Must F6 on **same tile** |

**Magazine swap sequence (one command at a time)**  
1. **UNLOAD**  
2. **`INVENTORY_MOVE`** (if spare is not in hand / needs stow)  
3. **RELOAD**

**Drop + pickup**  
1. **DROP** (loose test item)  
2. New F6 → **PICKUP** using exact **`battleItemId`** from **`groundInventory`**.

**Docs:** `M1-BATTLESCAPE-WP8B1-RELOAD.md`, `M1-BATTLESCAPE-WP8B2-UNLOAD.md`, `M1-BATTLESCAPE-WP8B3-INVENTORY-MOVE.md`, `M1-BATTLESCAPE-WP8B4-GROUND-PICKUP-DROP.md`.

---

## C. WP8C fair-play observation (optional but recommended)

**Goal:** Prove **read-only** cues remain non-authoritative.

1. **Visible ground or kill**  
   - Cause a **visible** hostile death **or** place a visible ground item several tiles from the actor.  
   - F6: check **`groundItems.observations[]`** (`CONFIRMED_IN_LOS`) and/or **`perceptionLog.events[]`** for **`hostile_casualty_tile_observed`** (`confidence`: **`possible_ground_equipment`** or **`alien_casualty_tile`**).

2. **Move away**  
   - Retreat until tile is off LOS.  
   - F6: if remembered, status may show **`REMEMBERED_OFF_LOS`** — **not** current ground state.

3. **Approach tile**  
   - Move to the tile; fresh F6.  
   - Confirm **`actor.groundInventory`** lists exact **`battleItemId`** — **only** then compose **PICKUP**.

**Rules**

- **Never** construct **PICKUP** from **`groundItems`** or perception alone.  
- Treat **`possible_ground_equipment`** as **maybe**, not confirmed weapon type.

**Design reference:** `M1-BATTLESCAPE-WP8C-LOOT-AWARENESS.md`.

---

## D. Failure handling (reference)

| Outcome | Meaning | Action |
|---------|---------|--------|
| **REJECTED** | Engine/validation refused | Read `reason` / `rejectReason` in result; fix snapshot or TU |
| **INTERRUPTED** | Session/binding reset mid-flight | New F6; new binding; new `command_id` |
| **FAILED** | Internal / unexpected | Capture logs; no replay of same `command_id` |
| **EXECUTING** (stuck) | Await terminal | Executor/relay diagnostics per runbook |
| **NOT_AI_CONTROLLED** | Soldier not AI-owned | Adjust `companion-soldier-control.json` |
| **stale binding** | `state_version` / `snapshot_sha256` mismatch | Mandatory fresh F6 |
| **request_in_flight** | Prior command not retired | Complete or clear per relay procedure |
| **inbox_occupied** | Another command pending | Wait / clear competing inbox |

---

## E. Result collection table (copy for session notes)

| Command | Command ID | Initial snapshot SHA | Terminal status | Expected TU | Actual TU | Item `battleItemId` | Post snapshot OK? | Pass/Fail |
|---------|--------------|----------------------|-----------------|-------------|-----------|---------------------|-------------------|-----------|
| RELOAD | | | | | | | | |
| UNLOAD | | | | | | | | |
| INVENTORY_MOVE | | | | | | | | |
| DROP | | | | | | | | |
| PICKUP | | | | | | | | |

**Overall session:** PASS / FAIL — requires **all** planned commands **COMPLETED** with plausible TU and coherent snapshot deltas.

---

## F. References

- `AGENTS.md` — binding, cooperative autonomy, CLI publish only.  
- `companion/m0-publish/docs/tactical-command-m1-20b.md` — operator procedure detail.  
- `M1-BATTLESCAPE-WP8C-LOOT-AWARENESS.md` — WP8C snapshot semantics.
