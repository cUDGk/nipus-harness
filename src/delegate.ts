import { defineTool, SessionManager, SettingsManager, type ModelRuntime,
  type ResourceLoader } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { roleContext, type Usage } from './gate.ts';
import { settledPrompt } from './loop.ts';
import { createSession, modelFor, retrySettings } from './session.ts';
import { createTools } from './tools.ts';
import type { Task } from './cli.ts';
import type { createWeb } from './web.ts';
import type { McpServer } from './mcp.ts';

export function delegate(options: { task: Task; usage: { by_role: Record<string, Usage> }; runDir: string;
  agentDir: string; baseUrl: string; runtime: ModelRuntime; loader: ResourceLoader; flush: () => Promise<void>;
  web?: ReturnType<typeof createWeb>; mcpTools?: ReturnType<McpServer['tool']>[] }) {
  const { task, usage, runDir, agentDir, baseUrl, runtime, loader, flush } = options;
  return defineTool({
    name: 'delegate', label: 'Delegate', executionMode: 'sequential',
    description: 'Ask a declared role to perform a task.',
    parameters: Type.Object({ role: Type.String(), task: Type.String() }),
    execute: async (_id, item) => {
      const role = task.roles?.[item.role];
      const reply = (value: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        details: {} });
      if (!role) return reply({ error: 'unknown_role' });
      const childModel = modelFor(role.model)!;
      const roleUsage = usage.by_role[item.role] ??= { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0,
        quota_percent: 0 };
      const context = { name: item.role, aggregate: roleUsage, usage: { calls: 0, input: 0, cached: 0, output: 0,
        reasoning: 0, quota_percent: 0 }, limit: role.max_quota_percent, error: undefined as unknown };
      return roleContext.run(context, async () => {
        let child: Awaited<ReturnType<typeof createSession>>['session'];
        let childFinish: { state: string; summary: string } | undefined;
        const tools = [...createTools({ workspace: task.workspace, readRoots: task.read_roots ?? [], runDir,
          web: options.web, webFetch: task.web?.fetch !== false, noImages: !!task.clean_room,
          box: task.box, env: task.env, path: task.path, maxRunS: task.max_run_s,
          finish: (state, summary) => { childFinish = { state, summary }; void child.abort(); },
        }), ...(options.mcpTools ?? [])].filter(tool => role.tools.includes(tool.name));
        ({ session: child } = await createSession({ cwd: task.workspace, agentDir, modelRuntime: runtime,
          resourceLoader: loader, tools: role.tools, customTools: tools,
          sessionManager: SessionManager.inMemory(task.workspace),
          settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', retry: retrySettings() }),
        }, childModel, role.effort, baseUrl));
        child.subscribe(event => {
          if (event.type === 'auto_retry_start' && context.error) queueMicrotask(() => child.abortRetry());
        });
        try {
          if (child.thinkingLevel !== role.effort) return reply({ error: 'thinking_level_changed' });
          for (let attempt = 0; attempt < 2 && !childFinish; attempt++) {
            await settledPrompt(child, attempt ? 'Call finish with your result.' : item.task);
            await flush();
            if (context.error) {
              return reply({ error: context.error instanceof Error ? context.error.message : 'child_failed' });
            }
          }
          return reply(childFinish ?? { error: 'no_finish' });
        } finally { child.dispose(); }
      });
    },
  });
}
