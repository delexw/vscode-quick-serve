import * as vscode from 'vscode';
import { ServerEntry, ServerStatus } from './types.js';
import { ServerStore } from './serverStore.js';

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerEntry> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerEntry | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: ServerStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(entry: ServerEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.None);

    item.iconPath = new vscode.ThemeIcon(
      entry.status === ServerStatus.Up ? 'circle-filled' :
      entry.status === ServerStatus.Down ? 'error' : 'question',
      entry.status === ServerStatus.Up
        ? new vscode.ThemeColor('charts.green')
        : entry.status === ServerStatus.Down
          ? new vscode.ThemeColor('charts.red')
          : undefined,
    );

    item.description = entry.url;
    item.tooltip = `${entry.name}\n${entry.url}\nStatus: ${entry.status}\nCmd: ${entry.startCommand}`;
    item.contextValue = entry.status === ServerStatus.Up ? 'server-up' : 'server-down';

    if (entry.status === ServerStatus.Up) {
      item.command = {
        command: 'quickServe.openInBrowser',
        title: 'Open in Browser',
        arguments: [entry],
      };
    }

    return item;
  }

  getChildren(): ServerEntry[] {
    return this.store.getAll();
  }
}
