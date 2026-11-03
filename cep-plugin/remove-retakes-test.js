/* UI test for the same MCP remove_retakes handler exposed to MCP clients. */
(function () {
    var button = document.getElementById('removeRetakesButton');
    var status = document.getElementById('removeRetakesStatus');
    var inputIn = document.getElementById('removeRetakesIn');
    var inputOut = document.getElementById('removeRetakesOut');
    var inputTimeout = document.getElementById('removeRetakesTimeout');
    var stopButton = document.getElementById('removeRetakesStop');
    var isRunning = false;

    function setStatus(message, isError) {
        status.textContent = message;
        status.style.color = isError ? 'var(--error)' : 'var(--text-1)';
    }

    button.addEventListener('click', function () {
        var start = Number(inputIn.value);
        var end = Number(inputOut.value);
        if (!inputIn.value.trim() || !inputOut.value.trim() || !isFinite(start) || !isFinite(end) || start < 0 || end <= start) {
            setStatus('Enter numeric times with Start Time ≥ 0 and End Time greater than Start Time.', true);
            return;
        }
        if (button.disabled) return;
        if (!window.MCPPremiereAssistant || typeof window.MCPPremiereAssistant.invokeRemoveRetakes !== 'function') {
            setStatus('The local MCP assistant service is not available. Restart the MCP server and reopen this panel.', true);
            return;
        }
        button.disabled = true;
        stopButton.disabled = false;
        isRunning = true;
        button.textContent = 'Processing…';
        setStatus('Generating a local word-level SRT and analyzing retakes…', false);
        var timeoutSeconds = Number(inputTimeout.value);
        if ([45, 60, 90].indexOf(timeoutSeconds) < 0) {
            setStatus('Choose a cut wait timeout of 45, 60, or 90 seconds.', true);
            return;
        }
        window.MCPPremiereAssistant.invokeRemoveRetakes(start, end, timeoutSeconds).then(function (result) {
            if (result && result.success === false && result.status === 'analysis_failed') {
                setStatus(result.error || 'The retake analysis model failed. No timeline changes were made.', true);
                return;
            }
            if (!result || typeof result !== 'object' || typeof result.groupsDetected !== 'number') {
                setStatus((result && result.error) || 'Remove Retakes did not complete. Check the MCP Bridge and Python configuration.', true);
                return;
            }
            var summary = 'Groups: ' + Number(result.groupsDetected || 0) +
                ' · Removed: ' + Number(result.rejectedTakesRemoved || 0) +
                ' · Uncertain skipped: ' + Number(result.groupsSkippedUncertain || 0);
            var errors = Array.isArray(result.errors) && result.errors.length ? ' · Errors: ' + result.errors.join(' | ') : '';
            var topError = result.error ? ' · ' + result.error : '';
            var note = result.note ? ' · ' + result.note : '';
            setStatus(summary + errors + topError + note, result.success !== true || !!errors);
        }).catch(function (error) {
            setStatus('Remove Retakes failed: ' + error.message, true);
        }).finally(function () {
            isRunning = false;
            button.disabled = false;
            stopButton.disabled = true;
            button.textContent = 'Remove Retakes';
        });
    });
    stopButton.addEventListener('click', function () {
        if (!isRunning || stopButton.disabled) return;
        stopButton.disabled = true;
        setStatus('Requesting stop… If Premiere has already started native Extract, that edit may still finish.', false);
        if (window.MCPPremiereAssistant && typeof window.MCPPremiereAssistant.stopRemoveRetakes === 'function') {
            window.MCPPremiereAssistant.stopRemoveRetakes().then(function (result) {
                setStatus((result && result.message) || 'Stop requested. The current Premiere operation may still finish.', false);
            }).catch(function (error) {
                setStatus('Could not request stop: ' + error.message, true);
            });
        }
    });
})();
