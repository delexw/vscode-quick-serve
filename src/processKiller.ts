import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as util from 'util';
import { getOutputChannel } from './outputChannel.js';

const execAsync = util.promisify(child_process.exec);

export class ProcessKiller {
  private readonly out: vscode.OutputChannel;

  constructor() {
    this.out = getOutputChannel();
  }

  /**
   * Kill the process for a server entry.
   *
   * Strategy 1: `lsof` / `netstat` by port — most precise. Skipped for ports 80/443
   *   which are typically reverse proxies (Caddy, nginx) rather than the server itself.
   * Strategy 2 (fallback, Unix): `pgrep -f` by resolved command pattern.
   */
  async kill(entry: { startCommand: string; url: string }): Promise<boolean> {
    const cmd = await this.resolveCmd(entry.startCommand);
    this.log(`Server: cmd="${cmd}"`);

    // Strategy 1: port-based kill — most precise, avoids ambiguity
    const port = this.parsePort(entry.url);
    if (port && port !== 80 && port !== 443) {
      this.log(`Killing by port :${port}`);
      const killed = await this.killByPort(port);
      if (killed) { return true; }
    }

    if (port === 80 || port === 443) {
      this.log(`Skipping port ${port} (likely a reverse proxy)`);
    }

    // Strategy 2: command pattern fallback (Unix only)
    if (process.platform !== 'win32') {
      const killed = await this.killByCommand(cmd);
      if (killed) { return true; }
    }

    this.log('No matching process found');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Strategies
  // ---------------------------------------------------------------------------

  private async killByCommand(cmd: string): Promise<boolean> {
    const pids = await this.pgrep(cmd);
    if (pids.length > 0) { return await this.killSafePids(pids); }

    // For compound commands (&&, ;), collect PIDs from ALL segments so we
    // kill every related process — e.g. both Puma and webpack from one alias.
    const segments = this.splitCommandSegments(cmd);
    if (segments.length > 0) {
      const allPids: string[] = [];
      for (const segment of segments) {
        allPids.push(...await this.pgrep(segment));
      }
      if (allPids.length > 0) {
        return await this.killSafePids([...new Set(allPids)]);
      }
    }

    this.log('No process found matching command pattern');
    return false;
  }

  private async pgrep(pattern: string): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`pgrep -f ${this.shellEscape(pattern)}`);
      const pids = stdout.trim().split('\n').filter(Boolean);
      if (pids.length > 0) {
        this.log(`pgrep "${pattern}" matched PIDs: ${pids.join(', ')}`);
      }
      return pids;
    } catch {
      return [];
    }
  }

  /** Split a compound command (&&, ;) into individual segments, reversed. */
  private splitCommandSegments(cmd: string): string[] {
    const parts = cmd.split(/\s*(?:&&|;)\s*/).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) { return []; }
    // Reverse so we try the last (likely still running) command first
    return parts.reverse();
  }

  private async killByPort(port: number): Promise<boolean> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execAsync(`netstat -ano | findstr :${port} | findstr LISTENING`);
        const pids = [...new Set(stdout.trim().split('\n').map(l => l.trim().split(/\s+/).pop()).filter(Boolean))];
        this.log(`Found PIDs on port ${port}: ${pids.join(', ')}`);
        for (const pid of pids) {
          await execAsync(`taskkill /PID ${pid} /F`).catch(() => {});
        }
        this.log(`Killed ${pids.length} process(es)`);
        return pids.length > 0;
      } else {
        const { stdout } = await execAsync(`lsof -ti :${port} -sTCP:LISTEN`);
        const pids = stdout.trim().split('\n').filter(Boolean);
        this.log(`lsof found PIDs on port ${port}: ${pids.join(', ')}`);
        return await this.killSafePids(pids);
      }
    } catch (err) {
      this.log(`No process on port ${port} (${err instanceof Error ? err.message : String(err)})`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Kill PIDs and all their descendants, after excluding our own process tree. */
  private async killSafePids(pids: string[]): Promise<boolean> {
    const ownPids = await this.getOwnPids();
    this.log(`Own process tree (excluded): ${[...ownPids].join(', ')}`);

    // Collect the full descendant tree for each matched PID
    const allPids = new Set<string>();
    for (const pid of pids) {
      if (!ownPids.has(Number(pid))) {
        allPids.add(pid);
        for (const child of await this.getDescendants(pid)) {
          if (!ownPids.has(Number(child))) { allPids.add(child); }
        }
      }
    }

    if (allPids.size > 0) {
      const targets = [...allPids];
      this.log(`Killing PIDs (with descendants): ${targets.join(', ')}`);
      await execAsync(`kill ${targets.join(' ')}`);
      this.log('Process(es) killed successfully');
      return true;
    }

    this.log('All matched PIDs are in own process tree');
    return false;
  }

  /** Recursively collect all descendant PIDs of a given PID. */
  private async getDescendants(pid: string): Promise<string[]> {
    const all: string[] = [];
    try {
      const { stdout } = await execAsync(`pgrep -P ${pid}`);
      const children = stdout.trim().split('\n').filter(Boolean);
      for (const child of children) {
        all.push(child);
        all.push(...await this.getDescendants(child));
      }
    } catch { /* no children */ }
    return all;
  }

  private async getOwnPids(): Promise<Set<number>> {
    const own = new Set<number>();
    own.add(process.pid);
    if (process.ppid) { own.add(process.ppid); }
    try {
      let current = process.pid;
      for (let i = 0; i < 20; i++) {
        const { stdout } = await execAsync(`ps -o ppid= -p ${current}`);
        const ppid = Number(stdout.trim());
        if (!ppid || ppid <= 1) { break; }
        own.add(ppid);
        current = ppid;
      }
    } catch { /* ignore */ }
    return own;
  }


  private parsePort(url: string): number | undefined {
    try {
      const parsed = new URL(url);
      if (parsed.port) { return Number(parsed.port); }
      if (parsed.protocol === 'https:') { return 443; }
      if (parsed.protocol === 'http:') { return 80; }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Extract the actual executable command from a startCommand string. */
  private async resolveCmd(startCommand: string): Promise<string> {
    // Strip "cd /path && " prefix
    const cdMatch = startCommand.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*(.+)$/);
    if (cdMatch) { return cdMatch[2].trim(); }

    // Bare single-word command — might be a shell alias/function
    if (process.platform !== 'win32' && /^\S+$/.test(startCommand)) {
      const resolved = await this.resolveShellCommand(startCommand);
      if (resolved) { return resolved; }
    }

    return startCommand;
  }

  /**
   * Resolve a bare command name through the user's shell.
   * Handles aliases (single-line) and functions (multi-line body).
   */
  private async resolveShellCommand(command: string): Promise<string | undefined> {
    const shell = process.env.SHELL || '/bin/bash';

    let typeOutput: string;
    try {
      const { stdout } = await execAsync(
        `${shell} -ic 'type ${this.shellEscape(command)}' 2>/dev/null`,
        { timeout: 3000 },
      );
      typeOutput = stdout.trim();
    } catch { return undefined; }

    // Alias — single-line expansion
    // zsh:  "foo is an alias for cd /path && cmd"
    // bash: "foo is aliased to `cd /path && cmd'"
    const aliasMatch = typeOutput.match(/is (?:aliased to|an alias for)\s+[`']?(.+?)[`']?\s*$/);
    if (aliasMatch) {
      const expanded = aliasMatch[1];
      this.log(`Resolved alias "${command}" → "${expanded}"`);
      // Strip cd prefix from alias expansion too
      const cdMatch = expanded.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*(.+)$/);
      return cdMatch ? cdMatch[2].trim() : expanded;
    }

    // Shell function — extract executable lines from body
    if (/shell function/.test(typeOutput)) {
      try {
        const { stdout } = await execAsync(
          `${shell} -ic 'which ${this.shellEscape(command)}' 2>/dev/null`,
          { timeout: 3000 },
        );
        const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);
        this.log(`Resolved function "${command}" (${lines.length} lines)`);

        const skip = /^(?:cd |export |source |exit|return|\.|#|{|}|[\w_]+\s*\(\)|ensure_|git |chmod |mkdir )/;
        const setup = /uptodate|setup|install|bootstrap|migrate/i;
        const cmds = lines
          .filter(l => !skip.test(l) && !setup.test(l))
          .map(l => l.replace(/^(?:[\w]+=\S+\s+)+/, ''));  // strip VAR=val prefixes

        if (cmds.length > 0) {
          const cmd = cmds.join(' && ');
          this.log(`  cmd="${cmd}"`);
          return cmd;
        }
      } catch { /* function body unavailable */ }
    }

    return undefined;
  }

  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }

  private log(message: string): void {
    this.out.appendLine(`[Kill] ${message}`);
  }
}
