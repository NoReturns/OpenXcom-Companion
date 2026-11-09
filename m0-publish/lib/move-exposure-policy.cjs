'use strict';

/**
 * Advisory pre-MOVE exposure and reaction-fire planning (P1-REACTION-RISK-02C).
 * Instructions only — no scoring, no command gates, no persisted threat fields.
 */

const MOVE_EXPOSURE_POLICY_RULES = [
  {
    id: 'exposure_before_move',
    rule:
      'After mandatory status, equipment, and hostile-intelligence review, evaluate movement exposure before publishing MOVE. This is advisory reasoning, not a hard block.',
  },
  {
    id: 'known_vs_possible_vs_unknown',
    rule:
      'KNOWN THREAT = current engine-visible hostile with facing in tactical.units[] (confirmed_current_los per hostile-intelligence consumer). POSSIBLE THREAT = off-LOS discovered tiles, flanking unknowns, or plausible exposure without current LOS. UNKNOWN EXPOSURE = unseen map areas or unseen enemies — not automatically dangerous.',
  },
  {
    id: 'no_last_seen_as_live',
    rule:
      'perceptionLog unit_last_seen and last_seen coordinates are historical. Never treat them as confirmed current hostile positions.',
  },
  {
    id: 'neutrals_not_hostile',
    rule:
      'Neutrals and civilians are not hostile reaction-fire threats for planning.',
  },
  {
    id: 'reaction_fire_mechanics',
    rule:
      'Reaction fire may occur between movement steps while a MOVE executes; the operator cannot issue another command mid-walk. movement_stop_reason reaction_fire means the reaction sequence interrupted the walk — not confirmed hit or damage. hostile_spotted does not imply reaction fire.',
  },
  {
    id: 'no_hidden_stats',
    rule:
      'Do not assume hidden aliens have zero reaction skill or cannot react. Lack of observation does not prove absence of reaction capability.',
  },
  {
    id: 'route_uncertainty',
    rule:
      'Use terrain visibility/floor ASCII and walkF/walkO for planning hints only. Do not invent exact path cost, step count, or line-of-fire geometry when the snapshot does not supply it. State uncertainty instead of treating straight-line distance as authoritative.',
  },
  {
    id: 'staged_move_preference',
    rule:
      'Prefer shorter or staged MOVEs when exposure is tactically important, known hostiles threaten the route, a covered intermediate tile is observable, or a long move commits most remaining TUs. Do not mandate one-tile moves or reject every exposed route.',
  },
  {
    id: 'aggressive_allowed',
    rule:
      'Longer or exposed MOVEs remain valid for emergency extraction, rescue, critical objectives, imminent danger, or accepted tactical risk — document the justification briefly when choosing them.',
  },
  {
    id: 'strategic_not_tactical_only',
    rule:
      'Weigh movement risk against campaign and mission context — not only map-local exposure. Mission score, minimum casualties, lowest reaction exposure, maximum remaining TUs, and clearing every hostile are factors, not universal objectives.',
  },
  {
    id: 'strategic_context_factors',
    rule:
      'When information exists, consider: campaign objectives, this mission’s objectives, plausible campaign consequences (funding, future position), value of soldiers and scarce gear, benefit of completing or partially completing the mission, and cost of withdrawal or failure. When campaign or geoscape context is absent from the briefing, state that uncertainty explicitly — do not invent rewards or funding formulas.',
  },
  {
    id: 'deliberate_risk',
    rule:
      'Risk-taking should be deliberate and proportionate to objectives and knowledge. Authorized high-risk MOVEs (AI-owned soldiers only) are valid when strategically justified. Do not automatically sacrifice soldiers; do not override human-controlled soldier ownership.',
  },
  {
    id: 'no_snapshot_spam',
    rule:
      'Do not require a fresh snapshot between every verified COMPLETE MOVE. Do not chain moves solely to farm observations.',
  },
  {
    id: 'post_interrupt',
    rule:
      'After terminal INTERRUPTED/FAILED MOVE: runMandatoryPostCommandPrelude, refresh binding when recovery requires it, replan from final_position, re-read hostile observations, and avoid blind re-publish of the same destination with stale binding.',
  },
  {
    id: 'incomplete_not_event',
    rule:
      'movement_incomplete and no_progress are engine fallback categories — not confirmed battlefield events (not synonymous with hostile spotted or reaction fire).',
  },
];

