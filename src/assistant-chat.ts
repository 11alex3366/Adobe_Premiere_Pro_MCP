import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { generateText, Output, hasToolCall, stepCountIs, tool, type ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import type { PremiereProTools } from './tools/index.js';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';

type ModelProvider = 'openai' | 'anthropic' | 'google' | 'openai-compatible' | 'ollama';
type ModelProfile = {
  id: string;
  name: string;
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKey: string;
};
type ProfileStore = { version: 1; rotationStartedAt: number; profiles: ModelProfile[]; retakeProfileId?: string | null };
type ChatLogger = { info(message: string): void; error(message: string): void };

const ROTATION_MS = 10 * 60 * 1000;
const PROFILE_STORE_DIR = join(homedir(), '.adobe-premiere-pro-mcp');
const PROFILE_STORE_FILE = join(PROFILE_STORE_DIR, 'assistant-model-profiles.json');
const CHAT_SYSTEM = [
  'You are the AI assistant inside the Adobe Premiere Pro MCP Bridge panel.',
  'Use the available MCP tools to act on the active Premiere project. For tools outside the compact advertised set, use search_tools, get_tool_schema, and invoke_tool.',
  'For a single requested cut, call remove_range once. For multiple cuts, call remove_ranges once with all requested ranges.',
  'After calling remove_range or remove_ranges, stop. Do not inspect, verify, retry, or call another tool; the panel will show that the command was sent without another model request.',
  'For remove_retakes, use the requested In/Out seconds and make exactly one tool call. After it returns, stop and report its concise summary; do not inspect or retry.',
  'Be concise. Never claim a Premiere action succeeded unless the tool result confirms it.',
  '',
  MCP_SERVER_INSTRUCTIONS,
].join('\n');

const profileInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.enum(['openai', 'anthropic', 'google', 'openai-compatible', 'ollama']),
  model: z.string().trim().min(1).max(200),
  baseUrl: z.string().trim().max(500).optional(),
  apiKey: z.string().max(2000).optional(),
}).strict();

export class PremiereAssistantChat {
  private server: Server | undefined;
  private activeRetakeAbort: AbortController | null = null;
  private token = '';
  private runtimeFile: string;
  private tempDir: string;

  constructor(
    private readonly tools: PremiereProTools,
    tempDirValue: string,
    private readonly sessionId: string,
    private readonly logger: ChatLogger,
  ) {
    this.tempDir = tempDirValue;
    this.runtimeFile = join(this.tempDir, 'assistant-chat-runtime.json');
  }

