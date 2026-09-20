/**
 * 长文本按句切分（渐进分段播放的基础）。
 *
 * 规则：
 * - 中文按句末标点（。！？…；;、）切分，标点保留在本段末尾（保证合成语调自然）；
 * - 英文按 `.!?;` 后跟空白/行尾切分（避免误拆小数如 3.14）；
 * - 单段不超过 maxChars：先按句拆成"原子"，再打包；单句超长时硬切。
 */
export declare function splitIntoSegments(text: string, maxChars?: number): string[];
//# sourceMappingURL=segmenter.d.ts.map