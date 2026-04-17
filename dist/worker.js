import { definePlugin, runWorker, } from "@paperclipai/plugin-sdk";
import { DEFAULT_CONFIG, COLORS, METRIC_NAMES, PLUGIN_ID, WEBHOOK_KEYS, ACP_PLUGIN_EVENT_PREFIX, BUDGET_ALERT_THRESHOLD } from "./constants.js";
import { paperclipFetch } from "./paperclip-fetch.js";
import { postEmbed, postEmbedWithId, getApplicationId, registerSlashCommands, respondToInteraction, } from "./discord-api.js";
import { formatIssueCreated, formatIssueDone, formatApprovalCreated, formatSessionFailure, formatBudgetWarning, formatAgentRunStarted, formatAgentRunFinished, humanizePriority, } from "./formatters.js";
import { handleInteraction, SLASH_COMMANDS } from "./commands.js";
import { runIntelligenceScan, runBackfill } from "./intelligence.js";
import { connectGateway } from "./gateway.js";
import { handleAcpOutput, initiateHandoff, startDiscussion, } from "./session-registry.js";
import { DiscordAdapter } from "./adapter.js";
import { registerCommand } from "./custom-commands.js";
import { registerWatch, checkWatches } from "./proactive-suggestions.js";
import { resolveAgentName } from "./agent-name-cache.js";
// Module-level state captured during setup() so onWebhook() can reuse it.
let _pluginCtx = null;
let _cmdCtx = null;
import { resolveCompanyId } from "./company-resolver.js";
import { getEscalation, saveEscalation, trackPendingEscalation, untrackPendingEscalation, collectPendingEscalationIds, } from "./escalation-state.js";
/**
 * Heuristic: does this string look like an opaque agent ID (UUID or ULID),
 * as opposed to a human-readable name?
 *
 * Used to decide whether to replace `agentName` with a cache-resolved name.
 * The value may legitimately be a human name like "Trader" — in that case we
 * keep it.
 */
function looksLikeAgentId(value) {
    if (typeof value !== "string")
        return false;
    const trimmed = value.trim();
    // UUID v4-ish: 8-4-4-4-12 hex
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        return true;
    }
    // ULID (26 Crockford base32 chars) or similar opaque 20+ char token with no spaces
    if (/^[0-9A-Z]{20,}$/.test(trimmed))
        return true;
    return false;
}
/**
 * Walks the event payload looking for agent-id fields (`agentId`,
 * `assigneeAgentId`, `fromAgentId`, …) and writes a resolved display name into
 * the payload if one isn't present or looks like an ID.
 *
 * Returns a new event with an enriched payload, leaving the original event
 * untouched. This runs for every notification before the formatter is called,
 * so approval/run/error notifications don't show bare IDs.
 */
