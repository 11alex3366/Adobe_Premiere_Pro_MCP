/* Local CEP chat client and saved provider settings. */
(function () {
    'use strict';

    var runtime = null;
    var history = [];
    var profileRefreshTimer = null;
    var chatBusy = false;
    var chatRequestController = null;
    var editingProfileId = null;
    var profiles = [];

    function byId(id) { return document.getElementById(id); }

    function addMessage(text, role) {
        var item = document.createElement('div');
        item.className = 'chat-message ' + role;
        item.textContent = String(text || '');
        var log = byId('chatLog');
        log.appendChild(item);
        log.scrollTop = log.scrollHeight;
    }

    function setStatus(text, isError) {
        byId('chatStatus').textContent = text;
        byId('chatStatus').style.color = isError ? '#ffb3aa' : '';
    }

    function setApiSettingsStatus(text, isError) {
        var element = byId('chatApiSettingsStatus');
        element.textContent = text;
        element.style.color = isError ? '#ffb3aa' : '';
    }

    function updateProviderHelp() {
        var provider = byId('chatProvider').value;
        var help = byId('chatApiHelp');
        var base = byId('chatBaseUrl');
        var key = byId('chatApiKey');
        if (provider === 'google') {
            base.placeholder = 'Leave blank';
            key.placeholder = 'Paste your Google AI Studio API key';
            help.textContent = 'Google Gemini: leave Base URL blank. Create/copy your API key in Google AI Studio.';
        } else if (provider === 'openai') {
            base.placeholder = 'Leave blank';
            key.placeholder = 'Paste your OpenAI API key';
            help.textContent = 'OpenAI: leave Base URL blank. Paste the API key from your OpenAI API account.';
        } else if (provider === 'anthropic') {
            base.placeholder = 'Leave blank';
            key.placeholder = 'Paste your Anthropic API key';
            help.textContent = 'Anthropic: leave Base URL blank. Paste the API key from your Anthropic Console.';
        } else if (provider === 'ollama') {
            base.placeholder = 'http://localhost:11434/v1';
            key.placeholder = 'Optional for local Ollama';
            help.textContent = 'Ollama: start Ollama on this PC, leave the key blank, and use http://localhost:11434/v1.';
        } else {
            base.placeholder = 'https://provider.example/v1';
            key.placeholder = 'Paste the key from your API provider';
            help.textContent = 'OpenAI-compatible: enter the provider API root, usually ending in /v1, plus its API key. Do not add /chat/completions.';
        }
    }

    function readRuntime() {
        try {
            if (!window.bridge || typeof window.bridge.getTempDirectory !== 'function') return null;
            var fs = require('fs');
            var path = require('path');
            var file = path.join(window.bridge.getTempDirectory(), 'assistant-chat-runtime.json');
            var value = JSON.parse(fs.readFileSync(file, 'utf8'));
            return value && value.baseUrl && value.token ? value : null;
        } catch (e) { return null; }
    }

    function api(path, options) {
        if (!runtime) return Promise.reject(new Error('Local chat service is not running. Start or restart the Premiere MCP server.'));
        var request = options || {};
        request.headers = request.headers || {};
        request.headers.Authorization = 'Bearer ' + runtime.token;
        if (request.body) request.headers['Content-Type'] = 'application/json';
        return fetch(runtime.baseUrl + path, request).then(function (response) {
            return response.text().then(function (text) {
                var data;
                try { data = text ? JSON.parse(text) : {}; } catch (e) { data = { error: text }; }
                if (!response.ok) throw new Error(data.error || ('Local chat request failed (' + response.status + ').'));
                return data;
            });
        });
    }

    function renderProfiles(data) {
        profiles = data.profiles || [];
        renderRetakeProfile(data);
        var container = byId('chatProfiles');
        container.textContent = '';
        profiles.forEach(function (profile) {
            var row = document.createElement('div');
            row.className = 'chat-profile' + (profile.id === data.activeId ? ' active' : '');
            var label = document.createElement('span');
            label.textContent = (profile.id === data.activeId ? '● ' : '') + profile.name + ' · ' + profile.provider + ' · ' + profile.model;
            row.appendChild(label);
            var edit = document.createElement('button');
            edit.className = 'secondary';
            edit.type = 'button';
            edit.textContent = 'Edit';
            edit.addEventListener('click', function () { editProfile(profile); });
            row.appendChild(edit);
            var remove = document.createElement('button');
            remove.className = 'secondary';
            remove.type = 'button';
            remove.textContent = 'Delete';
            remove.addEventListener('click', function () {
                if (window.confirm('Delete the saved API connection "' + profile.name + '"?')) mutateProfile({ action: 'remove', id: profile.id });
            });
            row.appendChild(remove);
            container.appendChild(row);
        });
        var status = byId('chatRotationStatus');
        if (!profiles.length) {
            status.textContent = 'No API connections';
            setStatus('Open Settings to add a provider and select a model.', false);
        } else {
            var remaining = Math.max(0, Math.ceil((data.nextRotationAt - Date.now()) / 1000));
            status.textContent = (data.activeProfile ? data.activeProfile.name : 'Ready') + ' · next in ' + Math.floor(remaining / 60) + ':' + ('0' + (remaining % 60)).slice(-2);
        }
    }

    function renderRetakeProfile(data) {
        var select = byId('removeRetakesProfile');
        if (!select) return;
        select.innerHTML = '';
        if (!profiles.length) {
            var empty = document.createElement('option');
            empty.value = '';
            empty.textContent = 'Add an API connection first';
            select.appendChild(empty);
            select.disabled = true;
            return;
        }
        select.disabled = false;
        profiles.forEach(function (profile) {
            var option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name + ' · ' + profile.provider + ' · ' + profile.model;
            select.appendChild(option);
        });
        select.value = data.retakeProfileId || profiles[0].id;
    }

    function saveRetakeProfile() {
        var profileId = byId('removeRetakesProfile').value;
        byId('removeRetakesProfile').disabled = true;
        byId('removeRetakesStatus').textContent = 'Saving retake analysis model…';
        api('/retake-profile', { method: 'POST', body: JSON.stringify({ profileId: profileId }) }).then(function () {
            byId('removeRetakesStatus').textContent = 'Retake analysis will use the selected API/model.';
        }).catch(function (error) {
            byId('removeRetakesStatus').textContent = 'Could not save the retake API: ' + error.message;
        }).finally(function () {
            byId('removeRetakesProfile').disabled = false;
        });
    }

    function refreshProfiles() {
        runtime = readRuntime();
        if (!runtime) {
            byId('chatRotationStatus').textContent = 'MCP server unavailable';
            setStatus('Start/restart the MCP server, then reload this panel.', true);
            return Promise.resolve();
        }
        return api('/profiles', { method: 'GET' }).then(renderProfiles).catch(function (error) {
            byId('chatRotationStatus').textContent = 'Chat offline';
            setStatus(error.message, true);
        });
    }

    function resetForm() {
        editingProfileId = null;
        byId('chatApiFormTitle').textContent = 'Add API connection';
        byId('chatSaveApi').textContent = 'Save API';
        byId('chatProfileName').value = '';
        byId('chatProvider').value = 'openai';
        byId('chatBaseUrl').value = '';
        byId('chatApiKey').value = '';
        byId('chatModelManual').value = '';
        byId('chatModelSelect').innerHTML = '<option value="">Fetch models to choose</option>';
        byId('chatApiKey').placeholder = 'Enter provider key';
        byId('chatFetchModels').textContent = 'Fetch Models';
        updateProviderHelp();
        setApiSettingsStatus('Enter your provider details, then click Fetch Models.', false);
    }

    function editProfile(profile) {
        editingProfileId = profile.id;
        byId('chatApiFormTitle').textContent = 'Edit API connection';
        byId('chatSaveApi').textContent = 'Save Changes';
        byId('chatProfileName').value = profile.name;
        byId('chatProvider').value = profile.provider;
        byId('chatBaseUrl').value = profile.baseUrl || '';
        byId('chatApiKey').value = '';
        byId('chatApiKey').placeholder = profile.hasApiKey ? 'Saved key kept if left blank; enter a new key to replace it' : 'Enter provider key';
        byId('chatModelManual').value = profile.model;
        byId('chatModelSelect').innerHTML = '<option value="">Fetch models to choose</option>';
        byId('chatFetchModels').textContent = 'Fetch Models';
        updateProviderHelp();
        setApiSettingsStatus('Saved API key is kept if the key field is left blank.', false);
        byId('chatProfileName').scrollIntoView({ block: 'nearest' });
    }

    function mutateProfile(payload) {
        byId('chatSaveApi').disabled = true;
        byId('chatFetchModels').disabled = true;
        return api('/profiles', { method: 'POST', body: JSON.stringify(payload) }).then(function () {
            if (payload.action !== 'remove') resetForm();
            setApiSettingsStatus('API connection saved locally. Rotation starts again from the first connection.', false);
            setStatus('API connection saved locally.', false);
            return refreshProfiles();
        }).catch(function (error) {
            setApiSettingsStatus(error.message, true);
            setStatus(error.message, true);
        }).finally(function () {
            byId('chatSaveApi').disabled = false;
            byId('chatFetchModels').disabled = false;
        });
    }

    function fetchModels() {
        var request = {
            provider: byId('chatProvider').value,
            baseUrl: byId('chatBaseUrl').value.trim(),
            apiKey: byId('chatApiKey').value,
        };
        if (editingProfileId) request.profileId = editingProfileId;
        var button = byId('chatFetchModels');
        button.disabled = true;
        button.textContent = 'Loading…';
        setApiSettingsStatus('Requesting model list…', false);
        return api('/models', { method: 'POST', body: JSON.stringify(request) }).then(function (data) {
            var options = byId('chatModelSelect');
            options.innerHTML = '<option value="">Choose a model…</option>';
            var current = byId('chatModelManual').value.trim();
            var currentFound = false;
            (data.models || []).forEach(function (model) {
                var option = document.createElement('option');
                option.value = model.id;
                option.textContent = model.label === model.id ? model.id : model.label + ' (' + model.id + ')';
                options.appendChild(option);
                if (current && current === model.id) currentFound = true;
            });
            if (currentFound) {
                options.value = current;
                byId('chatModelManual').value = '';
            }
            setApiSettingsStatus((data.models || []).length + ' models loaded. Choose one below, or enter the exact model ID manually.', false);
        }).catch(function (error) {
            setApiSettingsStatus(error.message + ' You can still enter a model ID manually.', true);
        }).finally(function () {
            button.disabled = false;
            button.textContent = 'Fetch Models';
        });
    }

    function saveProfile(event) {
        event.preventDefault();
        var profile = {
            name: byId('chatProfileName').value.trim(),
            provider: byId('chatProvider').value,
            model: byId('chatModelManual').value.trim() || byId('chatModelSelect').value,
            baseUrl: byId('chatBaseUrl').value.trim(),
            apiKey: byId('chatApiKey').value,
        };
        if (!profile.model) {
            setStatus('Choose a model from the loaded list or enter its model ID.', true);
            byId('chatModelSelect').focus();
            return;
        }
        mutateProfile(editingProfileId
            ? { action: 'update', id: editingProfileId, profile: profile }
            : { action: 'add', profile: profile });
    }

    function sendMessage(event) {
        event.preventDefault();
        if (chatBusy) return;
        var input = byId('chatInput');
        var message = input.value.trim();
        if (!message) return;
        chatBusy = true;
        chatRequestController = new AbortController();
        input.value = '';
        history.push({ role: 'user', content: message });
        addMessage(message, 'user');
        byId('chatSend').disabled = true;
        byId('chatSend').textContent = 'Working…';
        byId('chatStop').disabled = false;
        setStatus('Sending to the active model connection…', false);
        api('/chat', { method: 'POST', body: JSON.stringify({ message: message, history: history.slice(0, -1) }), signal: chatRequestController.signal }).then(function (data) {
            if (data.reply) {
                addMessage(data.reply, 'assistant');
                history.push({ role: 'assistant', content: data.reply });
            }
            if (data.activeProfile) setStatus('Handled by ' + data.activeProfile.name + ' · ' + data.activeProfile.model, false);
            refreshProfiles();
        }).catch(function (error) {
            if (error.name === 'AbortError') {
                addMessage('Stopped waiting. Premiere may finish an edit that had already started.', 'assistant');
                setStatus('Stopped. Check the active sequence before repeating an edit.', false);
                return;
            }
            addMessage(error.message, 'error');
            setStatus(error.message, true);
        }).finally(function () {
            chatBusy = false;
            chatRequestController = null;
            byId('chatSend').disabled = false;
            byId('chatSend').textContent = 'Send';
            byId('chatStop').disabled = true;
            input.focus();
        });
    }

    function init() {
        byId('chatForm').addEventListener('submit', sendMessage);
        byId('chatStop').addEventListener('click', function () { if (chatRequestController) chatRequestController.abort(); });
        byId('chatApiForm').addEventListener('submit', saveProfile);
        byId('chatFetchModels').addEventListener('click', fetchModels);
        byId('chatNewApi').addEventListener('click', resetForm);
        byId('chatModelSelect').addEventListener('change', function () { if (this.value) byId('chatModelManual').value = ''; });
        byId('chatModelManual').addEventListener('input', function () { if (this.value.trim()) byId('chatModelSelect').value = ''; });
        byId('chatSettingsOpen').addEventListener('click', function () {
            refreshProfiles();
            if (typeof byId('chatSettingsDialog').showModal === 'function') byId('chatSettingsDialog').showModal();
            else byId('chatSettingsDialog').setAttribute('open', 'open');
        });
        byId('removeRetakesManageApi').addEventListener('click', function () { byId('chatSettingsOpen').click(); });
        byId('removeRetakesProfile').addEventListener('change', saveRetakeProfile);
        byId('chatSettingsClose').addEventListener('click', function () {
            var dialog = byId('chatSettingsDialog');
            if (typeof dialog.close === 'function') dialog.close();
            else dialog.removeAttribute('open');
        });
        byId('chatProvider').addEventListener('change', function () {
            updateProviderHelp();
            byId('chatModelSelect').innerHTML = '<option value="">Fetch models to choose</option>';
            setApiSettingsStatus('Enter your provider details, then click Fetch Models.', false);
        });
        updateProviderHelp();
        refreshProfiles();
        profileRefreshTimer = setInterval(refreshProfiles, 15000);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    window.MCPPremiereAssistant = {
        invokeRemoveRetakes: function (startTime, endTime, timeoutSeconds) {
            runtime = readRuntime();
            return api('/tools/remove_retakes', { method: 'POST', body: JSON.stringify({ start_time: startTime, end_time: endTime, timeout_seconds: timeoutSeconds }) });
        },
        stopRemoveRetakes: function () {
            runtime = readRuntime();
            return api('/tools/remove_retakes/stop', { method: 'POST', body: '{}' });
        }
    };
    window.addEventListener('beforeunload', function () { if (profileRefreshTimer) clearInterval(profileRefreshTimer); });
})();
