'use strict';

/**
 * Fair-play rules for HE / grenade / launch perception (P2 briefing, M1 B7 close-out).
 * Engine hooks unchanged — documentation + programmatic mirror for agents.
 */

function getExplosivePerceptionContractMarkdown() {
  return [
    '**Explosive perception (fair-play):**',
    '- `explosion_observed_or_heard` (blast visible or audio-only) does **not** identify the source unit. Never infer a hidden alien from blast position or sound alone.',
    '- A visible `grenade_throw_observed` or `explosive_launch_observed` confirms only that throw/launch observation (type, tile, hostile `subjectUnitId` when export includes it). It does **not** automatically authorize kill attribution on a later blast.',
    '- Confirm casualties only with explicit export evidence: `combat_casualty_attributed` (visible fatal actor gates), `soldier_down` / roster ledger, or `hostile_casualty_tile_observed` under LOS rules — not proximity to an explosion alone.',
    '- `explosionOriginClass: unit_death_detonation` is allowed only when engine fair-play gates pass (visible blast **and** visible source unit class); it still omits `subjectUnitId`. Do not treat it as universal grenade or terrain labeling.',
    '- Do not merge throw and blast events into a hidden-attribution narrative without exported `combat_casualty_attributed`.',
    '- Carried-unconscious HE damage vs perception remains a separate engine risk (`ASTER-EXPLOSION-CORRECTNESS-01`); do not infer extra intelligence from explosion effects on unconscious bodies.',
  ].join('\n');
}

module.exports = {
  getExplosivePerceptionContractMarkdown,
};