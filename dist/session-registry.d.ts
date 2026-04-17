import type { PluginContext } from "@paperclipai/plugin-sdk";
export type TransportKind = "native" | "acp";
export interface AgentSessionEntry {
    sessionId: string;
    agentId: string;
    agentName: string;
    agentDisplayName: string;
    companyId: string;
    transport: TransportKind;
    spawnedAt: string;
    status: "running" | "completed" | "failed" | "cancelled";
    lastActivityAt: string;
}
export interface HandoffRecord {
    handoffId: string;
    threadId: string;
    fromAgent: string;
    toAgent: string;
    toAgentId: string;
    companyId: string;
    reason: string;
    context?: string;
    status: "pending" | "approved" | "rejected";
    messageId?: string;
    channelId?: string;
    createdAt: string;
    resolvedAt?: string;
    resolvedBy?: string;
}
export interface DiscussionLoop {
    discussionId: string;
    threadId: string;
    initiator: string;
    initiatorAgentId: string;
    target: string;
    targetAgentId: string;
    companyId: string;
    topic: string;
    maxTurns: number;
    humanCheckpointInterval: number;
    currentTurn: number;
    currentSpeaker: string;
    currentSpeakerAgentId: string;
    status: "active" | "paused_checkpoint" | "completed" | "stale" | "cancelled";
    lastActivityAt: string;
    createdAt: string;
}
export declare function getThreadSessions(ctx: PluginContext, threadId: string, companyId?: string): Promise<AgentSessionEntry[]>;
export declare function spawnAgentInThread(ctx: PluginContext, token: string, threadId: string, agentName: string, companyId: string, taskPrompt: string, maxAgents?: number): Promise<{
    ok: boolean;
    sessionId?: string;
    transport?: TransportKind;
    error?: string;
}>;
export declare function closeAgentInThread(ctx: PluginContext, token: string, threadId: string, agentName: string, companyId: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare function parseAgentMention(text: string, sessions: AgentSessionEntry[]): AgentSessionEntry | null;
export declare function routeMessageToAgent(ctx: PluginContext, threadId: string, text: string, companyId: string, replyToSessionId?: string): Promise<boolean>;
export declare function handleAcpOutput(ctx: PluginContext, token: string, event: {
    sessionId: string;
    threadId: string;
    agentName: string;
    output: string;
    companyId?: string;
    status?: "running" | "completed" | "failed";
}): Promise<void>;
export declare function createAgentThread(ctx: PluginContext, token: string, channelId: string, agentName: string, task: string, companyId: string): Promise<string | null>;
export declare function getThreadStatus(ctx: PluginContext, threadId: string, companyId?: string): Promise<{
    sessions: AgentSessionEntry[];
}>;
export declare function initiateHandoff(ctx: PluginContext, token: string, threadId: string, fromAgent: string, toAgent: string, companyId: string, reason: string, handoffContext?: string): Promise<{
    handoffId: string;
    status: string;
}>;
export declare function handleHandoffButton(ctx: PluginContext, token: string, customId: string, actor: string): Promise<unknown>;
export declare function startDiscussion(ctx: PluginContext, token: string, threadId: string, initiator: string, target: string, companyId: string, topic: string, maxTurns?: number, humanCheckpointInterval?: number): Promise<{
    discussionId: string;
    status: string;
}>;
export declare function handleDiscussionButton(ctx: PluginContext, token: string, customId: string, actor: string): Promise<unknown>;
interface AcpInteractionOption {
    name: string;
    value?: string | number | boolean;
    options?: AcpInteractionOption[];
}
interface AcpInteractionData {
    options?: AcpInteractionOption[];
}
export declare function handleAcpCommand(ctx: PluginContext, token: string, data: AcpInteractionData, companyId: string, defaultChannelId: string): Promise<unknown>;
export {};
