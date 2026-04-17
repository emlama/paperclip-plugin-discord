import type { PluginContext } from "@paperclipai/plugin-sdk";
import { type DiscordChannelMessage } from "./discord-api.js";
export interface Signal {
    category: "feature_wish" | "pain_point" | "maintainer_directive" | "sentiment";
    text: string;
    author: string;
    authorWeight: number;
    channelId: string;
    timestamp: string;
    messageId: string;
    expiresAt?: string;
}
export declare function extractSignals(messages: DiscordChannelMessage[], roleWeightMap: Map<string, number>, channelId: string, retentionDays?: number): Signal[];
export declare function filterExpiredSignals(signals: Signal[]): Signal[];
export declare function runIntelligenceScan(ctx: PluginContext, token: string, guildId: string, channelIds: string[], companyId: string, retentionDays?: number): Promise<Signal[]>;
export declare function mergeSignals(existing: Signal[], incoming: Signal[]): Signal[];
export declare function runBackfill(ctx: PluginContext, token: string, guildId: string, channelIds: string[], companyId: string, backfillDays?: number): Promise<Signal[]>;
