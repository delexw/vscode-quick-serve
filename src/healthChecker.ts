import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import { ServerStatus } from './types.js';
import { ServerStore } from './serverStore.js';
import { ServerTreeProvider } from './serverTreeProvider.js';
import { config } from './config.js';

export class HealthChecker implements vscode.Disposable {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private previousStatuses = new Map<string, ServerStatus>();

  constructor(
    private store: ServerStore,
    private treeProvider: ServerTreeProvider,
  ) {}

  start(): void {
    this.checkAll();
    this.intervalId = setInterval(() => this.checkAll(), config.healthCheckPollInterval);
  }

  restart(): void {
    this.dispose();
    this.start();
  }

  dispose(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async checkAll(): Promise<void> {
    const servers = this.store.getAll();
    await Promise.all(servers.map(s => this.checkOne(s.id, s.url)));
    this.treeProvider.refresh();
  }

  private async checkOne(id: string, url: string): Promise<void> {
    const prevStatus = this.previousStatuses.get(id);
    const newStatus = await this.ping(url);

    this.store.updateStatus(id, newStatus);

    if (prevStatus === ServerStatus.Up && newStatus === ServerStatus.Down) {
      const entry = this.store.getById(id);
      const name = entry?.name ?? 'Unknown';
      vscode.window.showWarningMessage(`Quick Serve: "${name}" is down!`);
    }

    this.previousStatuses.set(id, newStatus);
  }

  private ping(url: string): Promise<ServerStatus> {
    return new Promise(resolve => {
      const isHttps = url.startsWith('https');
      const mod = isHttps ? https : http;
      const options: https.RequestOptions = {
        timeout: config.healthCheckRequestTimeout,
      };

      if (isHttps) {
        options.rejectUnauthorized = false;
      }

      const req = mod.get(url, options, res => {
        resolve(res.statusCode && res.statusCode < 500 ? ServerStatus.Up : ServerStatus.Down);
        res.resume();
      });

      req.on('error', () => resolve(ServerStatus.Down));
      req.on('timeout', () => {
        req.destroy();
        resolve(ServerStatus.Down);
      });
    });
  }
}
