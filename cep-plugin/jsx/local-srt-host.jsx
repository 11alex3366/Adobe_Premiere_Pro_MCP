// SRT host functions adapted from AutoEditPanel's working Premiere JSX bridge.
// This file is loaded by CEP before local-srt.js invokes any of these functions.
var MCP_SRT_TICKS = 254016000000;

// CEP calls this JSX directly with CSInterface.evalScript, outside the MCP
// bridge's JSON polyfill wrapper. ExtendScript on Premiere 23 may not expose
// JSON.stringify, so serialize the plain result objects used by this host here.
function MCP_SRT_stringify(value) {
    if (value === null || typeof value === "undefined") return "null";
    var kind = typeof value;
    if (kind == "string") {
        return "\"" + String(value).replace(/\\/g, "\\\\").replace(/\"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t") + "\"";
    }
    if (kind == "number") return isFinite(value) ? String(value) : "null";
    if (kind == "boolean") return value ? "true" : "false";
    if (value instanceof Array) {
        var items = [];
        for (var ai = 0; ai < value.length; ai++) items.push(MCP_SRT_stringify(value[ai]));
        return "[" + items.join(",") + "]";
    }
    if (kind == "object") {
        var properties = [];
        for (var key in value) {
            if (!value.hasOwnProperty || value.hasOwnProperty(key)) {
                var item = value[key];
                if (typeof item != "undefined" && typeof item != "function") properties.push(MCP_SRT_stringify(key) + ":" + MCP_SRT_stringify(item));
            }
        }
        return "{" + properties.join(",") + "}";
    }
    return "null";
}

// Premiere builds may expose sequence.end as a Time object, tick count, or
// tick-count string. Keep this conversion consistent with the other host tools.
function MCP_SRT_seconds(value) {
    if (value === null || typeof value === "undefined") return NaN;
    try {
        if (typeof value.seconds !== "undefined") {
            var seconds = Number(value.seconds);
            if (isFinite(seconds)) return seconds;
        }
    } catch (eSeconds) {}
    try {
        if (typeof value.ticks !== "undefined") {
            var ticks = Number(value.ticks);
            if (isFinite(ticks)) return ticks / MCP_SRT_TICKS;
        }
    } catch (eTicks) {}
    if (typeof value === "string") {
        var stringTicks = Number(value);
        return isFinite(stringTicks) ? stringTicks / MCP_SRT_TICKS : NaN;
    }
    if (typeof value === "number") {
        // A bare number returned by Premiere's sequence.end property is ticks.
        return isFinite(value) ? value / MCP_SRT_TICKS : NaN;
    }
    return NaN;
}

function MCP_SRT_time(seconds) {
    var t = new Time();
    t.seconds = seconds;
    return t;
}

function MCP_SRT_exportRange(outPath, presetPath, requestedStart, requestedEnd) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no active sequence";
        var inT = 0, outT = 0;
        var priorIn = Number(seq.getInPoint());
        var priorOut = Number(seq.getOutPoint());
        var hasPriorMarks = isFinite(priorIn) && isFinite(priorOut);
        try {
            if (typeof requestedStart === "number" && typeof requestedEnd === "number") {
                var duration = MCP_SRT_seconds(seq.end);
                if (!isFinite(requestedStart) || !isFinite(requestedEnd) || !isFinite(duration) || requestedStart < 0 || requestedEnd <= requestedStart || requestedEnd > duration + 0.000001) {
                    return "error: requested In/Out range is invalid or outside the active sequence (In=" + requestedStart + "s, Out=" + requestedEnd + "s, duration=" + duration + "s)";
                }
                inT = requestedStart;
                outT = requestedEnd;
                seq.setInPoint(inT);
                seq.setOutPoint(outT);
            } else {
                inT = seq.getInPointAsTime().seconds;
                outT = seq.getOutPointAsTime().seconds;
            }
        } catch (e) {}
        var mode = 1;
        if (!(outT > inT)) { mode = 0; inT = 0; }
        seq.exportAsMediaDirect(outPath, presetPath, mode);
        if (typeof requestedStart === "number" && hasPriorMarks) {
            try { seq.setInPoint(priorIn); } catch (restoreInError) {}
            try { seq.setOutPoint(priorOut); } catch (restoreOutError) {}
        }
        return "ok|" + inT + "|" + outT + "|" + seq.name + "|" + seq.sequenceID;
    } catch (e) {
        try {
            if (typeof requestedStart === "number" && hasPriorMarks && app.project && app.project.activeSequence) {
                app.project.activeSequence.setInPoint(priorIn);
                app.project.activeSequence.setOutPoint(priorOut);
            }
        } catch (restoreError) {}
        return "error: " + e;
    }
}

