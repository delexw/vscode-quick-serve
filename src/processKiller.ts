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
   * Strategy 1 (Unix): `pgrep -f` by command pattern, optionally filtered by cwd.
   * Strategy 2 (fallback): `lsof` / `netstat` by port — skipped for ports 80/443
   *   which are typically reverse proxies (Caddy, nginx) rather than the server itself.
   */
  async kill(entry: { startCommand: string; url: string }): Promise<boolean> {
    const { cwd, cmd } = await this.parseStartCommand(entry.startCommand);
    this.log(`Server: cmd="${cmd}"${cwd ? `, cwd="${cwd}"` : ''}`);

    // Strategy 1: find by command pattern (Unix only)
    if (process.platform !== 'win32') {
      const killed = await this.killByCommand(cmd, cwd);
      if (killed) { return true; }
    }

    // Strategy 2: port-based fallback
    const port = this.parsePort(entry.url);
    if (port && port !== 80 && port !== 443) {
      this.log(`Falling back to port-based kill on :${port}`);
      return await this.killByPort(port);
    }

    if (port === 80 || port === 443) {
      this.log(`Skipping port ${port} (likely a reverse proxy)`);
    }

    this.log('No matching process found');
    return false;
  }

  // ---------------------------------------------------------------------------
  // Strategies
  // ---------------------------------------------------------------------------

  private async killByCommand(cmd: string, cwd: string | undefined): Promise<boolean> {
    // Try full command first (exact match)
    const fullPids = await this.pgrepWithCwd(cmd, cwd);
    if (fullPids.length > 0) {
      return await this.killSafePids(fullPids);
    }

    // For compound commands (&&, ;), collect PIDs from ALL segments so we
    // kill every related process — e.g. both Puma and webpack from one alias.
    const segments = this.splitCommandSegments(cmd);
    if (segments.length > 0) {
      const allPids: string[] = [];
      for (const pattern of segments) {
        const pids = await this.pgrepWithCwd(pattern, cwd);
        allPids.push(...pids);
      }
      if (allPids.length > 0) {
        return await this.killSafePids([...new Set(allPids)]);
      }
    }

    this.log('No process found matching command pattern');
    return false;
  }

  /** Try pgrep -f for a pattern, optionally filtering by cwd. */
  private async pgrepWithCwd(pattern: string, cwd: string | undefined): Promise<string[]> {
    try {
      const { stdout } = await execAsync(`pgrep -f ${this.shellEscape(pattern)}`);
      let pids = stdout.trim().split('\n').filter(Boolean);
      this.log(`pgrep "${pattern}" matched PIDs: ${pids.join(', ')}`);
      if (pids.length === 0) { return []; }

      if (cwd) {
        const filtered: string[] = [];
        for (const pid of pids) {
          const procCwd = await this.getProcessCwd(pid);
          if (procCwd?.startsWith(cwd)) { filtered.push(pid); }
        }
        if (filtered.length > 0) {
          pids = filtered;
          this.log(`After cwd filter (${cwd}): ${pids.join(', ')}`);
        } else {
          this.log(`No PIDs matched cwd "${cwd}", skipping to avoid killing unrelated processes`);
          return [];
        }
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

  private async getProcessCwd(pid: string): Promise<string | undefined> {
    try {
      if (process.platform === 'linux') {
        const { stdout } = await execAsync(`readlink /proc/${pid}/cwd`);
        return stdout.trim() || undefined;
      }
      if (process.platform === 'darwin') {
        const { stdout } = await execAsync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null`);
        for (const line of stdout.split('\n')) {
          if (line.startsWith('n/')) { return line.slice(1); }
        }
      }
    } catch { /* ignore */ }
    return undefined;
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

  private async parseStartCommand(startCommand: string): Promise<{ cwd?: string; cmd: string }> {
    const parsed = this.parseCdPrefix(startCommand);
    if (parsed.cwd) { return parsed; }

    // Bare single-word command — might be a shell alias/function.
    // Resolve it so pgrep can match the real process command line.
    if (process.platform !== 'win32' && /^\S+$/.test(startCommand)) {
      const resolved = await this.resolveCommand(startCommand);
      if (resolved) { return resolved; }
    }

    return { cmd: startCommand };
  }

  private parseCdPrefix(command: string): { cwd?: string; cmd: string } {
    const match = command.match(/^cd\s+("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*(.+)$/);
    if (match) {
      const cwd = match[1].replace(/^['"]|['"]$/g, '');
      return { cwd, cmd: match[2].trim() };
    }
    return { cmd: command };
  }

  /**
   * Resolve a bare command name through the user's shell.
   * Handles aliases (single-line) and functions (multi-line body).
   */
  private async resolveCommand(command: string): Promise<{ cwd?: string; cmd: string } | undefined> {
    const shell = process.env.SHELL || '/bin/bash';

    // 1. Check what kind of command it is
    let typeOutput: string;
    try {
      const { stdout } = await execAsync(
        `${shell} -ic 'type ${this.shellEscape(command)}' 2>/dev/null`,
        { timeout: 3000 },
      );
      typeOutput = stdout.trim();
    } catch { return undefined; }

    // 2a. Alias — single-line expansion
    // zsh:  "foo is an alias for cd /path && cmd"
    // bash: "foo is aliased to `cd /path && cmd'"
    const aliasMatch = typeOutput.match(/is (?:aliased to|an alias for)\s+[`']?(.+?)[`']?\s*$/);
    if (aliasMatch) {
      const expanded = aliasMatch[1];
      this.log(`Resolved alias "${command}" → "${expanded}"`);
      const parsed = this.parseCdPrefix(expanded);
      return parsed.cwd ? parsed : { cmd: expanded };
    }

    // 2b. Shell function — get the body via `which`, extract executable lines.
    //     killSafePids walks the full descendant tree, so finding the parent is enough.
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
          return { cmd };
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
