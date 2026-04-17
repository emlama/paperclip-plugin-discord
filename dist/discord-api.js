import { DISCORD_API_BASE, METRIC_NAMES } from "./constants.js";
import { withRetry } from "./retry.js";
async function discordFetch(ctx, token, path, options = {}) {
    const url = `${DISCORD_API_BASE}${path}`;
    const init = {
        method: options.method ?? "GET",
        headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
        },
    };
    if (options.body) {
        init.body = JSON.stringify(options.body);
    }
    return ctx.http.fetch(url, init);
}
export async function postEmbed(ctx, token, channelId, message) {
    try {
        await withRetry(async () => {
            const response = await discordFetch(ctx, token, `/channels/${channelId}/messages`, {
                method: "POST",
                body: {
                    content: message.content,
                    embeds: message.embeds,
                    components: message.components,
                },
            });
            if (!response.ok) {
                const text = await response.text();
                const err = new Error(`Discord API error: ${response.status}`);
                err.status = response.status;
                err.headers = response.headers;
                ctx.logger.warn("Discord API error", {
                    status: response.status,
                    body: text,
                    channelId,
                });
                throw err;
            }
        });
        await ctx.metrics.write(METRIC_NAMES.sent, 1);
        return true;
    }
    catch (error) {
        ctx.logger.error("Discord notification delivery failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        await ctx.metrics.write(METRIC_NAMES.failed, 1);
        return false;
    }
}
export async function postEmbedWithId(ctx, token, channelId, message) {
    try {
        let messageId = null;
        await withRetry(async () => {
            const response = await discordFetch(ctx, token, `/channels/${channelId}/messages`, {
                method: "POST",
                body: {
                    content: message.content,
                    embeds: message.embeds,
                    components: message.components,
                },
            });
            if (!response.ok) {
                const text = await response.text();
                const err = new Error(`Discord API error: ${response.status}`);
                err.status = response.status;
                err.headers = response.headers;
                ctx.logger.warn("Discord API error", {
                    status: response.status,
                    body: text,
                    channelId,
                });
                throw err;
            }
            const data = (await response.json());
            messageId = data.id;
        });
        await ctx.metrics.write(METRIC_NAMES.sent, 1);
        return messageId;
    }
    catch (error) {
        ctx.logger.error("Discord notification delivery failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        await ctx.metrics.write(METRIC_NAMES.failed, 1);
        return null;
    }
}
export async function registerSlashCommands(ctx, token, applicationId, guildId, commands) {
    try {
        const response = await discordFetch(ctx, token, `/applications/${applicationId}/guilds/${guildId}/commands`, { method: "PUT", body: commands });
        if (!response.ok) {
            const text = await response.text();
            ctx.logger.warn("Failed to register slash commands", {
                status: response.status,
                body: text,
            });
            return false;
        }
        return true;
    }
    catch (error) {
        ctx.logger.error("Slash command registration failed", {
            error: error instanceof Error ? error.message : String(error),
        });
        return false;
    }
}
export async function getChannelMessages(ctx, token, channelId, limit = 100) {
    try {
        const response = await discordFetch(ctx, token, `/channels/${channelId}/messages?limit=${limit}`);
        if (!response.ok)
            return [];
        return (await response.json());
    }
    catch {
        return [];
    }
}
export async function getChannelMessagesAll(ctx, token, channelId, opts = {}) {
    const maxMessages = opts.maxMessages ?? 5000;
    const maxAgeDays = opts.maxAgeDays ?? 90;
    const pageDelayMs = opts.pageDelayMs ?? 500;
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const allMessages = [];
    let before;
    while (allMessages.length < maxMessages) {
        const query = before
            ? `/channels/${channelId}/messages?limit=100&before=${before}`
            : `/channels/${channelId}/messages?limit=100`;
        try {
            const response = await discordFetch(ctx, token, query);
            if (!response.ok)
                break;
            const page = (await response.json());
            if (page.length === 0)
                break;
            for (const msg of page) {
                if (msg.timestamp < cutoff) {
                    // Reached max age cutoff
                    return allMessages;
                }
                allMessages.push(msg);
            }
            before = page[page.length - 1].id;
            opts.onProgress?.(allMessages.length);
            // Rate limit delay between pages
            if (pageDelayMs > 0) {
                await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
            }
        }
        catch {
            break;
        }
    }
    return allMessages;
}
export async function getGuildRoles(ctx, token, guildId) {
    try {
        const response = await discordFetch(ctx, token, `/guilds/${guildId}/roles`);
        if (!response.ok)
            return [];
        return (await response.json());
    }
    catch {
        return [];
    }
}
export async function getApplicationId(ctx, token) {
    try {
        const response = await discordFetch(ctx, token, "/oauth2/applications/@me");
        if (!response.ok)
            return null;
        const data = (await response.json());
        return data.id;
    }
    catch {
        return null;
    }
}
export function respondToInteraction(data) {
    return {
        type: data.type,
        data: {
            content: data.content,
            embeds: data.embeds,
            flags: data.ephemeral ? 64 : 0,
        },
    };
}
//# sourceMappingURL=discord-api.js.map