// Return the source clip intervals on the busiest video track in the requested
// sequence range. Audio is exported from the sequence for each interval so that
// linked audio, mixers, and effects keep Premiere's normal timeline behavior.
function MCP_SRT_getClipRanges(requestedStart, requestedEnd) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return MCP_SRT_stringify({ success: false, error: "No active sequence" });
        var duration = MCP_SRT_seconds(seq.end);
        var start = 0, end = duration;
        if (typeof requestedStart === "number" && typeof requestedEnd === "number") {
            if (!isFinite(requestedStart) || !isFinite(requestedEnd) || requestedStart < 0 || requestedEnd <= requestedStart || requestedEnd > duration + 0.000001) {
                return MCP_SRT_stringify({ success: false, error: "Requested In/Out range is invalid or outside the active sequence" });
            }
            start = requestedStart; end = requestedEnd;
        } else {
            try {
                var markedIn = Number(seq.getInPointAsTime().seconds);
                var markedOut = Number(seq.getOutPointAsTime().seconds);
                if (isFinite(markedIn) && isFinite(markedOut) && markedOut > markedIn) {
                    start = Math.max(0, markedIn); end = Math.min(duration, markedOut);
                }
            } catch (markError) {}
        }
        if (!(end > start)) return MCP_SRT_stringify({ success: false, error: "The active sequence has no usable duration in this range" });

        function collectTracks(collection, type) {
            var best = null;
            for (var trackIndex = 0; trackIndex < collection.numTracks; trackIndex++) {
                var track = collection[trackIndex], ranges = [], coverage = 0;
                if (!track || !track.clips) continue;
                for (var clipIndex = 0; clipIndex < track.clips.numItems; clipIndex++) {
                    var clip = track.clips[clipIndex];
                    var clipStart = NaN, clipEnd = NaN;
                    try { clipStart = MCP_SRT_seconds(clip.start); clipEnd = MCP_SRT_seconds(clip.end); } catch (timeError) {}
                    if (!isFinite(clipStart) || !isFinite(clipEnd)) continue;
                    clipStart = Math.max(start, clipStart); clipEnd = Math.min(end, clipEnd);
                    if (clipEnd <= clipStart) continue;
                    ranges.push({ start: clipStart, end: clipEnd, name: String(clip.name || "") });
                    coverage += clipEnd - clipStart;
                }
                if (ranges.length && (!best || ranges.length > best.ranges.length || (ranges.length === best.ranges.length && coverage > best.coverage))) {
                    best = { track: trackIndex + 1, type: type, ranges: ranges, coverage: coverage };
                }
            }
            return best;
        }

        var selected = collectTracks(seq.videoTracks, "video");
        if (!selected) selected = collectTracks(seq.audioTracks, "audio");
        if (!selected || !selected.ranges.length) return MCP_SRT_stringify({ success: false, error: "No timeline clips were found in the active sequence In/Out range" });
        selected.ranges.sort(function (a, b) { return a.start - b.start; });
        return MCP_SRT_stringify({ success: true, sequenceName: String(seq.name), sequenceId: String(seq.sequenceID), start: start, end: end, trackType: selected.type, track: selected.track, clips: selected.ranges });
    } catch (e) {
        return MCP_SRT_stringify({ success: false, error: String(e) });
    }
}

function MCP_SRT_findItemByPath(parent, normalizedPath) {
    for (var i = 0; i < parent.children.numItems; i++) {
        var item = parent.children[i];
        try {
            if (item.type == 2) {
                var nested = MCP_SRT_findItemByPath(item, normalizedPath);
                if (nested) return nested;
            } else if (String(item.getMediaPath()).replace(/\\/g, "/").toLowerCase() == normalizedPath) {
                return item;
            }
        } catch (e) {}
    }
    return null;
}

