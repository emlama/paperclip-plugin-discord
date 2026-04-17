import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface MediaAttachment {
    id: string;
    filename: string;
    url: string;
    content_type?: string;
    size: number;
}
export type MediaType = "audio" | "video" | "image" | "unknown";
export declare function classifyMedia(attachment: MediaAttachment): MediaType;
export declare function detectMedia(attachments: MediaAttachment[]): Array<{
    attachment: MediaAttachment;
    mediaType: MediaType;
}>;
export declare function transcribeAudio(ctx: PluginContext, audioUrl: string, companyId: string): Promise<string | null>;
export declare function routeToBriefAgent(ctx: PluginContext, companyId: string, content: string, sourceChannelId: string, sourceMessageId: string): Promise<string | null>;
export declare function processMediaMessage(ctx: PluginContext, token: string, channelId: string, messageId: string, attachments: MediaAttachment[], companyId: string): Promise<void>;
