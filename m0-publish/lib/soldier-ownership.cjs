'use strict';

const {
  parseSoldierControlDocument,
  relayControlBindingMatches,
  SoldierControlParseError,
} = require('./soldier-control-relay.cjs');

/**
 * Mirrors engine CompanionSoldierOwnershipCore defaults (local file only).
 */
function isAiControlledUnit(controlFileJson, battleSessionId, unitId, bindingContext = null) {
  if (!controlFileJson || !battleSessionId) {
    return false;
  }
  let doc;
  try {
    doc = parseSoldierControlDocument(controlFileJson);
  } catch (error) {
    if (error instanceof SoldierControlParseError) {
      return false;
    }
    return false;
  }
  const ctx = bindingContext
    ? { session_id: battleSessionId, ...bindingContext }
  : { session_id: battleSessionId };
  if (!relayControlBindingMatches(doc, ctx)) {
    return false;
  }
  return doc.assignments[unitId] === 'ai';
}

module.exports = {
  isAiControlledUnit,
};
