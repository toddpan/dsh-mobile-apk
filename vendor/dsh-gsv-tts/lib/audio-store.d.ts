import type { IncomingMessage, ServerResponse } from 'http';
export interface AudioChunk {
    /** 该块的 base64 编码音频数据（GSV-TTS-Lite 输出 32-bit float32 波形） */
    base64: string;
    /** 采样率（Hz） */
    sampleRate: number;
}
export declare class AudioStore {
    private baseUrl?;
    private dir;
    /**
     * @param baseUrl DSH webServer 的 `http://host:port`；缺省时退回 data URL。
     */
    constructor(baseUrl?: string | undefined);
    get enabled(): boolean;
    /** 将音频块写成 WAV 文件并返回可播放 URL。 */
    save(name: string, chunks: AudioChunk[]): {
        url: string;
        name: string;
    };
    /** 将原始音频字节（MP3/WAV 等）落盘并返回可播放 URL（4.0.0 Edge MP3 透传）。 */
    saveRaw(name: string, data: Buffer): {
        url: string;
        name: string;
    };
    /** 服务 `/dsh-gsv-tts/audio/<file>` 请求。 */
    serve(req: IncomingMessage, res: ServerResponse): Promise<void>;
    /** 启动时清空上次会话残留。 */
    private purgeAll;
    /** 会话内限制文件数量，超出删除最旧的。 */
    private enforceCap;
    private listFiles;
}
/** 为 32-bit 单声道 IEEE float PCM 构造标准 44 字节 WAV(RIFF) 头。
 *  GSV-TTS-Lite 的 `clip.audio_data` 是 float32 波形（-1~1），对应 WAV format=3。 */
export declare function buildWav(pcm: Buffer, sampleRate: number): Buffer;
//# sourceMappingURL=audio-store.d.ts.map