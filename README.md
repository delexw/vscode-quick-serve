# Quick Serve

Manage and monitor local dev servers from the VS Code sidebar.

## Features

- **Sidebar panel** — see all your servers at a glance with live status indicators (up/down/unknown)
- **Health monitoring** — automatic polling detects when servers go down and notifies you
- **One-click actions** — start servers in integrated or external terminal, open in browser
- **AI-powered suggestions** — scan a project folder and let AI discover servers, URLs, and start commands
- **Multi-provider AI** — works with OpenAI, Anthropic, Google, or any OpenAI-compatible API (OpenRouter, Ollama, etc.)
- **Shell alias detection** — AI discovers your custom shell aliases and functions that start servers
- **Proxy URL detection** — finds local proxy URLs (*.dev, *.test, *.local) from project configs

## Getting Started

1. Install the extension
2. Open the **Quick Serve** panel in the activity bar
3. Click **+** to add a server manually, or use AI suggestions

### Manual Setup

For each server, provide:
- **Name** — a label (e.g. "Frontend Dev")
- **URL** — the local URL (e.g. `http://localhost:3000`)
- **Start command** — shell command to start it (e.g. `cd /path/to/project && npm run dev`)

### AI Suggestions

1. Run **"Quick Serve: Enable AI Suggestions"** from the command palette (`Cmd+Shift+P`)
2. Enter your AI provider API key (stored securely in VS Code's encrypted storage)
3. Pick the parent folder containing your projects
4. AI scans each subfolder, discovers servers, and presents suggestions
5. Select which servers to add

## Settings

| Setting | Default | Description |
|---|---|---|
| `quickServe.terminalMode` | `integrated` | `integrated` or `external` terminal |
| `quickServe.ai.enabled` | `false` | Enable AI suggestions |
| `quickServe.ai.provider` | `openai` | `openai`, `anthropic`, `google`, or `openai-compatible` |
| `quickServe.ai.model` | `gpt-5.2` | Model ID for the selected provider |
| `quickServe.ai.maxSteps` | `null` | Max AI exploration steps (`null` = no limit) |
| `quickServe.ai.baseUrl` | `""` | Custom base URL for openai-compatible provider |
| `quickServe.servers` | `[]` | Server list (editable in settings.json) |

## License

[MIT](./LICENSE)
