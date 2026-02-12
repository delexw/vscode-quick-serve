import * as vscode from 'vscode';
import { ServerStore } from './serverStore.js';
import { ServerTreeProvider } from './serverTreeProvider.js';
import type { ServerAttributeItem } from './serverTreeProvider.js';
import { HealthChecker } from './healthChecker.js';
import { ServerEntry } from './types.js';

export class ServerCommands {
  constructor(
    private readonly store: ServerStore,
    private readonly treeProvider: ServerTreeProvider,
    private readonly healthChecker: HealthChecker,
  ) {}

  async add(): Promise<void> {
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

    await this.store.add(name, url, startCommand);
    this.treeProvider.refresh();
    this.healthChecker.checkAll();
  }

  async edit(entry: ServerEntry): Promise<void> {
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

    await this.store.update(entry.id, { name, url, startCommand });
    this.treeProvider.refresh();
  }

  async editAttribute(attr: ServerAttributeItem): Promise<void> {
    const newValue = await vscode.window.showInputBox({
      prompt: `Edit ${attr.label}`,
      value: attr.value === '(none)' ? '' : attr.value,
      ignoreFocusOut: true,
    });
    if (newValue === undefined || newValue === attr.value) { return; }

    const patchValue = attr.key === 'group' && newValue === '' ? undefined : newValue;
    await this.store.update(attr.server.id, { [attr.key]: patchValue });
    this.treeProvider.refresh();
  }

  async remove(entry: ServerEntry): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      `Remove server "${entry.name}"?`,
      { modal: true },
      'Remove',
    );
    if (confirm !== 'Remove') { return; }

    await this.store.remove(entry.id);
    this.treeProvider.refresh();
  }

  async bulkRemove(): Promise<void> {
    const servers = this.store.getAll();
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
    await this.store.removeMany(idsToRemove);
    this.treeProvider.refresh();
  }

  async clearGroups(): Promise<void> {
    const servers = this.store.getAll();
    const grouped = servers.filter(s => s.group);
    if (grouped.length === 0) {
      vscode.window.showInformationMessage('Quick Serve: No servers have group assignments.');
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Clear group assignments from ${grouped.length} server(s)?`,
      { modal: true },
      'Clear',
    );
    if (confirm !== 'Clear') { return; }
    await this.store.clearAllGroups();
    this.treeProvider.refresh();
  }
}
