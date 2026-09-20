import { GsvProvider } from './providers/gsv.js';
import { EdgeProvider } from './providers/edge.js';
import type { AudioStore } from './audio-store.js';
import type { Config, ProviderHealth, ProviderKind, SynthesizeResult, SynthesizeSegmentsResult, VoiceInfo, VoicePreset } from './types.js';
import type { VoiceManager } from './voice-manager.js';
export declare class TTSService {
    private config;
    private audioStore;
    private voiceManager;
    private gsv;
    private edge;
    constructor(config: Config, audioStore: AudioStore, opts?: {
        voiceManager?: VoiceManager;
        gsv?: GsvProvider;
        edge?: EdgeProvider;
    });
    private provider;
    /** 当前提供方音色列表（gsv = 本地预设；edge = 精选微软声音）。 */
    listVoices(kind?: ProviderKind): Promise<VoiceInfo[]>;
    /** 当前提供方健康（edge = 试合成退避；gsv = 引擎状态）。 */
    health(kind?: ProviderKind): Promise<ProviderHealth>;
    /** 单次合成整段（tts_speak / 试听路径）。voice 可为预设对象（gsv）或音色 id（edge）。 */
    synthesize(text: string, voice?: VoicePreset | string, signal?: AbortSignal, kind?: ProviderKind): Promise<SynthesizeResult>;
    /** 渐进分段合成（朗读按钮 / 自动朗读路径）：按 provider 逐段合成，段间 0 静音。 */
    synthesizeSegments(text: string, voice?: VoicePreset | string, signal?: AbortSignal): Promise<SynthesizeSegmentsResult>;
    private synthesizeGsv;
    private synthesizeEdge;
}
//# sourceMappingURL=tts.service.d.ts.map