const MOVE_EXPOSURE_EXAMPLES = [
  {
    id: 'known_hostile_near_route',
    situation: 'Known hostile with confirmed current LOS near the planned route.',
    decision:
      'Treat as KNOWN THREAT. Prefer a shorter MOVE to an observable covered tile, kneel if useful, or accept documented risk. Face the threat; do not assume the alien cannot react.',
  },
  {
    id: 'uncertain_open_ground',
    situation: 'Open ground toward the destination; no hostiles in units[]; last_seen is stale.',
    decision:
      'POSSIBLE/UNKNOWN exposure only. last_seen is not a live position. Consider a shorter MOVE to an observable tile; state that reaction capability is unknown. Do not claim cover that terrain does not show.',
  },
  {
    id: 'emergency_skyranger',
    situation: 'Soldier must reach Skyranger ramp under fire; mission time critical.',
    decision:
      'Long exposed MOVE may be justified. Publish MOVE with explicit risk acceptance; expect reaction_fire or hostile_spotted interruption; prepare to replan from final_position after terminal result.',
  },
];

function getMoveExposurePolicyMarkdown() {
  const lines = [
    '## Pre-MOVE exposure and reaction fire (advisory)',
    '',
    'Apply **after** hostile intelligence review and **before** authoring MOVE (same briefing, no extra relay fields).',
    '',
    '### Exposure classes (qualitative — not persisted)',
    '',
    '- **KNOWN THREAT** — `classifyCurrentHostileObservation()` → `confirmed_current_los` hostiles in `tactical.units[]` with facing.',
    '- **POSSIBLE THREAT** — off-LOS discovered approaches, plausible ambush axes, or multiple hostiles near a corridor without full geometry proof.',
    '- **UNKNOWN EXPOSURE** — unseen tiles or unobserved enemies; unknown ≠ confirmed safe.',
    '',
    '### Before MOVE — checklist',
    '',
    '1. List **known** hostiles (current LOS only) threatening the actor or route.',
    '2. Note **possible** exposure (terrain visibility layers, open floor, long crossing) without inventing LOS math.',
    '3. Estimate TU budget from `walkF`/`walkO` and **remaining TUs** — rough only; engine path is authoritative at execution.',
    '4. Ask whether a **shorter intermediate destination** or covered tile reduces risk with acceptable mission cost.',
    '5. State **reaction-fire exposure**: any KNOWN hostile may react during the walk; absence of data does not disprove reaction capability.',
    '6. Weigh **strategic context** (campaign/mission objectives, troop and gear value, withdrawal vs partial success) — exposure and casualties are inputs, not automatic optima.',
    '7. If risk is high but strategically justified, proceed with **brief documented justification** (extraction, rescue, urgent objective, campaign-critical outcome).',
    '',
    '### Strategic context (campaign-aware, advisory)',
    '',
    'Individual mission score and maximum survival are **not always** the primary goals. A tactically costly move may strengthen the campaign; a “clean” fight may weaken it through losses or depleted resources.',
    '',
    'Before choosing exposure level, note what you know about: mission objectives, broader campaign stakes, soldier/equipment scarcity, partial mission value, and withdrawal or failure consequences. Do **not** assume all missions reward the same tradeoffs; do **not** invent funding or promotion math without relay data.',
    '',
    '### Reaction fire (verified mechanics)',
    '',
    '- Reaction checks can run **between movement steps**; another Companion command cannot be issued until the MOVE is terminal.',
    '- `reaction_fire` on the result means interruption by the reaction sequence — **not** confirmed hit or damage.',
    '- `hostile_spotted` means new hostile contact ended the walk — **not** proof of reaction fire.',
    '',
    '### After interrupted MOVE',
    '',
    '1. `runMandatoryPostCommandPrelude({ result, command })`.',
    '2. When `requiresFreshBindingBeforeNextPublish` is true, refresh binding (SEND or post-command state when available).',
    '3. Re-run hostile/intel review on fresh state; plan from **`final_position`** with a new `command_id`.',
    '4. Do not resubmit the same destination on stale `snapshot_sha256` / `state_version`.',
    '',
    '### Policy rules',
    '',
  ];
  for (const item of MOVE_EXPOSURE_POLICY_RULES) {
    lines.push(`- **${item.id}:** ${item.rule}`);
  }
  lines.push('', '### Example decisions (patterns, not orders)', '');
  for (const ex of MOVE_EXPOSURE_EXAMPLES) {
    lines.push(`- **${ex.id}:** ${ex.situation} → ${ex.decision}`);
  }
  return lines.join('\n');
}

module.exports = {
  MOVE_EXPOSURE_POLICY_RULES,
  MOVE_EXPOSURE_EXAMPLES,
  getMoveExposurePolicyMarkdown,
};
