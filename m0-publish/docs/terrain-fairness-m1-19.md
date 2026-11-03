# Terrain fairness policy (M1-19)

## Player UI baseline

OpenXcom’s battlescape UI shows:

- **Undiscovered** map areas as black fog (no geometry).
- **Discovered** tiles in the geoscape-style map view with last-known layout; **currently visible** tiles are fully lit.
- The player does **not** receive a separate historical terrain database—discovered off-screen tiles still exist in the save as live `Tile` objects.

## Companion export vs UI

| Topic | Finding | Policy |
|-------|---------|--------|
| Undiscovered geometry | Omitted from snapshot terrain records (`disc == 0`). | **No leak** of undiscovered cells in terrain blob. |
| Off-LOS discovered tiles | Export reads **live** engine tiles at snapshot time (`terrain.memoryNote`). | **Limitation (documented):** changes off current LOS (doors, damage) may appear in export before the player re-observes them—same underlying save state the engine uses, not a separate AI-only channel. |
| UFO door walk costs off-LOS | Prior capture used `MapData::getTUCost` when `isUFODoor() && !inLos`, bypassing tile state. | **Corrected (M1-19):** always use `Tile::getTUCost` so exported walk costs match what discovery/export rules allow; no special off-LOS UFO-door path. |
| terrainBrief | Labels `CURRENTLY_VISIBLE` vs `DISCOVERED_NOT_CURRENTLY_VISIBLE`; warns off-LOS is not historical memory. | **Honest**; does not claim observation turn or guaranteed paths. |

## Not invented

We do **not** implement historical terrain memory or “last seen” snapshots in this milestone.

## Residual limitation

Off-LOS **live** geometry in authorized discovered records remains a fair-play discussion: it mirrors engine save state, not omniscient map knowledge. True memory semantics require a future `packed-v2` / `lastDirectlyObservedTurn` extension (see terrainBrief `futureEngineExtensionProposal`).
