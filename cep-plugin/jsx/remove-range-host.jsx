// Shared Premiere-side range removal. Both the MCP handler and panel test call this.
// Use Premiere's native QE Extract command so the edit is performed as one ripple
// operation across sync-locked tracks instead of iterating over every timeline clip.
var MCP_removeRangeImplementation = 'native-extract-seconds-receipt-v3';
var MCP_removeRangeLastOperation = null;
function MCP_removeRange(requestedStartTime, requestedEndTime, publishNativeResult, batchResults, batchIndex, isFinalBatchItem) {
  var startedAt = new Date().getTime();
  var result = { success: false, status: 'preflight_failed', activeSequenceFound: false };
  var seq = null;
  var qeSeq = null;
  var trackStates = [];
  var oldIn = null;
  var oldOut = null;
  var marksSaved = false;
  var editStarted = false;
  var restoreErrors = [];
  var TICKS_PER_SECOND = 254016000000;
  var start = Number(requestedStartTime);
  var end = Number(requestedEndTime);
  var operationKey = '';

  function fail(status, message, extra) {
    result.success = false;
    result.status = status;
    result.error = message;
    if (extra) for (var key in extra) result[key] = extra[key];
  }
  function seconds(value) {
    if (value === null || typeof value === 'undefined') return NaN;
    try { if (typeof value.seconds !== 'undefined') return Number(value.seconds); } catch (eSeconds) {}
    try { if (typeof value.ticks !== 'undefined') return Number(value.ticks) / TICKS_PER_SECOND; } catch (eTicks) {}
    var numeric = Number(value);
    return isFinite(numeric) ? numeric / TICKS_PER_SECOND : NaN;
  }
  function trackCount(collection) {
    if (!collection) return 0;
    if (typeof collection.numTracks === 'number') return collection.numTracks;
    if (typeof collection.length === 'number') return collection.length;
    return 0;
  }
  function frameTimecode(frameNumber, nominalFps) {
    var totalFrames = Math.max(0, Math.round(frameNumber));
    var hh = Math.floor(totalFrames / (nominalFps * 3600));
    var mm = Math.floor((totalFrames % (nominalFps * 3600)) / (nominalFps * 60));
    var ss = Math.floor((totalFrames % (nominalFps * 60)) / nominalFps);
    var ff = totalFrames % nominalFps;
    function pad(value) { return value < 10 ? '0' + value : String(value); }
    return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(ff);
  }

  try {
    if (!isFinite(start) || !isFinite(end) || start < 0 || end <= start) {
      fail('invalid_range', 'start_time must be non-negative and end_time must be greater than start_time.');
    } else if (!app.project) {
      fail('no_project', 'No Premiere project is open.');
    } else {
      seq = app.project.activeSequence;
      if (!seq) {
        fail('no_active_sequence', 'There is no active Premiere sequence.');
      } else {
        result.activeSequenceFound = true;
        result.sequenceName = String(seq.name || '');
        operationKey = String(seq.sequenceID || seq.name || '') + '|' + String(start) + '|' + String(end);
        if (MCP_removeRangeLastOperation && MCP_removeRangeLastOperation.key === operationKey && new Date().getTime() - MCP_removeRangeLastOperation.completedAt < 60000) {
          var duplicateResult = {};
          for (var cachedKey in MCP_removeRangeLastOperation.result) duplicateResult[cachedKey] = MCP_removeRangeLastOperation.result[cachedKey];
          duplicateResult.duplicateSuppressed = true;
          duplicateResult.message = 'Duplicate bridge dispatch suppressed; the cached result is from the immediately preceding identical range operation.';
          return JSON.stringify(duplicateResult);
        }
        var duration = seconds(seq.end);
        var frameTicks = Number(seq.timebase);
        if (!isFinite(duration) || duration <= 0) {
          fail('invalid_sequence_duration', 'Could not determine the active sequence duration.');
        } else if (end > duration + 0.0000001) {
          fail('range_out_of_bounds', 'end_time is outside the active sequence duration.', { sequenceDurationSeconds: duration });
        } else if (!isFinite(frameTicks) || frameTicks <= 0) {
          fail('unsupported_timebase', 'Could not read the active sequence frame duration.');
        } else if (typeof app.enableQE !== 'function' || typeof qe === 'undefined' || !qe.project || typeof qe.project.getActiveSequence !== 'function') {
          fail('qe_unavailable', 'Premiere QE is unavailable; the timeline was not changed.');
        } else {
          app.enableQE();
          qeSeq = qe.project.getActiveSequence();
          if (!qeSeq) {
            fail('qe_sequence_unavailable', 'Premiere QE could not resolve the active sequence; the timeline was not changed.');
          } else if (typeof qeSeq.extract !== 'function') {
            fail('native_extract_unavailable', 'This Premiere version does not expose the native QE Extract command; no slower per-clip fallback was run.');
          } else {
            var frameSeconds = frameTicks / TICKS_PER_SECOND;
            var startFrame = Math.round(start / frameSeconds);
            var endFrame = Math.round(end / frameSeconds);
            var actualStart = startFrame * frameSeconds;
            var actualEnd = endFrame * frameSeconds;
            var tolerance = Math.max(0.00001, frameSeconds * 0.25);
            if (actualEnd <= actualStart || actualEnd > duration + frameSeconds * 0.001) {
              fail('invalid_frame_range', 'The requested range collapses or falls outside the active sequence after frame alignment.', { sequenceDurationSeconds: duration, frameDurationSeconds: frameSeconds });
            } else {
              var oldInValue = Number(seq.getInPoint());
              var oldOutValue = Number(seq.getOutPoint());
              if (!isFinite(oldInValue) || !isFinite(oldOutValue)) {
                fail('sequence_marks_unavailable', 'Could not preserve the active sequence In/Out marks; the timeline was not changed.');
              } else {
                oldIn = oldInValue;
                oldOut = oldOutValue;
                marksSaved = true;
                var trackSpecs = [
                  { type: 'video', collection: seq.videoTracks, getTrack: 'getVideoTrackAt' },
                  { type: 'audio', collection: seq.audioTracks, getTrack: 'getAudioTrackAt' }
                ];
                var stateError = '';
                for (var si = 0; si < trackSpecs.length && !stateError; si++) {
                  var spec = trackSpecs[si];
                  for (var ti = 0; ti < trackCount(spec.collection); ti++) {
                    var qeTrack = qeSeq[spec.getTrack](ti);
                    if (!qeTrack || typeof qeTrack.isLocked !== 'function' || typeof qeTrack.setLock !== 'function' || typeof qeTrack.isSyncLocked !== 'function' || typeof qeTrack.setSyncLock !== 'function') {
                      stateError = 'Premiere does not expose lock and Sync Lock controls for ' + spec.type + ' track ' + (ti + 1) + '; the timeline was not changed.';
                      break;
                    }
                    var wasLocked = Boolean(qeTrack.isLocked());
                    var wasSyncLocked = Boolean(qeTrack.isSyncLocked());
                    trackStates.push({
                      track: qeTrack,
                      type: spec.type,
                      index: ti,
                      locked: wasLocked,
                      syncLocked: wasSyncLocked,
                      lockChanged: wasLocked,
                      syncLockChanged: !wasSyncLocked
                    });
                  }
                }
                if (stateError) {
                  fail('track_state_unavailable', stateError);
                } else {
                  // Native Extract respects locked/Sync Locked tracks. Temporarily
                  // make every audio/video track participate, then restore its state.
                  for (var pi = 0; pi < trackStates.length; pi++) {
                    var state = trackStates[pi];
                    if (state.lockChanged) state.track.setLock(0);
                    if (state.syncLockChanged) state.track.setSyncLock(1);
                    if ((state.lockChanged && state.track.isLocked()) || (state.syncLockChanged && !state.track.isSyncLocked())) {
                      stateError = 'Could not prepare ' + state.type + ' track ' + (state.index + 1) + ' for native Extract.';
                      break;
                    }
                  }
                  if (stateError) {
                    fail('track_preparation_failed', stateError, { timelineChanged: false });
                  } else {
                    result.requestedStartTime = start;
                    result.requestedEndTime = end;
                    result.actualStartTime = actualStart;
                    result.actualEndTime = actualEnd;
                    result.removedDurationSeconds = actualEnd - actualStart;
                    result.frameDurationSeconds = frameSeconds;
                    result.sequenceDurationBeforeSeconds = duration;
                    result.videoAudioTrackCount = trackStates.length;

                    // Sequence.setInPoint/setOutPoint in Premiere's ExtendScript DOM
                    // take seconds (unlike TrackItem times, which expose ticks).
                    // Passing ticks here silently marked a range far beyond the edit.
                    seq.setInPoint(actualStart);
                    seq.setOutPoint(actualEnd);
                    editStarted = true;
                    qeSeq.extract();
                    // Premiere has returned from its native Extract call, which is the
                    // point where the requested edit has been applied. Publish now so
                    // MCP does not need to wait for slower post-edit DOM checks or the
                    // CEP evalScript callback. The normal response still contains the
                    // detailed verification and restoration status when it is available.
                    var earlyResult = { success: true, status: 'native_extract_returned', operation: 'Premiere native QE Extract', sequenceName: String(seq.name || ''), requestedStartTime: start, requestedEndTime: end, actualStartTime: actualStart, actualEndTime: actualEnd, removedDurationSeconds: actualEnd - actualStart, verified: false, confirmation: 'Premiere returned from native Extract; final duration and state restoration checks are continuing.' };
                    if (publishNativeResult === 'single' && typeof MCP_publishNativeResult === 'function') {
                      MCP_publishNativeResult(earlyResult);
                    } else if (publishNativeResult === 'batch' && batchResults instanceof Array && batchIndex >= 0) {
                      batchResults[batchIndex] = earlyResult;
                      if (isFinalBatchItem === true && typeof MCP_publishNativeResult === 'function') {
                        // ExtendScript's Date object in Premiere Pro 23 has no toISOString().
                        // Publish the receipt using only JSON-compatible fields supported there.
                        MCP_publishNativeResult({ success: true, result: JSON.stringify(batchResults) });
                      }
                    }

                    var afterDuration = seconds(seq.end);
                    var expectedDuration = duration - (actualEnd - actualStart);
                    if (isFinite(afterDuration) && Math.abs(afterDuration - expectedDuration) > tolerance) {
                      fail('native_extract_unverified', 'Premiere ran native Extract, but the sequence duration did not confirm the expected ripple.', {
                        sequenceDurationAfterSeconds: afterDuration,
                        expectedSequenceDurationSeconds: expectedDuration,
                        timelineMayBeModified: true
                      });
                    } else {
                      result.success = true;
                      result.status = 'completed';
                      result.operation = 'Premiere native QE Extract';
                      result.sequenceDurationAfterSeconds = afterDuration;
                      result.verified = isFinite(afterDuration);
                      result.message = 'Premiere native Extract removed the In/Out range and rippled the sync-locked tracks.';
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (e) {
    fail(editStarted ? 'native_extract_failed' : 'operation_failed', String(e), { timelineMayBeModified: editStarted });
  } finally {
    if (marksSaved && seq) {
      try { seq.setInPoint(oldIn); } catch (eRestoreIn) { restoreErrors.push('Could not restore the previous In point: ' + eRestoreIn); }
      try { seq.setOutPoint(oldOut); } catch (eRestoreOut) { restoreErrors.push('Could not restore the previous Out point: ' + eRestoreOut); }
    }
    for (var ri = trackStates.length - 1; ri >= 0; ri--) {
      var restoreState = trackStates[ri];
      if (restoreState.syncLockChanged) {
        try { restoreState.track.setSyncLock(restoreState.syncLocked ? 1 : 0); } catch (eRestoreSync) { restoreErrors.push('Could not restore Sync Lock on ' + restoreState.type + ' track ' + (restoreState.index + 1) + '.'); }
      }
      if (restoreState.lockChanged) {
        try { restoreState.track.setLock(restoreState.locked ? 1 : 0); } catch (eRestoreLock) { restoreErrors.push('Could not restore lock on ' + restoreState.type + ' track ' + (restoreState.index + 1) + '.'); }
      }
    }
    result.durationMs = new Date().getTime() - startedAt;
  }
  if (restoreErrors.length) {
    result.success = false;
    result.status = 'state_restore_failed';
    result.restoreErrors = restoreErrors;
    result.timelineMayBeModified = editStarted;
    result.error = (result.error ? result.error + ' ' : '') + 'Premiere could not restore some prior sequence or track states.';
  }
  if (editStarted && operationKey) {
    MCP_removeRangeLastOperation = { key: operationKey, completedAt: new Date().getTime(), result: result };
  }
  return JSON.stringify(result);
}
