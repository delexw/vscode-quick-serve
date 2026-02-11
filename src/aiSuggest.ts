import * as vscode from 'vscode';
import * as os from 'os';
import * as child_process from 'child_process';
import * as util from 'util';
import { z } from 'zod';
import { streamText, generateObject, tool } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { config, type AIProvider } from './config.js';
import { ServerStore } from './serverStore.js';

const execAsync = util.promisify(child_process.exec);

const MAX_LINES_PER_FILE = 300;

class AILogger {
  private channel: vscode.OutputChannel;
  private stepNum = 0;

  constructor() {
    this.channel = vscode.window.createOutputChannel('Quick Serve');
  }

  start(folder: string, provider: string, model: string): void {
    this.stepNum = 0;
    this.channel.clear();
    this.channel.show(true);
    this.channel.appendLine(`[Quick Serve AI] Scanning: ${folder}`);
    this.channel.appendLine(`[Quick Serve AI] Provider: ${provider} | Model: ${model}`);
    this.channel.appendLine('');
  }

  logStep(toolCalls?: { toolName: string; args: unknown }[], toolResults?: { result: unknown }[]): void {
    this.stepNum++;
    this.channel.appendLine(`\n--- Step ${this.stepNum} ---`);

    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        this.channel.appendLine(`> Tool: ${tc.toolName}(${JSON.stringify(tc.args)})`);
      }
    }

    if (toolResults && toolResults.length > 0) {
      for (const tr of toolResults) {
        const res = typeof tr.result === 'string' ? tr.result : JSON.stringify(tr.result);
        this.channel.appendLine(`< Result: ${res.length > 500 ? res.slice(0, 500) + '...' : res}`);
      }
    }
  }

  append(text: string): void {
    this.channel.append(text);
  }

  info(message: string): void {
    this.channel.appendLine(`[Quick Serve AI] ${message}`);
  }

  error(message: string): void {
    this.channel.appendLine(`[Error] ${message}`);
  }

  resetSteps(): void {
    this.stepNum = 0;
  }

  get steps(): number {
    return this.stepNum;
  }
}

let logger: AILogger | undefined;

function getLogger(): AILogger {
  if (!logger) {
    logger = new AILogger();
  }
  return logger;
}

const SYSTEM_PROMPT = `You are a dev-tools assistant. The user has selected a project folder. Your task: find every server, service, or application that can be started and accessed via HTTP.

You have tools: listDirectory and readFile. Follow these steps:

STEP 1: Use listDirectory to explore the project folder structure.

STEP 2: Use readFile to read relevant files (package.json, docker-compose.yml, Makefile, scripts/, etc.) to find server definitions.

The user's shell aliases and functions are provided in the <shell-context> tag of the prompt. Check for any aliases/functions that start servers relevant to this project.

Explore as needed, then summarize all discovered servers. For each server describe:
- name: concise label based on the project root folder (e.g. "App Frontend", "API Backend")
- url: the WEB URL that a developer would open in a browser. This must be the frontend/UI URL, NOT internal API endpoints, database connections, or backend service URLs. Use local URL with port (e.g. "http://localhost:3000") or a local proxy/reverse-proxy URL matching patterns like "https://*.dev", "https://*.test", "https://*.local" (e.g. "https://myapp.test/app", "https://api.myproject.dev"). Check project markdown files, Caddyfile, nginx configs, .env files for these URLs.
- startCommand: MUST start with "cd /absolute/path/to/project && " followed by the command (e.g. "cd /Users/me/projects/myapp && npm run dev"). This ensures the command works from any working directory.

PRIORITY for startCommand:
1. Shell alias/function from <shell-context> (highest precedence)
2. Project scripts (./scripts/start.sh, ./bin/serve)
3. Project commands (npm run dev, make serve, docker compose up)
4. Framework defaults (fallback)

Only suggest servers evidenced by the files. Do not guess. Do not return duplicate servers — if the same service appears with different startCommands, keep only the one with the highest precedence per the PRIORITY list above.

IMPORTANT: The user already has servers configured. These are listed in the <existing-servers> tag of the prompt. Do NOT suggest any server that duplicates an existing one — skip it if the startCommand, url, or name matches an already-configured server.`;

