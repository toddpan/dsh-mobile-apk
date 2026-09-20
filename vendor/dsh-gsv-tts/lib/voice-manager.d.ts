import type { VoicePreset, Config } from './types.js';
export declare class VoiceManager {
    private voices;
    private defaultVoice;
    constructor(config: Config);
    list(): VoicePreset[];
    get(name?: string): VoicePreset | undefined;
    get defaultName(): string;
}
//# sourceMappingURL=voice-manager.d.ts.map