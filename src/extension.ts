import * as vscode from 'vscode';
import { ServerStore } from './serverStore.js';
import { ServerTreeProvider } from './serverTreeProvider.js';
import { HealthChecker } from './healthChecker.js';
import { ServerEntry } from './types.js';
import { config } from './config.js';
import { suggestServers } from './aiSuggest.js';
import { groupServersWithAI } from './aiGroup.js';
import { ProcessKiller } from './processKiller.js';
import { TerminalLauncher } from './terminalLauncher.js';
import { ServerCommands } from './serverCommands.js';

const killer = new ProcessKiller();
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
  const terminalLauncher = new TerminalLauncher();
  const serverCmds = new ServerCommands(store, treeProvider, healthChecker);
  const secrets = context.secrets;

  const treeView = vscode.window.createTreeView('quickServeServers', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
  });

  // Defer server loading so the panel renders first
  queueMicrotask(() => {
    store.reload();
    treeProvider.refresh();
  });

  context.subscriptions.push(
    treeView,
    healthChecker,
    terminalLauncher,

    // Auto-reload when user edits settings.json directly
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('quickServe.servers')) {
        store.reload();
        treeProvider.refresh();
      }
      if (e.affectsConfiguration('quickServe.healthCheck')) {
        healthChecker.restart();
      }
    }),

    // --- Server CRUD ---
    vscode.commands.registerCommand('quickServe.addServer', () => serverCmds.add()),
    vscode.commands.registerCommand('quickServe.editServer', (e: ServerEntry) => serverCmds.edit(e)),
    vscode.commands.registerCommand('quickServe.editServerAttribute', (a) => serverCmds.editAttribute(a)),
    vscode.commands.registerCommand('quickServe.removeServer', (e: ServerEntry) => serverCmds.remove(e)),
    vscode.commands.registerCommand('quickServe.bulkRemoveServers', () => serverCmds.bulkRemove()),
    vscode.commands.registerCommand('quickServe.clearGroups', () => serverCmds.clearGroups()),

    // --- Server lifecycle ---
    vscode.commands.registerCommand('quickServe.startServer', (entry: ServerEntry) => {
      terminalLauncher.start(entry);
    }),

    vscode.commands.registerCommand('quickServe.restartServer', async (entry: ServerEntry) => {
      await killer.kill(entry);
      terminalLauncher.restart(entry);
    }),

    vscode.commands.registerCommand('quickServe.killServerPort', async (entry: ServerEntry) => {
      const killed = await killer.kill(entry);
      if (killed) {
        vscode.window.showInformationMessage(`Quick Serve: Server process for "${entry.name}" killed.`);
      } else {
        vscode.window.showInformationMessage(`Quick Serve: No matching process found for "${entry.name}".`);
      }
      healthChecker.checkAll();
    }),

    vscode.commands.registerCommand('quickServe.openInBrowser', (entry: ServerEntry) => {
      vscode.env.openExternal(vscode.Uri.parse(entry.url));
    }),

    vscode.commands.registerCommand('quickServe.refreshServers', () => {
      healthChecker.checkAll();
    }),

    // --- AI ---
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

    vscode.commands.registerCommand('quickServe.groupServersWithAI', async () => {
      if (!config.aiEnabled) {
        const action = await vscode.window.showErrorMessage(
          'Quick Serve: AI features are disabled. Enable via "Quick Serve: Enable AI Suggestions" command.',
          'Enable Now',
        );
        if (action === 'Enable Now') {
          const cfg = vscode.workspace.getConfiguration('quickServe');
          await cfg.update('ai.enabled', true, vscode.ConfigurationTarget.Global);
        }
        return;
      }
      const apiKey = await getOrPromptApiKey(secrets);
      if (!apiKey) { return; }
      const grouped = await groupServersWithAI(store, apiKey);
      if (grouped > 0) {
        treeProvider.refresh();
      }
    }),
  );

  healthChecker.start();
}

export function deactivate() {}
