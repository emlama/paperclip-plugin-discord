import { getChannelMessages, getChannelMessagesAll, getGuildRoles, } from "./discord-api.js";
import { BACKFILL_DEFAULT_DAYS, BACKFILL_MAX_MESSAGES_PER_CHANNEL, BACKFILL_PAGE_DELAY_MS, BACKFILL_SIGNAL_CAP, DEFAULT_ROLE_WEIGHT, METRIC_NAMES, ROLE_WEIGHTS, } from "./constants.js";
const SIGNAL_PATTERNS = [
    {
        category: "feature_wish",
        patterns: [
            /\bi wish\b/i,
            /\bwe need\b/i,
            /\bfeature request\b/i,
            /\bwould be nice\b/i,
            /\bcan we add\b/i,
            /\bshould support\b/i,
            /\bplease add\b/i,
        ],
    },
    {
        category: "pain_point",
        patterns: [
            /\bi'm stuck\b/i,
            /\bdoesn'?t work\b/i,
            /\bbug\b/i,
            /\bbroken\b/i,
            /\bcrash/i,
            /\berror\b/i,
            /\bfrustrat/i,
        ],
    },
    {
        category: "maintainer_directive",
        patterns: [
            /\bwe('re| are) (going to|planning)\b/i,
            /\broadmap\b/i,
            /\bnext release\b/i,
            /\bpriority\b/i,
            /\bwe decided\b/i,
        ],
    },
    {
        category: "sentiment",
        patterns: [
            /\blove (this|it|paperclip)\b/i,
            /\bamazing\b/i,
            /\bgreat (tool|project|work)\b/i,
            /\bdisappoint/i,
            /\bswitching (to|from)\b/i,
        ],
    },
];
function buildRoleWeightMap(roles) {
    const map = new Map();
    for (const role of roles) {
        const name = role.name.toLowerCase();
        const weight = ROLE_WEIGHTS[name] ?? DEFAULT_ROLE_WEIGHT;
        map.set(role.id, weight);
    }
    return map;
}
function getAuthorWeight(memberRoles, roleWeightMap) {
    if (!memberRoles || memberRoles.length === 0)
        return DEFAULT_ROLE_WEIGHT;
    let maxWeight = DEFAULT_ROLE_WEIGHT;
    for (const roleId of memberRoles) {
        const w = roleWeightMap.get(roleId);
        if (w && w > maxWeight)
            maxWeight = w;
    }
    return maxWeight;
}
function classifyMessage(content) {
    for (const { category, patterns } of SIGNAL_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(content))
                return category;
        }
    }
    return null;
}
const DEFAULT_RETENTION_DAYS = 30;
export function extractSignals(messages, roleWeightMap, channelId, retentionDays = DEFAULT_RETENTION_DAYS) {
    const signals = [];
    const expiresAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
    for (const msg of messages) {
        if (msg.author.username.endsWith("[bot]"))
            continue;
        if (msg.content.length < 10)
            continue;
        const category = classifyMessage(msg.content);
        if (!category)
            continue;
        const authorWeight = getAuthorWeight(msg.member?.roles, roleWeightMap);
        if (category === "maintainer_directive" && authorWeight < 3)
            continue;
        signals.push({
            category,
            text: msg.content.slice(0, 500),
            author: msg.author.username,
            authorWeight,
            channelId,
            timestamp: msg.timestamp,
            messageId: msg.id,
            expiresAt,
        });
    }
    return signals;
}
export function filterExpiredSignals(signals) {
    const now = new Date().toISOString();
    return signals.filter((s) => !s.expiresAt || s.expiresAt > now);
}
export async function runIntelligenceScan(ctx, token, guildId, channelIds, companyId, retentionDays = DEFAULT_RETENTION_DAYS) {
    if (channelIds.length === 0)
        return [];
    const roles = await getGuildRoles(ctx, token, guildId);
    const roleWeightMap = buildRoleWeightMap(roles);
    const allSignals = [];
    for (const channelId of channelIds) {
        const messages = await getChannelMessages(ctx, token, channelId, 100);
        const signals = extractSignals(messages, roleWeightMap, channelId, retentionDays);
        allSignals.push(...signals);
    }
    const freshSignals = filterExpiredSignals(allSignals);
    freshSignals.sort((a, b) => {
        if (b.authorWeight !== a.authorWeight)
            return b.authorWeight - a.authorWeight;
        return b.timestamp.localeCompare(a.timestamp);
    });
    await ctx.state.set({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord_intelligence",
    }, {
        signals: freshSignals.slice(0, 50),
        lastScanned: new Date().toISOString(),
        channelsScanned: channelIds.length,
    });
    await ctx.metrics.write(METRIC_NAMES.signalsExtracted, freshSignals.length);
    ctx.logger.info("Intelligence scan complete", {
        signals: freshSignals.length,
        channels: channelIds.length,
    });
    return freshSignals;
}
export function mergeSignals(existing, incoming) {
    const fresh = filterExpiredSignals(existing);
    const seen = new Set(fresh.map((s) => s.messageId));
    const merged = [...fresh];
    for (const s of incoming) {
        if (!seen.has(s.messageId)) {
            merged.push(s);
            seen.add(s.messageId);
        }
    }
    merged.sort((a, b) => {
        if (b.authorWeight !== a.authorWeight)
            return b.authorWeight - a.authorWeight;
        return b.timestamp.localeCompare(a.timestamp);
    });
    return merged;
}
export async function runBackfill(ctx, token, guildId, channelIds, companyId, backfillDays = BACKFILL_DEFAULT_DAYS) {
    if (channelIds.length === 0)
        return [];
    ctx.logger.info("Starting historical backfill", {
        channels: channelIds.length,
        days: backfillDays,
    });
    const roles = await getGuildRoles(ctx, token, guildId);
    const roleWeightMap = buildRoleWeightMap(roles);
    const allSignals = [];
    for (let i = 0; i < channelIds.length; i++) {
        const channelId = channelIds[i];
        ctx.logger.info(`Backfilling channel ${i + 1}/${channelIds.length}`, { channelId });
        const messages = await getChannelMessagesAll(ctx, token, channelId, {
            maxMessages: BACKFILL_MAX_MESSAGES_PER_CHANNEL,
            maxAgeDays: backfillDays,
            pageDelayMs: BACKFILL_PAGE_DELAY_MS,
            onProgress: (fetched) => {
                if (fetched % 500 === 0) {
                    ctx.logger.info(`  ...${fetched} messages fetched`, { channelId });
                }
            },
        });
        ctx.logger.info(`  ${messages.length} messages fetched`, { channelId });
        const signals = extractSignals(messages, roleWeightMap, channelId);
        allSignals.push(...signals);
    }
    // Load existing signals and merge (dedup by messageId)
    const existing = await ctx.state.get({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord_intelligence",
    });
    const existingSignals = existing?.signals ?? [];
    const merged = mergeSignals(existingSignals, allSignals);
    await ctx.state.set({
        scopeKind: "company",
        scopeId: companyId,
        stateKey: "discord_intelligence",
    }, {
        signals: merged.slice(0, BACKFILL_SIGNAL_CAP),
        lastScanned: new Date().toISOString(),
        backfillComplete: true,
        backfilledAt: new Date().toISOString(),
        channelsScanned: channelIds.length,
        totalMessagesScanned: allSignals.length,
    });
    await ctx.metrics.write(METRIC_NAMES.signalsExtracted, allSignals.length);
    ctx.logger.info("Backfill complete", {
        newSignals: allSignals.length,
        totalStored: Math.min(merged.length, BACKFILL_SIGNAL_CAP),
        channels: channelIds.length,
    });
    return merged.slice(0, BACKFILL_SIGNAL_CAP);
}
//# sourceMappingURL=intelligence.js.map