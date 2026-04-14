import type { PluginContext } from "@paperclipai/plugin-sdk";

/**
 * Resolves agent IDs to display names via `ctx.agents.list`, with a short TTL
 * cache so notification enrichment does not hammer the Paperclip API.
 *
 * The SDK does not expose `ctx.agents.get(id)` at the time of writing, so we
 * list agents for a company and build an id→name map. Misses return `null` so
 * callers can fall back to whatever they had before.
 */

const CACHE_TTL_MS = 60 * 1000; // 60 seconds

interface CacheEntry {
  map: Map<string, string>;
  expiresAt: number;
}

const companyCaches = new Map<string, CacheEntry>();

type AgentRecord = {
  id: string;
  name?: string | null;
  displayName?: string | null;
};

async function loadAgentMap(
  ctx: PluginContext,
  companyId: string,
): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = companyCaches.get(companyId);
  if (cached && cached.expiresAt > now) {
    return cached.map;
  }

  const map = new Map<string, string>();
  try {
    const agents = (await ctx.agents.list({ companyId })) as AgentRecord[];
    for (const agent of agents) {
      if (!agent?.id) continue;
      const label = agent.displayName || agent.name;
      if (label) map.set(agent.id, String(label));
    }
  } catch (error) {
    ctx.logger.debug("agent-name-cache: list failed", {
      companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  companyCaches.set(companyId, { map, expiresAt: now + CACHE_TTL_MS });
  return map;
}

/**
 * Resolves a single agent ID to a human-readable name. Returns `null` if no
 * match is found or the call fails. Callers should fall back to whatever they
 * already have.
 */
export async function resolveAgentName(
  ctx: PluginContext,
  companyId: string | undefined,
  agentId: string | undefined | null,
): Promise<string | null> {
  if (!agentId) return null;
  if (!companyId) return null;
  const map = await loadAgentMap(ctx, companyId);
  return map.get(agentId) ?? null;
}

/**
 * Test-only helper to reset the cache between unit tests.
 */
export function __resetAgentNameCache(): void {
  companyCaches.clear();
}