const serverSuggestionSchema = z.object({
  servers: z.array(z.object({
    name: z.string().describe('Human-readable server name'),
    url: z.string().describe('Local URL including port'),
    startCommand: z.string().describe('Shell command to start the server'),
  })).describe('List of detected server configurations'),
});

export function resolveModel(provider: AIProvider, modelId: string, apiKey: string) {
  switch (provider) {
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'openai-compatible': {
      const baseURL = config.aiBaseUrl;
      if (!baseURL) {
        throw new Error('Set quickServe.ai.baseUrl for openai-compatible provider (e.g. https://openrouter.ai/api/v1)');
      }
      return createOpenAI({ apiKey, baseURL })(modelId);
    }
    default:
      throw new Error(`Unsupported AI provider: "${provider}". Supported: openai, anthropic, google, openai-compatible`);
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
    const content = new TextDecoder().decode(bytes);
    if (content.includes('\0')) { return null; }
    const lines = content.split('\n');
    if (lines.length > MAX_LINES_PER_FILE) {
      return lines.slice(0, MAX_LINES_PER_FILE).join('\n') + `\n... (truncated, ${lines.length} total lines)`;
    }
    return content;
  } catch {
    return null;
  }
}

async function listDirIfExists(dirPath: string): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(dirPath));
    return entries.map(([name]) => name);
  } catch {
    return [];
  }
}

async function discoverShellContext(log: AILogger): Promise<string> {
  const homeDir = os.homedir();
  const shell = process.env.SHELL || '/bin/bash';
  const sections: string[] = [];

  // 1. Read shell config files
  const configFiles = [
    '~/.zshrc', '~/.bashrc', '~/.bash_profile', '~/.profile',
    '~/.aliases', '~/.zsh_aliases',
  ];

  for (const cf of configFiles) {
    const fullPath = cf.replace('~', homeDir);
    const content = await readFileIfExists(fullPath);
    if (content) {
      sections.push(`=== ${cf} ===\n${content}`);
    }
  }

  // 2. Read shell framework custom dirs
  const frameworkDirs = [
    { dir: `${homeDir}/.oh-my-zsh/custom`, ext: '.zsh' },
    { dir: `${homeDir}/.oh-my-bash/custom`, ext: '.bash' },
    { dir: `${homeDir}/.bash_it/custom`, ext: '.bash' },
  ];

  for (const { dir, ext } of frameworkDirs) {
    const files = await listDirIfExists(dir);
    for (const file of files) {
      if (file.endsWith(ext)) {
        const content = await readFileIfExists(`${dir}/${file}`);
        if (content) {
          sections.push(`=== ${dir}/${file} ===\n${content}`);
        }
      }
    }
  }

  // 3. List function names (compact — names only, not bodies)
  try {
    const { stdout } = await execAsync(`${shell} -ilc "typeset +f"`, {
      env: { ...process.env, HOME: homeDir },
      timeout: 10_000,
    });
    if (stdout.trim()) {
      sections.push(`=== Shell function names (typeset +f) ===\n${stdout.trim()}`);
    }
  } catch {
    // ignore
  }

  const context = sections.join('\n\n');
  log.info(`Shell context: ${sections.length} sources, ${context.length} chars`);
  return context;
}

