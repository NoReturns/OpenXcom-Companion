'use strict';

/**
 * Mirrors engine CompanionSoldierOwnershipCore defaults (local file only).
 */
function isAiControlledUnit(controlFileJson, battleSessionId, unitId) {
  if (!controlFileJson || !battleSessionId) {
    return false;
  }
  let value;
  try {
    value = JSON.parse(controlFileJson);
  } catch {
    return false;
  }
  if (!value || value.schema_version !== 1) {
    return false;
  }
  if (value.session_id !== battleSessionId) {
    return false;
  }
  const assignments = value.assignments;
  if (!assignments || typeof assignments !== 'object') {
    return false;
  }
  const mode = assignments[String(unitId)] ?? assignments[unitId];
  return mode === 'ai';
}

module.exports = {
  isAiControlledUnit,
};
