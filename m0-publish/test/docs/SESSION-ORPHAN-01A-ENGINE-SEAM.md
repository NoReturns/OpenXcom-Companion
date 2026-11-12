# ASTER-M1-SESSION-ORPHAN-01A — minimum engine test seam

## Gap

`tryResolveOrphanedDirectedFireSessionBoundary`, `onBattleCompanionBindingContext`, and `interruptInFlightForBindingReset` live in `CompanionCommandRuntime.cpp` as `static` or translation-unit globals (`g_active`, `g_boundSessionId`). They are not invocable from `companion_command_test.cpp` without either:

1. **Integration harness** — disposable battlescape fixture with temp `OPENXCOM_COMPANION_SNAPSHOT_PATH`, pre-seeded inbox/result, synthetic `BattlescapeGame` tick, or
2. **Narrow export seam** — test-only hooks in `CompanionCommandRuntimeSupport` (preferred for 01B).

## Recommended 01B seam (minimal)

Add to `CompanionCommandRuntimeSupport.h` (test builds only or always-exported pure simulators):

```cpp
struct SessionOrphanDiskFixture {
  bool inboxPresent;
  bool journalContainsCommand;
  bool inboxDigestMatches;
  std::string inboxCommandId;
  std::string inboxCommandType;
  std::string inboxSessionId;
  std::string resultCommandId;
  std::string resultSessionId;
  std::string resultStatus;
};

struct SessionOrphanMemory {
  std::string boundSessionId;
  std::string boundTacticalBattleId;
  bool activeInFlight;
};

SessionOrphanEffects simulateOnBattleCompanionBindingContext(
  SessionOrphanMemory *memory,
  const SessionOrphanDiskFixture *disk,
  const std::string &liveSessionId,
  const std::string &liveTacticalBattleId);

bool simulateTryResolveOrphanedDirectedFireSessionBoundary(
  SessionOrphanDiskFixture *disk,
  const SessionOrphanMemory &memory,
  const std::string &liveSessionId);
```

Implementation: move the **policy** from `CompanionCommandRuntime.cpp` into `CompanionCommandRuntimeSupport.cpp` helpers, call from production `tick` / `onBattleCompanionBindingContext`. Tests call the same helpers — no duplicate logic in Node.

## Source map (production)

| Concern | File | Symbol |
|---------|------|--------|
| Session entry / cold start | `CompanionCommandRuntime.cpp` | `onBattleCompanionBindingContext` |
| In-flight interrupt on change | same | `interruptInFlightForBindingReset` |
| Stale inbox archive | same | `tryArchiveStaleInboxForSessionChange` |
| Disk orphan terminalize | same | `tryResolveOrphanedDirectedFireSessionBoundary` |
| Rehydrate guard | `CompanionCommandRuntimeSupport.cpp` | `shouldRehydrateOrphanedDirectedFireForSession` |
| Launch hygiene | `companion-canonical-runtime.cjs` | `evaluateInboxQuarantine` |
| Delivery gate | `tactical-command.cjs` | `canAcceptNewCommand` |

## Node coverage (01A)

`companion-m1-session-orphan-01a.test.cjs` + `test/support/session-orphan-production-lifecycle-model.cjs` mirror production policy and drive RED assertions. Relay integration uses temp dirs only.

## Proposed production repair (01B, not in 01A)

1. On binding context (including **cold start**), if persisted result is non-terminal and `session_id` ≠ live session, write `INTERRUPTED` and archive inbox — **without** requiring `g_active.inFlight`.
2. Launch: if inbox/result `EXECUTING` and snapshot session mismatch, **quarantine** (not `warn`).
3. Keep same-session `g_active.inFlight` path unchanged (regression test in 01A).