function createTools(folderUri: vscode.Uri) {
  const homeDir = os.homedir();

  return {
    listDirectory: tool({
      description: 'List files and directories. Use a path relative to the project folder, or an absolute path starting with ~ for home directory (e.g. "~/.oh-my-zsh/custom/"). Use "" or "." for project root. Returns names with trailing / for directories.',
      parameters: z.object({
        path: z.string().describe('Relative path within project (e.g. "", "src") or absolute with ~ (e.g. "~/.oh-my-zsh/custom/")'),
      }),
      execute: async ({ path }) => {
        let targetUri: vscode.Uri;
        if (path.startsWith('~')) {
          targetUri = vscode.Uri.file(path.replace('~', homeDir));
        } else {
          targetUri = path && path !== '.'
            ? vscode.Uri.joinPath(folderUri, path)
            : folderUri;
        }
        try {
          const entries = await vscode.workspace.fs.readDirectory(targetUri);
          return entries
            .map(([name, type]) => type === vscode.FileType.Directory ? `${name}/` : name)
            .join('\n');
        } catch {
          return 'Error: directory not found or not readable';
        }
      },
    }),

    readFile: tool({
      description: 'Read the contents of a file. Use a path relative to the project folder, or an absolute path starting with ~ for home directory shell configs (e.g. ~/.bashrc, ~/.zshrc).',
      parameters: z.object({
        path: z.string().describe('File path — relative to project (e.g. "package.json") or absolute with ~ (e.g. "~/.zshrc")'),
      }),
      execute: async ({ path }) => {
        let fileUri: vscode.Uri;
        if (path.startsWith('~')) {
          fileUri = vscode.Uri.file(path.replace('~', homeDir));
        } else {
          fileUri = vscode.Uri.joinPath(folderUri, path);
        }
        try {
          const bytes = await vscode.workspace.fs.readFile(fileUri);
          const content = new TextDecoder().decode(bytes);
          if (content.includes('\0')) { return 'Error: binary file, skipped'; }
          const lines = content.split('\n');
          if (lines.length > MAX_LINES_PER_FILE) {
            return lines.slice(0, MAX_LINES_PER_FILE).join('\n') + `\n... (truncated, ${lines.length} total lines)`;
          }
          return content;
        } catch {
          return 'Error: file not found or not readable';
        }
      },
    }),
  };
}

type ServerSuggestion = z.infer<typeof serverSuggestionSchema>['servers'][number];
export type Model = ReturnType<typeof resolveModel>;

