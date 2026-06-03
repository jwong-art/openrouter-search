import { Type, type Static } from "typebox";
declare const pluginConfigSchema: Type.TObject<{
    timeout_ms: Type.TOptional<Type.TInteger>;
}>;
export type PluginConfig = Static<typeof pluginConfigSchema>;
declare const _default: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default _default;
