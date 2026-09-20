import { Communicate, listVoices as libListVoices } from 'edge-tts-universal';
import type { ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo } from '../types.js';
/** 注入的库依赖（单测用假实现替换）。 */
export interface EdgeLib {
    Communicate: typeof Communicate;
    listVoices: typeof libListVoices;
}
/**
 * 微软 Edge 云端 TTS（简单模式）提供方。
 * 底层 edge-tts-universal：原生流式、token 自动刷新、错误恢复、代理（第 1 层）；
 * 我方 health() = 试合成 + 缓存退避（第 2 层）。
 */
export declare class EdgeProvider implements TTSProvider {
    private clock;
    readonly kind: "edge";
    private lib;
    private healthCache;
    constructor(lib?: Partial<EdgeLib>, clock?: () => number);
    listVoices(): Promise<VoiceInfo[]>;
    stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
    health(): Promise<ProviderHealth>;
    /** 试合成 1 秒"你好"：消费到首块音频即视为可用；限时兜底（定时器必清理，防进程挂起）。 */
    private testSynthesis;
}
//# sourceMappingURL=edge.d.ts.map