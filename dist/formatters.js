import { COLORS } from "./constants.js";
const DEFAULT_BASE_URL = "http://localhost:3100";
const STATUS_LABELS = {
    todo: "To Do",
    in_progress: "In Progress",
    in_review: "In Review",
    done: "Done",
    blocked: "Blocked",
    backlog: "Backlog",
    cancelled: "Cancelled",
};
const PRIORITY_LABELS = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
};
export function humanizeStatus(raw) {
    return STATUS_LABELS[raw] ?? raw;
}
export function humanizePriority(raw) {
    return PRIORITY_LABELS[raw] ?? raw;
}
function resolveBaseUrl(baseUrl) {
    const url = (baseUrl || DEFAULT_BASE_URL).trim();
    const normalized = url.endsWith("/") ? url.slice(0, -1) : url;
    try {
        const parsed = new URL(normalized);
        if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)) {
            return null;
        }
        return normalized;
    }
    catch {
        return null;
    }
}
export function formatIssueCreated(event, baseUrl) {
    const p = event.payload;
    const identifier = String(p.identifier ?? event.entityId);
    const title = String(p.title ?? "Untitled");
    const description = p.description ? String(p.description) : null;
    const status = p.status ? String(p.status) : null;
    const priority = p.priority ? String(p.priority) : null;
    const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
    const projectName = p.projectName ? String(p.projectName) : null;
    const creatorName = p.creatorName ? String(p.creatorName) : null;
    const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
    const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
    const parentId = p.parentId ? String(p.parentId) : null;
    const fields = [];
    if (parentIdentifier) {
        const parentLine = parentTitle
            ? `**${parentIdentifier}** — ${parentTitle}`
            : `**${parentIdentifier}**`;
        fields.push({ name: "Parent", value: parentLine, inline: true });
    }
    if (status)
        fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
    if (priority)
        fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
    if (assigneeName)
        fields.push({ name: "Assignee", value: assigneeName, inline: true });
    if (projectName)
        fields.push({ name: "Project", value: projectName, inline: true });
    const knownKeys = new Set([
        "identifier", "title", "description", "status", "priority",
        "assigneeName", "projectName", "assigneeAgentId", "projectId",
        "creatorName", "parentIdentifier", "parentTitle", "parentId",
    ]);
    for (const [key, value] of Object.entries(p)) {
        if (knownKeys.has(key) || value == null || value === "")
            continue;
        const display = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (display.length > 0 && display.length <= 1024) {
            fields.push({ name: key, value: display, inline: display.length < 40 });
        }
    }
    const base = resolveBaseUrl(baseUrl);
    const footerParts = [];
    if (creatorName)
        footerParts.push(`Created by ${creatorName}`);
    if (projectName)
        footerParts.push(projectName);
    const footerText = footerParts.length > 0 ? footerParts.join(" • ") : "Paperclip";
    const buttons = [];
    if (base) {
        buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
    }
    if (base && parentId) {
        buttons.push({
            type: 2,
            style: 5,
            label: "View Parent",
            url: `${base}/issues/${parentId}`,
        });
    }
    return {
        embeds: [
            {
                title: `Issue Created: ${identifier}`,
                description: description
                    ? `**${title}**\n> ${description.slice(0, 500)}`
                    : `**${title}**`,
                color: COLORS.BLUE,
                fields,
                footer: { text: footerText },
                timestamp: event.occurredAt,
            },
        ],
        components: buttons.length > 0 ? [{ type: 1, components: buttons }] : [],
    };
}
export function formatIssueDone(event, baseUrl) {
    const p = event.payload;
    const identifier = String(p.identifier ?? event.entityId);
    const title = String(p.title ?? "") || identifier;
    const status = p.status ? String(p.status) : null;
    const priority = p.priority ? String(p.priority) : null;
    const assigneeName = p.assigneeName ? String(p.assigneeName) : null;
    const assigneeUserId = p.assigneeUserId ? String(p.assigneeUserId) : null;
    const executorName = p.executorName ? String(p.executorName) : null;
    const agentName = p.agentName ? String(p.agentName) : null;
    const explicitCompletedBy = p.completedBy ? String(p.completedBy) : null;
    const assigneeAgentId = p.assigneeAgentId ? String(p.assigneeAgentId) : null;
    const completedBy = humanizeActorLabel(explicitCompletedBy || assigneeName || executorName || agentName || assigneeUserId || assigneeAgentId) || "Unknown";
    const lastComment = p.lastComment ? String(p.lastComment) : null;
    // Cap at 1024 chars — Discord's per-field limit. The old 200-char cap hid
    // most completion comments; raising it lets readers get the full summary
    // without opening the issue.
    const summary = lastComment ? lastComment.slice(0, 1024) : "No summary available";
    const priorComments = Array.isArray(p.priorComments)
        ? p.priorComments
        : [];
    const parentIdentifier = p.parentIdentifier ? String(p.parentIdentifier) : null;
    const parentTitle = p.parentTitle ? String(p.parentTitle) : null;
    const parentId = p.parentId ? String(p.parentId) : null;
    const fields = [];
    fields.push({ name: "Completed by", value: completedBy, inline: true });
    if (status)
        fields.push({ name: "Status", value: `\`${humanizeStatus(status)}\``, inline: true });
    if (priority)
        fields.push({ name: "Priority", value: `\`${humanizePriority(priority)}\``, inline: true });
    fields.push({ name: "Summary", value: summary });
    if (priorComments.length > 0) {
        const lines = priorComments.map((c) => {
            const body = c.body ? String(c.body) : "";
            const author = c.author ? String(c.author) : "";
            const snippet = body.slice(0, 240);
            return author ? `**${author}:** ${snippet}` : snippet;
        });
        const value = lines.join("\n\n").slice(0, 1024);
        if (value)
            fields.push({ name: "Prior activity", value });
    }
    if (parentIdentifier) {
        const parentLine = parentTitle
            ? `**${parentIdentifier}** — ${parentTitle}`
            : `**${parentIdentifier}**`;
        fields.push({ name: "Parent", value: parentLine, inline: true });
    }
    const base = resolveBaseUrl(baseUrl);
    const buttons = [];
    if (base) {
        buttons.push({ type: 2, style: 5, label: "View Issue", url: `${base}/issues/${event.entityId}` });
    }
    if (p.prUrl) {
        buttons.push({ type: 2, style: 5, label: "View Diff", url: String(p.prUrl) });
    }
    buttons.push({
        type: 2,
        style: 4,
        label: "Reopen",
        custom_id: `issue_reopen_${event.entityId}`,
    });
    return {
        embeds: [
            {
                title: `✅ Issue Completed: ${identifier}`,
                description: `**${title}** is now done.`,
                color: COLORS.GREEN,
                fields,
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
            },
        ],
        components: [{ type: 1, components: buttons }],
    };
}
function humanizeActorLabel(value) {
    if (!value)
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith("discord:"))
        return trimmed.slice("discord:".length);
    return trimmed;
}
export function formatApprovalCreated(event, baseUrl) {
    const p = event.payload;
    const approvalType = String(p.type ?? "unknown");
    const approvalId = String(p.approvalId ?? event.entityId);
    const title = String(p.title ?? "");
    const description = String(p.description ?? "");
    const agentName = String(p.agentName ?? "");
    const issueIds = Array.isArray(p.issueIds) ? p.issueIds : [];
    const dashboardBase = resolveBaseUrl(baseUrl);
    const fields = [];
    if (agentName)
        fields.push({ name: "Agent", value: agentName, inline: true });
    fields.push({ name: "Type", value: `\`${approvalType}\``, inline: true });
    if (issueIds.length > 0) {
        fields.push({ name: "Linked Issues", value: issueIds.join(", ") });
    }
    const linkedIssues = Array.isArray(p.linkedIssues) ? p.linkedIssues : [];
    if (linkedIssues.length > 0) {
        const issueLines = linkedIssues.map((issue) => {
            const parts = [`**${issue.identifier ?? "?"}** ${issue.title ?? ""}`];
            const meta = [];
            if (issue.status)
                meta.push(String(issue.status));
            if (issue.priority)
                meta.push(String(issue.priority));
            if (issue.assignee)
                meta.push(`→ ${issue.assignee}`);
            if (meta.length > 0)
                parts.push(`(${meta.join(" | ")})`);
            if (issue.description)
                parts.push(`\n> ${String(issue.description).slice(0, 100)}`);
            return parts.join(" ");
        });
        fields.push({ name: `Linked Issues (${linkedIssues.length})`, value: issueLines.join("\n\n").slice(0, 1024) });
    }
    const knownKeys = new Set(["type", "approvalId", "title", "description", "agentName", "issueIds", "agentId", "runId", "linkedIssues"]);
    for (const [key, value] of Object.entries(p)) {
        if (knownKeys.has(key) || value == null || value === "")
            continue;
        const display = typeof value === "object" ? JSON.stringify(value) : String(value);
        if (display.length > 0 && display.length <= 1024) {
            fields.push({ name: key, value: display, inline: display.length < 40 });
        }
    }
    return {
        embeds: [
            {
                title: title ? `Approval: ${title}` : "Approval Requested",
                description: description || undefined,
                color: COLORS.YELLOW,
                fields,
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
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
                        custom_id: `approval_approve_${approvalId}`,
                    },
                    {
                        type: 2,
                        style: 4,
                        label: "Reject",
                        custom_id: `approval_reject_${approvalId}`,
                    },
                    ...(dashboardBase
                        ? [{
                                type: 2,
                                style: 5,
                                label: "View",
                                url: `${dashboardBase}/approvals/${approvalId}`,
                            }]
                        : []),
                ],
            },
        ],
    };
}
export function formatAgentError(event) {
    const p = event.payload;
    const agentName = String(p.agentName ?? p.name ?? event.entityId);
    const errorMessage = String(p.error ?? p.message ?? "Unknown error");
    return {
        embeds: [
            {
                title: "Agent Error",
                description: `**${agentName}** encountered an error`,
                color: COLORS.RED,
                fields: [
                    { name: "Error", value: errorMessage.slice(0, 1024) },
                ],
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
            },
        ],
    };
}
// ---------------------------------------------------------------------------
// Session failure classification
// ---------------------------------------------------------------------------
const ERROR_CLASSIFICATIONS = [
    {
        pattern: /token.?limit|context.?length|max.?tokens|context.?window/i,
        label: "Session / Token Limit",
        nextSteps: "The session hit its token limit. Use `/clip retry <task>` to restart with a fresh context, or break the task into smaller subtasks.",
    },
    {
        pattern: /budget.?exhaust|budget.?exceed|insufficient.?budget|over.?budget/i,
        label: "Budget Exhausted",
        nextSteps: "The agent's budget has been fully consumed. Use `/clip budget <agent>` to check the current state and top up if needed.",
    },
    {
        pattern: /timeout|timed?.?out|deadline.?exceed/i,
        label: "Timeout",
        nextSteps: "The session timed out before completing. Use `/clip retry <task>` to restart, or increase the timeout if applicable.",
    },
];
function classifyError(errorMessage) {
    for (const cls of ERROR_CLASSIFICATIONS) {
        if (cls.pattern.test(errorMessage)) {
            return { label: cls.label, nextSteps: cls.nextSteps };
        }
    }
    return {
        label: "Unknown Error",
        nextSteps: "Check the agent logs for details. Use `/clip status <agent>` to see the current agent state.",
    };
}
export function formatSessionFailure(event) {
    const p = event.payload;
    const agentName = String(p.agentName ?? p.name ?? event.entityId);
    const errorMessage = String(p.error ?? p.message ?? "Unknown error");
    const taskIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
    const taskTitle = p.issueTitle ? String(p.issueTitle) : null;
    const lastActiveAt = p.lastActiveAt ? String(p.lastActiveAt) : null;
    const classification = classifyError(errorMessage);
    const fields = [];
    if (taskIdentifier) {
        const taskLine = taskTitle
            ? `**${taskIdentifier}** — ${taskTitle}`
            : `**${taskIdentifier}**`;
        fields.push({ name: "Task", value: taskLine, inline: true });
    }
    fields.push({ name: "Error Type", value: `\`${classification.label}\``, inline: true });
    if (lastActiveAt) {
        const ts = Math.floor(new Date(lastActiveAt).getTime() / 1000);
        fields.push({ name: "Last Active", value: `<t:${ts}:R>`, inline: true });
    }
    fields.push({ name: "Error", value: errorMessage.slice(0, 1024) });
    fields.push({ name: "Next Steps", value: classification.nextSteps });
    return {
        embeds: [
            {
                title: `Session Failed: ${agentName}`,
                description: `**${agentName}** session ended with an error`,
                color: COLORS.RED,
                fields,
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
            },
        ],
    };
}
export function formatBudgetWarning(data) {
    return {
        embeds: [
            {
                title: `Budget Warning: ${data.agentName}`,
                description: `**${data.agentName}** has used **${data.pct}%** of its budget`,
                color: COLORS.YELLOW,
                fields: [
                    { name: "Spent", value: `$${data.spent.toFixed(2)}`, inline: true },
                    { name: "Limit", value: `$${data.limit.toFixed(2)}`, inline: true },
                    { name: "Remaining", value: `$${data.remaining.toFixed(2)}`, inline: true },
                    {
                        name: "Next Steps",
                        value: `Use \`/clip budget ${data.agentName}\` to check live budget status.`,
                    },
                ],
                footer: { text: "Paperclip" },
                timestamp: new Date().toISOString(),
            },
        ],
    };
}
export function formatAgentRunStarted(event) {
    const p = event.payload;
    const agentName = String(p.agentName ?? event.entityId);
    const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
    const issueTitle = p.issueTitle ? String(p.issueTitle) : null;
    const taskLine = issueIdentifier
        ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
        : "";
    return {
        embeds: [
            {
                title: `Run Started: ${agentName}`,
                description: `**${agentName}** has started a new run.${taskLine}`,
                color: COLORS.BLUE,
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
            },
        ],
    };
}
export function formatAgentRunFinished(event) {
    const p = event.payload;
    const agentName = String(p.agentName ?? event.entityId);
    const issueIdentifier = p.issueIdentifier ? String(p.issueIdentifier) : null;
    const issueTitle = p.issueTitle ? String(p.issueTitle) : null;
    const taskLine = issueIdentifier
        ? `\nTask: **${issueIdentifier}**${issueTitle ? ` — ${issueTitle}` : ""}`
        : "";
    return {
        embeds: [
            {
                title: `Run Finished: ${agentName}`,
                description: `**${agentName}** completed successfully.${taskLine}`,
                color: COLORS.GREEN,
                footer: { text: "Paperclip" },
                timestamp: event.occurredAt,
            },
        ],
    };
}
//# sourceMappingURL=formatters.js.map