import type { HealthCheckResult, SetupResult } from './types.js';
export declare class EngineSetup {
    private apiUrl;
    private installDir;
    constructor(apiUrl: string, installDir: string);
    healthCheck(): Promise<HealthCheckResult>;
    setup(): Promise<SetupResult>;
    private detectPythonCmd;
    /** 探测 gsv_tts 是否可用：先试系统裸路径，再试仓库源码 / --target 安装路径。 */
    private probeGsvTts;
    private detectPythonPaths;
    private generateWrapper;
    private parsePort;
    private waitForReady;
}
//# sourceMappingURL=setup.d.ts.map