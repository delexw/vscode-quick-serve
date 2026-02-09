import * as vscode from 'vscode';

export type TerminalMode = 'integrated' | 'external';

interface PersistedServer {
  name: string;
  url: string;
  startCommand: string;
}

function get() {
  return vscode.workspace.getConfiguration('quickServe');
}

export const config = {
  get terminalMode(): TerminalMode {
    return get().get<TerminalMode>('terminalMode', 'integrated');
  },

  get servers(): PersistedServer[] {
    return get().get<PersistedServer[]>('servers', []);
  },

  async setServers(servers: PersistedServer[]): Promise<void> {
    await get().update('servers', servers, vscode.ConfigurationTarget.Global);
  },
};
