import type { PluginEvent } from "@paperclipai/plugin-sdk";
import type { DiscordMessage } from "./discord-api.js";
export declare function humanizeStatus(raw: string): string;
export declare function humanizePriority(raw: string): string;
export declare function formatIssueCreated(event: PluginEvent, baseUrl?: string): DiscordMessage;
export declare function formatIssueDone(event: PluginEvent, baseUrl?: string): DiscordMessage;
export declare function formatApprovalCreated(event: PluginEvent, baseUrl?: string): DiscordMessage;
export declare function formatAgentError(event: PluginEvent): DiscordMessage;
export declare function formatSessionFailure(event: PluginEvent): DiscordMessage;
export interface BudgetWarningData {
    agentName: string;
    agentId: string;
    spent: number;
    limit: number;
    remaining: number;
    pct: number;
}
export declare function formatBudgetWarning(data: BudgetWarningData): DiscordMessage;
export declare function formatAgentRunStarted(event: PluginEvent): DiscordMessage;
export declare function formatAgentRunFinished(event: PluginEvent): DiscordMessage;
