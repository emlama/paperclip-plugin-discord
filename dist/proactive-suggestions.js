import { postEmbed, getChannelMessages } from "./discord-api.js";
import { COLORS, METRIC_NAMES } from "./constants.js";
// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------
async function getWatches(ctx, companyId) {
    const raw = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "proactive_watches",
    });
    if (!raw)
        return [];
    return raw.watches ?? [];
}
async function saveWatches(ctx, companyId, watches) {
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "proactive_watches" }, { watches });
}
// ---------------------------------------------------------------------------
// Register a watch
// ---------------------------------------------------------------------------
export async function registerWatch(ctx, companyId, watchName, patterns, channelIds, responseTemplate, cooldownMinutes, agentId, agentName) {
    if (patterns.length === 0) {
        return { ok: false, watchId: "", error: "At least one pattern is required." };
    }
    // Validate regex patterns
    for (const p of patterns) {
        try {
            new RegExp(p, "i");
        }
        catch {
            return { ok: false, watchId: "", error: `Invalid regex pattern: ${p}` };
        }
    }
    const watchId = `watch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const watches = await getWatches(ctx, companyId);
    // Check for duplicate name
    const existing = watches.find((w) => w.watchName === watchName);
    if (existing) {
        existing.patterns = patterns;
        existing.channelIds = channelIds;
        existing.responseTemplate = responseTemplate;
        existing.cooldownMinutes = cooldownMinutes;
        existing.agentId = agentId;
        existing.agentName = agentName;
        existing.registeredAt = new Date().toISOString();
        await saveWatches(ctx, companyId, watches);
        ctx.logger.info("Watch updated", { watchName, watchId: existing.watchId });
        return { ok: true, watchId: existing.watchId };
    }
    watches.push({
        watchId,
        watchName,
        patterns,
        channelIds,
        responseTemplate,
        agentId,
        agentName,
        companyId,
        cooldownMinutes: cooldownMinutes > 0 ? cooldownMinutes : 60,
        registeredAt: new Date().toISOString(),
    });
    await saveWatches(ctx, companyId, watches);
    ctx.logger.info("Watch registered", { watchId, watchName, agentName });
    return { ok: true, watchId };
}
// ---------------------------------------------------------------------------
// Check watches job
// ---------------------------------------------------------------------------
export async function checkWatches(ctx, token, companyId, defaultChannelId) {
    const watches = await getWatches(ctx, companyId);
    if (watches.length === 0)
        return;
    const now = Date.now();
    for (const watch of watches) {
        // Check cooldown
        if (watch.lastTriggeredAt) {
            const elapsed = now - new Date(watch.lastTriggeredAt).getTime();
            if (elapsed < watch.cooldownMinutes * 60 * 1000)
                continue;
        }
        // Determine which channels to scan
        const channelsToScan = watch.channelIds.length > 0 ? watch.channelIds : [defaultChannelId];
        const compiledPatterns = watch.patterns.map((p) => new RegExp(p, "i"));
        let triggered = false;
        let matchedMessage = null;
        for (const channelId of channelsToScan) {
            if (triggered)
                break;
            const messages = await getChannelMessages(ctx, token, channelId, 50);
            for (const msg of messages) {
                // Skip bot messages
                if (msg.author.username.endsWith("[bot]"))
                    continue;
                // Only check messages from the last scan interval
                const msgAge = now - new Date(msg.timestamp).getTime();
                if (msgAge > 20 * 60 * 1000)
                    continue; // 20 min window
                for (const regex of compiledPatterns) {
                    if (regex.test(msg.content)) {
                        triggered = true;
                        matchedMessage = {
                            channelId,
                            content: msg.content.slice(0, 300),
                            author: msg.author.username,
                        };
                        break;
                    }
                }
                if (triggered)
                    break;
            }
        }
        if (triggered && matchedMessage) {
            watch.lastTriggeredAt = new Date().toISOString();
            await saveWatches(ctx, companyId, watches);
            const suggestion = watch.responseTemplate
                .replace("{{author}}", matchedMessage.author)
                .replace("{{content}}", matchedMessage.content)
                .replace("{{channel}}", matchedMessage.channelId);
            await postEmbed(ctx, token, matchedMessage.channelId, {
                embeds: [{
                        title: `Suggestion from ${watch.agentName}`,
                        description: suggestion.slice(0, 2048),
                        color: COLORS.PURPLE,
                        fields: [
                            { name: "Watch", value: watch.watchName, inline: true },
                            { name: "Triggered by", value: `${matchedMessage.author}: "${matchedMessage.content.slice(0, 100)}"` },
                        ],
                        footer: { text: "Paperclip Proactive Suggestion" },
                        timestamp: new Date().toISOString(),
                    }],
            });
            // Also invoke the agent for deeper analysis
            try {
                await ctx.agents.invoke(watch.agentId, companyId, {
                    prompt: `Proactive watch "${watch.watchName}" triggered by message from ${matchedMessage.author}: "${matchedMessage.content}". Please analyze and provide detailed suggestions.`,
                    reason: `Proactive watch: ${watch.watchName}`,
                });
            }
            catch (err) {
                ctx.logger.warn("Proactive agent invoke failed", {
                    watchId: watch.watchId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            await ctx.metrics.write(METRIC_NAMES.watchesTriggered, 1);
            ctx.logger.info("Watch triggered", {
                watchId: watch.watchId,
                watchName: watch.watchName,
                channelId: matchedMessage.channelId,
            });
        }
    }
}
//# sourceMappingURL=proactive-suggestions.js.map