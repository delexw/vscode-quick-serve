import * as vscode from 'vscode';
import { ServerEntry, ServerStatus } from './types.js';
import { ServerStore } from './serverStore.js';

export interface ServerAttributeItem {
  type: 'attribute';
  server: ServerEntry;
  key: keyof Pick<ServerEntry, 'name' | 'url' | 'startCommand'>;
  label: string;
  value: string;
}

export type ServerTreeNode = ServerEntry | ServerAttributeItem;

export function isAttribute(node: ServerTreeNode): node is ServerAttributeItem {
  return 'type' in node && node.type === 'attribute';
}

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: ServerStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: ServerTreeNode): vscode.TreeItem {
    if (isAttribute(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.value;
      item.iconPath = new vscode.ThemeIcon(
        node.key === 'name' ? 'tag' :
        node.key === 'url' ? 'link' : 'terminal',
      );
      item.contextValue = 'server-attribute';
      return item;
    }

    const entry = node;
    const item = new vscode.TreeItem(entry.name, vscode.TreeItemCollapsibleState.Collapsed);

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

  getChildren(element?: ServerTreeNode): ServerTreeNode[] {
    if (!element) {
      return this.store.getAll();
    }

    if (!isAttribute(element)) {
      const server = element;
      return [
        { type: 'attribute', server, key: 'name', label: 'Name', value: server.name },
        { type: 'attribute', server, key: 'url', label: 'URL', value: server.url },
        { type: 'attribute', server, key: 'startCommand', label: 'Start Command', value: server.startCommand },
      ];
    }

    return [];
  }
}