function MCP_SRT_importCaptions(srtPath, startAt, format) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no active sequence";
        app.project.importFiles([srtPath], true, app.project.rootItem, false);
        var item = MCP_SRT_findItemByPath(app.project.rootItem, String(srtPath).replace(/\\/g, "/").toLowerCase());
        if (!item) return "error: SRT imported but Premiere did not return its project item";
        var fmt;
        try {
            fmt = {
                subtitle: Sequence.CAPTION_FORMAT_SUBTITLE,
                "608": Sequence.CAPTION_FORMAT_608,
                "708": Sequence.CAPTION_FORMAT_708,
                teletext: Sequence.CAPTION_FORMAT_TELETEXT,
                ebu: Sequence.CAPTION_FORMAT_OPEN_EBU
            }[format];
        } catch (e) {}
        var placed = fmt === undefined ? seq.createCaptionTrack(item, startAt) : seq.createCaptionTrack(item, startAt, fmt);
        return placed ? "ok: placed" : "error: Premiere imported the SRT but did not create a caption track";
    } catch (e) {
        return "error: " + e;
    }
}

function MCP_SRT_chooseGraphicsTrack() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return MCP_SRT_stringify({ success: false, error: "No active sequence" });
        var count = seq.videoTracks.numTracks;
        if (count < 1) return MCP_SRT_stringify({ success: false, error: "The active sequence has no video track" });
        var index = count - 1;
        var top = seq.videoTracks[index];
        if (top && top.clips && top.clips.numItems > 0) {
            app.enableQE();
            var qeSeq = qe.project.getActiveSequence();
            if (!qeSeq || String(qeSeq.guid) !== String(seq.sequenceID)) throw new Error("Could not safely address the active sequence to add a video track");
            qeSeq.addTracks(1, count, 0, 1, seq.audioTracks.numTracks, 0, 0);
            if (seq.videoTracks.numTracks !== count + 1) throw new Error("Premiere did not add a video track");
            index = count;
        }
        return MCP_SRT_stringify({ success: true, index: index, track: index + 1, created: index === count });
    } catch (e) {
        return MCP_SRT_stringify({ success: false, error: String(e) });
    }
}

function MCP_SRT_mogrtTextProperty(component) {
    for (var i = 0; i < component.properties.numItems; i++) {
        var property = component.properties[i], displayName = "", value = "";
        try { displayName = String(property.displayName).toLowerCase(); } catch (e) {}
        try { value = String(property.getValue()); } catch (e2) {}
        if (/textEditValue/.test(value) || displayName == "source text" || displayName == "text") return property;
    }
    return null;
}

function MCP_SRT_setMogrtText(property, text) {
    var current = "";
    try { current = String(property.getValue()); } catch (e) {}
    if (/"textEditValue"\s*:/.test(current)) {
        var escaped = String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, "\\n");
        property.setValue(current.replace(/("textEditValue"\s*:\s*)"(?:[^"\\]|\\.)*"/, function (match, prefix) {
            return prefix + '"' + escaped + '"';
        }), 1);
    } else {
        property.setValue(String(text), 1);
    }
}

function MCP_SRT_placeMogrt(templatePath, start, end, text, videoTrack) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "error: no active sequence";
        var trackIndex = videoTrack - 1;
        if (trackIndex < 0 || trackIndex >= seq.videoTracks.numTracks) return "error: video track V" + videoTrack + " does not exist";
        var item = seq.importMGT(templatePath, String(Math.round(start * MCP_SRT_TICKS)), trackIndex, 0);
        if (!item) return "error: importMGT failed (check the .mogrt path)";
        var component = item.getMGTComponent();
        if (!component) return "error: the template has no editable parameters";
        var property = MCP_SRT_mogrtTextProperty(component);
        if (!property) return "error: text parameter not found in the template";
        MCP_SRT_setMogrtText(property, text);
        try { item.end = MCP_SRT_time(end); }
        catch (durationError) { return "error: template duration could not be set: " + durationError; }
        return "ok";
    } catch (e) {
        return "error: " + e;
    }
}
