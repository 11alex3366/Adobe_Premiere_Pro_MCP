/* Local-only Whisper SRT workflow for the existing CEP bridge panel. */
(function () {
    var cs = new CSInterface();
    var fs = require('fs');
    var os = require('os');
    var path = require('path');
    var childProcess = require('child_process');
    var $ = function (id) { return document.getElementById(id); };
    var busy = false;
    var activeWorker = null;
    var exportTimer = null;
    var rejectExportWait = null;
    var shuttingDown = false;
    var audioPresetPath = '';
    var audioPresetReady = false;
    var settings = ['srtPython', 'srtModel', 'srtDevice', 'srtLanguage', 'srtWords', 'srtTextPreset'];
    var storage = window.localStorage;

    function remember(el) {
        try { var previous = storage.getItem('premiere-mcp-' + el.id); if (previous !== null) el.value = previous; } catch (e) {}
        el.addEventListener('change', function () {
            try { storage.setItem('premiere-mcp-' + el.id, el.value); } catch (e) {}
        });
    }
    settings.forEach(function (id) { remember($(id)); });
    $('srtWords').addEventListener('input', function () { $('srtWordsValue').textContent = this.value; });
    $('srtWordsValue').textContent = $('srtWords').value;

    function status(message, error) {
        var el = $('srtStatus');
        el.textContent = message;
        el.style.color = error ? 'var(--error)' : 'var(--text-1)';
    }
    function result(message) { $('srtResult').textContent = message || ''; }
    function evalRawHost(script, action) {
        return new Promise(function (resolve, reject) {
            cs.evalScript(script, function (raw) {
                if (!raw || raw === 'EvalScript error.' || raw === 'EvalScript error') {
                    return reject(new Error('Premiere failed to ' + action + '. Its SRT host script may not be loaded; restart Premiere and reopen MCP Bridge (CEP).'));
                }
                resolve(String(raw));
            });
        });
    }
    function evalHost(script) {
        return new Promise(function (resolve, reject) {
            cs.evalScript(script, function (raw) {
                if (!raw || raw === 'EvalScript error.' || raw === 'EvalScript error') {
                    return reject(new Error('Premiere failed to run the SRT host script. Restart Premiere so it loads jsx/local-srt-host.jsx, then reopen MCP Bridge (CEP).'));
                }
                try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(String(raw))); }
            });
        });
    }
    function extensionDirectory() {
        var location = decodeURIComponent(window.location.pathname);
        if (/^\/[A-Za-z]:/.test(location)) location = location.slice(1);
        return path.dirname(location);
    }
    function option(select, label, value) {
        var el = document.createElement('option'); el.textContent = label; el.value = value; select.appendChild(el);
    }
    function findAudioPreset() {
        // Resolve factory MP3 presets from every installed Premiere/AME version.
        // This avoids depending on app.path being exposed by ExtendScript in CEP.
        var roots = [];
        [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].forEach(function (programFiles) {
            if (!programFiles) return;
            var adobe = path.join(programFiles, 'Adobe');
            try {
                fs.readdirSync(adobe, { withFileTypes: true }).forEach(function (entry) {
                    if (entry.isDirectory() && /^Adobe (Premiere Pro|Media Encoder)/i.test(entry.name)) {
                        roots.push(path.join(adobe, entry.name, 'MediaIO', 'systempresets'));
                    }
                });
            } catch (e) {}
        });
        var hits = [];
        function walk(dir, depth) {
            if (depth > 7 || hits.length > 500) return;
            var entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            entries.forEach(function (entry) {
                var full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full, depth + 1);
                else if (/\.epr$/i.test(entry.name) && /mp3|wav|waveform|audio only|aac/i.test(entry.name + ' ' + path.basename(dir))) hits.push(full);
            });
        }
        roots.forEach(function (root) { walk(root, 0); });
        audioPresetPath = hits.filter(function (p) { return /mp3/i.test(p); })[0] || hits.filter(function (p) { return /wav|waveform/i.test(p); })[0] || '';
        audioPresetReady = true;
        $('srtAudioPresetStatus').textContent = audioPresetPath
            ? 'Automatically using Premiere’s ' + (/mp3/i.test(audioPresetPath) ? 'MP3' : 'WAV') + ' audio export preset.'
            : 'No installed MP3/WAV export preset was found in Premiere or Media Encoder.';
        if (!audioPresetPath) status('Could not locate Premiere’s built-in MP3/WAV export preset.', true);
    }
    function findTextPresets() {
        var roots = [path.join(os.homedir(), 'Documents', 'Adobe', 'Common', 'Motion Graphics Templates')];
        if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Adobe', 'Common', 'Motion Graphics Templates'));
        var found = [];
        function walk(dir, depth) {
            if (depth > 5 || found.length >= 250) return;
            var entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            entries.forEach(function (entry) {
                var full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full, depth + 1);
                else if (/\.mogrt$/i.test(entry.name)) found.push({ name: path.basename(entry.name, '.mogrt'), path: full });
            });
        }
        roots.forEach(function (root) { walk(root, 0); });
        var select = $('srtTextPreset'); select.innerHTML = ''; option(select, 'Native caption track', '');
        found.sort(function (a, b) { return a.name.localeCompare(b.name); });
        found.forEach(function (preset) { option(select, preset.name, preset.path); });
        var saved = storage.getItem('premiere-mcp-srtTextPreset');
        if (saved && found.some(function (item) { return item.path === saved; })) select.value = saved;
    }

    function waitForExport(file, deadline) {
        return new Promise(function (resolve, reject) {
            rejectExportWait = reject;
            var lastSize = -1, stable = 0;
            function poll() {
                if (shuttingDown) return reject(new Error('SRT generation cancelled because the MCP Bridge panel is closing.'));
                if (Date.now() > deadline) return reject(new Error('Premiere did not finish exporting the temporary audio in time.'));
                var size = 0;
                try { size = fs.statSync(file).size; } catch (e) {}
                if (size > 0 && size === lastSize) stable++; else stable = 0;
                if (stable >= 2) return resolve();
                lastSize = size;
                exportTimer = setTimeout(poll, 800);
            }
            poll();
        });
    }
    function transcribe(audio, output) {
        return new Promise(function (resolve, reject) {
            var python = $('srtPython').value.trim() || 'python';
            var args = [path.join(extensionDirectory(), 'python', 'srt_worker.py'), '--audio', audio, '--out', output,
                '--model', $('srtModel').value.trim() || 'large-v3', '--lang', $('srtLanguage').value.trim() || 'auto',
                '--device', $('srtDevice').value, '--words-per-subtitle', $('srtWords').value];
            var child;
            try { child = childProcess.spawn(python, args, { windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) }); activeWorker = child; }
            catch (error) { return reject(error); }
            var buffer = '', stderr = '', doneMessage = null;
            child.stdout.on('data', function (chunk) {
                buffer += chunk.toString(); var lines = buffer.split(/\r?\n/); buffer = lines.pop();
                lines.forEach(function (line) {
                    try {
                        var message = JSON.parse(line);
                        if (message.type === 'progress') status(message.text || 'Transcribing locally…');
                        else if (message.type === 'error') stderr = message.message || stderr;
                        else if (message.type === 'done') doneMessage = message;
                    } catch (e) {}
                });
            });
            child.stderr.on('data', function (chunk) { stderr += chunk.toString(); });
            child.on('error', function (error) { if (activeWorker === child) activeWorker = null; reject(new Error('Could not launch Python. Set the full Python executable path. ' + error.message)); });
            child.on('close', function (code) {
                if (activeWorker === child) activeWorker = null;
                if (code === 0 && fs.existsSync(output)) resolve(doneMessage || {});
                else reject(new Error((stderr || 'Local transcription failed (exit ' + code + ').').slice(-700)));
            });
        });
    }
    function parseSrt(raw) {
        function seconds(value) {
            var m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(value.trim());
            return m ? (+m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000) : NaN;
        }
        return raw.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/).map(function (block) {
            var lines = block.split('\n'), ti = lines.findIndex(function (line) { return line.indexOf('-->') >= 0; });
            if (ti < 0) return null;
            var times = lines[ti].split('-->');
            return { start: seconds(times[0]), end: seconds(times[1]), text: lines.slice(ti + 1).join(' ').trim() };
        }).filter(function (cue) { return cue && isFinite(cue.start) && isFinite(cue.end) && cue.end > cue.start && cue.text; });
    }
    function importNative(srtPath, startAt) {
        return evalRawHost('MCP_SRT_importCaptions(' + JSON.stringify(srtPath) + ',' + Number(startAt) + ',"subtitle")', 'import and place the SRT').then(function (raw) {
            var ok = raw.indexOf('ok') === 0;
            return { success: ok, imported: ok, placed: ok, message: raw, error: ok ? '' : raw };
        });
    }
    function chooseGraphicsTrack() {
        return evalHost('MCP_SRT_chooseGraphicsTrack()');
    }
    function importGraphics(cues, preset, track, startAt) {
        var imported = 0, errors = [];
        return cues.reduce(function (promise, cue, index) {
            return promise.then(function () {
                status('Applying text preset: ' + (index + 1) + '/' + cues.length + ' graphics…');
                return evalRawHost('MCP_SRT_placeMogrt(' + JSON.stringify(preset) + ',' + (cue.start + startAt) + ',' + (cue.end + startAt) + ',' + JSON.stringify(cue.text) + ',' + (Number(track) + 1) + ')', 'place a subtitle graphic').then(function (raw) {
                    if (raw.indexOf('ok') === 0) imported++;
                    else errors.push(raw);
                });
            });
        }, Promise.resolve()).then(function () { return { success: imported > 0 && !errors.length, placed: imported, total: cues.length, errors: errors }; });
    }

    function finishCallback(callback, payload) {
        if (typeof callback !== 'function') return;
        try { callback(payload); } catch (e) {}
    }
    function run(onComplete) {
        if (busy) {
            var busyResult = { success: false, status: 'busy', activeSequenceFound: false, transcriptionStarted: false, srtGenerated: false, subtitlesImported: false, error: 'SRT generation is already in progress.' };
            status(busyResult.error, true);
            finishCallback(onComplete, busyResult);
            return false;
        }
        if (!fs || !childProcess || !path) {
            var apiResult = { success: false, status: 'configuration_error', activeSequenceFound: false, transcriptionStarted: false, srtGenerated: false, subtitlesImported: false, error: 'CEP Node.js APIs are unavailable. Check the extension manifest.' };
            status(apiResult.error, true); finishCallback(onComplete, apiResult); return false;
        }
        if (!audioPresetReady) {
            var presetPending = { success: false, status: 'configuration_error', activeSequenceFound: false, transcriptionStarted: false, srtGenerated: false, subtitlesImported: false, error: 'Still detecting Premiere’s audio export preset. Try again in a moment.' };
            status(presetPending.error, true); finishCallback(onComplete, presetPending); return false;
        }
        if (!audioPresetPath) {
            var presetMissing = { success: false, status: 'configuration_error', activeSequenceFound: false, transcriptionStarted: false, srtGenerated: false, subtitlesImported: false, error: 'Premiere’s built-in MP3/WAV export preset could not be found. Reinstall or repair Premiere/Media Encoder.' };
            status(presetMissing.error, true); finishCallback(onComplete, presetMissing); return false;
        }
        busy = true; $('srtGenerateButton').disabled = true; $('srtGenerateButton').textContent = 'Processing…'; result('');
        var work = path.join(os.tmpdir(), 'premiere-mcp-local-srt');
        var token = Date.now() + '-' + Math.floor(Math.random() * 1000000);
        var audio = path.join(work, token + '.mp3'); var output = path.join(work, token + '.srt');
        var sequenceInfo = null, transcriptionStarted = false, srtGenerated = false, finalResult = null;
        try { fs.mkdirSync(work, { recursive: true }); } catch (error) {
            busy = false; $('srtGenerateButton').disabled = false; $('srtGenerateButton').textContent = 'Generate SRT and Import';
            var directoryError = { success: false, status: 'local_io_error', activeSequenceFound: false, transcriptionStarted: false, srtGenerated: false, subtitlesImported: false, error: error.message };
            status(error.message, true); finishCallback(onComplete, directoryError); return false;
        }
        status('Exporting the active sequence In/Out range to temporary audio…');
        evalRawHost('MCP_SRT_exportRange(' + JSON.stringify(audio) + ',' + JSON.stringify(audioPresetPath) + ')', 'export the active sequence audio').then(function (raw) {
            var parts = raw.split('|');
            if (parts[0] !== 'ok') throw new Error(raw || 'Premiere could not export audio.');
            sequenceInfo = { start: Number(parts[1]) || 0, end: Number(parts[2]) || 0, name: parts.slice(3).join('|') };
            return waitForExport(audio, Date.now() + 180000);
        }).then(function () {
            status('Starting local Whisper transcription…');
            transcriptionStarted = true;
            return transcribe(audio, output);
        }).then(function (transcription) {
            var srt = fs.readFileSync(output, 'utf8'); var cues = parseSrt(srt);
            if (!cues.length) throw new Error('The transcription did not produce a valid SRT file.');
            srtGenerated = true;
            if ($('srtTextPreset').value) {
                status('Checking the top video track for a safe placement…');
                return chooseGraphicsTrack().then(function (track) {
                    if (!track.success) throw new Error(track.error || 'Could not choose a graphics track.');
                    sequenceInfo.graphicsTrack = track.track;
                    sequenceInfo.createdGraphicsTrack = track.created;
                    return importGraphics(cues, $('srtTextPreset').value, track.index, sequenceInfo.start);
                })
                    .then(function (placed) { return { placed: placed, count: cues.length, words: transcription.words || 0 }; });
            }
            status('Importing SRT and creating a native caption track…');
            return importNative(output, sequenceInfo.start).then(function (placed) { return { placed: placed, count: cues.length, words: transcription.words || 0 }; });
        }).then(function (summary) {
            var placement = summary.placed;
            var importedCount = placement && typeof placement.placed === 'number' ? placement.placed : (placement && placement.success ? summary.count : 0);
            if (placement && placement.success) {
                status('Finished. ' + (placement.placed || summary.count) + ' subtitles placed on the active sequence' + (sequenceInfo.graphicsTrack ? ' on V' + sequenceInfo.graphicsTrack + (sequenceInfo.createdGraphicsTrack ? ' (new track).' : '.') : '.'));
                result('SRT: ' + output + ' · Segments: ' + summary.count + ' · Words: ' + summary.words);
            } else if (placement && placement.imported) {
                status('SRT generated and imported, but Premiere did not confirm timeline placement.', true);
                result('SRT: ' + output + ' · ' + (placement.message || 'Check the active sequence.'));
            } else if (placement && placement.errors && placement.errors.length) {
                status('Placed ' + placement.placed + '/' + placement.total + ' graphics; some presets or items failed.', true);
                result('SRT: ' + output + ' · First placement error: ' + placement.errors[0]);
            } else {
                status('SRT generated, but timeline import failed: ' + ((placement && placement.error) || 'unknown Premiere error'), true);
                result('SRT file: ' + output);
            }
            finalResult = {
                success: !!(placement && placement.success),
                status: placement && placement.success ? 'completed' : importedCount > 0 ? 'partial' : 'placement_failed',
                activeSequenceFound: true,
                activeSequence: sequenceInfo.name,
                transcriptionStarted: true,
                srtGenerated: true,
                subtitlesImported: importedCount > 0,
                subtitlesPlaced: importedCount,
                subtitleCount: summary.count,
                wordsTranscribed: summary.words,
                srtPath: output,
                graphicsTrack: sequenceInfo.graphicsTrack || null,
                createdGraphicsTrack: !!sequenceInfo.createdGraphicsTrack,
                message: placement && placement.errors && placement.errors.length ? placement.errors[0] : (placement && placement.message) || ''
            };
        }).catch(function (error) {
            var message = error.message || String(error);
            status(message, true);
            result(srtGenerated ? 'SRT file: ' + output : '');
            finalResult = {
                success: false,
                status: srtGenerated ? 'placement_failed' : transcriptionStarted ? 'transcription_failed' : sequenceInfo ? 'audio_export_failed' : 'sequence_or_export_failed',
                activeSequenceFound: !!sequenceInfo,
                activeSequence: sequenceInfo && sequenceInfo.name,
                transcriptionStarted: transcriptionStarted,
                srtGenerated: srtGenerated,
                subtitlesImported: false,
                srtPath: srtGenerated ? output : null,
                error: message
            };
        }).then(function () {
                try { if (fs.existsSync(audio)) fs.unlinkSync(audio); } catch (e) {}
                busy = false; $('srtGenerateButton').disabled = false; $('srtGenerateButton').textContent = 'Generate SRT and Import';
                finishCallback(onComplete, finalResult || { success: false, status: 'failed', activeSequenceFound: !!sequenceInfo, transcriptionStarted: transcriptionStarted, srtGenerated: srtGenerated, subtitlesImported: false, error: 'SRT generation ended without a result.' });
            });
        return true;
    }
    $('srtGenerateButton').addEventListener('click', run);
    window.MCPPremiereLocalSRT = {
        generate: function (callback) { return run(callback); },
        shutdown: function () {
            shuttingDown = true;
            if (exportTimer) clearTimeout(exportTimer);
            exportTimer = null;
            if (rejectExportWait) { var reject = rejectExportWait; rejectExportWait = null; reject(new Error('SRT generation cancelled because the MCP Bridge panel is closing.')); }
            if (activeWorker) { try { activeWorker.kill(); } catch (e) {} activeWorker = null; }
        }
    };
    findAudioPreset();
    findTextPresets();
})();
