import * as vscode from 'vscode';
import { z } from 'zod';
import { generateObject } from 'ai';
import { resolveModel } from './aiSuggest.js';
import { config } from './config.js';
import { ServerStore } from './serverStore.js';

const groupAssignmentSchema = z.object({
  groups: z.array(z.object({
    serverId: z.string().describe('The server ID'),
    group: z.string().describe('Logical group label (e.g. "Frontend", "Backend API", "Infrastructure")'),
  })).describe('Group assignment for each server'),
});

const GROUP_SYSTEM_PROMPT = `You are a dev-tools assistant. Given a list of local development servers with their names, URLs, and start commands, assign each server to a logical group.

Rules:
- Groups should be short, human-readable labels (2-3 words max, e.g. "Frontend", "Backend API", "Database Tools", "Infrastructure")
- Group servers that serve a similar purpose or belong to the same layer of the application stack
- If a server doesn't clearly fit any group, assign it to "General"
- Aim for 2-5 groups total. Don't create too many groups — prefer fewer, broader categories
- Every server must receive exactly one group assignment
- Use title case for group names`;

export async function groupServersWithAI(store: ServerStore, apiKey: string): Promise<number> {
  const servers = store.getAll();

  if (servers.length < 2) {
    vscode.window.showInformationMessage('Quick Serve: Need at least 2 servers to create meaningful groups.');
    return 0;
  }

  let model;
  try {
    model = resolveModel(config.aiProvider, config.aiModel, apiKey);
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Quick Serve: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  const serverList = servers.map(s => ({
    id: s.id,
    name: s.name,
    url: s.url,
    startCommand: s.startCommand,
    currentGroup: s.group ?? '(none)',
  }));

  let assigned = 0;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Quick Serve: AI is grouping servers...',
      cancellable: false,
    },
    async () => {
      try {
        const { object: result } = await generateObject({
          model,
          schema: groupAssignmentSchema,
          system: GROUP_SYSTEM_PROMPT,
          prompt: `Here are the servers to group:\n\n${JSON.stringify(serverList, null, 2)}`,
        });

        const assignments = new Map<string, string>();
        for (const { serverId, group } of result.groups) {
          if (store.getById(serverId)) {
            assignments.set(serverId, group);
          }
        }

        await store.updateGroups(assignments);
        assigned = assignments.size;
      } catch (err: unknown) {
        vscode.window.showErrorMessage(
          `Quick Serve: AI grouping failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  if (assigned > 0) {
    vscode.window.showInformationMessage(`Quick Serve: Grouped ${assigned} server(s).`);
  }

  return assigned;
}
