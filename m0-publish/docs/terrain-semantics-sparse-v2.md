# Terrain semantics transport — `sparse-v2` (M1-WP8)

Extends `sparse-v1` with **discovered off-LOS structure categories** and **in-LOS door open bits**.
Pairs with `packed-v1` geometry. `sparse-v1` remains decodable for older snapshots.

## YAML envelope

```yaml
terrain:
  semantics:
    encoding: sparse-v2
    recordCount: <u32>
    data: "<canonical base64>"
```

## Binary blob

Magic `OXTS`, format version **`2`**, 3 reserved zero bytes, `recordCount` u32 LE, records sorted **z, y, x**.

Each record:

1. `x, y, z, partFlags` (same bit layout as sparse-v1)
2. One category byte per set part flag (same ids as sparse-v1)
3. `meta` byte:
   - bit0: tile was in player LOS at export
   - bit1: body door open (only when body category is UFO_DOOR or ORDINARY_DOOR and bit0 set)
   - bit2: west door open (same rule)
   - bit3: north door open (same rule)
   - bit4: `O_FLOOR` has `isGravLift()` (movement-relevant grav lift floor; independent of object-first `sem.body`)
   - bits5–7: reserved (must be 0 on encode)

Max record length **8** bytes.

## Grav-lift acceptance (P5, Battleship harness)

Disposable full-reveal Battleship exports (`STR_BATTLESHIP`, seeds 42001/42002, `BattlescapeGenerator` harness) with **bit4** present show **37** movement-relevant grav-lift **floor** tiles (`structureMeta.floorGravLift`) and **23** geometry-verified same-`(x,y)` vertical links in Node `gravLiftStructures`. An earlier audit counted only sparse `sem.body === GRAV_LIFT` on object-first tiles (**14** on those maps) and concluded **no** verified column links — that was **incomplete semantic capture**, not absent UFO geometry. Authoritative floor classification uses bit4 / `O_FLOOR` `isGravLift()`, not `sem.body` alone.

## Fairness

| Data | Rule |
|------|------|
| Structure category | Emitted for **discovered** parts from MapData + dataset role (same classifier as WP1), including off-LOS discovered tiles. |
| Door open/closed | Emitted only when tile is **in player LOS** at export and part is a classified door. |
| Undiscovered cells | Never appear in terrain records. |
| UFO layout / modules | Not exported (no MapBlock graph). |

Door state uses live `Tile` animation frame for UFO doors and closed swinging-door MapData for ordinary doors.
