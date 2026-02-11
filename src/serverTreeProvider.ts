import * as vscode from 'vscode';
import { ServerEntry, ServerStatus } from './types.js';
import { ServerStore } from './serverStore.js';

export interface ServerAttributeItem {
  type: 'attribute';
  server: ServerEntry;
  key: keyof Pick<ServerEntry, 'name' | 'url' | 'startCommand' | 'group'>;
  label: string;
  value: string;
}

export interface GroupNode {
  type: 'group';
  label: string;
}

export type ServerTreeNode = ServerEntry | ServerAttributeItem | GroupNode;

export function isAttribute(node: ServerTreeNode): node is ServerAttributeItem {
  return 'type' in node && node.type === 'attribute';
}

export function isGroup(node: ServerTreeNode): node is GroupNode {
  return 'type' in node && node.type === 'group';
}

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerTreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private store: ServerStore) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: ServerTreeNode): vscode.TreeItem {
    if (isGroup(node)) {
      const count = this.store.getAll().filter(s =>
        node.label === 'General' ? !s.group : s.group === node.label,
      ).length;
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('symbol-folder');
      item.contextValue = 'server-group';
      item.description = `${count} server(s)`;
      return item;
    }

    if (isAttribute(node)) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.value;
      item.iconPath = new vscode.ThemeIcon(
        node.key === 'name' ? 'tag' :
        node.key === 'url' ? 'link' :
        node.key === 'group' ? 'symbol-folder' : 'terminal',
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
      const allServers = this.store.getAll();
      const hasAnyGroup = allServers.some(s => s.group);

      if (!hasAnyGroup) {
        return allServers;
      }

      const groups = new Set<string>();
      for (const server of allServers) {
        groups.add(server.group ?? 'General');
      }

      return [...groups].sort((a, b) => {
        if (a === 'General') { return 1; }
        if (b === 'General') { return -1; }
        return a.localeCompare(b);
      }).map(label => ({ type: 'group' as const, label }));
    }

    if (isGroup(element)) {
      return this.store.getAll().filter(s =>
        element.label === 'General' ? !s.group : s.group === element.label,
      );
    }

    if (!isAttribute(element)) {
      const server = element;
      return [
        { type: 'attribute', server, key: 'name', label: 'Name', value: server.name },
        { type: 'attribute', server, key: 'url', label: 'URL', value: server.url },
        { type: 'attribute', server, key: 'startCommand', label: 'Start Command', value: server.startCommand },
        { type: 'attribute', server, key: 'group', label: 'Group', value: server.group ?? '(none)' },
      ];
    }

    return [];
  }
}
