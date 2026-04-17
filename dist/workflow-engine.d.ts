import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface WorkflowStep {
    id?: string;
    type: "fetch_issue" | "invoke_agent" | "http_request" | "send_message" | "create_issue" | "wait_approval" | "set_state";
    issueId?: string;
    agentId?: string;
    prompt?: string;
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    message?: string;
    channelId?: string;
    title?: string;
    description?: string;
    projectId?: string;
    parentId?: string;
    assigneeAgentId?: string;
    stateKey?: string;
    stateValue?: string;
    approvalMessage?: string;
}
export interface Workflow {
    name: string;
    description?: string;
    steps: WorkflowStep[];
    createdAt: string;
    createdBy?: string;
}
export interface WorkflowCommandStore {
    workflows: Record<string, Workflow>;
}
interface StepResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}
export interface WorkflowRunOptions {
    ctx: PluginContext;
    token: string;
    channelId: string;
    companyId: string;
    baseUrl: string;
    workflow: Workflow;
    args: string;
    /** Resume from this step index (for approval continuation) */
    resumeFromStep?: number;
    /** Restored context when resuming */
    resumeCtx?: {
        args: string[];
        fullArgs: string;
        results: Record<string, StepResult>;
        state: Record<string, unknown>;
    };
}
export declare function runWorkflow(opts: WorkflowRunOptions): Promise<{
    ok: boolean;
    stepsCompleted: number;
    suspended?: boolean;
    error?: string;
}>;
export declare function getWorkflowStore(ctx: PluginContext, companyId: string): Promise<WorkflowCommandStore>;
export declare function saveWorkflowStore(ctx: PluginContext, companyId: string, store: WorkflowCommandStore): Promise<void>;
export declare function resumeWorkflowAfterApproval(ctx: PluginContext, token: string, channelId: string, companyId: string, baseUrl: string, approvalId: string, approved: boolean): Promise<{
    ok: boolean;
    error?: string;
}>;
export declare const BUILTIN_COMMANDS: Set<string>;
export {};
