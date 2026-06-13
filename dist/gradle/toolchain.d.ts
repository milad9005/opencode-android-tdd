/**
 * JDK toolchain discovery. The spike proved a JRE-only JAVA_HOME (no `javac`)
 * fails Gradle BEFORE compilation with an exit code indistinguishable from a
 * real test failure — so resolving a true JDK is a prerequisite the gate must
 * own, and a toolchain problem must surface as ENV_FAILURE, never RED.
 */
export interface Toolchain {
    javaHome: string;
    javacPath: string;
    version: string;
    toolchainId: string;
}
export interface ToolchainResult {
    ok: boolean;
    toolchain?: Toolchain;
    reason?: string;
    candidatesTried: string[];
}
export declare function discoverToolchain(env?: Record<string, string | undefined>): ToolchainResult;
