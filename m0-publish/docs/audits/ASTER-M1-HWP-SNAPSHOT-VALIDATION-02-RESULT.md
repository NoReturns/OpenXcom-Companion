# ASTER-M1-HWP-SNAPSHOT-VALIDATION-02 — Publisher fix result

**Status:** Implemented (publisher only). Await operator review before deploy/commit.

## Change

`companion/m0-publish/lib/friendly-hwp-observation-v1.cjs` — `fixedWeapons[].battleItemId` and optional `fixedWeapons[].loaded.battleItemId` now use the same non-negative engine item id range as roster equipment (`min: 0`, `max: 2147483647`), matching `tactical-publish.cjs` `validateEquipmentItem` / `validateLoaded` / `validateNestedAmmo`.

**Cause of live SEND failure:** Cannon tank exported `fixedWeapons[0].battleItemId: 0` (first `BattleItem` in battle); HWP validator previously required `min: 1`.

## Regression

- Fixture: `test/fixtures/friendly-hwp-battle-item-id-zero.yaml`
- Tests: `test/friendly-hwp-observation-v1.test.cjs` (id `0`, positive ids, negative rejection)

## Follow-up (out of scope for -02)

**HWP-S1 normalization gap:** `validateFixedWeapon()` allows `nestedAmmo`, `slot`, `inventorySlotType`, and `hand` in `WEAPON_KEYS` but does not copy them onto the validated weapon object (engine export includes them via `buildEquipmentItemNode`). Not a SEND blocker once `battleItemId` accepts `0`, but **must be addressed before HWP directed-fire / ammo identity integration** so relay binding matches export. Track as separate HWP equipment passthrough work — do not fold into validation-only repair.

## Operator

After promoting updated publisher to the relay daemon (no battle restart required), retry SEND on the open battle.