import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface EscalationRecord {
    escalationId: string;
    companyId: string;
    agentName: string;
    reason: string;
    confidenceScore?: number;
    agentReasoning?: string;
    conversationHistory?: Array<{
        role: string;
        content: string;
    }>;
    suggestedReply?: string;
    channelId: string;
    messageId: string;
    status: "pending" | "resolved" | "timed_out";
    createdAt: string;
    resolvedAt?: string;
    resolvedBy?: string;
    resolution?: string;
}
export declare function getEscalation(ctx: PluginContext, escalationId: string, escalationCompanyId?: string): Promise<EscalationRecord | null>;
export declare function saveEscalation(ctx: PluginContext, record: EscalationRecord): Promise<void>;
export declare function trackPendingEscalation(ctx: PluginContext, escalationId: string, escalationCompanyId?: string): Promise<void>;
export declare function untrackPendingEscalation(ctx: PluginContext, escalationId: string, escalationCompanyId?: string): Promise<void>;
/**
 * Collect pending escalation IDs across both company-scoped and legacy scopes,
 * deduplicating by escalation ID.
 */
export declare function collectPendingEscalationIds(ctx: PluginContext, companyId: string | undefined): Promise<string[]>;
