import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { ServerStore } from './serverStore.js';
import { ServerTreeProvider } from './serverTreeProvider.js';
import { HealthChecker } from './healthChecker.js';
import { ServerEntry } from './types.js';
import { config } from './config.js';
import { suggestServers } from './aiSuggest.js';

const terminals = new Map<string, vscode.Terminal>();
const SECRET_KEY = 'quickServe.ai.apiKey';

async function getOrPromptApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  let apiKey = await secrets.get(SECRET_KEY);
  if (apiKey) { return apiKey; }

  apiKey = await vscode.window.showInputBox({
    prompt: 'Enter your AI provider API key',
    placeHolder: 'sk-...',
    password: true,
    ignoreFocusOut: true,
  });
  if (!apiKey) { return undefined; }

  await secrets.store(SECRET_KEY, apiKey);
  return apiKey;
}

export function activate(context: vscode.ExtensionContext) {
  const store = new ServerStore();
  const treeProvider = new ServerTreeProvider(store);
  const healthChecker = new HealthChecker(store, treeProvider);
  const secrets = context.secrets;

  const treeView = vscode.window.createTreeView('quickServeServers', {
    treeDataProvider: treeProvider,
  });

  // Defer server loading so the panel renders first
  queueMicrotask(() => {
    store.reload();
    treeProvider.refresh();
  });

  context.subscriptions.push(
    treeView,
    healthChecker,

    // Auto-reload when user edits settings.json directly
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('quickServe.servers')) {
        store.reload();
        treeProvider.refresh();
      }
    }),

    vscode.window.onDidCloseTerminal(t => {
      for (const [id, term] of terminals) {
        if (term === t) {
          terminals.delete(id);
          break;
        }
      }
    }),

    vscode.commands.registerCommand('quickServe.addServer', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Server name',
        placeHolder: 'e.g. Frontend Dev',
        ignoreFocusOut: true,
      });
      if (!name) { return; }

      const url = await vscode.window.showInputBox({
        prompt: 'Server URL',
        placeHolder: 'e.g. https://localhost:3000/app',
        ignoreFocusOut: true,
      });
      if (!url) { return; }

      const startCommand = await vscode.window.showInputBox({
        prompt: 'Start command (shell command to start the server)',
        placeHolder: 'e.g. cd /path && npm start',
        ignoreFocusOut: true,
      });
      if (!startCommand) { return; }

      await store.add(name, url, startCommand);
      treeProvider.refresh();
      healthChecker.checkAll();
    }),

    vscode.commands.registerCommand('quickServe.editServer', async (entry: ServerEntry) => {
      const name = await vscode.window.showInputBox({
        prompt: 'Server name',
        value: entry.name,
        ignoreFocusOut: true,
      });
      if (!name) { return; }

      const url = await vscode.window.showInputBox({
        prompt: 'Server URL',
        value: entry.url,
        ignoreFocusOut: true,
      });
      if (!url) { return; }

      const startCommand = await vscode.window.showInputBox({
        prompt: 'Start command',
        value: entry.startCommand,
        ignoreFocusOut: true,
      });
      if (!startCommand) { return; }

      await store.update(entry.id, { name, url, startCommand });
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('quickServe.removeServer', async (entry: ServerEntry) => {
      const confirm = await vscode.window.showWarningMessage(
        `Remove server "${entry.name}"?`,
        { modal: true },
        'Remove',
      );
      if (confirm !== 'Remove') { return; }

      await store.remove(entry.id);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('quickServe.bulkRemoveServers', async () => {
      const servers = store.getAll();
      if (servers.length === 0) {
        vscode.window.showInformationMessage('Quick Serve: No servers to remove.');
        return;
      }

      const serverMap = new Map(servers.map(s => [`${s.name}\0${s.url}`, s.id]));
      const items = servers.map(s => ({
        label: s.name,
        description: s.url,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        placeHolder: 'Select servers to remove',
        title: 'Quick Serve: Remove Servers',
        ignoreFocusOut: true,
      });

      if (!selected || selected.length === 0) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Remove ${selected.length} server(s)?`,
        { modal: true },
        'Remove',
      );
      if (confirm !== 'Remove') { return; }

      const idsToRemove = new Set<string>();
      for (const item of selected) {
        const id = serverMap.get(`${item.label}\0${item.description}`);
        if (id) { idsToRemove.add(id); }
      }
      await store.removeMany(idsToRemove);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('quickServe.startServer', (entry: ServerEntry) => {
      const mode = config.terminalMode;

      if (mode === 'external') {
        startInExternalTerminal(entry);
      } else {
        let terminal = terminals.get(entry.id);
        if (!terminal || !vscode.window.terminals.includes(terminal)) {
          terminal = vscode.window.createTerminal(`Quick Serve: ${entry.name}`);
          terminals.set(entry.id, terminal);
        }
        terminal.sendText(entry.startCommand);
        terminal.show();
      }
    }),

    vscode.commands.registerCommand('quickServe.restartServer', (entry: ServerEntry) => {
      const mode = config.terminalMode;

      if (mode === 'external') {
        startInExternalTerminal(entry);
      } else {
        // Kill existing terminal if tracked
        const existing = terminals.get(entry.id);
        if (existing && vscode.window.terminals.includes(existing)) {
          existing.dispose();
        }
        const terminal = vscode.window.createTerminal(`Quick Serve: ${entry.name}`);
        terminals.set(entry.id, terminal);
        terminal.sendText(entry.startCommand);
        terminal.show();
      }
    }),

    vscode.commands.registerCommand('quickServe.openInBrowser', (entry: ServerEntry) => {
      vscode.env.openExternal(vscode.Uri.parse(entry.url));
    }),

    vscode.commands.registerCommand('quickServe.refreshServers', () => {
      healthChecker.checkAll();
    }),

    vscode.commands.registerCommand('quickServe.setApiKey', async () => {
      const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your AI provider API key (leave empty to clear)',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
      });
      if (apiKey === undefined) { return; } // cancelled
      if (apiKey === '') {
        await secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage('Quick Serve: API key cleared.');
      } else {
        await secrets.store(SECRET_KEY, apiKey);
        vscode.window.showInformationMessage('Quick Serve: API key updated.');
      }
    }),

    vscode.commands.registerCommand('quickServe.enableAISuggestions', async () => {
      const cfg = vscode.workspace.getConfiguration('quickServe');
      if (!cfg.get<boolean>('ai.enabled', false)) {
        await cfg.update('ai.enabled', true, vscode.ConfigurationTarget.Global);
      }
      const apiKey = await getOrPromptApiKey(secrets);
      if (!apiKey) { return; }
      const added = await suggestServers(store, apiKey);
      if (added > 0) {
        treeProvider.refresh();
        healthChecker.checkAll();
      }
    }),

    vscode.commands.registerCommand('quickServe.suggestServers', async () => {
      if (!config.aiEnabled) {
        const action = await vscode.window.showErrorMessage(
          'Quick Serve: AI suggestions are disabled. Enable via "Quick Serve: Enable AI Suggestions" command.',
          'Enable Now',
        );
        if (action === 'Enable Now') {
          vscode.commands.executeCommand('quickServe.enableAISuggestions');
        }
        return;
      }
      const apiKey = await getOrPromptApiKey(secrets);
      if (!apiKey) { return; }
      const added = await suggestServers(store, apiKey);
      if (added > 0) {
        treeProvider.refresh();
        healthChecker.checkAll();
      }
    }),
  );

  healthChecker.start();
}

function startInExternalTerminal(entry: ServerEntry): void {
  const { startCommand, name } = entry;
  const platform = process.platform;

  if (platform === 'darwin') {
    child_process.spawn('osascript', [
      '-e', `tell application "Terminal" to do script "${startCommand.replace(/"/g, '\\"')}"`,
      '-e', `tell application "Terminal" to activate`,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else if (platform === 'win32') {
    child_process.spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', startCommand], {
      detached: true, stdio: 'ignore',
    }).unref();
  } else {
    // Linux: try common terminal emulators
    const terminals = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
    let launched = false;
    for (const term of terminals) {
      try {
        const args = term === 'gnome-terminal' ? ['--', 'bash', '-c', startCommand]
          : ['-e', `bash -c "${startCommand.replace(/"/g, '\\"')}; exec bash"`];
        child_process.spawn(term, args, { detached: true, stdio: 'ignore' }).unref();
        launched = true;
        break;
      } catch { /* try next */ }
    }
    if (!launched) {
      vscode.window.showErrorMessage(`Quick Serve: Could not find an external terminal for "${name}"`);
    }
  }
}

export function deactivate() {}
