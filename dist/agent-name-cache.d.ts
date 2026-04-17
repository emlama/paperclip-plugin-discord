import type { PluginContext } from "@paperclipai/plugin-sdk";
/**
 * Resolves a single agent ID to a human-readable name. Returns `null` if no
 * match is found or the call fails. Callers should fall back to whatever they
 * already have.
 */
export declare function resolveAgentName(ctx: PluginContext, companyId: string | undefined, agentId: string | undefined | null): Promise<string | null>;
/**
 * Test-only helper to reset the cache between unit tests.
 */
export declare function __resetAgentNameCache(): void;
