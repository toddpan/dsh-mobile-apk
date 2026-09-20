export class VoiceManager {
    voices = new Map();
    defaultVoice;
    constructor(config) {
        this.defaultVoice = config.defaultVoice;
        for (const v of config.voices) {
            this.voices.set(v.name, v);
        }
    }
    list() {
        return Array.from(this.voices.values());
    }
    get(name) {
        if (name && this.voices.has(name)) {
            return this.voices.get(name);
        }
        if (this.defaultVoice && this.voices.has(this.defaultVoice)) {
            return this.voices.get(this.defaultVoice);
        }
        return this.voices.values().next().value;
    }
    get defaultName() {
        return this.defaultVoice;
    }
}
//# sourceMappingURL=voice-manager.js.map