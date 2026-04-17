import { DISCORD_API_BASE } from "./constants.js";
import { withRetry } from "./retry.js";
export class DiscordAdapter {
    ctx;
    token;
    constructor(ctx, token) {
        this.ctx = ctx;
        this.token = token;
    }
    async sendText(channelId, text) {
        try {
            const response = await withRetry(() => this.ctx.http.fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
                method: "POST",
                headers: {
                    Authorization: `Bot ${this.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ content: text }),
            }));
            if (!response.ok) {
                const body = await response.text();
                this.ctx.logger.warn("sendText failed", {
                    status: response.status,
                    body,
                    channelId,
                });
                return null;
            }
            const data = (await response.json());
            return data.id;
        }
        catch (error) {
            this.ctx.logger.error("sendText error", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }
    async sendButtons(channelId, embeds, components) {
        try {
            const response = await withRetry(() => this.ctx.http.fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
                method: "POST",
                headers: {
                    Authorization: `Bot ${this.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ embeds, components }),
            }));
            if (!response.ok) {
                const body = await response.text();
                this.ctx.logger.warn("sendButtons failed", {
                    status: response.status,
                    body,
                    channelId,
                });
                return null;
            }
            const data = (await response.json());
            return data.id;
        }
        catch (error) {
            this.ctx.logger.error("sendButtons error", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }
    async editMessage(channelId, messageId, message) {
        try {
            const response = await withRetry(() => this.ctx.http.fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}`, {
                method: "PATCH",
                headers: {
                    Authorization: `Bot ${this.token}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    content: message.content,
                    embeds: message.embeds,
                    components: message.components,
                }),
            }));
            if (!response.ok) {
                const body = await response.text();
                this.ctx.logger.warn("editMessage failed", {
                    status: response.status,
                    body,
                    channelId,
                    messageId,
                });
                return false;
            }
            return true;
        }
        catch (error) {
            this.ctx.logger.error("editMessage error", {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }
    formatAgentLabel(agentName) {
        return `**[${agentName}]**`;
    }
    formatMention(userId) {
        return `<@${userId}>`;
    }
    formatCodeBlock(text, language) {
        const lang = language ?? "";
        return `\`\`\`${lang}\n${text}\n\`\`\``;
    }
}
//# sourceMappingURL=adapter.js.map