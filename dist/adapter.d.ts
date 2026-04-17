import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { DiscordEmbed, DiscordComponent, DiscordMessage } from "./discord-api.js";
export interface PlatformAdapter {
    sendText(channelId: string, text: string): Promise<string | null>;
    sendButtons(channelId: string, embeds: DiscordEmbed[], components: DiscordComponent[]): Promise<string | null>;
    editMessage(channelId: string, messageId: string, message: DiscordMessage): Promise<boolean>;
    formatAgentLabel(agentName: string): string;
    formatMention(userId: string): string;
    formatCodeBlock(text: string, language?: string): string;
}
export declare class DiscordAdapter implements PlatformAdapter {
    private ctx;
    private token;
    constructor(ctx: PluginContext, token: string);
    sendText(channelId: string, text: string): Promise<string | null>;
    sendButtons(channelId: string, embeds: DiscordEmbed[], components: DiscordComponent[]): Promise<string | null>;
    editMessage(channelId: string, messageId: string, message: DiscordMessage): Promise<boolean>;
    formatAgentLabel(agentName: string): string;
    formatMention(userId: string): string;
    formatCodeBlock(text: string, language?: string): string;
}
