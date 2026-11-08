'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const {
  parseAndValidate,
  buildWeaponFireActorAllowlist,
  loadAndValidateSnapshotFromText,
} = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

function v4Root(overrides = {}) {
  const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
  return { ...base, ...overrides };
}

describe('eventLog historical roster actors (M1 turn-6 regression)', () => {
  it('allows weapon_fired from roster soldier absent from units[] (post-death export gap)', () => {
    const raw = v4Root();
    raw.units = raw.units.filter((unit) => unit.id !== 2);
    raw.eventLog.events.push({
      seq: 4,
      type: 'weapon_fired',
      turn: 2,
      actorUnitId: 2,
      weaponItemType: 'STR_PISTOL',
      actionType: 'snap',
      target: [3, 3, 0],
    });
    raw.eventLog.latestSeq = 4;
    const tactical = parseAndValidate(raw);
    assert.equal(tactical.eventLog.events.length, 4);
    assert.equal(tactical.eventLog.events[3].actorUnitId, 2);
  });

  it('still rejects hostile actorUnitId in weapon_fired events', () => {
    const raw = v4Root();
    raw.eventLog.events.push({
      seq: 4,
      type: 'weapon_fired',
      turn: 1,
      actorUnitId: 1000000,
      weaponItemType: 'STR_PLASMA_RIFLE',
      actionType: 'snap',
      target: [5, 5, 0],
    });
    raw.eventLog.latestSeq = 4;
    assert.throws(
      () => parseAndValidate(raw),
      /friendly soldier or recorded roster combatant/,
    );
  });

  it('buildWeaponFireActorAllowlist merges active friendlies and log roster actors', () => {
    const raw = v4Root();
    const allow = buildWeaponFireActorAllowlist(raw.units, raw.eventLog.events);
    assert.equal(allow.has(1), true);
    assert.equal(allow.has(2), true);
    assert.equal(allow.has(1000000), false);
  });

  it('accepts turn-6-style fixture: unit 13 fires then leaves units[]', () => {
    const raw = v4Root({ turn: 6 });
    raw.units = raw.units.filter((unit) => unit.id !== 1);
    raw.eventLog = {
      sessionId: 'c9742fdf2e23046a747b35e701347414',
      oldestSeq: 44,
      latestSeq: 44,
      droppedCount: 0,
      events: [{
        seq: 44,
        type: 'weapon_fired',
        turn: 6,
        actorUnitId: 13,
        weaponItemType: 'STR_PISTOL',
        actionType: 'snap',
        target: [40, 45, 0],
      }],
    };
    const tactical = loadAndValidateSnapshotFromText(YAML.stringify(raw), YAML);
    assert.equal(tactical.turn, 6);
    assert.equal(tactical.eventLog.events[0].actorUnitId, 13);
  });
});