async function scanFolder(
  childUri: vscode.Uri,
  name: string,
  model: Model,
  log: AILogger,
  maxSteps: number | undefined,
  abortSignal: AbortSignal,
  shellContext: string,
  existingServers: { name: string; url: string; startCommand: string }[],
): Promise<ServerSuggestion[]> {
  log.resetSteps();
  const tools = createTools(childUri);

  // Step 1: streamText — AI explores the subfolder
  let finalText: string;
  try {
    const textStream = streamText({
      model,
      system: SYSTEM_PROMPT,
      prompt: `Project folder: ${childUri.fsPath}\nUser home: ${os.homedir()}\nUser shell: ${process.env.SHELL || '/bin/bash'}\n\n<shell-context>\n${shellContext}\n</shell-context>\n\n<existing-servers>\n${existingServers.length > 0 ? existingServers.map(s => `- name: ${s.name} | url: ${s.url} | startCommand: ${s.startCommand}`).join('\n') : '(none)'}\n</existing-servers>`,
      tools,
      maxSteps,
      abortSignal,
      onStepFinish({ toolCalls, toolResults }) {
        log.logStep(toolCalls, toolResults);
      },
    });

    for await (const chunk of textStream.textStream) {
      log.append(chunk);
    }

    finalText = await textStream.text;
  } catch (err: unknown) {
    if (abortSignal.aborted) { return []; }
    log.error(`Failed to scan ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  log.info(`Analysis of ${name} complete (${log.steps} steps)`);
  log.info('Extracting structured results...');

  // Step 2: generateObject — extract servers
  try {
    const { object: result } = await generateObject({
      model,
      schema: serverSuggestionSchema,
      prompt: `Based on the following analysis of a project folder, extract all detected servers.\n\n${finalText}`,
      abortSignal,
    });

    log.info(`Found ${result.servers.length} server(s) in ${name}`);
    return result.servers;
  } catch (err: unknown) {
    if (abortSignal.aborted) { return []; }
    log.error(`Failed to extract results from ${name}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export async function suggestServers(store: ServerStore, apiKey: string): Promise<number> {

  // Pick folder — always show QuickPick first for context
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const folderItems: vscode.QuickPickItem[] = [
    ...workspaceFolders.map(wf => ({
      label: wf.name,
      description: wf.uri.fsPath,
    })),
    { label: '$(folder) Browse...', description: 'Pick a folder from disk' },
  ];

  const folderChoice = await vscode.window.showQuickPick(folderItems, {
    placeHolder: 'Pick the parent folder containing your server projects',
    title: 'Quick Serve: AI Scan — Select Folder',
    ignoreFocusOut: true,
  });
  if (!folderChoice) { return 0; }

  let folderUri: vscode.Uri;

  if (folderChoice.label === '$(folder) Browse...') {
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Scan Folder',
    });
    if (!picked || picked.length === 0) { return 0; }
    folderUri = picked[0];
  } else {
    const wf = workspaceFolders.find(f => f.uri.fsPath === folderChoice.description);
    if (!wf) { return 0; }
    folderUri = wf.uri;
  }

  // Resolve AI model
  let model;
  try {
    model = resolveModel(config.aiProvider, config.aiModel, apiKey);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Quick Serve: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  // List direct child folders
  let childFolders: [string, vscode.Uri][];
  try {
    const entries = await vscode.workspace.fs.readDirectory(folderUri);
    childFolders = entries
      .filter(([, type]) => type === vscode.FileType.Directory)
      .filter(([name]) => !name.startsWith('.'))
      .map(([name]) => [name, vscode.Uri.joinPath(folderUri, name)] as [string, vscode.Uri]);
  } catch {
    vscode.window.showErrorMessage('Quick Serve: Failed to read the selected folder.');
    return 0;
  }

  if (childFolders.length === 0) {
    vscode.window.showInformationMessage('Quick Serve: No subfolders found in the selected folder.');
    return 0;
  }

  // Warn about token cost
  const proceed = await vscode.window.showWarningMessage(
    `Quick Serve: AI will scan ${childFolders.length} subfolder(s) in "${folderUri.fsPath}". This uses API tokens and costs may vary depending on folder size.`,
    'Continue',
    'Cancel',
  );
  if (proceed !== 'Continue') { return 0; }

  const log = getLogger();
  log.start(folderUri.fsPath, config.aiProvider, config.aiModel);
  log.info(`Found ${childFolders.length} subfolder(s) to scan`);

  // Discover shell context once (shared across all child folder scans)
  log.info('Discovering shell aliases and functions...');
  const shellContext = await discoverShellContext(log);

  const maxSteps = config.aiMaxSteps ?? 100;
  const allServers: ServerSuggestion[] = [];

  // Scan each child folder (cancellable)
  const abort = new AbortController();

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Quick Serve: AI is analyzing projects...',
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => {
        abort.abort();
        log.info('Cancelled by user.');
      });

      for (let i = 0; i < childFolders.length; i++) {
        if (abort.signal.aborted) { break; }

        const [name, childUri] = childFolders[i];
        progress.report({ message: `(${i + 1}/${childFolders.length}) ${name}` });
        log.info(`\n========== Scanning: ${name} (${i + 1}/${childFolders.length}) ==========`);

        const existingServers = store.getAll().map(s => ({ name: s.name, url: s.url, startCommand: s.startCommand }));
        const servers = await scanFolder(childUri, name, model, log, maxSteps, abort.signal, shellContext, existingServers);
        allServers.push(...servers);
      }
    },
  );

  // Deduplicate by startCommand and filter out servers already in the store
  const existingCommands = new Set(store.getAll().map(s => s.startCommand));
  const existingUrls = new Set(store.getAll().map(s => s.url));
  const seen = new Set<string>();
  const uniqueServers: ServerSuggestion[] = [];
  for (const server of allServers) {
    if (!seen.has(server.startCommand) && !existingCommands.has(server.startCommand) && !existingUrls.has(server.url)) {
      seen.add(server.startCommand);
      uniqueServers.push(server);
    }
  }

  log.info(`\nScan complete. Total: ${uniqueServers.length} unique server(s) (${allServers.length} before dedup) across ${childFolders.length} subfolder(s)`);

  if (uniqueServers.length === 0) {
    vscode.window.showInformationMessage('Quick Serve: No servers detected in any subfolder.');
    return 0;
  }

  const suggestions = { servers: uniqueServers };

  // QuickPick
  const items = suggestions.servers.map(s => ({
    label: s.name,
    description: s.url,
    detail: s.startCommand,
    picked: true,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: 'Select servers to add',
    title: 'AI Suggested Servers',
    ignoreFocusOut: true,
  });

  if (!selected || selected.length === 0) { return 0; }

  for (const item of selected) {
    const match = suggestions.servers.find(s => s.name === item.label);
    if (match) {
      await store.add(match.name, match.url, match.startCommand);
    }
  }

  return selected.length;
}
