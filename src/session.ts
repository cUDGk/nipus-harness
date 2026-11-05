import { getModel } from '@earendil-works/pi-ai/compat';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { createAgentSession } from '@earendil-works/pi-coding-agent';

type Model = NonNullable<ReturnType<typeof getModel>>;

export function retrySettings() {
  const override = Number(process.env.HARNESS_RETRY_BASE_MS);
  const baseDelayMs = Number.isFinite(override) && override > 0 ? override : 5000;
  return { enabled: true, maxRetries: 8, baseDelayMs, maxAgentDelayMs: baseDelayMs * 64,
    provider: { maxRetries: 0 } };
}

export function resolvedEffort(model: Model, effort: ThinkingLevel) {
  if (!model.reasoning) return undefined; // pi then sends no reasoning field, so the gate must expect none.
  return effort === 'off'
    ? (model.thinkingLevelMap?.off === null ? undefined : model.thinkingLevelMap?.off ?? 'none')
    : model.thinkingLevelMap?.[effort] ?? effort;
}

// A new model reaches the account before pi's catalog, so an unknown gpt name borrows the terra entry. The provider
// refuses a name it does not serve, and the run then fails with its message.
export const inCatalog = (name: string) => !!getModel('openai', name as never);
export function modelFor(name: string): Model | undefined {
  const known = getModel('openai', name as never);
  if (known) return known;
  if (!/^gpt-[a-z0-9][a-z0-9.-]*$/.test(name)) return undefined;
  return { ...getModel('openai', 'gpt-6.1-terra' as never)!, id: name, name } as Model;
}

export function checkEffort(model: Model, effort: string) {
  const map = model.thinkingLevelMap as Record<string, unknown> | undefined;
  if (!map || (Object.hasOwn(map, effort) && map[effort] !== null)) return;
  const usable = Object.keys(map).filter(level => map[level] !== null).join(', ');
  throw new Error(`Unsupported effort for ${model.id}: ${effort}. Use one of: ${usable}`);
}

export function createSession(
  options: Parameters<typeof createAgentSession>[0], model: Model, effort: ThinkingLevel, baseUrl: string,
) {
  return createAgentSession({
    ...options,
    model: { ...model, baseUrl, compat: { ...(model.compat as object | undefined), supportsMidConvoEffort: false } },
    thinkingLevel: effort,
  });
}
