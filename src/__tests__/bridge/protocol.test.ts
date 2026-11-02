/**
 * The file-queue handoff between the server and the CEP panel.
 *
 * The protocol is a directory of command-<id>.json and response-<id>.json files
 * polled by both sides, so every failure here is a race or a partial read rather
 * than a logic error, and each one was visible in practice: stale response files
 * accumulated in the bridge directory, and a malformed payload was reported as
 * "Ensure Premiere Pro is open".
 */

import { PremiereProBridge } from '../../bridge/index.js';
import { promises as fs } from 'fs';
import path from 'path';

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    access: jest.fn(),
    readdir: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    unlink: jest.fn(),
    rename: jest.fn(),
    rm: jest.fn(),
  }
}));

jest.mock('node:crypto', () => ({
  randomUUID: jest.fn(() => 'test-uuid-1234')
}));

describe('bridge file-queue protocol', () => {
  const mockFs = fs as jest.Mocked<typeof fs>;
  const dir = '/tmp/premiere-mcp-bridge-test';
  const commandPath = path.join(dir, 'command-test-uuid-1234.json');
  const responsePath = path.join(dir, 'response-test-uuid-1234.json');
  const activePath = path.join(dir, 'active-test-uuid-1234.json');
  const stagingPath = path.join(dir, '.tmp-test-uuid-1234.json');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PREMIERE_TEMP_DIR = dir;
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.access.mockRejectedValue(new Error('Not found'));
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.rename.mockResolvedValue(undefined);
    mockFs.unlink.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([] as never);
  });

  afterEach(() => {
    delete process.env.PREMIERE_TEMP_DIR;
  });

  const readyBridge = async (): Promise<PremiereProBridge> => {
    const bridge = new PremiereProBridge();
    await bridge.initialize();
    return bridge;
  };

  describe('publishing a command', () => {
    it('renames into place rather than writing the polled name directly', async () => {
      // The panel picks up anything matching command-*.json the moment it appears.
      // Writing that name directly publishes it before the content is complete.
      mockFs.readFile.mockResolvedValue(JSON.stringify({ ok: true }));
      const bridge = await readyBridge();

      await bridge.executeScript('return 1;');

      expect(mockFs.writeFile).toHaveBeenCalledWith(stagingPath, expect.stringContaining('"sessionId":"test-uuid-1234"'));
      expect(mockFs.writeFile).not.toHaveBeenCalledWith(commandPath, expect.any(String));
      expect(mockFs.rename).toHaveBeenCalledWith(stagingPath, commandPath);
    });

    it('stages under a name the panel will not mistake for a command', async () => {
      // The panel matches on a "command-" prefix, so the scratch name must not
      // start with one or it defeats the point of staging.
      mockFs.readFile.mockResolvedValue(JSON.stringify({ ok: true }));
      const bridge = await readyBridge();

      await bridge.executeScript('return 1;');

      const staged = mockFs.writeFile.mock.calls.find(([filePath]) => String(filePath) === stagingPath)?.[0] as string;
      expect(path.basename(staged).startsWith('command-')).toBe(false);
    });

    it('removes the scratch file when the rename into place fails', async () => {
      // Nothing else ever matches that name, so a failed rename leaves it on disk
      // for good. The shared bridge directory is not removed on shutdown, so these
      // accumulate there indefinitely.
      mockFs.rename.mockResolvedValueOnce(undefined);
      mockFs.rename.mockRejectedValueOnce(new Error('EXDEV'));
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;')).rejects.toThrow();

      expect(mockFs.unlink).toHaveBeenCalledWith(stagingPath);
    });
  });

  describe('session lifecycle', () => {
    it('starts a new session and removes only stale bridge protocol files', async () => {
      mockFs.readdir.mockResolvedValue([
        'command-old-session.json',
        'response-old-session.json',
        'active-old-session.json',
        'claim-old-session.json',
        '.tmp-old-session.json',
        '.server-session-old-session.tmp',
        'config.json',
        'remove-range-diagnostics.log',
        'premiere-mcp-diagnostics-latest.json',
        'bridge-heartbeat.json',
      ] as never);

      const bridge = await readyBridge();
      const sessionWrite = mockFs.writeFile.mock.calls.find(([filePath]) => String(filePath).endsWith('.server-session-test-uuid-1234.tmp'));
      expect(JSON.parse(String(sessionWrite?.[1]))).toMatchObject({ sessionId: 'test-uuid-1234', active: true });
      for (const name of ['command-old-session.json', 'response-old-session.json', 'active-old-session.json', 'claim-old-session.json', '.tmp-old-session.json', '.server-session-old-session.tmp']) {
        expect(mockFs.unlink).toHaveBeenCalledWith(path.join(dir, name));
      }
      expect(mockFs.unlink).not.toHaveBeenCalledWith(path.join(dir, 'config.json'));
      expect(mockFs.unlink).not.toHaveBeenCalledWith(path.join(dir, 'remove-range-diagnostics.log'));
      expect(mockFs.unlink).not.toHaveBeenCalledWith(path.join(dir, 'bridge-heartbeat.json'));
    });

    it('uses a fresh session ID on consecutive server restarts', async () => {
      const uuid = jest.requireMock('node:crypto').randomUUID as jest.Mock;
      uuid.mockReturnValueOnce('session-one').mockReturnValueOnce('session-two').mockReturnValueOnce('session-three');
      await readyBridge();
      await readyBridge();
      await readyBridge();

      const sessionWrites = mockFs.writeFile.mock.calls.filter(([filePath]) => String(filePath).includes('.server-session-'));
      expect(JSON.parse(String(sessionWrites[0]?.[1]))).toMatchObject({ sessionId: 'session-one', active: true });
      expect(JSON.parse(String(sessionWrites[1]?.[1]))).toMatchObject({ sessionId: 'session-two', active: true });
      expect(JSON.parse(String(sessionWrites[2]?.[1]))).toMatchObject({ sessionId: 'session-three', active: true });
    });

    it('cancels pending file requests and clears their protocol files on shutdown', async () => {
      const bridge = await readyBridge();
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      const pending = bridge.executeScript('return 1;', 20000);
      await Promise.resolve();
      await bridge.cleanup();

      await expect(pending).rejects.toThrow(/session ended|cancelled/i);
      expect(mockFs.unlink).toHaveBeenCalledWith(commandPath);
      expect(mockFs.unlink).toHaveBeenCalledWith(responsePath);
      expect(mockFs.unlink).toHaveBeenCalledWith(activePath);
      expect(mockFs.unlink).toHaveBeenCalledWith(path.join(dir, 'claim-test-uuid-1234.json'));
    });
  });

  describe('a response that will not parse', () => {
    it('recovers from a torn read once the whole file lands', async () => {
      const whole = JSON.stringify({ result: { ok: true } });
      mockFs.readFile
        .mockResolvedValueOnce(whole.slice(0, 12) as any)  // caught mid-write
        .mockResolvedValue(whole as any);
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;')).resolves.toEqual({ ok: true });
    });

    it('reports the payload, not a connection problem, when it never parses', async () => {
      // Previously every failure here fell through to the same timeout message,
      // sending the reader to check whether Premiere was running when the real
      // problem was the bytes on disk.
      mockFs.readFile.mockResolvedValue('{"result": "unterminated' as any);
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 500)).rejects.toThrow(
        /never became valid JSON/,
      );
      await expect(bridge.executeScript('return 1;', 500)).rejects.toThrow(
        /Last parse error/,
      );
    });

    it('includes what was actually on disk so the payload can be diagnosed', async () => {
      mockFs.readFile.mockResolvedValue('NOT JSON AT ALL' as any);
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 500)).rejects.toThrow(
        /NOT JSON AT ALL/,
      );
    });
  });

  describe('cleanup', () => {
    it('removes both files when the response never arrives', async () => {
      // Cleanup used to sit after the await, so a timeout skipped it entirely and
      // the response file was left behind once the panel finally wrote one.
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 400)).rejects.toThrow(/timeout/i);

      expect(mockFs.unlink).toHaveBeenCalledWith(commandPath);
      expect(mockFs.unlink).toHaveBeenCalledWith(responsePath);
      expect(mockFs.unlink).toHaveBeenCalledWith(activePath);
    });
    it('removes both files on the ordinary path too', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ result: { ok: true } }));
      const bridge = await readyBridge();

      await bridge.executeScript('return 1;');

      expect(mockFs.unlink).toHaveBeenCalledWith(commandPath);
      expect(mockFs.unlink).toHaveBeenCalledWith(responsePath);
      expect(mockFs.unlink).toHaveBeenCalledWith(activePath);
    });

    it('does not let a cleanup failure mask the result', async () => {
      mockFs.readFile.mockResolvedValue(JSON.stringify({ result: { ok: true } }));
      mockFs.unlink.mockRejectedValue(new Error('EPERM'));
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;')).resolves.toEqual({ ok: true });
    });
  });

  describe('panel heartbeat', () => {
    const heartbeatPath = path.join(dir, 'bridge-heartbeat.json');

    it('fails in a couple of seconds when Premiere is not listening, instead of hanging for a minute', async () => {
      mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
      const bridge = await readyBridge();
      const started = Date.now();

      await expect(bridge.executeScript('return 1;', 20000)).rejects.toThrow(
        /MCP Bridge is not running/,
      );

      expect(Date.now() - started).toBeLessThan(5000);
    });

    it('tells the caller to click Start Bridge when the panel is open but idle', async () => {
      mockFs.readFile.mockImplementation(async (file) => {
        if (String(file) === heartbeatPath) {
          return JSON.stringify({ t: Date.now(), started: false, sessionId: 'test-uuid-1234', panelSessionId: 'panel-test' });
        }
        throw new Error('ENOENT');
      });
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 20000)).rejects.toThrow(
        /click Start Bridge/i,
      );
    });

    it('keeps waiting when the panel is alive and working on the command', async () => {
      mockFs.readFile.mockImplementation(async (file) => {
        if (String(file) === heartbeatPath) {
          return JSON.stringify({ t: Date.now(), started: true, sessionId: 'test-uuid-1234', panelSessionId: 'panel-test' });
        }
        throw new Error('ENOENT');
      });
      const bridge = await readyBridge();
      const started = Date.now();

      await expect(bridge.executeScript('return 1;', 700)).rejects.toThrow(/timeout/i);
      expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    });

    it('says the scripting thread is stuck when the panel heartbeat is fresh but ExtendScript has not returned', async () => {
      mockFs.readFile.mockImplementation(async (file) => {
        if (String(file) === heartbeatPath) {
          return JSON.stringify({ t: Date.now(), started: true, sessionId: 'test-uuid-1234', panelSessionId: 'panel-test', scriptOkAt: Date.now() - 20000 });
        }
        throw new Error('ENOENT');
      });
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 700)).rejects.toThrow(/scripting thread is stuck/i);
    });

    it('keeps waiting for a command CEP accepted when its heartbeat goes stale during ExtendScript', async () => {
      let heartbeatReads = 0;
      mockFs.readFile.mockImplementation(async (file) => {
        if (String(file) === heartbeatPath) return JSON.stringify({ t: ++heartbeatReads === 1 ? Date.now() : 1, started: true, sessionId: 'test-uuid-1234', panelSessionId: 'panel-test' });
        if (String(file) === activePath) return JSON.stringify({ accepted: true, sessionId: 'test-uuid-1234', panelSessionId: 'panel-test' });
        throw new Error('ENOENT');
      });
      const bridge = await readyBridge();
      const started = Date.now();

      await expect(bridge.executeScript('return 1;', 1800)).rejects.toThrow(/Bridge response timeout/i);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1800);
    });

    it('cancels a pending request when the CEP panel session changes', async () => {
      const heartbeatPath = path.join(dir, 'bridge-heartbeat.json');
      let heartbeatReads = 0;
      mockFs.readFile.mockImplementation(async (file) => {
        if (String(file) === heartbeatPath) {
          const panelSessionId = ++heartbeatReads === 1 ? 'panel-before-restart' : 'panel-after-restart';
          return JSON.stringify({ t: Date.now(), started: true, sessionId: 'test-uuid-1234', panelSessionId });
        }
        throw new Error('ENOENT');
      });
      const bridge = await readyBridge();

      await expect(bridge.executeScript('return 1;', 5000)).rejects.toThrow(/panel restarted/i);
    });
  });
});
