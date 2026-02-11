import { ServerEntry, ServerStatus } from './types.js';
import { config } from './config.js';
import * as crypto from 'crypto';

export class ServerStore {
  private servers: ServerEntry[] = [];

  constructor() {
    // Don't load here — let activate() defer it so the panel renders first
  }

  reload(): void {
    const persisted = config.servers;
    // Preserve runtime status for entries that already exist
    const oldStatuses = new Map(this.servers.map(s => [s.name + s.url, s.status]));
    this.servers = persisted.map(s => ({
      id: crypto.randomUUID(),
      ...s,
      status: oldStatuses.get(s.name + s.url) ?? ServerStatus.Unknown,
    }));
  }

  getAll(): ServerEntry[] {
    return this.servers;
  }

  getById(id: string): ServerEntry | undefined {
    return this.servers.find(s => s.id === id);
  }

  async add(name: string, url: string, startCommand: string): Promise<ServerEntry> {
    const entry: ServerEntry = {
      id: crypto.randomUUID(),
      name,
      url,
      startCommand,
      status: ServerStatus.Unknown,
    };
    this.servers.push(entry);
    await this.persist();
    return entry;
  }

  async update(id: string, patch: Partial<Pick<ServerEntry, 'name' | 'url' | 'startCommand' | 'group'>>): Promise<void> {
    const entry = this.getById(id);
    if (!entry) { return; }
    Object.assign(entry, patch);
    if (entry.group === undefined || entry.group === '') {
      delete entry.group;
    }
    await this.persist();
  }

  async updateGroups(assignments: Map<string, string>): Promise<void> {
    for (const [id, group] of assignments) {
      const entry = this.getById(id);
      if (entry) {
        entry.group = group;
      }
    }
    await this.persist();
  }

  async clearAllGroups(): Promise<void> {
    for (const server of this.servers) {
      delete server.group;
    }
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.servers = this.servers.filter(s => s.id !== id);
    await this.persist();
  }

  async removeMany(ids: Set<string>): Promise<void> {
    this.servers = this.servers.filter(s => !ids.has(s.id));
    await this.persist();
  }

  updateStatus(id: string, status: ServerStatus): void {
    const entry = this.getById(id);
    if (entry) {
      entry.status = status;
    }
  }

  private async persist(): Promise<void> {
    const toSave = this.servers.map(({ id, status, ...rest }) => rest);
    await config.setServers(toSave);
  }
}
