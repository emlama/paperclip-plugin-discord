import type { PluginContext } from "@paperclipai/plugin-sdk";
export interface CommandParameter {
    name: string;
    description: string;
    required: boolean;
}
export interface CustomCommand {
    command: string;
    description: string;
    parameters: CommandParameter[];
    agentId: string;
    agentName: string;
    companyId: string;
    registeredAt: string;
}
export declare function registerCommand(ctx: PluginContext, companyId: string, command: string, description: string, parameters: CommandParameter[], agentId: string, agentName: string): Promise<{
    ok: boolean;
    error?: string;
}>;
export interface ParsedCommand {
    command: string;
    args: string;
    rawText: string;
}
export declare function parseCommandMessage(text: string): ParsedCommand | null;
export declare function executeCommand(ctx: PluginContext, token: string, channelId: string, parsed: ParsedCommand, companyId: string): Promise<boolean>;
export declare function listCommands(ctx: PluginContext, companyId: string): Promise<CustomCommand[]>;
