import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface DiscordEmbed {
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
    }>;
    footer?: {
        text: string;
    };
    timestamp?: string;
}
export interface DiscordComponent {
    type: number;
    components?: DiscordComponent[];
    style?: number;
    label?: string;
    custom_id?: string;
    url?: string;
}
export interface DiscordMessage {
    content?: string;
    embeds?: DiscordEmbed[];
    components?: DiscordComponent[];
}
export interface DiscordGuildRole {
    id: string;
    name: string;
    position: number;
    permissions: string;
}
export interface DiscordChannelMessage {
    id: string;
    content: string;
    author: {
        id: string;
        username: string;
    };
    timestamp: string;
    member?: {
        roles: string[];
    };
}
export declare function postEmbed(ctx: PluginContext, token: string, channelId: string, message: DiscordMessage): Promise<boolean>;
export declare function postEmbedWithId(ctx: PluginContext, token: string, channelId: string, message: DiscordMessage): Promise<string | null>;
export declare function registerSlashCommands(ctx: PluginContext, token: string, applicationId: string, guildId: string, commands: Array<{
    name: string;
    description: string;
    options?: unknown[];
}>): Promise<boolean>;
export declare function getChannelMessages(ctx: PluginContext, token: string, channelId: string, limit?: number): Promise<DiscordChannelMessage[]>;
export declare function getChannelMessagesAll(ctx: PluginContext, token: string, channelId: string, opts?: {
    maxMessages?: number;
    maxAgeDays?: number;
    pageDelayMs?: number;
    onProgress?: (fetched: number) => void;
}): Promise<DiscordChannelMessage[]>;
export declare function getGuildRoles(ctx: PluginContext, token: string, guildId: string): Promise<DiscordGuildRole[]>;
export declare function getApplicationId(ctx: PluginContext, token: string): Promise<string | null>;
export declare function respondToInteraction(data: {
    type: number;
    content?: string;
    embeds?: DiscordEmbed[];
    ephemeral?: boolean;
}): unknown;
