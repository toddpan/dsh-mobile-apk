/**
 * GSV-TTS-Lite 引擎进程管理：启动（detached，宿主退出后仍存活）、停止、状态查询。
 * 单个实例跨配置热更新存活，避免 reconfigure 丢失子进程引用。
 */
export interface EngineStatus {
    running: boolean;
    port: number;
    message?: string;
}
export interface EngineActionResult {
    ok: boolean;
    running: boolean;
    message: string;
}
export declare class EngineManager {
    private child;
    private apiUrl;
    private installDir;
    /** 配置热更新时同步（进程引用保留）。 */
    configure(apiUrl: string, installDir: string): void;
    private get port();
    /** 引擎是否响应（以 API 健康检查为准）。 */
    status(): Promise<EngineStatus>;
    /** 启动引擎：已运行则直接返回；否则 detached 拉起并等待就绪。 */
    start(): Promise<EngineActionResult>;
    /** 停止引擎：终止由本管理器拉起的进程；外部托管进程不受影响。 */
    stop(): Promise<EngineActionResult>;
    private detectPython;
    private waitForReady;
}
//# sourceMappingURL=engine-manager.d.ts.map