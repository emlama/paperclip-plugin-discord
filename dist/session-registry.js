import { postEmbed, respondToInteraction } from "./discord-api.js";
import { COLORS, DISCORD_API_BASE, MAX_AGENTS_PER_THREAD, MAX_CONVERSATION_TURNS, DISCUSSION_STALE_MS, METRIC_NAMES, } from "./constants.js";
const outputQueues = new Map();
const outputFlushTimers = new Map();
const OUTPUT_FLUSH_DELAY_MS = 500;
function enqueueOutput(threadId, agentDisplayName, output) {
    if (!outputQueues.has(threadId)) {
        outputQueues.set(threadId, []);
    }
    outputQueues.get(threadId).push({ agentDisplayName, output, timestamp: Date.now() });
}
async function flushOutputQueue(ctx, token, threadId, multiAgent) {
    const queue = outputQueues.get(threadId);
    if (!queue || queue.length === 0)
        return;
    const items = queue.splice(0, queue.length);
    items.sort((a, b) => a.timestamp - b.timestamp);
    for (const item of items) {
        const truncated = item.output.length > 1900
            ? item.output.slice(0, 1900) + "\n... (truncated)"
            : item.output;
        const prefix = multiAgent ? `**[${item.agentDisplayName}]** ` : "";
        await postEmbed(ctx, token, threadId, { content: `${prefix}\`\`\`\n${truncated}\n\`\`\`` });
    }
    if (queue.length === 0)
        outputQueues.delete(threadId);
}
function scheduleFlush(ctx, token, threadId, multiAgent) {
    if (outputFlushTimers.has(threadId))
        return;
    const timer = setTimeout(async () => {
        outputFlushTimers.delete(threadId);
        await flushOutputQueue(ctx, token, threadId, multiAgent);
    }, OUTPUT_FLUSH_DELAY_MS);
    outputFlushTimers.set(threadId, timer);
}
// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
function sessionsKey(threadId) {
    return `sessions_${threadId}`;
}
export async function getThreadSessions(ctx, threadId, companyId) {
    const key = sessionsKey(threadId);
    if (companyId) {
        const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
        if (raw)
            return raw.sessions ?? [];
    }
    // Backward-compat fallback: read from "default" scope
    const fallback = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    if (!fallback)
        return [];
    return fallback.sessions ?? [];
}
async function saveThreadSessions(ctx, threadId, sessions, companyId = "default") {
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: sessionsKey(threadId) }, { sessions });
}
async function getHandoff(ctx, handoffId, companyId) {
    const key = `handoff_${handoffId}`;
    if (companyId) {
        const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
        if (raw)
            return raw;
    }
    const fallback = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    return fallback ?? null;
}
async function saveHandoff(ctx, record) {
    const scopeId = record.companyId || "default";
    await ctx.state.set({ scopeKind: "company", scopeId, stateKey: `handoff_${record.handoffId}` }, record);
}
async function getDiscussion(ctx, id, companyId) {
    const key = `discussion_${id}`;
    if (companyId) {
        const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
        if (raw)
            return raw;
    }
    const fallback = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    return fallback ?? null;
}
async function saveDiscussion(ctx, record) {
    const scopeId = record.companyId || "default";
    await ctx.state.set({ scopeKind: "company", scopeId, stateKey: `discussion_${record.discussionId}` }, record);
}
async function findActiveDiscussion(ctx, threadId, companyId) {
    const key = `active_discussion_${threadId}`;
    if (companyId) {
        const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
        if (raw)
            return raw;
    }
    const fallback = await ctx.state.get({ scopeKind: "company", scopeId: "default", stateKey: key });
    return fallback ?? null;
}
async function clearActiveDiscussion(ctx, threadId, companyId = "default") {
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `active_discussion_${threadId}` }, null);
}
// ---------------------------------------------------------------------------
// Agent resolution helpers
// ---------------------------------------------------------------------------
async function resolveAgentId(ctx, agentName, companyId) {
    try {
        const agents = await ctx.agents.list({ companyId });
        const match = agents.find((a) => a.name === agentName || a.name.toLowerCase() === agentName.toLowerCase());
        return match?.id ?? null;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Spawn: native first, ACP fallback
// ---------------------------------------------------------------------------
export async function spawnAgentInThread(ctx, token, threadId, agentName, companyId, taskPrompt, maxAgents = MAX_AGENTS_PER_THREAD) {
    const sessions = await getThreadSessions(ctx, threadId, companyId);
    const running = sessions.filter((s) => s.status === "running");
    if (running.length >= maxAgents) {
        return {
            ok: false,
            error: `Thread already has ${running.length} active agents (max ${maxAgents}). Close one first.`,
        };
    }
    if (running.find((s) => s.agentName.toLowerCase() === agentName.toLowerCase())) {
        return { ok: false, error: `Agent **${agentName}** is already running in this thread.` };
    }
    const agentId = await resolveAgentId(ctx, agentName, companyId);
    if (!agentId) {
        return { ok: false, error: `Agent **${agentName}** not found.` };
    }
    // Try native session first
    let sessionId;
    let transport = "native";
    try {
        const session = await ctx.agents.sessions.create(agentId, companyId, {
            taskKey: `discord-thread-${threadId}`,
            reason: `Spawned in Discord thread for: ${taskPrompt.slice(0, 200)}`,
        });
        sessionId = session.sessionId;
        // Send the initial prompt
        await ctx.agents.sessions.sendMessage(sessionId, companyId, {
            prompt: taskPrompt,
            reason: "Initial task prompt from Discord",
            onEvent: (event) => {
                if (event.eventType === "chunk" && event.message) {
                    enqueueOutput(threadId, agentName, event.message);
                    const isMulti = sessions.filter((s) => s.status === "running").length > 0;
                    scheduleFlush(ctx, token, threadId, isMulti);
                }
            },
        });
    }
    catch (nativeErr) {
        ctx.logger.warn("Native session create failed, trying ACP fallback", {
            agentName,
            error: nativeErr instanceof Error ? nativeErr.message : String(nativeErr),
        });
        // ACP fallback: emit acp-spawn event
        try {
            transport = "acp";
            sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            ctx.events.emit("acp-spawn", companyId, {
                sessionId,
                agentId,
                agentName,
                threadId,
                prompt: taskPrompt,
            });
        }
        catch (acpErr) {
            ctx.logger.error("ACP fallback also failed", {
                error: acpErr instanceof Error ? acpErr.message : String(acpErr),
            });
            return { ok: false, error: "Failed to create agent session via native or ACP transport." };
        }
    }
    if (!sessionId) {
        return { ok: false, error: "Failed to obtain session ID." };
    }
    const now = new Date().toISOString();
    const entry = {
        sessionId,
        agentId,
        agentName,
        agentDisplayName: agentName,
        companyId,
        transport,
        spawnedAt: now,
        status: "running",
        lastActivityAt: now,
    };
    sessions.push(entry);
    await saveThreadSessions(ctx, threadId, sessions, companyId);
    await ctx.metrics.write(METRIC_NAMES.agentSessionsCreated, 1);
    if (running.length > 0) {
        await postEmbed(ctx, token, threadId, {
            embeds: [
                {
                    title: `Agent Joined: ${agentName}`,
                    description: `**${agentName}** has joined the thread. ${running.length + 1} agents active.`,
                    color: COLORS.BLUE,
                    footer: { text: "Paperclip" },
                    timestamp: now,
                },
            ],
        });
    }
    ctx.logger.info("Agent spawned in thread", { sessionId, agentName, threadId, transport });
    return { ok: true, sessionId, transport };
}
// ---------------------------------------------------------------------------
// Close agent
// ---------------------------------------------------------------------------
export async function closeAgentInThread(ctx, token, threadId, agentName, companyId) {
    const sessions = await getThreadSessions(ctx, threadId, companyId);
    const target = sessions.find((s) => s.agentName.toLowerCase() === agentName.toLowerCase() && s.status === "running");
    if (!target) {
        return { ok: false, error: `No running agent named **${agentName}** in this thread.` };
    }
    target.status = "completed";
    await saveThreadSessions(ctx, threadId, sessions, companyId);
    // Close the underlying session
    try {
        if (target.transport === "native") {
            await ctx.agents.sessions.close(target.sessionId, companyId);
        }
        else {
            ctx.events.emit("acp-close", companyId, { sessionId: target.sessionId });
        }
    }
    catch (err) {
        ctx.logger.warn("Failed to close underlying session", {
            sessionId: target.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
    await postEmbed(ctx, token, threadId, {
        embeds: [
            {
                title: `Agent Closed: ${agentName}`,
                description: `**${agentName}** has been closed.`,
                color: COLORS.GRAY,
                footer: { text: "Paperclip" },
                timestamp: new Date().toISOString(),
            },
        ],
    });
    return { ok: true };
}
// ---------------------------------------------------------------------------
// Message routing: @mention, reply-to, most-recent fallback
// ---------------------------------------------------------------------------
export function parseAgentMention(text, sessions) {
    const mentionMatch = text.match(/@(\S+)/);
    if (!mentionMatch)
        return null;
    const mention = mentionMatch[1].toLowerCase();
    for (const s of sessions) {
        if (s.agentName.toLowerCase() === mention || s.agentDisplayName.toLowerCase() === mention) {
            return s;
        }
    }
    for (const s of sessions) {
        if (s.agentName.toLowerCase().startsWith(mention) || s.agentDisplayName.toLowerCase().startsWith(mention)) {
            return s;
        }
    }
    return null;
}
function getMostRecentlyActive(sessions) {
    const running = sessions.filter((s) => s.status === "running");
    if (running.length === 0)
        return null;
    return running.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())[0] ?? null;
}
export async function routeMessageToAgent(ctx, threadId, text, companyId, replyToSessionId) {
    const sessions = await getThreadSessions(ctx, threadId, companyId);
    const running = sessions.filter((s) => s.status === "running");
    if (running.length === 0)
        return false;
    let target = null;
    // 1. Reply-to routing
    if (replyToSessionId) {
        target = running.find((s) => s.sessionId === replyToSessionId) ?? null;
    }
    // 2. @mention routing
    if (!target) {
        target = parseAgentMention(text, running);
    }
    // 3. Most recently active fallback
    if (!target) {
        target = getMostRecentlyActive(running);
    }
    if (!target)
        return false;
    // Check for active discussion checkpoint
    const discussionId = await findActiveDiscussion(ctx, threadId, companyId);
    if (discussionId) {
        const discussion = await getDiscussion(ctx, discussionId, companyId);
        if (discussion && discussion.status === "paused_checkpoint") {
            discussion.status = "active";
            discussion.lastActivityAt = new Date().toISOString();
            await saveDiscussion(ctx, discussion);
        }
    }
    // Update last activity
    target.lastActivityAt = new Date().toISOString();
    await saveThreadSessions(ctx, threadId, sessions, companyId);
    // Route via the correct transport
    try {
        if (target.transport === "native") {
            await ctx.agents.sessions.sendMessage(target.sessionId, companyId, {
                prompt: text,
                reason: "Message from Discord thread",
                onEvent: (event) => {
                    if (event.eventType === "chunk" && event.message) {
                        enqueueOutput(threadId, target.agentDisplayName, event.message);
                        const isMulti = sessions.filter((s) => s.status === "running").length > 1;
                        scheduleFlush(ctx, "", threadId, isMulti);
                    }
                },
            });
        }
        else {
            ctx.events.emit("acp-message", companyId, {
                sessionId: target.sessionId,
                threadId,
                text,
                targetAgent: target.agentName,
            });
        }
        await ctx.metrics.write(METRIC_NAMES.agentMessagesRouted, 1);
    }
    catch (err) {
        ctx.logger.error("Failed to route message to agent", {
            sessionId: target.sessionId,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
    return true;
}
// ---------------------------------------------------------------------------
// ACP output handler (for ACP-transport sessions)
// ---------------------------------------------------------------------------
export async function handleAcpOutput(ctx, token, event) {
    const { sessionId, threadId, agentName, output, status } = event;
    const eventCompanyId = event.companyId || "default";
    let sessions = await getThreadSessions(ctx, threadId, eventCompanyId);
    let session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) {
        const now = new Date().toISOString();
        session = {
            sessionId,
            agentId: "",
            agentName,
            agentDisplayName: agentName,
            companyId: eventCompanyId,
            transport: "acp",
            spawnedAt: now,
            status: "running",
            lastActivityAt: now,
        };
        sessions.push(session);
    }
    if (status && status !== session.status) {
        session.status = status;
    }
    session.lastActivityAt = new Date().toISOString();
    await saveThreadSessions(ctx, threadId, sessions, eventCompanyId);
    const multiAgent = sessions.filter((s) => s.status === "running" || s.sessionId === sessionId).length > 1;
    enqueueOutput(threadId, session.agentDisplayName, output);
    if (status === "completed" || status === "failed") {
        await postEmbed(ctx, token, threadId, {
            embeds: [
                {
                    title: status === "completed" ? `Agent Completed: ${agentName}` : `Agent Failed: ${agentName}`,
                    description: `**${agentName}** has ${status === "completed" ? "finished successfully" : "encountered an error"}.`,
                    color: status === "completed" ? COLORS.GREEN : COLORS.RED,
                    footer: { text: "Paperclip" },
                    timestamp: new Date().toISOString(),
                },
            ],
        });
    }
    const discussionId = await findActiveDiscussion(ctx, threadId, eventCompanyId);
    if (discussionId) {
        await advanceDiscussion(ctx, token, threadId, discussionId, agentName);
    }
    scheduleFlush(ctx, token, threadId, multiAgent);
}
// ---------------------------------------------------------------------------
// Thread creation
// ---------------------------------------------------------------------------
export async function createAgentThread(ctx, token, channelId, agentName, task, companyId) {
    const threadName = `${agentName}: ${task.slice(0, 80)}`;
    try {
        const response = await ctx.http.fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
                Authorization: `Bot ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                content: `Starting agent session: **${agentName}**`,
            }),
        });
        if (!response.ok) {
            ctx.logger.warn("Failed to post starter message for thread", { status: response.status });
            return null;
        }
        const starterMsg = (await response.json());
        const threadResponse = await ctx.http.fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages/${starterMsg.id}/threads`, {
            method: "POST",
            headers: {
                Authorization: `Bot ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                name: threadName,
                auto_archive_duration: 1440,
            }),
        });
        if (!threadResponse.ok) {
            ctx.logger.warn("Failed to create thread", { status: threadResponse.status });
            return null;
        }
        const thread = (await threadResponse.json());
        const threadId = thread.id;
        await postEmbed(ctx, token, threadId, {
            embeds: [
                {
                    title: `Agent Session: ${agentName}`,
                    description: `**Task:** ${task}`,
                    color: COLORS.BLUE,
                    footer: { text: "Paperclip" },
                    timestamp: new Date().toISOString(),
                },
            ],
        });
        ctx.logger.info("Agent thread created", { threadId, agentName });
        return threadId;
    }
    catch (error) {
        ctx.logger.error("Failed to create agent thread", {
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}
// ---------------------------------------------------------------------------
// Thread status
// ---------------------------------------------------------------------------
export async function getThreadStatus(ctx, threadId, companyId) {
    const sessions = await getThreadSessions(ctx, threadId, companyId);
    return { sessions };
}
// ---------------------------------------------------------------------------
// Handoff
// ---------------------------------------------------------------------------
export async function initiateHandoff(ctx, token, threadId, fromAgent, toAgent, companyId, reason, handoffContext) {
    const handoffId = `hoff_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const toAgentId = (await resolveAgentId(ctx, toAgent, companyId)) ?? "";
    const embeds = [
        {
            title: `Handoff Request: ${fromAgent} -> ${toAgent}`,
            description: reason.slice(0, 2048),
            color: COLORS.YELLOW,
            fields: [
                { name: "From", value: fromAgent, inline: true },
                { name: "To", value: toAgent, inline: true },
                ...(handoffContext ? [{ name: "Context", value: handoffContext.slice(0, 1024) }] : []),
            ],
            footer: { text: "Paperclip Handoff" },
            timestamp: new Date().toISOString(),
        },
    ];
    const components = [
        {
            type: 1,
            components: [
                { type: 2, style: 3, label: "Approve Handoff", custom_id: `handoff_approve_${handoffId}` },
                { type: 2, style: 4, label: "Reject Handoff", custom_id: `handoff_reject_${handoffId}` },
            ],
        },
    ];
    await postEmbed(ctx, token, threadId, { embeds, components });
    const record = {
        handoffId,
        threadId,
        fromAgent,
        toAgent,
        toAgentId,
        companyId,
        reason,
        context: handoffContext,
        status: "pending",
        channelId: threadId,
        createdAt: new Date().toISOString(),
    };
    await saveHandoff(ctx, record);
    ctx.logger.info("Handoff initiated", { handoffId, fromAgent, toAgent, threadId });
    return { handoffId, status: "pending" };
}
// ---------------------------------------------------------------------------
// Handoff button handler
// ---------------------------------------------------------------------------
export async function handleHandoffButton(ctx, token, customId, actor) {
    const parts = customId.split("_");
    const action = parts[1];
    const handoffId = parts.slice(2).join("_");
    // No companyId available yet — fallback read will check "default" scope
    const record = await getHandoff(ctx, handoffId);
    if (!record) {
        return respondToInteraction({ type: 4, content: `Handoff \`${handoffId}\` not found.`, ephemeral: true });
    }
    if (record.status !== "pending") {
        return respondToInteraction({ type: 4, content: `Handoff already ${record.status}.`, ephemeral: true });
    }
    if (action === "approve") {
        record.status = "approved";
        record.resolvedAt = new Date().toISOString();
        record.resolvedBy = `discord:${actor}`;
        await saveHandoff(ctx, record);
        // Spawn the target agent in the thread with handoff context
        const prompt = `[Handoff from ${record.fromAgent}] ${record.reason}${record.context ? `\n\nContext: ${record.context}` : ""}`;
        await spawnAgentInThread(ctx, token, record.threadId, record.toAgent, record.companyId, prompt);
        return {
            type: 7,
            data: {
                embeds: [{
                        title: `Handoff Approved: ${record.fromAgent} -> ${record.toAgent}`,
                        description: `Approved by ${actor}. **${record.toAgent}** is now handling this.`,
                        color: COLORS.GREEN,
                        fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
                        footer: { text: "Paperclip Handoff" },
                        timestamp: new Date().toISOString(),
                    }],
                components: [],
            },
        };
    }
    if (action === "reject") {
        record.status = "rejected";
        record.resolvedAt = new Date().toISOString();
        record.resolvedBy = `discord:${actor}`;
        await saveHandoff(ctx, record);
        return {
            type: 7,
            data: {
                embeds: [{
                        title: `Handoff Rejected: ${record.fromAgent} -> ${record.toAgent}`,
                        description: `Rejected by ${actor}. **${record.fromAgent}** continues.`,
                        color: COLORS.RED,
                        fields: [{ name: "Reason", value: record.reason.slice(0, 1024) }],
                        footer: { text: "Paperclip Handoff" },
                        timestamp: new Date().toISOString(),
                    }],
                components: [],
            },
        };
    }
    return respondToInteraction({ type: 4, content: `Unknown handoff action: ${action}`, ephemeral: true });
}
// ---------------------------------------------------------------------------
// Discussion loop
// ---------------------------------------------------------------------------
export async function startDiscussion(ctx, token, threadId, initiator, target, companyId, topic, maxTurns = 10, humanCheckpointInterval = 0) {
    const discussionId = `disc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clampedMaxTurns = Math.min(Math.max(maxTurns, 2), MAX_CONVERSATION_TURNS);
    const initiatorAgentId = (await resolveAgentId(ctx, initiator, companyId)) ?? "";
    const targetAgentId = (await resolveAgentId(ctx, target, companyId)) ?? "";
    const now = new Date().toISOString();
    const record = {
        discussionId,
        threadId,
        initiator,
        initiatorAgentId,
        target,
        targetAgentId,
        companyId,
        topic,
        maxTurns: clampedMaxTurns,
        humanCheckpointInterval: humanCheckpointInterval > 0 ? humanCheckpointInterval : 0,
        currentTurn: 0,
        currentSpeaker: initiator,
        currentSpeakerAgentId: initiatorAgentId,
        status: "active",
        lastActivityAt: now,
        createdAt: now,
    };
    await saveDiscussion(ctx, record);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: `active_discussion_${threadId}` }, discussionId);
    await postEmbed(ctx, token, threadId, {
        embeds: [{
                title: `Discussion Started: ${initiator} <-> ${target}`,
                description: `**Topic:** ${topic}\n**Max turns:** ${clampedMaxTurns}${humanCheckpointInterval > 0 ? `\n**Checkpoint every:** ${humanCheckpointInterval} turns` : ""}`,
                color: COLORS.PURPLE,
                footer: { text: `Discussion ${discussionId}` },
                timestamp: now,
            }],
    });
    // Send opening prompt to initiator via native session
    if (initiatorAgentId) {
        try {
            await ctx.agents.invoke(initiatorAgentId, companyId, {
                prompt: `[Discussion with ${target}] Topic: ${topic}\n\nPlease share your thoughts. You have ${clampedMaxTurns} turns total.`,
                reason: `Discussion ${discussionId} opening`,
            });
        }
        catch {
            ctx.events.emit("acp-message", companyId, {
                sessionId: `discussion_${discussionId}`,
                threadId,
                text: `[Discussion with ${target}] Topic: ${topic}`,
                targetAgent: initiator,
            });
        }
    }
    ctx.logger.info("Discussion started", { discussionId, initiator, target, maxTurns: clampedMaxTurns });
    return { discussionId, status: "active" };
}
async function advanceDiscussion(ctx, token, threadId, discussionId, lastSpeaker) {
    const discussion = await getDiscussion(ctx, discussionId);
    if (!discussion || discussion.status !== "active")
        return;
    const discCompanyId = discussion.companyId || "default";
    const elapsed = Date.now() - new Date(discussion.lastActivityAt).getTime();
    if (elapsed > DISCUSSION_STALE_MS) {
        discussion.status = "stale";
        await saveDiscussion(ctx, discussion);
        await clearActiveDiscussion(ctx, threadId, discCompanyId);
        await postEmbed(ctx, token, threadId, {
            embeds: [{
                    title: "Discussion Stale",
                    description: `Discussion between **${discussion.initiator}** and **${discussion.target}** went stale.`,
                    color: COLORS.GRAY,
                    footer: { text: `Discussion ${discussionId}` },
                    timestamp: new Date().toISOString(),
                }],
        });
        return;
    }
    discussion.currentTurn++;
    discussion.lastActivityAt = new Date().toISOString();
    if (discussion.currentTurn >= discussion.maxTurns) {
        discussion.status = "completed";
        await saveDiscussion(ctx, discussion);
        await clearActiveDiscussion(ctx, threadId, discCompanyId);
        await postEmbed(ctx, token, threadId, {
            embeds: [{
                    title: "Discussion Complete",
                    description: `Discussion ended after ${discussion.currentTurn} turns.`,
                    color: COLORS.GREEN,
                    footer: { text: `Discussion ${discussionId}` },
                    timestamp: new Date().toISOString(),
                }],
        });
        return;
    }
    if (discussion.humanCheckpointInterval > 0 &&
        discussion.currentTurn > 0 &&
        discussion.currentTurn % discussion.humanCheckpointInterval === 0) {
        discussion.status = "paused_checkpoint";
        await saveDiscussion(ctx, discussion);
        await postEmbed(ctx, token, threadId, {
            embeds: [{
                    title: "Discussion Paused - Human Checkpoint",
                    description: `Turn ${discussion.currentTurn}/${discussion.maxTurns}. Send a message or click to continue.`,
                    color: COLORS.YELLOW,
                    footer: { text: `Discussion ${discussionId}` },
                    timestamp: new Date().toISOString(),
                }],
            components: [{
                    type: 1,
                    components: [
                        { type: 2, style: 3, label: "Continue Discussion", custom_id: `disc_continue_${discussionId}` },
                        { type: 2, style: 4, label: "End Discussion", custom_id: `disc_end_${discussionId}` },
                    ],
                }],
        });
        return;
    }
    const nextSpeaker = lastSpeaker === discussion.initiator ? discussion.target : discussion.initiator;
    const nextAgentId = nextSpeaker === discussion.initiator ? discussion.initiatorAgentId : discussion.targetAgentId;
    discussion.currentSpeaker = nextSpeaker;
    discussion.currentSpeakerAgentId = nextAgentId;
    await saveDiscussion(ctx, discussion);
    // Route to next speaker via native invoke or ACP
    const prompt = `[Discussion turn ${discussion.currentTurn}/${discussion.maxTurns}] Please respond to the previous message.`;
    if (nextAgentId) {
        try {
            await ctx.agents.invoke(nextAgentId, discussion.companyId, { prompt, reason: `Discussion ${discussionId}` });
        }
        catch {
            ctx.events.emit("acp-message", discussion.companyId, {
                sessionId: `discussion_${discussionId}`,
                threadId,
                text: prompt,
                targetAgent: nextSpeaker,
            });
        }
    }
}
// ---------------------------------------------------------------------------
// Discussion button handler
// ---------------------------------------------------------------------------
export async function handleDiscussionButton(ctx, token, customId, actor) {
    const parts = customId.split("_");
    const action = parts[1];
    const discussionId = parts.slice(2).join("_");
    const discussion = await getDiscussion(ctx, discussionId);
    if (!discussion) {
        return respondToInteraction({ type: 4, content: `Discussion \`${discussionId}\` not found.`, ephemeral: true });
    }
    if (action === "continue") {
        if (discussion.status !== "paused_checkpoint") {
            return respondToInteraction({ type: 4, content: `Discussion is not paused (${discussion.status}).`, ephemeral: true });
        }
        discussion.status = "active";
        discussion.lastActivityAt = new Date().toISOString();
        await saveDiscussion(ctx, discussion);
        if (discussion.currentSpeakerAgentId) {
            try {
                await ctx.agents.invoke(discussion.currentSpeakerAgentId, discussion.companyId, {
                    prompt: `[Discussion resumed by ${actor} - turn ${discussion.currentTurn}/${discussion.maxTurns}] Continue.`,
                    reason: `Discussion ${discussionId} resumed`,
                });
            }
            catch {
                ctx.events.emit("acp-message", discussion.companyId, {
                    sessionId: `discussion_${discussionId}`,
                    threadId: discussion.threadId,
                    text: `[Resumed by ${actor}] Continue the discussion.`,
                    targetAgent: discussion.currentSpeaker,
                });
            }
        }
        return {
            type: 7,
            data: {
                embeds: [{
                        title: "Discussion Resumed",
                        description: `Resumed by ${actor}. Turn ${discussion.currentTurn}/${discussion.maxTurns}.`,
                        color: COLORS.PURPLE,
                        footer: { text: `Discussion ${discussionId}` },
                        timestamp: new Date().toISOString(),
                    }],
                components: [],
            },
        };
    }
    if (action === "end") {
        discussion.status = "cancelled";
        await saveDiscussion(ctx, discussion);
        await clearActiveDiscussion(ctx, discussion.threadId, discussion.companyId || "default");
        return {
            type: 7,
            data: {
                embeds: [{
                        title: "Discussion Ended",
                        description: `Ended by ${actor} after ${discussion.currentTurn} turns.`,
                        color: COLORS.GRAY,
                        footer: { text: `Discussion ${discussionId}` },
                        timestamp: new Date().toISOString(),
                    }],
                components: [],
            },
        };
    }
    return respondToInteraction({ type: 4, content: `Unknown discussion action: ${action}`, ephemeral: true });
}
function getOption(options, name) {
    return options?.find((o) => o.name === name)?.value?.toString();
}
export async function handleAcpCommand(ctx, token, data, companyId, defaultChannelId) {
    const subcommand = data.options?.[0];
    if (!subcommand) {
        return respondToInteraction({ type: 4, content: "Missing subcommand.", ephemeral: true });
    }
    switch (subcommand.name) {
        case "spawn": {
            const agentName = getOption(subcommand.options, "agent");
            const task = getOption(subcommand.options, "task");
            if (!agentName || !task) {
                return respondToInteraction({ type: 4, content: "Usage: `/acp spawn agent:<name> task:<description>`", ephemeral: true });
            }
            const threadId = await createAgentThread(ctx, token, defaultChannelId, agentName, task, companyId);
            if (!threadId) {
                return respondToInteraction({ type: 4, content: "Failed to create Discord thread.", ephemeral: true });
            }
            const result = await spawnAgentInThread(ctx, token, threadId, agentName, companyId, task);
            if (!result.ok) {
                return respondToInteraction({ type: 4, content: result.error ?? "Failed to spawn agent.", ephemeral: true });
            }
            return respondToInteraction({
                type: 4,
                content: `Spawned **${agentName}** in thread.`,
            });
        }
        case "status": {
            const sessionId = getOption(subcommand.options, "session");
            if (!sessionId) {
                return respondToInteraction({ type: 4, content: "Usage: `/acp status session:<id>`", ephemeral: true });
            }
            return respondToInteraction({ type: 4, content: `Checking session \`${sessionId}\`...`, ephemeral: true });
        }
        case "cancel":
        case "close": {
            const sessionId = getOption(subcommand.options, "session");
            if (!sessionId) {
                return respondToInteraction({ type: 4, content: `Usage: \`/acp ${subcommand.name} session:<id>\``, ephemeral: true });
            }
            return respondToInteraction({ type: 4, content: `${subcommand.name === "cancel" ? "Cancelling" : "Closing"} session \`${sessionId}\`...` });
        }
        default:
            return respondToInteraction({ type: 4, content: `Unknown subcommand: ${subcommand.name}`, ephemeral: true });
    }
}
//# sourceMappingURL=session-registry.js.map