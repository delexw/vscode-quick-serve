import * as vscode from 'vscode';

export type TerminalMode = 'integrated' | 'external';
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'openai-compatible';

interface PersistedServer {
  name: string;
  url: string;
  startCommand: string;
  group?: string;
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

  get aiEnabled(): boolean {
    return get().get<boolean>('ai.enabled', false);
  },

  get aiProvider(): AIProvider {
    return get().get<AIProvider>('ai.provider', 'openai');
  },

  get aiModel(): string {
    return get().get<string>('ai.model', 'gpt-5.2');
  },

  get aiMaxSteps(): number | undefined {
    const val = get().get<number | null>('ai.maxSteps', null);
    return val ?? undefined;
  },

  get aiBaseUrl(): string {
    return get().get<string>('ai.baseUrl', '');
  },

  async setServers(servers: PersistedServer[]): Promise<void> {
    await get().update('servers', servers, vscode.ConfigurationTarget.Global);
  },
};
