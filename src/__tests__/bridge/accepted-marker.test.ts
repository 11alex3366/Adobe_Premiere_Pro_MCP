import path from 'node:path';

const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
const panelPath = path.join(__dirname, '..', '..', '..', 'cep-plugin', 'bridge-cep.js');

describe('CEP command acceptance marker', () => {
  it('keeps the session-aware marker written at command acceptance intact', () => {
    const source = realFs.readFileSync(panelPath, 'utf8');
    const logStart = source.indexOf('MCPPremiereBridge.prototype.log = function(message, level)');
    const logEnd = source.indexOf('MCPPremiereBridge.prototype.clearLog = function()', logStart);
    const logImplementation = source.slice(logStart, logEnd);

    expect(source).toContain('fs.writeFileSync(activePath, JSON.stringify({ id: command.id, sessionId: command.sessionId, panelSessionId: this.panelSessionId, accepted: true');
    expect(logImplementation).not.toContain('active-');
    expect(logImplementation).not.toContain('activeMatch');
  });
});
