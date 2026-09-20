import type { Config, VoicePreset, VoiceRegistry, VoiceRegistryPkg } from './types.js';
/** 单文件下载硬上限（独立于清单声明，防超限）。 */
export declare const MAX_FILE_BYTES: number;
/** 允许的音频后缀白名单。 */
export declare const ALLOWED_EXT: string[];
/** 音色 id 白名单。 */
export declare const ID_RE: RegExp;
export type RegistrySource = 'bundled' | 'remote';
export interface RegistryListEntry extends VoiceRegistryPkg {
    installed: boolean;
}
export interface RegistryListResult {
    source: RegistrySource;
    trusted: boolean;
    version: string;
    voices: RegistryListEntry[];
}
export interface RegistryInstallResult {
    ok: boolean;
    /** 阶段 1 需要确认时置 true（信任边界外不下载任何字节） */
    needsConfirm?: boolean;
    pkg?: VoiceRegistryPkg;
    voice?: VoicePreset;
    message: string;
}
export interface RegistryRemoveResult {
    ok: boolean;
    message: string;
}
export interface RegistryFetchers {
    /** 拉取文本（清单）。 */
    fetchText(url: string): Promise<string>;
    /** 下载二进制（音频）。 */
    fetchBinary(url: string): Promise<Buffer>;
}
/** 包内离线清单路径（编译后 lib/ 同级的 docs/voices.json）。 */
export declare function bundledManifestPath(): string;
/** 清单结构校验：schema、id/name 唯一、https 直链、sha256 格式。 */
export declare function validateManifest(raw: unknown): VoiceRegistry;
/**
 * 音色注册表核心（工具与 HTTP 路由共享）。
 *
 * 信任规则（唯一一条）：信任 = 随插件发版内置。仅包内离线清单且 trusted 为真可免确认；
 * 任何经 voiceRegistryUrl 来的远端清单一律两阶段确认，即便它自报 trusted。
 */
export declare class VoiceRegistryManager {
    private opts;
    constructor(opts: {
        getConfig: () => Config;
        /** 持久化配置补丁（settingsScope.update(patch)），热更新触发 reconfigure */
        writeConfig: (patch: Partial<Config>) => Promise<void>;
        fetchers?: Partial<RegistryFetchers>;
    });
    private fetchers;
    /** 解析清单：无 voiceRegistryUrl → 包内离线；有 → 远端（不可自证信任）。 */
    private resolveRegistry;
    /** 市场列表：拉取清单并标注已安装状态。 */
    list(registryUrl?: string): Promise<RegistryListResult>;
    /**
     * 安装（两阶段幂等）：
     * - 需确认时（非包内可信清单）第一段返回 needsConfirm，不下载任何字节；
     * - confirm 后（或包内可信）才下载 → sha256 校验 → 原子落盘 → 写 Config.voices。
     */
    install(id: string, confirm: boolean): Promise<RegistryInstallResult>;
    /** 卸载：仅限 source:'registry'，按 id 精确匹配；defaultVoice 悬空一并清空；deleteFiles 限定在 voices 目录内。 */
    remove(id: string, deleteFiles: boolean): Promise<RegistryRemoveResult>;
    /** 下载 → sha256 校验 → 原子落盘；返回可写回 Config 的 VoicePreset。 */
    private stage;
    /** 安装/删除目录：resolve 后必须仍位于 <installDir>/voices/ 之下。 */
    private voiceDir;
}
//# sourceMappingURL=voice-registry.d.ts.map