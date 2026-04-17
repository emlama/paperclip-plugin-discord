import type { PluginContext } from "@paperclipai/plugin-sdk";
interface InteractionOption {
    name: string;
    value?: string | number | boolean;
    options?: InteractionOption[];
    focused?: boolean;
}
interface InteractionData {
    name: string;
    custom_id?: string;
    component_type?: number;
    options?: InteractionOption[];
}
interface Interaction {
    type: number;
    data?: InteractionData;
    member?: {
        user: {
            username: string;
        };
    };
    channel_id?: string;
}
export interface CommandContext {
    baseUrl: string;
    companyId: string;
    token: string;
    defaultChannelId: string;
    /** PluginContext for lazy company-ID resolution at command time. */
    pluginCtx?: PluginContext;
}
export declare const SLASH_COMMANDS: {
    name: string;
    description: string;
    options: ({
        name: string;
        description: string;
        type: number;
        options?: undefined;
    } | {
        name: string;
        description: string;
        type: number;
        options: {
            name: string;
            description: string;
            type: number;
            required: boolean;
        }[];
    } | {
        name: string;
        description: string;
        type: number;
        options: {
            name: string;
            description: string;
            type: number;
            required: boolean;
            autocomplete: boolean;
        }[];
    } | {
        name: string;
        description: string;
        type: number;
        options: {
            name: string;
            description: string;
            type: number;
            required: boolean;
            choices: {
                name: string;
                value: string;
            }[];
        }[];
    } | {
        name: string;
        description: string;
        type: number;
        options: ({
            name: string;
            description: string;
            type: number;
            options: {
                name: string;
                description: string;
                type: number;
                required: boolean;
            }[];
        } | {
            name: string;
            description: string;
            type: number;
            options?: undefined;
        })[];
    })[];
}[];
export declare function handleInteraction(ctx: PluginContext, interaction: Interaction, cmdCtx: CommandContext): Promise<unknown>;
export {};
