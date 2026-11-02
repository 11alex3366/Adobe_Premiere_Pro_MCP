import { loadPanel } from '../helpers/panel.js';

describe('CEP command polling', () => {
  it('does not reread a command file while a Premiere command is in flight', () => {
    const { bridge, fs } = loadPanel();
    bridge.isProcessing = true;

    bridge.watchDirectory('C:/temp/premiere-mcp-bridge');

    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it('atomically claims a shared command so another CEP panel instance cannot dispatch it twice', () => {
    const { bridge, fs } = loadPanel();
    const claimed = new Set<string>();
    fs.readFileSync.mockImplementation((file) => String(file).endsWith('/server-session.json')
      ? JSON.stringify({ sessionId: 'server-session', active: true })
      : JSON.stringify({ id: 'shared-id', sessionId: 'server-session', panelSessionId: bridge.panelSessionId, script: 'return 1;' }));
    bridge.serverSessionId = 'server-session';
    bridge.serverSessionActive = true;
    fs.openSync.mockImplementation((file: string) => {
      if (claimed.has(file)) throw Object.assign(new Error('already claimed'), { code: 'EEXIST' });
      claimed.add(file);
      return 1;
    });
    bridge.getTempDirectory = () => '/tmp/premiere-mcp-bridge';
    bridge.addToQueue = jest.fn();
    bridge.updateCommandStatus = jest.fn();
    bridge.executeCommand = jest.fn();

    bridge.processCommandFile('/tmp/premiere-mcp-bridge/command-shared-id.json');
    bridge.processCommandFile('/tmp/premiere-mcp-bridge/command-shared-id.json');

    expect(fs.openSync).toHaveBeenCalledTimes(2);
    expect(bridge.executeCommand).toHaveBeenCalledTimes(1);
  });
});
