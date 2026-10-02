export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const FCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "fcode-plugins-official";
export const FCODE_OFFICIAL_PLUGIN_REPOSITORY_URL =
  "https://github.com/markusleevip/agent-plugins-official";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@fcode-plugins-official",
  "image-search@fcode-plugins-official",
  "documents@fcode-plugins-official",
  "pdf@fcode-plugins-official",
  "presentations@fcode-plugins-official",
  "spreadsheets@fcode-plugins-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@fcode-plugins-official",
  "skill-creator@fcode-plugins-official",
  "plugin-creator@fcode-plugins-official",
  "fcode-guide@fcode-plugins-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
  // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
  // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
]);

export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] = [
  {
    // 官方 GitHub 仓库与内置分片共用稳定身份；仓库声明必须匹配此 id。
    id: FCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "markusleevip/agent-plugins-official#main",
    name: FCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "Official FCode plugins marketplace: built-in and community plugins for FCode.",
    pluginCount: 0,
  },
];

// 商店「公开」分段只有一个 FCode 官方市场 id，内置与 CDN 不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [FCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}
