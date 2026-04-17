import { postEmbedWithId } from "./discord-api.js";
import { COLORS } from "./constants.js";
import { paperclipFetch } from "./paperclip-fetch.js";
// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------
function interpolate(template, wfCtx) {
    return template.replace(/\{\{(\w[\w.]*)\}\}/g, (_match, key) => {
        // {{arg0}}, {{arg1}}, ...
        const argMatch = key.match(/^arg(\d+)$/);
        if (argMatch) {
            const idx = parseInt(argMatch[1], 10);
            return wfCtx.args[idx] ?? "";
        }
        // {{args}} — full args string
        if (key === "args") {
            return wfCtx.fullArgs;
        }
        // {{prev.result}}
        if (key === "prev.result") {
            return wfCtx.prevResult ? stringify(wfCtx.prevResult.result) : "";
        }
        // {{step_id.result}}
        const dotIdx = key.indexOf(".");
        if (dotIdx > 0) {
            const stepId = key.slice(0, dotIdx);
            const field = key.slice(dotIdx + 1);
            const stepResult = wfCtx.results[stepId];
            if (stepResult && field === "result") {
                return stringify(stepResult.result);
            }
        }
        // {{state_key}}
        if (key in wfCtx.state) {
            return stringify(wfCtx.state[key]);
        }
        return `{{${key}}}`;
    });
}
function stringify(val) {
    if (val === null || val === undefined)
        return "";
    if (typeof val === "string")
        return val;
    return JSON.stringify(val);
}
// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------
async function execFetchIssue(ctx, step, wfCtx, baseUrl) {
    const issueId = interpolate(step.issueId ?? "", wfCtx);
    if (!issueId)
        return { ok: false, error: "Missing issueId" };
    try {
        const resp = await paperclipFetch(`${baseUrl}/api/issues/${issueId}`, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
        });
        if (!resp.ok)
            return { ok: false, error: `API ${resp.status}` };
        const data = await resp.json();
        return { ok: true, result: data };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
async function execInvokeAgent(ctx, step, wfCtx, companyId) {
    const agentId = interpolate(step.agentId ?? "", wfCtx);
    const prompt = interpolate(step.prompt ?? "", wfCtx);
    if (!agentId)
        return { ok: false, error: "Missing agentId" };
    try {
        await ctx.agents.invoke(agentId, companyId, {
            prompt,
            reason: "Workflow step: invoke_agent",
        });
        return { ok: true, result: { invoked: agentId, prompt } };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
async function execHttpRequest(ctx, step, wfCtx) {
    const url = interpolate(step.url ?? "", wfCtx);
    const method = (step.method ?? "GET").toUpperCase();
    if (!url)
        return { ok: false, error: "Missing url" };
    const headers = { "Content-Type": "application/json" };
    if (step.headers) {
        for (const [k, v] of Object.entries(step.headers)) {
            headers[k] = interpolate(v, wfCtx);
        }
    }
    const init = { method, headers };
    if (step.body && method !== "GET") {
        init.body = interpolate(step.body, wfCtx);
    }
    try {
        // Use ctx.http.fetch (NOT paperclipFetch) for user-configured URLs to
        // preserve the private-IP restriction and prevent SSRF.
        const resp = await ctx.http.fetch(url, init);
        let data;
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("json")) {
            data = await resp.json();
        }
        else {
            data = await resp.text();
        }
        return resp.ok
            ? { ok: true, result: data }
            : { ok: false, error: `HTTP ${resp.status}`, result: data };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
async function execSendMessage(ctx, step, wfCtx, token, defaultChannelId) {
    const message = interpolate(step.message ?? "", wfCtx);
    const channelId = interpolate(step.channelId ?? "", wfCtx) || defaultChannelId;
    if (!message)
        return { ok: false, error: "Missing message" };
    const msgId = await postEmbedWithId(ctx, token, channelId, {
        embeds: [
            {
                description: message,
                color: COLORS.BLUE,
                footer: { text: "Paperclip Workflow" },
                timestamp: new Date().toISOString(),
            },
        ],
    });
    return msgId
        ? { ok: true, result: { messageId: msgId, channelId } }
        : { ok: false, error: "Failed to send message" };
}
async function execCreateIssue(ctx, step, wfCtx, companyId, baseUrl) {
    const title = interpolate(step.title ?? "", wfCtx);
    if (!title)
        return { ok: false, error: "Missing title" };
    const payload = {
        title,
        description: interpolate(step.description ?? "", wfCtx),
        status: "todo",
    };
    if (step.projectId)
        payload.projectId = interpolate(step.projectId, wfCtx);
    if (step.parentId)
        payload.parentId = interpolate(step.parentId, wfCtx);
    if (step.assigneeAgentId)
        payload.assigneeAgentId = interpolate(step.assigneeAgentId, wfCtx);
    try {
        const resp = await paperclipFetch(`${baseUrl}/api/companies/${companyId}/issues`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        if (!resp.ok)
            return { ok: false, error: `API ${resp.status}` };
        const data = await resp.json();
        return { ok: true, result: data };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
async function execWaitApproval(ctx, step, wfCtx, token, defaultChannelId, workflowName, stepIndex, companyId) {
    const message = interpolate(step.approvalMessage ?? "Workflow requires approval to continue.", wfCtx);
    const channelId = interpolate(step.channelId ?? "", wfCtx) || defaultChannelId;
    const approvalId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const msgId = await postEmbedWithId(ctx, token, channelId, {
        embeds: [
            {
                title: "Workflow Approval Required",
                description: message,
                color: COLORS.YELLOW,
                fields: [
                    { name: "Workflow", value: workflowName, inline: true },
                    { name: "Step", value: `${stepIndex + 1}`, inline: true },
                ],
                footer: { text: `Approval ID: ${approvalId}` },
                timestamp: new Date().toISOString(),
            },
        ],
        components: [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: 3,
                        label: "Approve",
                        custom_id: `wf_approve_${approvalId}`,
                    },
                    {
                        type: 2,
                        style: 4,
                        label: "Reject",
                        custom_id: `wf_reject_${approvalId}`,
                    },
                ],
            },
        ],
    });
    if (!msgId)
        return { ok: false, error: "Failed to send approval message" };
    // Store suspended workflow state so it can be resumed on button click
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `wf_pending_${approvalId}` }, {
        approvalId,
        workflowName,
        stepIndex,
        wfCtx: {
            args: wfCtx.args,
            fullArgs: wfCtx.fullArgs,
            results: wfCtx.results,
            state: wfCtx.state,
        },
        channelId,
        messageId: msgId,
        createdAt: new Date().toISOString(),
    });
    return { ok: true, result: { approvalId, suspended: true }, suspended: true };
}
async function execSetState(step, wfCtx) {
    const key = interpolate(step.stateKey ?? "", wfCtx);
    const value = interpolate(step.stateValue ?? "", wfCtx);
    if (!key)
        return { ok: false, error: "Missing stateKey" };
    wfCtx.state[key] = value;
    return { ok: true, result: { key, value } };
}
export async function runWorkflow(opts) {
    const { ctx, token, channelId, companyId, baseUrl, workflow, args } = opts;
    const wfCtx = opts.resumeCtx
        ? { ...opts.resumeCtx, prevResult: null }
        : {
            args: args.split(/\s+/).filter(Boolean),
            fullArgs: args,
            results: {},
            prevResult: null,
            state: {},
        };
    const startStep = opts.resumeFromStep ?? 0;
    for (let i = startStep; i < workflow.steps.length; i++) {
        const step = workflow.steps[i];
        let result;
        switch (step.type) {
            case "fetch_issue":
                result = await execFetchIssue(ctx, step, wfCtx, baseUrl);
                break;
            case "invoke_agent":
                result = await execInvokeAgent(ctx, step, wfCtx, companyId);
                break;
            case "http_request":
                result = await execHttpRequest(ctx, step, wfCtx);
                break;
            case "send_message":
                result = await execSendMessage(ctx, step, wfCtx, token, channelId);
                break;
            case "create_issue":
                result = await execCreateIssue(ctx, step, wfCtx, companyId, baseUrl);
                break;
            case "wait_approval":
                result = await execWaitApproval(ctx, step, wfCtx, token, channelId, workflow.name, i, companyId);
                break;
            case "set_state":
                result = await execSetState(step, wfCtx);
                break;
            default:
                result = { ok: false, error: `Unknown step type: ${step.type}` };
        }
        // Store result by step id
        if (step.id) {
            wfCtx.results[step.id] = { ok: result.ok, result: result.result, error: result.error };
        }
        wfCtx.prevResult = { ok: result.ok, result: result.result, error: result.error };
        // If suspended (wait_approval), stop execution — will resume on button click
        if (result.suspended) {
            return { ok: true, stepsCompleted: i + 1, suspended: true };
        }
        // Stop on error
        if (!result.ok) {
            ctx.logger.warn("Workflow step failed", {
                workflow: workflow.name,
                step: i,
                type: step.type,
                error: result.error,
            });
            return { ok: false, stepsCompleted: i, error: result.error };
        }
    }
    return { ok: true, stepsCompleted: workflow.steps.length };
}
// ---------------------------------------------------------------------------
// Workflow store helpers
// ---------------------------------------------------------------------------
const STORE_KEY_PREFIX = "commands_";
export async function getWorkflowStore(ctx, companyId) {
    const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: `${STORE_KEY_PREFIX}${companyId}`,
    });
    if (!raw)
        return { workflows: {} };
    return raw;
}
export async function saveWorkflowStore(ctx, companyId, store) {
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `${STORE_KEY_PREFIX}${companyId}` }, store);
}
// ---------------------------------------------------------------------------
// Resume a suspended workflow after approval button click
// ---------------------------------------------------------------------------
export async function resumeWorkflowAfterApproval(ctx, token, channelId, companyId, baseUrl, approvalId, approved) {
    const pending = (await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: `wf_pending_${approvalId}`,
    }));
    if (!pending)
        return { ok: false, error: "Pending workflow not found" };
    // Clean up the pending state
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `wf_pending_${approvalId}` }, null);
    if (!approved) {
        return { ok: true };
    }
    // Load the workflow definition
    const store = await getWorkflowStore(ctx, companyId);
    const workflow = store.workflows[pending.workflowName];
    if (!workflow)
        return { ok: false, error: `Workflow "${pending.workflowName}" no longer exists` };
    // Inject the approval result into the context
    const resumeCtx = {
        ...pending.wfCtx,
        prevResult: null,
    };
    // Store approval result for the wait_approval step
    const step = workflow.steps[pending.stepIndex];
    if (step?.id) {
        resumeCtx.results[step.id] = { ok: true, result: { approved: true } };
    }
    const result = await runWorkflow({
        ctx,
        token,
        channelId,
        companyId,
        baseUrl,
        workflow,
        args: pending.wfCtx.fullArgs,
        resumeFromStep: pending.stepIndex + 1,
        resumeCtx,
    });
    return { ok: result.ok, error: result.error };
}
// ---------------------------------------------------------------------------
// Built-in command names that cannot be overridden
// ---------------------------------------------------------------------------
export const BUILTIN_COMMANDS = new Set([
    "status",
    "approve",
    "budget",
    "issues",
    "agents",
    "help",
    "connect",
    "connect-channel",
    "digest",
    "commands",
]);
//# sourceMappingURL=workflow-engine.js.map