/** 单次合成（tts_speak 工具 / 短文本）的清洗后长度上限。 */
export declare const MAX_TEXT_LENGTH = 6000;
/** 分段合成（朗读按钮 / 自动朗读）的清洗后长度上限（分段本身按句切分）。 */
export declare const MAX_SEGMENTED_TEXT_LENGTH = 30000;
/** 单段最大字符数（超过则按句打包时硬切）。 */
export declare const SEGMENT_MAX_CHARS = 800;
export declare class TextCleaner {
    static clean(text: string): string;
}
//# sourceMappingURL=text-cleaner.d.ts.map