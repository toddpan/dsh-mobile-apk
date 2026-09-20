import type { Config, ProviderChunk, ProviderHealth, TTSProvider, VoiceInfo, VoicePreset } from '../types.js';
import type { VoiceManager } from '../voice-manager.js';
/**
 * 本地 GSV-TTS-Lite 提供方（克隆/离线专业模式）。
 * 流式产出 PCM 块（mime audio/pcm-f32 + sampleRate），由上层 AudioStore 装配 WAV。
 */
export declare class GsvProvider implements TTSProvider {
    private opts;
    readonly kind: "gsv";
    constructor(opts: {
        getConfig: () => Config;
        voiceManager?: VoiceManager;
        /** 引擎状态探测（index.ts 接入 engineManager.status） */
        health?: () => Promise<ProviderHealth>;
    });
    listVoices(): Promise<VoiceInfo[]>;
    health(): Promise<ProviderHealth>;
    stream(text: string, voice: string, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
    /** 直接以预设流式合成（朗读/自动朗读/试听的临时预设都走这里）。 */
    streamWithPreset(text: string, voice: VoicePreset, signal?: AbortSignal): AsyncIterable<ProviderChunk>;
}
//# sourceMappingURL=gsv.d.ts.map