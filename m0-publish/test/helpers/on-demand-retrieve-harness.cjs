'use strict';

/**
 * Test-only delivery gate for isolated RETRIEVE harnesses that exercise local
 * deliver/publish/retire without a live play-session lease. Does not disable
 * production gates — only scoped createOnDemandRelayContext injection.
 */
function allowIsolatedRetrieveCommandDelivery(options = {}) {
  return () => ({
    ok: true,
    reason: 'isolated_retrieve_harness',
    ...options,
  });
}

module.exports = {
  allowIsolatedRetrieveCommandDelivery,
};