  async start(): Promise<void> {
    this.token = randomBytes(32).toString('hex');
    this.server = createServer((request, response) => { void this.handleRequest(request, response); });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Could not bind the local assistant chat server.');
    await writeFile(this.runtimeFile, JSON.stringify({
      version: 1,
      sessionId: this.sessionId,
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: this.token,
    }), { mode: 0o600 });
    this.logger.info(`Local assistant chat endpoint started on 127.0.0.1:${address.port}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.token = '';
    try {
      const raw = await readFile(this.runtimeFile, 'utf8');
      const runtime = JSON.parse(raw) as { sessionId?: string };
      if (runtime.sessionId === this.sessionId) await unlink(this.runtimeFile);
    } catch { /* Already cleaned or owned by a newer session. */ }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin;
    if (origin && origin !== 'null' && !origin.startsWith('file://')) {
      response.writeHead(403).end('Forbidden origin');
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin || 'null');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
    if (!this.authorized(request)) { response.writeHead(401).end('Unauthorized'); return; }

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const store = await this.readProfiles();
        const active = this.activeProfile(store);
        this.sendJson(response, 200, {
          ready: true,
          profileCount: store.profiles.length,
          activeProfile: active ? this.publicProfile(active.profile) : null,
          activeIndex: active?.index ?? -1,
          nextRotationAt: active?.nextRotationAt ?? null,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/profiles') {
        const store = await this.readProfiles();
        const active = this.activeProfile(store);
        this.sendJson(response, 200, {
          profiles: store.profiles.map((profile) => this.publicProfile(profile)),
          activeId: active?.profile.id ?? null,
          activeProfile: active ? this.publicProfile(active.profile) : null,
          retakeProfileId: this.getRetakeProfile(store)?.id ?? null,
          nextRotationAt: active?.nextRotationAt ?? null,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/retake-profile') {
        const body = await this.readBody(request);
        const store = await this.readProfiles();
        const profileId = typeof body.profileId === 'string' ? body.profileId : null;
        if (profileId && !store.profiles.some((profile) => profile.id === profileId)) throw new Error('Select a saved API connection for Remove Retakes.');
        store.retakeProfileId = profileId;
        await this.writeProfiles(store);
        this.sendJson(response, 200, { success: true, retakeProfileId: this.getRetakeProfile(store)?.id ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/profiles') {
        const body = await this.readBody(request);
        const action = body.action;
        const store = await this.readProfiles();
        if (action === 'add') {
          const profile = profileInputSchema.parse(body.profile);
          if (store.profiles.length >= 20) throw new Error('You can save up to 20 model profiles.');
          if (!profile.apiKey?.trim() && profile.provider !== 'ollama') throw new Error('Enter an API key for this provider.');
          const normalizedBase = profile.baseUrl?.trim().replace(/\/$/, '') || undefined;
          if ((profile.provider === 'openai-compatible' || profile.provider === 'ollama') && !normalizedBase) {
            throw new Error('This provider needs a Base URL.');
          }
          const storedProfile: ModelProfile = {
            id: randomBytes(12).toString('hex'),
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            apiKey: profile.apiKey?.trim() || 'ollama',
          };
          if (normalizedBase) storedProfile.baseUrl = normalizedBase;
          store.profiles.push(storedProfile);
        } else if (action === 'update' && typeof body.id === 'string') {
          const profile = profileInputSchema.parse(body.profile);
          const index = store.profiles.findIndex((item) => item.id === body.id);
          if (index < 0) throw new Error('Saved API connection was not found.');
          const oldProfile = store.profiles[index]!;
          const normalizedBase = profile.baseUrl?.trim().replace(/\/$/, '') || undefined;
          if ((profile.provider === 'openai-compatible' || profile.provider === 'ollama') && !normalizedBase) {
            throw new Error('This provider needs a Base URL.');
          }
          const updated: ModelProfile = {
            id: oldProfile.id,
            name: profile.name,
            provider: profile.provider,
            model: profile.model,
            apiKey: profile.apiKey?.trim() || oldProfile.apiKey,
          };
          if (normalizedBase) updated.baseUrl = normalizedBase;
          store.profiles[index] = updated;
        } else if (action === 'remove' && typeof body.id === 'string') {
          store.profiles = store.profiles.filter((profile) => profile.id !== body.id);
        } else {
          throw new Error('Unknown model profile action.');
        }
        if (action === 'add' && !store.retakeProfileId) store.retakeProfileId = store.profiles[0]?.id ?? null;
        if (action === 'remove' && store.retakeProfileId && !store.profiles.some((profile) => profile.id === store.retakeProfileId)) {
          store.retakeProfileId = store.profiles[0]?.id ?? null;
        }
        store.rotationStartedAt = Date.now();
        await this.writeProfiles(store);
        this.sendJson(response, 200, { success: true, profiles: store.profiles.map((profile) => this.publicProfile(profile)), retakeProfileId: this.getRetakeProfile(store)?.id ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/models') {
        const body = await this.readBody(request);
        const store = await this.readProfiles();
        const saved = typeof body.profileId === 'string' ? store.profiles.find((profile) => profile.id === body.profileId) : undefined;
        const provider = body.provider || saved?.provider;
        const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : saved?.baseUrl;
        const apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() ? body.apiKey.trim() : saved?.apiKey;
        if (!['openai', 'anthropic', 'google', 'openai-compatible', 'ollama'].includes(provider)) throw new Error('Select a supported provider first.');
        if (!apiKey && provider !== 'ollama') throw new Error('Enter or select a saved API key before loading models.');
        const models = await this.discoverModels(provider as ModelProvider, baseUrl, apiKey || 'ollama');
        this.sendJson(response, 200, { models });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/chat') {
        const body = await this.readBody(request);
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 12000) throw new Error('Enter a message no longer than 12,000 characters.');
        const store = await this.readProfiles();
        const active = this.activeProfile(store);
        if (!active) throw new Error('Add at least one model profile before chatting.');
        const controller = new AbortController();
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        const result = await this.runAgent(active.profile, body.history, message, controller.signal);
        this.sendJson(response, 200, { ...result, activeProfile: this.publicProfile(active.profile) });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/tools/remove_retakes') {
        const body = await this.readBody(request);
        const controller = new AbortController();
        this.activeRetakeAbort = controller;
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          const result = await this.tools.executeTool('remove_retakes', body as Record<string, any>, controller.signal);
          this.sendJson(response, 200, result);
        } finally {
          if (this.activeRetakeAbort === controller) this.activeRetakeAbort = null;
        }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/tools/remove_retakes/stop') {
        const stopped = !!this.activeRetakeAbort && !this.activeRetakeAbort.signal.aborted;
        this.activeRetakeAbort?.abort();
        this.activeRetakeAbort = null;
        this.sendJson(response, 200, { success: stopped, status: stopped ? 'stop_requested' : 'not_running', message: stopped ? 'Stop requested. A Premiere native Extract already in progress cannot be interrupted safely and may still complete.' : 'No Remove Retakes operation is currently running.' });
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sendJson(response, 400, { success: false, error: message });
    }
  }

  private async runAgent(profile: ModelProfile, historyValue: unknown, message: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const history = Array.isArray(historyValue) ? historyValue.slice(-30) : [];
    const messages = [
      ...history.flatMap((item): Array<{ role: 'user' | 'assistant'; content: string }> => {
        if (!item || typeof item !== 'object') return [];
        const record = item as Record<string, unknown>;
        if ((record.role === 'user' || record.role === 'assistant') && typeof record.content === 'string' && record.content.length <= 12000) {
          return [{ role: record.role, content: record.content }];
        }
        return [];
      }),
      { role: 'user' as const, content: message },
    ];
    const toolDefinitions = this.tools.getAdvertisedTools();
    const modelTools: Record<string, any> = {};
    for (const definition of toolDefinitions) {
      modelTools[definition.name] = tool({
        description: definition.description,
        inputSchema: definition.inputSchema,
        execute: async (args) => this.tools.executeTool(definition.name, args as Record<string, any>, signal),
      });
    }

    const generation = await generateText({
      model: this.resolveModel(profile),
      system: CHAT_SYSTEM,
      messages,
      tools: modelTools as ToolSet,
      // A destructive tool call is terminal for this turn. The tool result is
      // returned below as a fixed reply; do not ask the model for a second,
      // post-edit response after Premiere has finished.
      stopWhen: [stepCountIs(8), hasToolCall('remove_range'), hasToolCall('remove_ranges'), hasToolCall('remove_retakes')],
      maxRetries: 0,
      ...(signal ? { abortSignal: signal } : {}),
      timeout: { totalMs: 120000, stepMs: 90000 },
    });
    const calls = generation.steps.flatMap((step) => step.toolCalls.map((call) => call.toolName));
    const cutCall = generation.steps.flatMap((step) => step.toolResults).find((result) => result.toolName === 'remove_range' || result.toolName === 'remove_ranges');
    if (cutCall) {
      return { success: true, reply: 'تم إرسال أمر القص.', toolCalls: calls, result: cutCall.output };
    }
    const retakeCall = generation.steps.flatMap((step) => step.toolResults).find((result) => result.toolName === 'remove_retakes');
    if (retakeCall) return { success: true, reply: 'انتهى تنفيذ إزالة الإعادات.', toolCalls: calls, result: retakeCall.output };
    return { success: true, reply: generation.text, toolCalls: calls };
  }

  async analyzeRetakes(cues: Array<{ index: number; start: number; end: number; text: string; whisperConfidence?: number }>, signal?: AbortSignal): Promise<Array<{ id: number; takes: Array<{ start_time: number; end_time: number }>; bestTakeIndex: number | null; confidence: number; reason: string }>> {
    const store = await this.readProfiles();
    const profile = this.getRetakeProfile(store);
    if (!profile) throw new Error('No API connection is selected for Remove Retakes. Add one inside the Remove Retakes section.');
    const analysisSchema = z.object({
      groups: z.array(z.object({
        id: z.number().int().positive(),
        takes: z.array(z.object({ start_time: z.number().finite().nonnegative(), end_time: z.number().finite().positive() }).strict()).min(2),
        bestTakeIndex: z.number().int().nonnegative().nullable(),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(300),
      }).strict()),
    }).strict();
    const prompt = [
      'Analyze the entire transcript, which may be Arabic. Detect repeated sentences/phrases and alternative attempts, including incomplete attempts, when wording differs slightly.',
      'Explicitly compare the full word sequence for repeated blocks of 4 or more consecutive words, including Arabic. A repeated phrase after a pause is a retake even without punctuation. Ignore ordinary discourse repetition that is not a separate attempt.',
      'For each complete attempt, return exact start_time and end_time in seconds relative to the requested In point. Use the start of its first word cue and end of its last word cue; include only that attempt, not adjacent unrelated speech. Never return overlapping attempts. Order takes by time.',
      'Choose the most complete, coherent attempt. Use word timing and Whisper confidence only as weak supporting hints; transcript cues do not establish actual vocal clarity. If uncertain, set bestTakeIndex to null and confidence below 0.75. If no retakes exist, return an empty groups array.',
      'Return compact valid JSON only: {"groups":[{"id":1,"takes":[{"start_time":12.54,"end_time":16.34},{"start_time":16.76,"end_time":19.22}],"bestTakeIndex":1,"confidence":0.9,"reason":"complete phrase"}]}. Keep reason under 8 words. bestTakeIndex is zero-based.',
      'Transcript cues (times are seconds relative to the requested In point):',
      'Plain transcript for direct reading:',
      cues.map((cue) => cue.text.replace(/[\r\n]/g, ' ')).join(' '),
      'Indexed timed cues:',
      cues.map((cue) => `${cue.index}|${cue.start.toFixed(3)}|${cue.end.toFixed(3)}|${cue.whisperConfidence === undefined ? '-' : cue.whisperConfidence.toFixed(3)}|${cue.text.replace(/[\r\n|]/g, ' ')}`).join('\n'),
    ].join('\n');
    try {
      const generation = await generateText({
        model: this.resolveModel(profile),
        system: 'Analyze the word-level transcript and return the required structured retake plan. Do not provide prose or markdown.',
        prompt,
        output: Output.object({
          schema: analysisSchema,
          name: 'retake_analysis',
          description: 'Retake groups with exact SRT times and the best attempt index.',
        }),
        temperature: 0,
        // Keep one complete response budget for transcripts containing many
        // candidate groups, while disabling SDK retries for a single API call.
        maxOutputTokens: 8192,
        maxRetries: 0,
        ...(signal ? { abortSignal: signal } : {}),
        timeout: { totalMs: 90000, stepMs: 90000 },
      });
      if (!generation.output) throw new Error('The model returned no structured output.');
      return generation.output.groups;
    } catch (error) {
      if (signal?.aborted) throw new Error('Retake model analysis stopped by the user. No timeline changes were made.');
      const failure = error as Error & { text?: string };
      const raw = typeof failure.text === 'string' ? failure.text.trim().slice(0, 400) : '';
      this.logger.error(`[remove_retakes] stage=api_structured_analysis_failed attempt=1 profile=${profile.name} provider=${profile.provider} model=${profile.model} error=${failure.message || String(error)}`);
      const detail = raw ? ` Model response excerpt: ${raw}` : '';
      throw new Error(`Retake API analysis failed on its single attempt for ${profile.name} (${profile.provider}/${profile.model}): ${failure.message || String(error)}.${detail}`);
    }
  }

  private resolveModel(profile: ModelProfile) {
    switch (profile.provider) {
      case 'openai':
        return createOpenAI({ apiKey: profile.apiKey, ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}) })(profile.model);
      case 'anthropic':
        return createAnthropic({ apiKey: profile.apiKey, ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}) })(profile.model);
      case 'google':
        return createGoogleGenerativeAI({ apiKey: profile.apiKey, ...(profile.baseUrl ? { baseURL: profile.baseUrl } : {}) })(profile.model);
      case 'ollama':
        return createOpenAICompatible({ name: 'ollama', apiKey: profile.apiKey || 'ollama', baseURL: profile.baseUrl! })(profile.model);
      case 'openai-compatible':
        return createOpenAICompatible({ name: 'custom-compatible', apiKey: profile.apiKey, baseURL: profile.baseUrl! })(profile.model);
    }
  }

  private async discoverModels(provider: ModelProvider, baseUrl: string | undefined, apiKey: string): Promise<Array<{ id: string; label: string }>> {
    const requestJson = async (url: string, headers: Record<string, string> = {}) => {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      let data: any;
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
      if (!response.ok) throw new Error(data.error?.message || data.message || `Provider returned HTTP ${response.status}.`);
      return data;
    };
    let entries: Array<{ id: string; label?: string }>;
    if (provider === 'google') {
      const root = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
      const data = await requestJson(`${root}/v1beta/models?key=${encodeURIComponent(apiKey)}`);
      entries = (data.models || [])
        .filter((item: any) => Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes('generateContent'))
        .map((item: any) => ({ id: String(item.name || '').replace(/^models\//, ''), label: String(item.displayName || item.name || '') }));
    } else if (provider === 'anthropic') {
      const root = (baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
      const data = await requestJson(`${root}/v1/models?limit=100`, { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' });
      entries = (data.data || []).map((item: any) => ({ id: String(item.id || ''), label: String(item.display_name || item.id || '') }));
    } else if (provider === 'ollama') {
      const root = (baseUrl || 'http://localhost:11434/v1').replace(/\/v1\/?$/, '');
      try {
        const data = await requestJson(`${root}/api/tags`);
        entries = (data.models || []).map((item: any) => ({ id: String(item.name || item.model || ''), label: String(item.name || item.model || '') }));
      } catch {
        const data = await requestJson(`${root}/v1/models`, { Authorization: `Bearer ${apiKey}` });
        entries = (data.data || []).map((item: any) => ({ id: String(item.id || ''), label: String(item.id || '') }));
      }
    } else {
      const root = (baseUrl || (provider === 'openai' ? 'https://api.openai.com/v1' : '')).replace(/\/$/, '');
      if (!root) throw new Error('Enter the API Base URL for this compatible provider.');
      const data = await requestJson(`${root}/models`, { Authorization: `Bearer ${apiKey}` });
      entries = (data.data || data.models || []).map((item: any) => ({
        id: String(item.id || item.name || ''),
        label: String(item.name || item.id || ''),
      }));
    }
    const unique = new Map<string, { id: string; label: string }>();
    for (const item of entries) if (item.id) unique.set(item.id, { id: item.id, label: item.label || item.id });
    if (!unique.size) throw new Error('The provider returned no model list. You can still type a model ID manually.');
    return [...unique.values()].sort((a, b) => a.label.localeCompare(b.label));
  }

  private activeProfile(store: ProfileStore): { profile: ModelProfile; index: number; nextRotationAt: number } | null {
    if (!store.profiles.length) return null;
    const elapsed = Math.max(0, Date.now() - store.rotationStartedAt);
    const interval = Math.floor(elapsed / ROTATION_MS);
    const index = interval % store.profiles.length;
    const profile = store.profiles[index];
    if (!profile) return null;
    return {
      profile,
      index,
      nextRotationAt: store.rotationStartedAt + (interval + 1) * ROTATION_MS,
    };
  }

  private getRetakeProfile(store: ProfileStore): ModelProfile | null {
    if (store.retakeProfileId) return store.profiles.find((profile) => profile.id === store.retakeProfileId) ?? null;
    return store.profiles[0] ?? null;
  }

  private async readProfiles(): Promise<ProfileStore> {
    let raw: string;
    try {
      raw = await readFile(PROFILE_STORE_FILE, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, rotationStartedAt: Date.now(), profiles: [] };
      throw error;
    }
    const envelope = JSON.parse(raw) as { version?: number; protectedData?: string } & Partial<ProfileStore>;
    let data: ProfileStore;
    if (envelope.protectedData) {
      const json = process.platform === 'win32'
        ? await this.runWindowsDpapi(envelope.protectedData, 'unprotect')
        : Buffer.from(envelope.protectedData, 'base64').toString('utf8');
      data = JSON.parse(json) as ProfileStore;
    } else {
      data = envelope as ProfileStore;
    }
    if (data.version === 1 && Array.isArray(data.profiles) && Number.isFinite(data.rotationStartedAt)) return data;
    throw new Error('The saved model profile file is invalid. Remove or repair assistant-model-profiles.json, then add the profiles again.');
  }

  private async writeProfiles(store: ProfileStore): Promise<void> {
    await mkdir(PROFILE_STORE_DIR, { recursive: true, mode: 0o700 });
    const json = JSON.stringify(store, null, 2);
    const protectedData = process.platform === 'win32'
      ? await this.runWindowsDpapi(json, 'protect')
      : Buffer.from(json, 'utf8').toString('base64');
    const stagingFile = `${PROFILE_STORE_FILE}.${this.sessionId}.tmp`;
    await writeFile(stagingFile, JSON.stringify({ version: 1, protectedData }), { mode: 0o600 });
    await rename(stagingFile, PROFILE_STORE_FILE);
  }

  private async runWindowsDpapi(value: string, action: 'protect' | 'unprotect'): Promise<string> {
    const protect = action === 'protect';
    const script = [
      'Add-Type -AssemblyName System.Security;',
      '$inputValue = [Console]::In.ReadToEnd();',
      '$inputBytes = [Convert]::FromBase64String($inputValue);',
      protect
        ? '$outputBytes = [System.Security.Cryptography.ProtectedData]::Protect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);'
        : '$outputBytes = [System.Security.Cryptography.ProtectedData]::Unprotect($inputBytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
      '[Console]::Out.Write([Convert]::ToBase64String($outputBytes));',
    ].join(' ');
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', reject);
      child.once('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Windows DPAPI ${action} failed: ${Buffer.concat(stderr).toString('utf8').trim() || `exit ${code}`}`));
          return;
        }
        const result = Buffer.concat(stdout).toString('utf8').trim();
        resolve(protect ? result : Buffer.from(result, 'base64').toString('utf8'));
      });
      child.stdin.end(protect ? Buffer.from(value, 'utf8').toString('base64') : value);
    });
  }

  private publicProfile(profile: ModelProfile): Omit<ModelProfile, 'apiKey'> & { hasApiKey: boolean } {
    const { apiKey, ...safe } = profile;
    return { ...safe, hasApiKey: Boolean(apiKey) };
  }

  private authorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization || '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expectedBuffer = Buffer.from(this.token);
    const suppliedBuffer = Buffer.from(supplied);
    return suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(suppliedBuffer, expectedBuffer);
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, any>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 1024 * 1024) throw new Error('Request body is too large.');
      chunks.push(buffer);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON request.');
    return parsed as Record<string, any>;
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(value));
  }
}
