import * as vscode from 'vscode';
import * as child_process from 'child_process';
import { ServerEntry } from './types.js';
import { config } from './config.js';

export class TerminalLauncher implements vscode.Disposable {
  private readonly terminals = new Map<string, vscode.Terminal>();
  private readonly onCloseDisposable: vscode.Disposable;

  constructor() {
    this.onCloseDisposable = vscode.window.onDidCloseTerminal(t => {
      for (const [id, term] of this.terminals) {
        if (term === t) {
          this.terminals.delete(id);
          break;
        }
      }
    });
  }

  /** Start a server in the configured terminal mode (integrated or external). */
  start(entry: ServerEntry): void {
    if (config.terminalMode === 'external') {
      this.startExternal(entry);
    } else {
      this.startIntegrated(entry);
    }
  }

  /** Dispose the tracked terminal for a server (if any), then start fresh. */
  restart(entry: ServerEntry): void {
    const existing = this.terminals.get(entry.id);
    if (existing && vscode.window.terminals.includes(existing)) {
      existing.dispose();
    }
    this.terminals.delete(entry.id);
    this.start(entry);
  }

  dispose(): void {
    this.onCloseDisposable.dispose();
  }

  // ---------------------------------------------------------------------------
  // Integrated terminal
  // ---------------------------------------------------------------------------

  private startIntegrated(entry: ServerEntry): void {
    let terminal = this.terminals.get(entry.id);
    if (!terminal || !vscode.window.terminals.includes(terminal)) {
      terminal = vscode.window.createTerminal(`Quick Serve: ${entry.name}`);
      this.terminals.set(entry.id, terminal);
    }
    terminal.sendText(entry.startCommand);
    terminal.show();
  }

  // ---------------------------------------------------------------------------
  // External terminal (platform-specific)
  // ---------------------------------------------------------------------------

  private startExternal(entry: ServerEntry): void {
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
      this.startExternalLinux(startCommand, name);
    }
  }

  private startExternalLinux(startCommand: string, name: string): void {
    const emulators = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'];
    for (const emu of emulators) {
      try {
        const args = emu === 'gnome-terminal'
          ? ['--', 'bash', '-c', startCommand]
          : ['-e', `bash -c "${startCommand.replace(/"/g, '\\"')}; exec bash"`];
        child_process.spawn(emu, args, { detached: true, stdio: 'ignore' }).unref();
        return;
      } catch { /* try next */ }
    }
    vscode.window.showErrorMessage(`Quick Serve: Could not find an external terminal for "${name}"`);
  }
}
