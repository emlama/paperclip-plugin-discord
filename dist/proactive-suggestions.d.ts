import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface WatchEntry {
    watchId: string;
    watchName: string;
    patterns: string[];
    channelIds: string[];
    responseTemplate: string;
    agentId: string;
    agentName: string;
    companyId: string;
    cooldownMinutes: number;
    registeredAt: string;
    lastTriggeredAt?: string;
}
export declare function registerWatch(ctx: PluginContext, companyId: string, watchName: string, patterns: string[], channelIds: string[], responseTemplate: string, cooldownMinutes: number, agentId: string, agentName: string): Promise<{
    ok: boolean;
    watchId: string;
    error?: string;
}>;
export declare function checkWatches(ctx: PluginContext, token: string, companyId: string, defaultChannelId: string): Promise<void>;
