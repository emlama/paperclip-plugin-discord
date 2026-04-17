import type { PluginContext } from "@paperclipai/plugin-sdk";
export declare function resolveCompanyId(ctx: PluginContext): Promise<string>;
/** Reset cached company ID (for testing). */
export declare function _resetCompanyIdCache(): void;
