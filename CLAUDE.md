# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension ("Quick Serve") that manages and monitors local dev servers from a sidebar panel. Features health monitoring, AI-powered server discovery via Vercel AI SDK, and multi-terminal support.

## Build & Development

```bash
npm run compile        # One-time TypeScript compilation
npm run watch          # Watch mode (use during development)
npx @vscode/vsce package  # Package as .vsix
```

**Dev workflow:** Run `npm run watch`, then press F5 in VS Code to launch the Extension Development Host. No test framework or linter is configured — TypeScript strict mode is the primary code quality gate.

## Architecture

**Entry point:** `src/extension.ts::activate()` — registers all 10 commands, initializes the server store, tree view, and health checker.

### Core Modules

| Module | Role |
|---|---|
| `extension.ts` | Command handlers, terminal management (integrated + external), process killing |
| `aiSuggest.ts` | AI server discovery — two-phase flow: `streamText()` explores projects with tools, then `generateObject()` extracts structured suggestions |
| `serverStore.ts` | In-memory CRUD with persistence to VS Code global settings (`quickServe.servers`) |
| `serverTreeProvider.ts` | Tree view data provider with status icons (up/down/unknown) |
| `healthChecker.ts` | HTTP/HTTPS polling every 5 seconds with down-transition warnings |
| `config.ts` | Typed wrapper around `vscode.workspace.getConfiguration('quickServe')` |
| `types.ts` | `ServerEntry` interface and `ServerStatus` enum |

### Key Patterns

- **Terminal tracking:** `Map<serverId, vscode.Terminal>` — supports integrated and external (platform-specific) terminal modes
- **Process management:** `killProcessOnPort()` uses `lsof`/`kill` on Unix, `netstat`/`taskkill` on Windows; excludes own process tree
- **Secret storage:** AI API keys stored via `context.secrets` (encrypted), key: `'quickServe.ai.apiKey'`
- **AI integration:** Vercel AI SDK with multi-provider support (OpenAI, Anthropic, Google, OpenAI-compatible). Uses `listDirectory` and `readFile` tools to explore projects, reads shell config files for aliases, deduplicates by `startCommand`
- **Configuration reactivity:** `onDidChangeConfiguration` listener auto-reloads store and refreshes tree view

## Tech Stack

- TypeScript (ES2022, NodeNext modules, strict mode)
- VS Code Extension API ^1.89.0
- Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`)
- Zod for AI structured output schemas
