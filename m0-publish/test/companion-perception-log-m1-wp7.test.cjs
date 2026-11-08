'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ValidationError, parseAndValidate } = require('../lib/tactical-publish.cjs');

const FIXTURE_V4 = path.join(__dirname, 'fixtures', 'valid-v4.yaml');

function v4Root(overrides = {}) {
  const base = YAML.parse(fs.readFileSync(FIXTURE_V4, 'utf8'));
  return { ...base, ...overrides };
}

function emptyPerceptionMeta(events) {
  return {
    sessionId: 'a1b2c3d4e5f6789012345678abcdef01',
    oldestSeq: events.length ? 1 : 0,
    latestSeq: events.length ? events.length : 0,
    droppedCount: 0,
    events,
  };
}

function trajectoryObservedEvent(overrides = {}) {
  return {
    seq: 1,
    type: 'projectile_direction_observed',
    turn: 2,
    perceptionChannel: 'seen',
    confidence: 'trajectory_observed',
    positionKnown: true,
    position: [1, 1, 0],
    travelDirection: 'northwest',
    incomingBearing: 'southeast',
    ...overrides,
  };
}

describe('M1-WP7 projectile_direction_observed validation', () => {
  it('accepts SE-to-NW observed trajectory', () => {
    const tactical = parseAndValidate(
      v4Root({
        perceptionLog: emptyPerceptionMeta([trajectoryObservedEvent()]),
      })
    );
    assert.equal(tactical.perceptionLog.events[0].travelDirection, 'northwest');
    assert.equal(tactical.perceptionLog.events[0].incomingBearing, 'southeast');
  });

  it('accepts reversed bearing pair', () => {
    const tactical = parseAndValidate(
      v4Root({
        perceptionLog: emptyPerceptionMeta([
          trajectoryObservedEvent({
            travelDirection: 'southeast',
            incomingBearing: 'northwest',
          }),
        ]),
      })
    );
    assert.equal(tactical.perceptionLog.events[0].incomingBearing, 'northwest');
  });

  it('accepts single visible sample as trajectory_unavailable', () => {
    const tactical = parseAndValidate(
      v4Root({
        perceptionLog: emptyPerceptionMeta([
          {
            seq: 1,
            type: 'projectile_direction_observed',
            turn: 2,
            perceptionChannel: 'seen',
            confidence: 'trajectory_unavailable',
            positionKnown: true,
            position: [4, 4, 0],
          },
        ]),
      })
    );
    assert.equal(tactical.perceptionLog.events[0].travelDirection, undefined);
  });

  it('rejects trajectory_observed without direction fields', () => {
    assert.throws(
      () =>
        parseAndValidate(
          v4Root({
            perceptionLog: emptyPerceptionMeta([
              {
                seq: 1,
                type: 'projectile_direction_observed',
                turn: 2,
                perceptionChannel: 'seen',
                confidence: 'trajectory_observed',
                positionKnown: true,
                position: [1, 1, 0],
              },
            ]),
          })
        ),
      /travelDirection required/
    );
  });

  it('rejects hidden shooter subjectUnitId on projectile direction', () => {
    assert.throws(
      () =>
        parseAndValidate(
          v4Root({
            perceptionLog: emptyPerceptionMeta([
              trajectoryObservedEvent({ subjectUnitId: 1000001 }),
            ]),
          })
        ),
      /must not identify shooter/
    );
  });

  it('rejects heard-only projectile direction with coordinates', () => {
    assert.throws(
      () =>
        parseAndValidate(
          v4Root({
            perceptionLog: emptyPerceptionMeta([
              trajectoryObservedEvent({
                perceptionChannel: 'heard',
                confidence: 'audio_only',
              }),
            ]),
          })
        ),
      (err) => err instanceof ValidationError
    );
  });

  it('rejects direction fields on non-projectile events', () => {
    assert.throws(
      () =>
        parseAndValidate(
          v4Root({
            perceptionLog: emptyPerceptionMeta([
              {
                seq: 1,
                type: 'gunfire_observed',
                turn: 1,
                perceptionChannel: 'heard',
                confidence: 'audio_only',
                positionKnown: false,
                travelDirection: 'north',
              },
            ]),
          })
        ),
      /travelDirection invalid for type/
    );
  });

  it('rejects trajectory_unavailable with direction fields', () => {
    assert.throws(
      () =>
        parseAndValidate(
          v4Root({
            perceptionLog: emptyPerceptionMeta([
              trajectoryObservedEvent({
                confidence: 'trajectory_unavailable',
                travelDirection: 'north',
                incomingBearing: 'south',
              }),
            ]),
          })
        ),
      /must not include travelDirection when unavailable/
    );
  });

  it('preserves perceptionLog across repeated parse (F6 idempotency at schema layer)', () => {
    const raw = v4Root({
      perceptionLog: emptyPerceptionMeta([trajectoryObservedEvent()]),
    });
    const first = parseAndValidate(raw);
    const second = parseAndValidate(raw);
    assert.deepEqual(first.perceptionLog, second.perceptionLog);
  });
});
