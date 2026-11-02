/**
 * CEP evalScript is single-flight. A JS timeout that starts a second native
 * call while the first callback is still outstanding wedges Premiere until
 * restart (GitHub issue 86).
 */

import { loadPanel } from '../helpers/panel.js';

describe('CEP evalScript single-flight', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not start a second evalScript until the first native callback runs, even after the waiter times out', () => {
    jest.useFakeTimers();
    const { bridge } = loadPanel();
    const evalCalls: Array<(result: string) => void> = [];

    bridge.csInterface = {
      getHostEnvironment: () => ({ appName: 'PPRO', appVersion: '26.0.0' }),
      evalScript: (_script: string, callback: (result: string) => void) => {
        evalCalls.push(callback);
      }
    };
    bridge.normalizeHostEnvironment = (value: unknown) => value;
    bridge.log = () => {};

    const waiterResults: string[] = [];
    bridge.executeExtendScript('return 1;', (err: Error | null) => {
      waiterResults.push(err ? err.message : 'ok');
    });

    expect(evalCalls).toHaveLength(1);

    bridge.executeExtendScript('return 2;', () => {});
    expect(evalCalls).toHaveLength(1);

    jest.advanceTimersByTime(45000);
    expect(waiterResults[0]).toMatch(/timed out after 45000ms/);
    expect(evalCalls).toHaveLength(1);

    evalCalls[0](JSON.stringify({ ok: true }));
    jest.advanceTimersByTime(0);

    expect(evalCalls).toHaveLength(2);
  });

  it('still prepends the prelude on the script handed to evalScript', () => {
    jest.useFakeTimers();
    const { bridge, handedToEvalScript } = loadPanel();
    bridge.log = () => {};
    bridge.executeExtendScript('return 1;', () => {});
    expect(handedToEvalScript()).toContain('function __mcpStringify');
    expect(handedToEvalScript().endsWith('return 1;')).toBe(true);
  });
});

describe('CEP panel auto-start', () => {
  it('starts the bridge when the panel initializes and a temp directory exists', () => {
    const { bridge } = loadPanel();
    const started: string[] = [];
    bridge.loadConfig = () => {};
    bridge.updateUI = () => {};
    bridge.startCommandPolling = () => {};
    bridge.checkForPackageUpdate = () => {};
    bridge.getTempDirectory = () => '/tmp/premiere-mcp-bridge';
    bridge.startBridge = function () { started.push('started'); };
    bridge.csInterface = { getHostEnvironment: () => ({ appName: 'PPRO', appVersion: '26.0.0' }) };
    bridge.log = () => {};
    bridge.init();
    expect(started).toEqual(['started']);
  });
});

describe('CEP panel heartbeat', () => {
  it('writes bridge-heartbeat.json so the server can fail fast when Premiere is not listening', () => {
    const { bridge, fs } = loadPanel();
    bridge.getTempDirectory = () => '/tmp/premiere-mcp-bridge';
    bridge.isConnected = true;

    bridge.writeHeartbeat();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/premiere-mcp-bridge/bridge-heartbeat.json',
      expect.stringMatching(/"started":true/),
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      '/tmp/premiere-mcp-bridge/bridge-heartbeat.json',
      expect.stringMatching(/"scriptOkAt":/),
    );
  });

  it('reports the active MCP session in its heartbeat', () => {
    const { bridge, fs } = loadPanel();
    bridge.getTempDirectory = () => '/tmp/premiere-mcp-bridge';
    bridge.isConnected = true;

    bridge.writeHeartbeat();

    const heartbeat = JSON.parse(String(fs.writeFileSync.mock.calls[0]?.[1]));
    expect(heartbeat).toMatchObject({ started: true, sessionId: 'panel-session' });
    expect(heartbeat.panelSessionId).toBe(bridge.panelSessionId);
  });

  it('does not dispatch a command left by an older MCP session', () => {
    const { bridge, fs, handedToEvalScript } = loadPanel();
    const dir = '/tmp/premiere-mcp-bridge';
    bridge.getTempDirectory = () => dir;
    bridge.serverSessionId = 'old-session';
    bridge.serverSessionActive = true;
    fs.readFileSync.mockImplementation((file) => {
      if (String(file).endsWith('/server-session.json')) return JSON.stringify({ sessionId: 'new-session', active: true });
      return JSON.stringify({ id: 'old-command', sessionId: 'old-session', script: 'return 1;' });
    });

    bridge.processCommandFile(dir + '/command-old-command.json');

    expect(handedToEvalScript()).toBe('');
    expect(fs.unlinkSync).toHaveBeenCalledWith(dir + '/command-old-command.json');
    expect(fs.unlinkSync).toHaveBeenCalledWith(dir + '/active-old-command.json');
    expect(fs.unlinkSync).toHaveBeenCalledWith(dir + '/claim-old-command.json');
  });

  it('does not dispatch a command left by an older CEP panel session', () => {
    const { bridge, fs, handedToEvalScript } = loadPanel();
    const dir = '/tmp/premiere-mcp-bridge';
    bridge.getTempDirectory = () => dir;
    bridge.serverSessionId = 'server-session';
    bridge.serverSessionActive = true;
    fs.readFileSync.mockImplementation((file) => {
      if (String(file).endsWith('/server-session.json')) return JSON.stringify({ sessionId: 'server-session', active: true });
      return JSON.stringify({ id: 'old-panel-command', sessionId: 'server-session', panelSessionId: 'old-panel', script: 'return 1;' });
    });

    bridge.processCommandFile(dir + '/command-old-panel-command.json');

    expect(handedToEvalScript()).toBe('');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      dir + '/response-old-panel-command.json.part',
      expect.stringContaining('panel restarted'),
    );
    expect(fs.unlinkSync).toHaveBeenCalledWith(dir + '/command-old-panel-command.json');
  });
});
