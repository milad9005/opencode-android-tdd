/**
 * Module discovery: parse real `./gradlew :module:tasks` output into a typed
 * model, choose the v1 test task, and decide support status. Pure functions
 * over captured Gradle stdout (testable against spike fixtures) — no execution
 * here; the doctor orchestrator runs Gradle and feeds stdout in.
 *
 * Grounded in real VeroAndroid output (see spike/fixtures/discover_modules.txt):
 *   Android library => testDebugUnitTest / testFeatureUnitTest / testQaUnitTest
 *                      / testReleaseUnitTest, plus connectedAndroidTest.
 *   JVM library     => single `test` task, no variants.
 */
export type ModuleKind = "android" | "jvm" | "unknown";
export type SupportStatus = "SUPPORTED" | "UNSUPPORTED";
export interface UnsupportedReason {
    code: "NO_UNIT_TEST_TASK" | "KMP_SOURCE_SETS" | "INSTRUMENTED_ONLY" | "PRODUCT_FLAVORS" | "UNKNOWN_MODULE_KIND";
    detail: string;
}
export interface ModuleModel {
    path: string;
    kind: ModuleKind;
    /** unit-test task chosen for v1 (debug variant for android, `test` for jvm) */
    unitTestTask?: string;
    /** the unit-test source set name (`test` for both android-unit and jvm) */
    sourceSet: string;
    /** all unit-test tasks discovered (for diagnostics / future variant support) */
    allUnitTestTasks: string[];
    hasInstrumentedTests: boolean;
    status: SupportStatus;
    unsupported?: UnsupportedReason;
}
export interface DiscoverInput {
    path: string;
    tasksStdout: string;
    /** optional: source-set listing if available (KMP detection) */
    sourceSetsStdout?: string;
    /** build types considered "plain" (no flavor). Default covers VeroAndroid. */
    knownBuildTypes?: string[];
}
export declare function discoverModule(input: DiscoverInput): ModuleModel;
