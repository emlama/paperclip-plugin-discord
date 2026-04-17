import type { PluginContext } from "@paperclipai/plugin-sdk";
interface InteractionCreateEvent {
    id: string;
    token: string;
    type: number;
    data?: Record<string, unknown>;
    member?: {
        user: {
            username: string;
        };
    };
    guild_id?: string;
    channel_id?: string;
}
export interface MessageCreateEvent {
    id: string;
    channel_id: string;
    content: string;
    author: {
        id: string;
        username: string;
        bot?: boolean;
    };
    message_reference?: {
        message_id: string;
        channel_id: string;
        guild_id?: string;
    };
}
type InteractionHandler = (interaction: InteractionCreateEvent) => Promise<unknown>;
type MessageHandler = (message: MessageCreateEvent) => Promise<void>;
export interface GatewayOptions {
    listenForMessages?: boolean;
    includeMessageContent?: boolean;
}
export declare function respondViaCallback(ctx: PluginContext, interactionId: string, interactionToken: string, responseData: unknown): Promise<void>;
export declare function connectGateway(ctx: PluginContext, token: string, onInteraction: InteractionHandler, onMessage?: MessageHandler, options?: GatewayOptions): Promise<{
    close: () => void;
}>;
export {};