async function attachAgentName(ctx, event) {
    const payload = { ...event.payload };
    const companyId = event.companyId;
    if (!companyId)
        return event;
    // If there's already a non-ID agentName, we're done.
    const currentName = payload.agentName;
    if (typeof currentName === "string" && currentName && !looksLikeAgentId(currentName)) {
        return event;
    }
    // Try common id fields in priority order.
    const idCandidates = [
        payload.agentId,
        payload.assigneeAgentId,
        payload.fromAgentId,
        payload.executionAgentId,
        typeof currentName === "string" && looksLikeAgentId(currentName) ? currentName : null,
    ].filter((v) => typeof v === "string" && v.length > 0);
    for (const id of idCandidates) {
        const resolved = await resolveAgentName(ctx, companyId, id);
        if (resolved) {
            payload.agentName = resolved;
            return { ...event, payload };
        }
    }
    return event;
}
async function resolveChannel(ctx, companyId, fallback) {
    const override = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord-channel",
    });
    return override ?? fallback ?? null;
}
async function enrichIssueNotificationPayload(ctx, event) {
    const payload = { ...event.payload };
    if (event.entityType !== "issue" || !event.entityId)
        return payload;
    try {
        const companyId = await resolveIssueCompanyIdForNotification(ctx, event, payload);
        if (!companyId)
            return payload;
        const issue = await ctx.issues.get(event.entityId, companyId);
        if (issue) {
            if (payload.identifier == null)
                payload.identifier = issue.identifier ?? issue.id;
            if (payload.title == null)
                payload.title = issue.title ?? issue.identifier ?? issue.id;
            if (payload.description == null)
                payload.description = issue.description;
            if (payload.status == null)
                payload.status = issue.status;
            if (payload.priority == null)
                payload.priority = issue.priority;
            if (payload.assigneeAgentId == null)
                payload.assigneeAgentId = issue.assigneeAgentId;
            if (payload.assigneeUserId == null)
                payload.assigneeUserId = issue.assigneeUserId;
            if (payload.agentName == null)
                payload.agentName = issue.executionAgentNameKey;
            if (payload.completedAt == null && issue.completedAt)
                payload.completedAt = String(issue.completedAt);
            if (payload.updatedAt == null && issue.updatedAt)
                payload.updatedAt = String(issue.updatedAt);
            if (payload.projectName == null && issue.project?.name)
                payload.projectName = issue.project.name;
        }
        // If agentName is still an ID or missing, resolve via the agent name cache.
        // This covers cases where `executionAgentNameKey` holds a UUID instead of a
        // display name, which shows up as ugly IDs in Discord notifications.
        if (payload.assigneeAgentId && (!payload.agentName || looksLikeAgentId(payload.agentName))) {
            const resolved = await resolveAgentName(ctx, companyId, String(payload.assigneeAgentId));
            if (resolved)
                payload.agentName = resolved;
        }
        if (String(payload.status ?? "") === "done") {
            const comments = await ctx.issues.listComments(event.entityId, companyId);
            if (comments.length > 0) {
                const sorted = [...comments].sort((a, b) => {
                    const aTs = new Date(String(a.updatedAt ?? a.createdAt ?? 0)).getTime();
                    const bTs = new Date(String(b.updatedAt ?? b.createdAt ?? 0)).getTime();
                    return bTs - aTs;
                });
                const lastComment = sorted[0];
                if (payload.lastComment == null)
                    payload.lastComment = lastComment.body;
                if (payload.completedBy == null) {
                    if (lastComment.authorUserId) {
                        payload.completedBy = lastComment.authorUserId.startsWith("discord:")
                            ? lastComment.authorUserId
                            : "Board user";
                    }
                    else if (lastComment.authorAgentId) {
                        const resolvedAgentName = await resolveAgentName(ctx, companyId, lastComment.authorAgentId);
                        payload.completedBy = resolvedAgentName ?? payload.agentName ?? "Agent";
                    }
                }
                // Add up to 2 prior comments (before the last one) as context. The
                // formatter will render them in a "Prior activity" embed field.
                if (payload.priorComments == null && sorted.length > 1) {
                    const prior = [];
                    for (const c of sorted.slice(1, 3)) {
                        let author = "Unknown";
                        if (c.authorUserId) {
                            author = c.authorUserId.startsWith("discord:")
                                ? c.authorUserId.slice("discord:".length)
                                : "Board user";
                        }
                        else if (c.authorAgentId) {
                            const resolved = await resolveAgentName(ctx, companyId, c.authorAgentId);
                            author = resolved ?? "Agent";
                        }
                        prior.push({ author, body: c.body });
                    }
                    payload.priorComments = prior;
                }
            }
            if (payload.completedBy == null) {
                if (typeof payload.assigneeUserId === "string") {
                    payload.completedBy = payload.assigneeUserId.startsWith("discord:")
                        ? payload.assigneeUserId
                        : "Board user";
                }
                else if (payload.agentName) {
                    payload.completedBy = payload.agentName;
                }
                else if (payload.assigneeAgentId) {
                    const resolved = await resolveAgentName(ctx, companyId, String(payload.assigneeAgentId));
                    payload.completedBy = resolved ?? payload.assigneeAgentId;
                }
            }
        }
    }
    catch (error) {
        ctx.logger.debug("Issue notification enrichment failed", {
            issueId: event.entityId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    return payload;
}
async function resolveIssueCompanyIdForNotification(ctx, event, payload) {
    const candidates = [
        typeof event.companyId === "string" ? event.companyId : null,
        typeof payload.companyId === "string" ? payload.companyId : null,
    ].filter((value) => Boolean(value));
    for (const companyId of candidates) {
        const issue = await ctx.issues.get(event.entityId, companyId);
        if (issue)
            return companyId;
    }
    const companies = await ctx.companies.list();
    for (const company of companies) {
        const issue = await ctx.issues.get(event.entityId, company.id);
        if (issue)
            return company.id;
    }
    return candidates[0] ?? null;
}
const plugin = definePlugin({
    async setup(ctx) {
        const rawConfig = await ctx.config.get();
        ctx.logger.info(`Discord plugin config: ${JSON.stringify(rawConfig)}`);
        const config = {
            ...DEFAULT_CONFIG,
            ...rawConfig,
        };
        if (!config.discordBotTokenRef) {
            ctx.logger.warn("No discordBotTokenRef configured, plugin disabled");
            return;
        }
        const token = await ctx.secrets.resolve(config.discordBotTokenRef);
        const baseUrl = config.paperclipBaseUrl || "http://localhost:3100";
        const retentionDays = config.intelligenceRetentionDays || 30;
        // Company ID is resolved lazily on first /clip command or job invocation,
        // NOT during setup — startup-time API calls can cause worker activation to fail.
        const companyId = "default"; // placeholder; jobs use resolveCompanyId(ctx) at runtime
        const cmdCtx = {
            baseUrl,
            companyId,
            token,
            defaultChannelId: config.defaultChannelId,
            pluginCtx: ctx,
        };
        // Store context at module level so onWebhook() can reuse it.
        _pluginCtx = ctx;
        _cmdCtx = cmdCtx;
        // --- Register slash commands with Discord ---
        if (config.defaultGuildId) {
            const appId = await getApplicationId(ctx, token);
            if (appId) {
                const registered = await registerSlashCommands(ctx, token, appId, config.defaultGuildId, SLASH_COMMANDS);
                if (registered) {
                    ctx.logger.info("Slash commands registered with Discord");
                }
            }
        }
        // --- Reply routing handler for inbound messages ---
        async function handleMessageCreate(message) {
            if (config.enableInbound === false)
                return;
            // Ignore bot messages
            if (message.author.bot)
                return;
            // Only handle replies to other messages
            if (!message.message_reference?.message_id)
                return;
            const refChannelId = message.message_reference.channel_id ?? message.channel_id;
            const refMessageId = message.message_reference.message_id;
            const mapping = await ctx.state.get({
                scopeKind: "instance",
                stateKey: `msg_${refChannelId}_${refMessageId}`,
            });
            if (!mapping)
                return;
            const text = message.content;
            if (!text?.trim())
                return;
            if (mapping.entityType === "escalation") {
                // Route to escalation response
                const escalationCompanyId = mapping.companyId || "default";
                let record = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: escalationCompanyId,
                    stateKey: `escalation_${mapping.entityId}`,
                });
                // Backward-compat fallback: check "default" scope if company-scoped read returns null
                if (!record && escalationCompanyId !== "default") {
                    record = await ctx.state.get({
                        scopeKind: "company",
                        scopeId: "default",
                        stateKey: `escalation_${mapping.entityId}`,
                    });
                }
                if (record && record.status === "pending") {
                    record.status = "resolved";
                    record.resolvedAt = new Date().toISOString();
                    record.resolvedBy = `discord:${message.author.username}`;
                    record.resolution = "human_reply";
                    await ctx.state.set({ scopeKind: "company", scopeId: escalationCompanyId, stateKey: `escalation_${mapping.entityId}` }, record);
                    await ctx.metrics.write(METRIC_NAMES.escalationsResolved, 1);
                    ctx.events.emit("escalation-resolved", mapping.companyId, {
                        escalationId: mapping.entityId,
                        action: "human_reply",
                        resolvedBy: message.author.username,
                        responseText: text,
                    });
                }
                await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
                ctx.logger.info("Routed Discord reply to escalation", {
                    escalationId: mapping.entityId,
                    from: message.author.username,
                });
            }
            else if (mapping.entityType === "issue") {
                // Route to issue comment
                try {
                    await paperclipFetch(`${baseUrl}/api/issues/${mapping.entityId}/comments`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            body: text,
                            authorUserId: `discord:${message.author.username}`,
                        }),
                    });
                    await ctx.metrics.write(METRIC_NAMES.inboundRouted, 1);
                    ctx.logger.info("Routed Discord reply to issue comment", {
                        issueId: mapping.entityId,
                        from: message.author.username,
                    });
                }
                catch (err) {
                    ctx.logger.error("Failed to route inbound message", { error: String(err) });
                }
            }
        }
        const gatewayNeedsMessages = config.enableInbound !== false ||
            config.enableMediaPipeline === true ||
            config.enableCustomCommands === true ||
            config.enableProactiveSuggestions === true ||
            config.enableIntelligence === true;
        // --- Gateway connection for real-time interaction handling ---
        const gateway = await connectGateway(ctx, token, async (interaction) => {
            return handleInteraction(ctx, interaction, cmdCtx);
        }, gatewayNeedsMessages ? handleMessageCreate : undefined, {
            listenForMessages: gatewayNeedsMessages,
            includeMessageContent: gatewayNeedsMessages,
        });
        ctx.events.on("plugin.stopping", async () => {
            gateway.close();
        });
        // --- ACP bridge: listen for cross-plugin ACP output events ---
        ctx.events.on(`${ACP_PLUGIN_EVENT_PREFIX}.output`, async (event) => {
            const payload = event.payload;
            await handleAcpOutput(ctx, token, payload);
        });
        // --- Event deduplication ---
        // The runtime may redeliver events (retries, replays). Track recently
        // processed eventIds so each event produces at most one Discord message.
        const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes
        const seenEvents = new Map(); // eventId → timestamp
        function isDuplicate(eventId) {
            if (!eventId)
                return false;
            const now = Date.now();
            // Prune stale entries on each check (cheap for small maps)
            for (const [id, ts] of seenEvents) {
                if (now - ts > DEDUP_TTL_MS)
                    seenEvents.delete(id);
            }
            if (seenEvents.has(eventId))
                return true;
            seenEvents.set(eventId, now);
            return false;
        }
        // --- Event subscriptions ---
        const resolveTopicChannel = async (event) => {
            if (!config.topicRouting)
                return null;
            const payload = event.payload;
            const projectName = payload.projectName ? String(payload.projectName) : null;
            if (!projectName)
                return null;
            const channelMap = (await ctx.state.get({
                scopeKind: "instance",
                stateKey: "channel-project-map",
            }));
            return channelMap?.[projectName] ?? null;
        };
        const notify = async (event, formatter, overrideChannelId) => {
            if (isDuplicate(event.eventId)) {
                ctx.logger.debug(`Skipping duplicate event ${event.eventType} (${event.eventId})`);
                return;
            }
            const topicChannel = overrideChannelId ? null : await resolveTopicChannel(event);
            const channelId = await resolveChannel(ctx, event.companyId, topicChannel || overrideChannelId || config.defaultChannelId);
            if (!channelId)
                return;
            const enrichedEvent = await attachAgentName(ctx, event);
            const message = formatter(enrichedEvent, baseUrl);
            const messageId = await postEmbedWithId(ctx, token, channelId, message);
            if (messageId) {
                // Store message mapping for reply routing
                if (config.enableInbound !== false) {
                    await ctx.state.set({ scopeKind: "instance", stateKey: `msg_${channelId}_${messageId}` }, {
                        entityId: event.entityId,
                        entityType: event.entityType,
                        companyId: event.companyId,
                        eventType: event.eventType,
                    });
                }
                await ctx.activity.log({
                    companyId: event.companyId,
                    message: `Forwarded ${event.eventType} to Discord`,
                    entityType: "plugin",
                    entityId: event.entityId,
                });
            }
        };
        if (config.notifyOnIssueCreated) {
            ctx.events.on("issue.created", (event) => notify(event, formatIssueCreated));
        }
        if (config.notifyOnIssueDone) {
            ctx.events.on("issue.updated", async (event) => {
                const payload = await enrichIssueNotificationPayload(ctx, event);
                if (payload.status !== "done")
                    return;
                const completionMarker = String(payload.completedAt ?? "");
                if (completionMarker) {
                    const stateKey = `issue_done_notified_${event.entityId}`;
                    const previousMarker = await ctx.state.get({
                        scopeKind: "instance",
                        stateKey,
                    });
                    if (previousMarker === completionMarker) {
                        ctx.logger.debug(`Skipping duplicate completion notification for ${event.entityId}`);
                        return;
                    }
                    await ctx.state.set({ scopeKind: "instance", stateKey }, completionMarker);
                }
                await notify({ ...event, payload }, formatIssueDone);
            });
        }
        if (config.notifyOnApprovalCreated) {
            ctx.events.on("approval.created", (event) => notify(event, formatApprovalCreated, config.approvalsChannelId));
        }
        if (config.notifyOnAgentError) {
            ctx.events.on("agent.run.failed", (event) => notify(event, formatSessionFailure, config.errorsChannelId));
        }
        ctx.events.on("agent.run.started", (event) => notify(event, formatAgentRunStarted, config.bdPipelineChannelId));
        ctx.events.on("agent.run.finished", (event) => notify(event, formatAgentRunFinished, config.bdPipelineChannelId));
        // ===================================================================
        // Phase 1: Escalation - human-in-the-loop support
        // ===================================================================
        const adapter = new DiscordAdapter(ctx, token);
        const escalationChannelId = config.escalationChannelId || config.defaultChannelId;
        const escalationTimeoutMs = (config.escalationTimeoutMinutes || 30) * 60 * 1000;
        // Escalation state helpers are imported from ./escalation-state.js
        // Local wrappers that close over ctx for call-site convenience:
        const _getEscalation = (id, cid) => getEscalation(ctx, id, cid);
        const _saveEscalation = (r) => saveEscalation(ctx, r);
        const _trackPending = (id, cid) => trackPendingEscalation(ctx, id, cid);
        const _untrackPending = (id, cid) => untrackPendingEscalation(ctx, id, cid);
        function buildEscalationEmbed(payload) {
            const fields = [];
            fields.push({ name: "Reason", value: payload.reason.slice(0, 1024) });
            if (payload.confidenceScore !== undefined) {
                fields.push({
                    name: "Confidence Score",
                    value: `${(payload.confidenceScore * 100).toFixed(0)}%`,
                    inline: true,
                });
            }
            if (payload.agentReasoning) {
                fields.push({ name: "Agent Reasoning", value: payload.agentReasoning.slice(0, 1024) });
            }
            if (payload.suggestedReply) {
                fields.push({ name: "Suggested Reply", value: payload.suggestedReply.slice(0, 1024) });
            }
            let description;
            if (payload.conversationHistory && payload.conversationHistory.length > 0) {
                const recent = payload.conversationHistory.slice(-5);
                const lines = recent.map((msg) => {
                    const role = msg.role === "user" ? "Customer" : msg.role === "assistant" ? "Agent" : msg.role;
                    return `**${role}:** ${msg.content.slice(0, 200)}`;
                });
                description = lines.join("\n\n").slice(0, 2048);
            }
            const embeds = [
                {
                    title: `Escalation from ${payload.agentName}`,
                    description,
                    color: COLORS.YELLOW,
                    fields,
                    footer: { text: "Paperclip Escalation" },
                    timestamp: new Date().toISOString(),
                },
            ];
            const buttons = [];
            if (payload.suggestedReply) {
                buttons.push({
                    type: 2,
                    style: 3,
                    label: "Use Suggested Reply",
                    custom_id: `esc_suggest_${payload.escalationId}`,
                });
            }
            buttons.push({ type: 2, style: 1, label: "Reply to Customer", custom_id: `esc_reply_${payload.escalationId}` }, { type: 2, style: 2, label: "Override Agent", custom_id: `esc_override_${payload.escalationId}` }, { type: 2, style: 4, label: "Dismiss", custom_id: `esc_dismiss_${payload.escalationId}` });
            const components = [{ type: 1, components: buttons }];
            return { embeds, components };
        }
        if (config.enableEscalations !== false) {
            ctx.events.on(`plugin.${PLUGIN_ID}.escalation-created`, async (event) => {
                if (isDuplicate(event.eventId)) {
                    ctx.logger.debug(`Skipping duplicate escalation event (${event.eventId})`);
                    return;
                }
                const payload = event.payload;
                const escalationId = payload.escalationId || event.entityId || "";
                payload.escalationId = escalationId;
                const channelId = await resolveChannel(ctx, event.companyId, escalationChannelId);
                if (!channelId)
                    return;
                const { embeds, components } = buildEscalationEmbed(payload);
                const messageId = await adapter.sendButtons(channelId, embeds, components);
                if (messageId) {
                    const record = {
                        escalationId,
                        companyId: event.companyId,
                        agentName: payload.agentName,
                        reason: payload.reason,
                        confidenceScore: payload.confidenceScore,
                        agentReasoning: payload.agentReasoning,
                        conversationHistory: payload.conversationHistory,
                        suggestedReply: payload.suggestedReply,
                        channelId,
                        messageId,
                        status: "pending",
                        createdAt: new Date().toISOString(),
                    };
                    await _saveEscalation(record);
                    await _trackPending(escalationId, event.companyId);
                    await ctx.metrics.write(METRIC_NAMES.escalationsCreated, 1);
                    await ctx.activity.log({
                        companyId: event.companyId,
                        message: `Escalation created by ${payload.agentName}: ${payload.reason.slice(0, 100)}`,
                        entityType: "escalation",
                        entityId: escalationId,
                    });
                    ctx.logger.info("Escalation posted to Discord", { escalationId, channelId, messageId });
                }
            });
        }
        // --- Phase 1: escalate_to_human tool (3-arg register with ToolRunContext) ---
        ctx.tools.register("escalate_to_human", {
            displayName: "Escalate to Human",
            description: "Escalate a conversation to a human operator via Discord with interactive action buttons.",
            parametersSchema: {
                type: "object",
                properties: {
                    companyId: { type: "string", description: "Company ID" },
                    agentName: { type: "string", description: "Agent name" },
                    reason: { type: "string", description: "Why escalating" },
                    confidenceScore: { type: "number", description: "Confidence (0-1)" },
                    agentReasoning: { type: "string", description: "Internal reasoning" },
                    conversationHistory: {
                        type: "array",
                        items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } },
                        description: "Last N messages",
                    },
                    suggestedReply: { type: "string", description: "Suggested reply" },
                },
                required: ["companyId", "agentName", "reason"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const escalationId = `esc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            const escalationCompanyId = String(p.companyId || runCtx.companyId);
            const payload = {
                escalationId,
                companyId: escalationCompanyId,
                agentName: String(p.agentName),
                reason: String(p.reason),
                confidenceScore: p.confidenceScore !== undefined ? Number(p.confidenceScore) : undefined,
                agentReasoning: p.agentReasoning ? String(p.agentReasoning) : undefined,
                conversationHistory: p.conversationHistory,
                suggestedReply: p.suggestedReply ? String(p.suggestedReply) : undefined,
            };
            const channelId = await resolveChannel(ctx, escalationCompanyId, escalationChannelId);
            if (!channelId) {
                return { error: "No escalation channel configured." };
            }
            const { embeds, components } = buildEscalationEmbed(payload);
            const messageId = await adapter.sendButtons(channelId, embeds, components);
            if (messageId) {
                const record = {
                    escalationId,
                    companyId: escalationCompanyId,
                    agentName: payload.agentName,
                    reason: payload.reason,
                    confidenceScore: payload.confidenceScore,
                    agentReasoning: payload.agentReasoning,
                    conversationHistory: payload.conversationHistory,
                    suggestedReply: payload.suggestedReply,
                    channelId,
                    messageId,
                    status: "pending",
                    createdAt: new Date().toISOString(),
                };
                await _saveEscalation(record);
                await _trackPending(escalationId, escalationCompanyId);
                await ctx.metrics.write(METRIC_NAMES.escalationsCreated, 1);
            }
            return {
                content: JSON.stringify({
                    escalationId,
                    status: "pending",
                    message: "Escalation posted to Discord for human review.",
                }),
            };
        });
        // ===================================================================
        // Phase 2: Multi-Agent tools (3-arg register with ToolRunContext)
        // ===================================================================
        ctx.tools.register("handoff_to_agent", {
            displayName: "Handoff to Agent",
            description: "Hand off a conversation to another agent. Requires human approval.",
            parametersSchema: {
                type: "object",
                properties: {
                    threadId: { type: "string", description: "Discord thread ID" },
                    fromAgent: { type: "string", description: "Agent initiating the handoff" },
                    toAgent: { type: "string", description: "Target agent name" },
                    reason: { type: "string", description: "Reason for the handoff" },
                    context: { type: "string", description: "Context to pass to target agent" },
                },
                required: ["threadId", "fromAgent", "toAgent", "reason"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const result = await initiateHandoff(ctx, token, String(p.threadId), String(p.fromAgent), String(p.toAgent), runCtx.companyId, String(p.reason), p.context ? String(p.context) : undefined);
            return {
                content: JSON.stringify({
                    handoffId: result.handoffId,
                    status: result.status,
                    message: "Handoff posted to Discord for human approval.",
                }),
            };
        });
        ctx.tools.register("discuss_with_agent", {
            displayName: "Discuss with Agent",
            description: "Start a multi-turn discussion between two agents with human checkpoints.",
            parametersSchema: {
                type: "object",
                properties: {
                    threadId: { type: "string", description: "Discord thread ID" },
                    initiator: { type: "string", description: "Agent starting the discussion" },
                    target: { type: "string", description: "Agent to discuss with" },
                    topic: { type: "string", description: "Topic or question" },
                    maxTurns: { type: "number", description: "Max turns (default 10, max 50)" },
                    humanCheckpointInterval: { type: "number", description: "Pause every N turns (0 = none)" },
                },
                required: ["threadId", "initiator", "target", "topic"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const result = await startDiscussion(ctx, token, String(p.threadId), String(p.initiator), String(p.target), runCtx.companyId, String(p.topic), p.maxTurns ? Number(p.maxTurns) : 10, p.humanCheckpointInterval ? Number(p.humanCheckpointInterval) : 0);
            return {
                content: JSON.stringify({
                    discussionId: result.discussionId,
                    status: result.status,
                    message: "Discussion loop started.",
                }),
            };
        });
        // ===================================================================
        // Phase 1: Escalation timeout check job
        // ===================================================================
        ctx.jobs.register("check-escalation-timeouts", async () => {
            const jobCompanyId = await resolveCompanyId(ctx);
            const pendingIds = await collectPendingEscalationIds(ctx, jobCompanyId);
            if (pendingIds.length === 0)
                return;
            const now = Date.now();
            for (const escalationId of pendingIds) {
                const record = await _getEscalation(escalationId, jobCompanyId);
                if (!record || record.status !== "pending") {
                    await _untrackPending(escalationId, record?.companyId || jobCompanyId);
                    continue;
                }
                const elapsed = now - new Date(record.createdAt).getTime();
                if (elapsed < escalationTimeoutMs)
                    continue;
                record.status = "timed_out";
                record.resolvedAt = new Date().toISOString();
                await _saveEscalation(record);
                await _untrackPending(escalationId, record.companyId || jobCompanyId);
                await ctx.metrics.write(METRIC_NAMES.escalationsTimedOut, 1);
                await adapter.editMessage(record.channelId, record.messageId, {
                    embeds: [
                        {
                            title: `Escalation from ${record.agentName} - TIMED OUT`,
                            description: `This escalation was not resolved within ${config.escalationTimeoutMinutes || 30} minutes.`,
                            color: COLORS.RED,
                            fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
                            footer: { text: "Paperclip Escalation" },
                            timestamp: record.resolvedAt,
                        },
                    ],
                    components: [],
                });
                ctx.events.emit("escalation-timed-out", record.companyId, {
                    escalationId,
                    companyId: record.companyId,
                    agentName: record.agentName,
                    reason: record.reason,
                });
                ctx.logger.info("Escalation timed out", { escalationId });
            }
        });
        // ===================================================================
        // Budget threshold check job
        // ===================================================================
        ctx.jobs.register("check-budget-thresholds", async () => {
            const jobCompanyId = await resolveCompanyId(ctx);
            const agents = await ctx.agents.list({ companyId: jobCompanyId });
            for (const agent of agents) {
                const a = agent;
                if (a.status && a.status !== "active")
                    continue;
                const budgetState = await ctx.state.get({
                    scopeKind: "agent",
                    scopeId: a.id,
                    stateKey: "budget",
                });
                if (!budgetState?.limit || budgetState.limit <= 0)
                    continue;
                const spent = budgetState.spent ?? 0;
                const limit = budgetState.limit;
                const pct = spent / limit;
                if (pct < BUDGET_ALERT_THRESHOLD)
                    continue;
                // Dedup: check if we already alerted for this billing cycle
                const alertState = await ctx.state.get({
                    scopeKind: "agent",
                    scopeId: a.id,
                    stateKey: "budget-alert-last-sent",
                });
                // Only alert once per agent per billing cycle (identified by limit value)
                if (alertState?.limit === limit)
                    continue;
                const remaining = limit - spent;
                const pctRounded = Math.round(pct * 100);
                const channelId = await resolveChannel(ctx, jobCompanyId, config.errorsChannelId || config.defaultChannelId);
                if (!channelId)
                    continue;
                const message = formatBudgetWarning({
                    agentName: a.name,
                    agentId: a.id,
                    spent,
                    limit,
                    remaining,
                    pct: pctRounded,
                });
                await postEmbed(ctx, token, channelId, message);
                // Record that we sent the alert for this billing cycle
                await ctx.state.set({ scopeKind: "agent", scopeId: a.id, stateKey: "budget-alert-last-sent" }, { limit, sentAt: new Date().toISOString() });
                await ctx.metrics.write(METRIC_NAMES.budgetWarningsSent, 1);
                ctx.logger.info("Budget threshold alert sent", { agentId: a.id, agentName: a.name, pct: pctRounded });
            }
        });
        // ===================================================================
        // Phase 4: Custom Commands tool (3-arg register)
        // ===================================================================
        if (config.enableCustomCommands !== false) {
            ctx.tools.register("register_custom_command", {
                displayName: "Register Custom Command",
                description: "Register a custom !command for Discord users to invoke.",
                parametersSchema: {
                    type: "object",
                    properties: {
                        companyId: { type: "string", description: "Company ID" },
                        command: { type: "string", description: "Command name (without !)" },
                        description: { type: "string", description: "Description" },
                        parameters: {
                            type: "array",
                            items: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, required: { type: "boolean" } } },
                            description: "Parameters",
                        },
                    },
                    required: ["companyId", "command", "description"],
                },
            }, async (params, runCtx) => {
                const p = params;
                const result = await registerCommand(ctx, String(p.companyId || runCtx.companyId), String(p.command), String(p.description), p.parameters ?? [], runCtx.agentId, String(p.agentName ?? runCtx.agentId));
                return { content: JSON.stringify(result) };
            });
        }
        // ===================================================================
        // Phase 5: Proactive Suggestions tool (3-arg register)
        // ===================================================================
        if (config.enableProactiveSuggestions !== false) {
            ctx.tools.register("register_watch", {
                displayName: "Register Watch",
                description: "Register a watch condition that fires proactive suggestions.",
                parametersSchema: {
                    type: "object",
                    properties: {
                        companyId: { type: "string", description: "Company ID" },
                        watchName: { type: "string", description: "Watch name" },
                        patterns: { type: "array", items: { type: "string" }, description: "Regex patterns" },
                        channelIds: { type: "array", items: { type: "string" }, description: "Channel IDs (empty = all)" },
                        responseTemplate: { type: "string", description: "Suggestion template" },
                        cooldownMinutes: { type: "number", description: "Cooldown minutes (default 60)" },
                    },
                    required: ["companyId", "watchName", "patterns", "responseTemplate"],
                },
            }, async (params, runCtx) => {
                const p = params;
                const result = await registerWatch(ctx, String(p.companyId || runCtx.companyId), String(p.watchName), p.patterns ?? [], p.channelIds ?? [], String(p.responseTemplate), p.cooldownMinutes ? Number(p.cooldownMinutes) : 60, runCtx.agentId, String(p.agentName ?? runCtx.agentId));
                return { content: JSON.stringify(result) };
            });
        }
        ctx.jobs.register("check-watches", async () => {
            if (config.enableProactiveSuggestions === false) {
                ctx.logger.debug("check-watches: proactive suggestions disabled, skipping");
                return;
            }
            const cid = await resolveCompanyId(ctx);
            await checkWatches(ctx, token, cid, config.defaultChannelId);
        });
        // ===================================================================
        // Ad-hoc agent → Discord message tool
        // ===================================================================
        const POST_MESSAGE_KIND_STYLES = {
            note: { color: COLORS.BLUE, title: "Agent note" },
            status: { color: COLORS.GREEN, title: "Status update" },
            question: { color: COLORS.YELLOW, title: "Question" },
            alert: { color: COLORS.RED, title: "Alert" },
        };
        ctx.tools.register("discord_post_message", {
            displayName: "Post Discord Message",
            description: "Post an ad-hoc status update, note, question, or alert to a Discord channel. Use this to share progress, flag concerns, or leave a note for humans to read without interrupting them.",
            parametersSchema: {
                type: "object",
                properties: {
                    content: {
                        type: "string",
                        description: "The message body. Supports Discord markdown. Keep it under 1500 characters; longer messages will be truncated.",
                    },
                    kind: {
                        type: "string",
                        enum: ["note", "status", "question", "alert"],
                        description: "Semantic category that drives embed color and title. Defaults to 'note' (blue).",
                    },
                    channelId: {
                        type: "string",
                        description: "Optional Discord channel ID to post to. Defaults to the configured agentNotesChannelId, then defaultChannelId.",
                    },
                    title: {
                        type: "string",
                        description: "Optional short title for the embed. Overrides the default kind-derived title.",
                    },
                },
                required: ["content"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const content = typeof p.content === "string" ? p.content : "";
            if (!content.trim()) {
                return { error: "content is required and cannot be empty." };
            }
            const kindRaw = typeof p.kind === "string" ? p.kind : "note";
            const kind = (kindRaw in POST_MESSAGE_KIND_STYLES ? kindRaw : "note");
            const style = POST_MESSAGE_KIND_STYLES[kind];
            const requestedChannelId = typeof p.channelId === "string" && p.channelId.trim()
                ? p.channelId.trim()
                : null;
            const fallbackChannelId = config.agentNotesChannelId || config.defaultChannelId;
            const resolvedChannelId = await resolveChannel(ctx, runCtx.companyId, requestedChannelId || fallbackChannelId);
            if (!resolvedChannelId) {
                return { error: "No Discord channel configured for discord_post_message." };
            }
            // Resolve the calling agent's display name for the footer.
            let agentLabel = null;
            if (runCtx.agentId) {
                agentLabel = await resolveAgentName(ctx, runCtx.companyId, runCtx.agentId);
            }
            const footerText = agentLabel
                ? `Posted by ${agentLabel}`
                : runCtx.agentId
                    ? `Posted by agent ${runCtx.agentId}`
                    : "Paperclip agent";
            const title = typeof p.title === "string" && p.title.trim()
                ? p.title.trim()
                : style.title;
            const message = {
                embeds: [
                    {
                        title,
                        description: content.slice(0, 4000),
                        color: style.color,
                        footer: { text: footerText },
                        timestamp: new Date().toISOString(),
                    },
                ],
            };
            const posted = await postEmbed(ctx, token, resolvedChannelId, message);
            if (!posted) {
                return { error: "Failed to post message to Discord." };
            }
            await ctx.metrics.write(METRIC_NAMES.agentMessagesSent, 1);
            ctx.logger.info("discord_post_message: posted", {
                agentId: runCtx.agentId,
                agentName: agentLabel,
                kind,
                channelId: resolvedChannelId,
            });
            return {
                content: JSON.stringify({
                    status: "posted",
                    channelId: resolvedChannelId,
                    kind,
                }),
            };
        });
        // ===================================================================
        // Daily Digest Job
        // ===================================================================
        const effectiveDigestMode = config.digestMode ?? "off";
        ctx.jobs.register("discord-daily-digest", async () => {
            if (effectiveDigestMode === "off") {
                ctx.logger.debug("discord-daily-digest: digest mode is off, skipping");
                return;
            }
            const nowHour = new Date().getUTCHours();
            const nowMin = new Date().getUTCMinutes();
            if (nowMin >= 5)
                return; // only fire within first 5 min of the hour
            const parseHour = (t) => {
                const [h] = (t || "").split(":");
                return parseInt(h ?? "", 10);
            };
            const firstHour = parseHour(config.dailyDigestTime || "09:00");
            const secondHour = parseHour(config.bidailySecondTime || "17:00");
            const tridailyHours = (config.tridailyTimes || "07:00,13:00,19:00")
                .split(",")
                .map((t) => parseHour(t.trim()));
            let shouldSend = false;
            if (effectiveDigestMode === "daily") {
                shouldSend = nowHour === firstHour;
            }
            else if (effectiveDigestMode === "bidaily") {
                shouldSend = nowHour === firstHour || nowHour === secondHour;
            }
            else if (effectiveDigestMode === "tridaily") {
                shouldSend = tridailyHours.includes(nowHour);
            }
            if (!shouldSend)
                return;
            const companies = await ctx.companies.list();
            for (const company of companies) {
                const channelId = await resolveChannel(ctx, company.id, config.defaultChannelId);
                if (!channelId)
                    continue;
                try {
                    const agents = await ctx.agents.list({ companyId: company.id });
                    const activeAgents = agents.filter((a) => a.status === "active");
                    const issues = await ctx.issues.list({ companyId: company.id, limit: 50 });
                    const now = Date.now();
                    const oneDayMs = 24 * 60 * 60 * 1000;
                    const completedToday = issues.filter((i) => i.status === "done" && i.completedAt && (now - new Date(i.completedAt).getTime()) < oneDayMs);
                    const createdToday = issues.filter((i) => (now - new Date(i.createdAt).getTime()) < oneDayMs);
                    const inProgress = issues.filter((i) => i.status === "in_progress");
                    const inReview = issues.filter((i) => i.status === "in_review");
                    const blocked = issues.filter((i) => i.status === "blocked");
                    const dateStr = new Date().toISOString().split("T")[0];
                    const digestLabel = effectiveDigestMode === "bidaily" ? "Digest" : "Daily Digest";
                    const companyLabel = company.name ? ` — ${company.name}` : "";
                    const fields = [];
                    // Blocked items first (attention-first ordering)
                    if (blocked.length > 0) {
                        const blockedLines = blocked.slice(0, 10).map((i) => {
                            const reason = i.blockerReason ? ` → ${i.blockerReason}` : "";
                            return `• **${i.identifier ?? i.id}** — ${i.title}${reason}`;
                        }).join("\n");
                        fields.push({ name: `🚫 Blocked (${blocked.length})`, value: blockedLines.slice(0, 1024) });
                    }
                    // In Progress with assignee and priority
                    if (inProgress.length > 0) {
                        const ipLines = inProgress.slice(0, 10).map((i) => {
                            const meta = [];
                            if (i.assigneeName)
                                meta.push(String(i.assigneeName));
                            if (i.priority)
                                meta.push(humanizePriority(String(i.priority)));
                            const suffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
                            return `• **${i.identifier ?? i.id}** — ${i.title}${suffix}`;
                        }).join("\n");
                        fields.push({ name: `🔄 In Progress (${inProgress.length})`, value: ipLines.slice(0, 1024) });
                    }
                    if (inReview.length > 0) {
                        const reviewLines = inReview.slice(0, 10).map((i) => `• **${i.identifier ?? i.id}** — ${i.title}`).join("\n");
                        fields.push({ name: `🔍 In Review (${inReview.length})`, value: reviewLines.slice(0, 1024) });
                    }
                    // Completed: collapse after 3
                    if (completedToday.length > 0) {
                        const shownCompleted = completedToday.slice(0, 3).map((i) => `• **${i.identifier ?? i.id}** — ${i.title}`);
                        if (completedToday.length > 3) {
                            shownCompleted.push(`*+ ${completedToday.length - 3} more*`);
                        }
                        fields.push({ name: `✅ Completed Today (${completedToday.length})`, value: shownCompleted.join("\n").slice(0, 1024) });
                    }
                    // Summary stats
                    fields.push({ name: "📋 Created Today", value: String(createdToday.length), inline: true }, { name: "🤖 Active Agents", value: `${activeAgents.length}/${agents.length}`, inline: true });
                    // Trend line in footer
                    const footerText = `Paperclip • ${completedToday.length} completed, ${blocked.length} blocked, ${inProgress.length} in progress`;
                    const digestComponents = [];
                    const digestButtons = [
                        { type: 2, style: 5, label: "View Dashboard", url: baseUrl },
                    ];
                    if (blocked.length > 0) {
                        digestButtons.push({
                            type: 2,
                            style: 1,
                            label: "View Blocked",
                            custom_id: `digest_blocked_${company.id}`,
                        });
                    }
                    digestComponents.push({ type: 1, components: digestButtons });
                    const embeds = [
                        {
                            title: `📊 ${digestLabel}${companyLabel} — ${dateStr}`,
                            color: COLORS.BLUE,
                            fields,
                            footer: { text: footerText },
                            timestamp: new Date().toISOString(),
                        },
                    ];
                    await postEmbed(ctx, token, channelId, { embeds, components: digestComponents });
                    await ctx.metrics.write(METRIC_NAMES.digestSent, 1);
                }
                catch (err) {
                    ctx.logger.error("Daily digest failed for company", { companyId: company.id, error: String(err) });
                    await postEmbed(ctx, token, channelId, {
                        embeds: [{
                                title: "📊 Daily Digest",
                                description: "Could not generate digest. Check plugin logs for details.",
                                color: COLORS.RED,
                                footer: { text: "Paperclip" },
                                timestamp: new Date().toISOString(),
                            }],
                    });
                }
            }
        });
        if (effectiveDigestMode === "off") {
            ctx.logger.debug("Daily digest job registered (inactive)", { mode: effectiveDigestMode });
        }
        else {
            ctx.logger.info("Daily digest job registered", { mode: effectiveDigestMode });
        }
        // --- Per-company channel overrides ---
        ctx.data.register("channel-mapping", async (params) => {
            const cid = String(params.companyId);
            const saved = await ctx.state.get({
                scopeKind: "company",
                scopeId: cid,
                stateKey: "discord-channel",
            });
            return { channelId: saved ?? config.defaultChannelId };
        });
        ctx.actions.register("set-channel", async (params) => {
            const cid = String(params.companyId);
            const channelId = String(params.channelId);
            await ctx.state.set({ scopeKind: "company", scopeId: cid, stateKey: "discord-channel" }, channelId);
            ctx.logger.info("Updated Discord channel mapping", { companyId: cid, channelId });
            return { ok: true };
        });
        // --- Intelligence: agent-queryable tool (3-arg register) ---
        ctx.tools.register("discord_signals", {
            displayName: "Discord Signals",
            description: "Query recent community signals from Discord.",
            parametersSchema: {
                type: "object",
                properties: {
                    companyId: { type: "string", description: "Company ID" },
                    category: {
                        type: "string",
                        enum: ["feature_wish", "pain_point", "maintainer_directive", "sentiment"],
                        description: "Filter by category",
                    },
                },
                required: ["companyId"],
            },
        }, async (params, runCtx) => {
            const p = params;
            const cid = String(p.companyId || runCtx.companyId);
            const raw = await ctx.state.get({
                scopeKind: "company",
                scopeId: cid,
                stateKey: "discord_intelligence",
            });
            if (!raw)
                return { content: JSON.stringify({ signals: [], lastScanned: null }) };
            const data = raw;
            const now = new Date().toISOString();
            const fresh = data.signals.filter((s) => !s.expiresAt || s.expiresAt > now);
            const category = p.category ? String(p.category) : null;
            const filtered = category ? fresh.filter((s) => s.category === category) : fresh;
            return { content: JSON.stringify({ signals: filtered, lastScanned: data.lastScanned }) };
        });
        // --- Intelligence: scheduled scan ---
        ctx.jobs.register("discord-intelligence-scan", async () => {
            if (!config.enableIntelligence || !config.intelligenceChannelIds?.length) {
                ctx.logger.debug("discord-intelligence-scan: intelligence disabled or no channels configured, skipping");
                return;
            }
            const cid = await resolveCompanyId(ctx);
            await runIntelligenceScan(ctx, token, config.defaultGuildId, config.intelligenceChannelIds, cid, retentionDays);
        });
        if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
            ctx.logger.info("Intelligence scan job registered", {
                channels: config.intelligenceChannelIds.length,
            });
        }
        // --- Backfill ---
        if (config.enableIntelligence && config.intelligenceChannelIds.length > 0) {
            // Backfill also deferred to avoid startup-time company resolution.
            // It runs as an async task after setup completes.
            const tryBackfill = async () => {
                const cid = await resolveCompanyId(ctx);
                const existing = await ctx.state.get({
                    scopeKind: "company",
                    scopeId: cid,
                    stateKey: "discord_intelligence",
                });
                if (!existing?.backfillComplete) {
                    ctx.logger.info("First install detected, starting historical backfill...");
                    await runBackfill(ctx, token, config.defaultGuildId, config.intelligenceChannelIds, cid, config.backfillDays ?? 90);
                }
            };
            // Fire-and-forget so it doesn't block setup completion.
            tryBackfill().catch((err) => ctx.logger.warn("Backfill failed", { error: String(err) }));
            ctx.actions.register("trigger-backfill", async () => {
                const cid = await resolveCompanyId(ctx);
                await ctx.state.set({ scopeKind: "company", scopeId: cid, stateKey: "discord_intelligence" }, { signals: [], backfillComplete: false });
                const signals = await runBackfill(ctx, token, config.defaultGuildId, config.intelligenceChannelIds, cid, config.backfillDays ?? 90);
                return { ok: true, signalsFound: signals.length };
            });
        }
        ctx.logger.info("Discord bot plugin started (all 5 phases active)");
    },
    async onWebhook(input) {
        if (input.endpointKey === WEBHOOK_KEYS.discordInteractions) {
            const body = input.parsedBody;
            if (!body)
                return;
            const ctx = _pluginCtx;
            const cmdCtx = _cmdCtx;
            if (!ctx || !cmdCtx) {
                // Return a valid Discord interaction response even before setup completes.
                // The host framework forwards the return value as the HTTP response body.
                return respondToInteraction({
                    type: 4,
                    content: "Plugin is still starting up. Please try again in a moment.",
                    ephemeral: true,
                });
            }
            try {
                const response = await handleInteraction(ctx, body, cmdCtx);
                // The host framework forwards this as the HTTP response body to Discord.
                return response;
            }
            catch (err) {
                ctx.logger.error("Interaction handler failed", { error: String(err) });
                return respondToInteraction({
                    type: 4,
                    content: "An error occurred while processing this command. Please try again.",
                    ephemeral: true,
                });
            }
        }
    },
    async onValidateConfig(config) {
        if (!config.discordBotTokenRef || typeof config.discordBotTokenRef !== "string") {
            return { ok: false, errors: ["discordBotTokenRef is required"] };
        }
        if (!config.defaultChannelId || typeof config.defaultChannelId !== "string") {
            return { ok: false, errors: ["defaultChannelId is required"] };
        }
        return { ok: true };
    },
    async onHealth() {
        return { status: "ok" };
    },
});
runWorker(plugin, import.meta.url);
//# sourceMappingURL=worker.js.map