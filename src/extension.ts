import * as vscode from 'vscode';
import { ServerStore } from './serverStore.js';
import { ServerTreeProvider } from './serverTreeProvider.js';
import { HealthChecker } from './healthChecker.js';
import { ServerEntry } from './types.js';

const terminals = new Map<string, vscode.Terminal>();

export function activate(context: vscode.ExtensionContext) {
  const store = new ServerStore();
  const treeProvider = new ServerTreeProvider(store);
  const healthChecker = new HealthChecker(store, treeProvider);

  const treeView = vscode.window.createTreeView('quickServeServers', {
    treeDataProvider: treeProvider,
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
      });
      if (!name) { return; }

      const url = await vscode.window.showInputBox({
        prompt: 'Server URL',
        placeHolder: 'e.g. https://localhost:3000/app',
      });
      if (!url) { return; }

      const startCommand = await vscode.window.showInputBox({
        prompt: 'Start command (shell command to start the server)',
        placeHolder: 'e.g. cd /path && npm start',
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
      });
      if (!name) { return; }

      const url = await vscode.window.showInputBox({
        prompt: 'Server URL',
        value: entry.url,
      });
      if (!url) { return; }

      const startCommand = await vscode.window.showInputBox({
        prompt: 'Start command',
        value: entry.startCommand,
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

    vscode.commands.registerCommand('quickServe.startServer', (entry: ServerEntry) => {
      let terminal = terminals.get(entry.id);
      if (!terminal || !vscode.window.terminals.includes(terminal)) {
        terminal = vscode.window.createTerminal(`Quick Serve: ${entry.name}`);
        terminals.set(entry.id, terminal);
      }
      terminal.sendText(entry.startCommand);
      terminal.show();
    }),

    vscode.commands.registerCommand('quickServe.openInBrowser', (entry: ServerEntry) => {
      vscode.env.openExternal(vscode.Uri.parse(entry.url));
    }),

    vscode.commands.registerCommand('quickServe.refreshServers', () => {
      healthChecker.checkAll();
    }),
  );

  healthChecker.start();
}

export function deactivate() {}
