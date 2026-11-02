/* Manual UI for the shared MCP_removeRange Premiere host function. */
(function () {
    var button = document.getElementById('removeRangeButton');
    var status = document.getElementById('removeRangeStatus');
    var inputIn = document.getElementById('removeRangeIn');
    var inputOut = document.getElementById('removeRangeOut');

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

        button.disabled = true;
        button.textContent = 'Cutting…';
        setStatus('Running remove_range in Premiere…', false);
        if (!window.bridge || typeof window.bridge.executeExtendScript !== 'function') {
            button.disabled = false;
            button.textContent = 'Cut Range';
            setStatus('MCP Bridge is not running. Click Start Bridge and wait for Connected.', true);
            return;
        }
        console.info('[remove_range] stage=panel_request start=' + start + ' end=' + end);
        // Use the bridge's serialized evalScript queue so panel tests cannot race
        // an MCP remove_range call already executing in Premiere.
        var script = "(function () { if (typeof MCP_removeRange !== 'function') return JSON.stringify({ success: false, status: 'host_function_unavailable', error: 'The shared remove_range host function is not loaded. Close and reopen MCP Bridge (CEP), then retry.' }); return MCP_removeRange(" + JSON.stringify(start) + ',' + JSON.stringify(end) + '); })()';
        window.bridge.executeExtendScript(script, function (error, raw) {
            button.disabled = false;
            button.textContent = 'Cut Range';
            if (error) {
                console.error('[remove_range] stage=panel_bridge_failure error=' + error.message);
                setStatus('Premiere failed: ' + error.message, true);
                return;
            }
            var result = raw;
            if (typeof result === 'string') {
                try { result = JSON.parse(result); } catch (parseError) {}
            }
            if (result && result.success === true) {
                var message = 'Success — ' + (result.sequenceName || 'active sequence') + ': removed ' +
                    Number(result.removedDurationSeconds || (end - start)).toFixed(3) + ' seconds.';
                console.info('[remove_range] stage=panel_complete result=' + JSON.stringify(result));
                setStatus(message, false);
            } else {
                var errorText = result && result.error ? result.error : JSON.stringify(result);
                console.error('[remove_range] stage=premiere_failure result=' + JSON.stringify(result));
                setStatus('Premiere failed: ' + errorText, true);
            }
        }, 300000);
    });
})();
