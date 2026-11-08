'use strict';

const path = require('node:path');
const { RELAY_SHRINK_EXHAUSTED } = require('./relay-payload-adaptive-shrink.cjs');
const { isRelayShrinkExhausted } = require('./relay-publish-error.cjs');
const {
  writeManualIntelligenceArtifact,
  ManualUploadExportError,
} = require('./manual-upload-export.cjs');
const {
  buildManualUploadNotice,
  writeManualUploadNoticeAtomic,
  clearNodeManualUploadNotice,
  MANUAL_UPLOAD_NOTICE_MESSAGE,
} = require('./companion-manual-upload-notice.cjs');
const {
  NOTIFICATION_CODES,
  buildNotification,
} = require('./companion-relay-notify.cjs');
const {
  BRIEFING_ACK_STATUS_DEFERRED,
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED: ACK_MANUAL_UPLOAD,
} = require('./companion-on-demand-status.cjs');
const { basenameArtifact } = require('./companion-briefing-diagnostics.cjs');
const { pruneManualExportDirectory } = require('./companion-manual-export-retention.cjs');

const BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED = ACK_MANUAL_UPLOAD;
const JOURNAL_STATUS_MANUAL_UPLOAD_REQUIRED = 'manual_upload_required';

function resolveManualExportDir(snapshotDir) {
  return path.join(snapshotDir, 'manual-exports');
}

function writeDeferredBriefingAck(writeAck, request, message, errorCode = 'RATE_LIMIT') {
  if (typeof writeAck !== 'function') {
    return;
  }
  writeAck({
    request_id: request.request_id,
    status: BRIEFING_ACK_STATUS_DEFERRED,
    error_code: errorCode,
    message: message || 'Publish deferred (rate limit).',
  });
}

/**
 * Attempt GitHub relay publish; on shrink exhaustion only, write manual artifact + notice.
 */
async function publishRelayWithManualFallback(options) {
  const {
    relay,
    publishRelayState,
    snapshotDir,
    requestId,
    sessionId,
    turn,
    snapshotSha256,
    now = () => Date.now(),
    log = () => {},
    notify,
    manualUploadIo = {},
    briefingDiagnostics,
    writeDeferredAck,
  } = options;

  const manualExportDir = resolveManualExportDir(snapshotDir);
  const exportedAtMs = now();

  try {
    const result = await publishRelayState(relay);
    clearNodeManualUploadNotice(snapshotDir, {
      sessionId,
      reason: 'relay_published',
      clearedAtMs: exportedAtMs,
    }, manualUploadIo);
    return {
      kind: result?.skipped ? 'skipped' : 'published',
      result,
    };
  } catch (error) {
    const code = error.code ?? 'PUBLISH_FAILED';
    if (code === 'RATE_LIMIT') {
      const deferMessage = error.message || 'GitHub rate limit cooldown.';
      if (writeDeferredAck) {
        writeDeferredAck(deferMessage, code);
      }
      briefingDiagnostics?.emit({
        outcome: 'deferred',
        request_id: requestId,
        error_code: code,
        reason: deferMessage,
        turn,
      });
      return { kind: 'defer', error, code };
    }
    if (code === 'AUTH_FAILED' || code === 'SHA_CONFLICT') {
      return { kind: 'hard_error', error, code };
    }
    if (!isRelayShrinkExhausted(error)) {
      return { kind: 'retryable', error, code };
    }

    const shrinkContext = {
      initialBytes: error.initialBytes,
      finalBytes: error.finalBytes,
      steps: error.steps ?? [],
    };

    let exportResult;
    try {
      exportResult = writeManualIntelligenceArtifact(manualExportDir, relay, {
        exportedAtMs,
        requireShrinkExhausted: false,
        shrinkContext,
        ...manualUploadIo,
      });
    } catch (writeError) {
      const failureCode = writeError instanceof ManualUploadExportError
        ? writeError.code
        : 'MANUAL_EXPORT_WRITE_FAILED';
      log(`Manual artifact write failed (${failureCode}): ${writeError.message || String(writeError)}`);
      return {
        kind: 'manual_export_failed',
        publishError: error,
        writeError,
        errorCode: failureCode,
      };
    }

    const notice = buildManualUploadNotice({
      createdAtMs: exportedAtMs,
      artifactPath: path.resolve(exportResult.path),
      artifactSha256: exportResult.sha256,
      artifactFilename: exportResult.filename,
      sessionId,
      snapshotId: relay.snapshot_id,
      turn,
      requestId,
      reasonCode: RELAY_SHRINK_EXHAUSTED,
    });

    const noticeWrite = writeManualUploadNoticeAtomic(snapshotDir, notice, manualUploadIo);
    if (!noticeWrite.written) {
      log('Manual upload notice unchanged (newer notice already active).');
    } else {
      log(`Manual upload required: ${exportResult.path}`);
    }

    pruneManualExportDirectory(snapshotDir, manualExportDir, {
      extraProtected: [exportResult.path],
      io: manualUploadIo,
    });

    if (typeof notify === 'function') {
      notify(buildNotification(NOTIFICATION_CODES.MANUAL_UPLOAD_REQUIRED, {
        channel: 'briefing',
        request_id: requestId,
        session_id: sessionId,
        turn,
        reason_code: RELAY_SHRINK_EXHAUSTED,
        message: MANUAL_UPLOAD_NOTICE_MESSAGE,
        artifact_sha256: exportResult.sha256,
      }));
    }

    briefingDiagnostics?.emit({
      outcome: 'manual_upload_required',
      request_id: requestId,
      error_code: RELAY_SHRINK_EXHAUSTED,
      reason: MANUAL_UPLOAD_NOTICE_MESSAGE,
      artifact_filename: basenameArtifact(exportResult.filename || exportResult.path),
      turn,
    });

    return {
      kind: 'manual_upload_required',
      exportResult,
      notice: noticeWrite.notice,
      shrinkContext,
      publishError: error,
    };
  }
}

function manualUploadRequiredAckMessage(artifactPath) {
  return `${MANUAL_UPLOAD_NOTICE_MESSAGE}\nFile: ${artifactPath}`;
}

module.exports = {
  BRIEFING_ACK_STATUS_MANUAL_UPLOAD_REQUIRED,
  BRIEFING_ACK_STATUS_DEFERRED,
  JOURNAL_STATUS_MANUAL_UPLOAD_REQUIRED,
  resolveManualExportDir,
  publishRelayWithManualFallback,
  manualUploadRequiredAckMessage,
  writeDeferredBriefingAck,
};
