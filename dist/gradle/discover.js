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
const RE_TASK_LINE = /^([A-Za-z][A-Za-z0-9]*)\b/;
// Android unit-test task: test<Variant>UnitTest. Variant for default config is a
// build type with capitalized first letter (Debug/Feature/Qa/Release). A product
// FLAVOR would inject a flavor segment, yielding e.g. testFreeDebugUnitTest.
const RE_ANDROID_UNIT_TEST = /^test([A-Z][A-Za-z0-9]*)UnitTest$/;
const RE_INSTRUMENTED = /^(connectedAndroidTest|connected[A-Z][A-Za-z0-9]*AndroidTest|deviceAndroidTest|allDevicesCheck)$/;
// Matches KMP signals embedded in camelCase task names; word boundaries miss these.
const RE_KMP_TASK = /(compileKotlin(?:Metadata|Jvm|Ios|Android(?=UnitTest)|Desktop|Native|Js|Wasm)|commonTestClasses|commonMainClasses|metadataMainClasses|iosX64Test|iosArm64Test|iosSimulatorArm64Test|jvmTest\b|allTests\b)/;
function extractTaskNames(stdout) {
    const names = new Set();
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("=") || line.startsWith("-"))
            continue;
        const m = line.match(RE_TASK_LINE);
        if (!m)
            continue;
        // task lines look like "taskName - description" or just "taskName"
        const name = m[1];
        if (line === name || line.startsWith(name + " ") || line.startsWith(name + " -")) {
            names.add(name);
        }
    }
    return [...names];
}
/**
 * Decompose an android unit-test task name into its variant; detect product
 * flavors by counting build-type-vs-extra segments. Known build types here are
 * the recognized set; anything before a known build type is treated as a flavor.
 */
function isPlainBuildTypeVariant(variant, knownBuildTypes) {
    // variant is the capitalized middle of test<Variant>UnitTest, e.g. "Debug",
    // "Feature", or (with a flavor) "FreeDebug". Plain build type => exact match.
    return knownBuildTypes.some((bt) => variant.toLowerCase() === bt.toLowerCase());
}
export function discoverModule(input) {
    const knownBuildTypes = input.knownBuildTypes ?? ["debug", "feature", "qa", "release"];
    const tasks = extractTaskNames(input.tasksStdout);
    const androidUnitTasks = tasks.filter((t) => RE_ANDROID_UNIT_TEST.test(t));
    const hasPlainJvmTest = tasks.includes("test") && androidUnitTasks.length === 0;
    const hasInstrumentedTests = tasks.some((t) => RE_INSTRUMENTED.test(t));
    const kmpHit = (input.sourceSetsStdout !== undefined && RE_KMP_TASK.test(input.sourceSetsStdout)) ||
        RE_KMP_TASK.test(input.tasksStdout);
    const unsupported = (u) => ({
        path: input.path,
        kind: androidUnitTasks.length ? "android" : hasPlainJvmTest ? "jvm" : "unknown",
        sourceSet: "test",
        allUnitTestTasks: androidUnitTasks.length ? androidUnitTasks : hasPlainJvmTest ? ["test"] : [],
        hasInstrumentedTests,
        status: "UNSUPPORTED",
        unsupported: u,
    });
    if (kmpHit) {
        return unsupported({
            code: "KMP_SOURCE_SETS",
            detail: "Kotlin Multiplatform source sets detected (commonMain/androidUnitTest/etc). KMP is out of v1 scope.",
        });
    }
    // Android library/app with unit tests.
    if (androidUnitTasks.length > 0) {
        // detect product flavors: any variant that is not a plain known build type
        const variants = androidUnitTasks
            .map((t) => t.match(RE_ANDROID_UNIT_TEST)?.[1])
            .filter((v) => Boolean(v));
        const flavored = variants.filter((v) => !isPlainBuildTypeVariant(v, knownBuildTypes));
        if (flavored.length > 0) {
            return unsupported({
                code: "PRODUCT_FLAVORS",
                detail: `Product flavors detected (variant(s): ${flavored.join(", ")}). Flavors beyond plain build types are out of v1 scope.`,
            });
        }
        const debugTask = androidUnitTasks.find((t) => /^testDebugUnitTest$/.test(t));
        if (!debugTask) {
            return unsupported({
                code: "NO_UNIT_TEST_TASK",
                detail: `No testDebugUnitTest task; available: ${androidUnitTasks.join(", ")}.`,
            });
        }
        return {
            path: input.path,
            kind: "android",
            unitTestTask: debugTask,
            sourceSet: "test",
            allUnitTestTasks: androidUnitTasks,
            hasInstrumentedTests,
            status: "SUPPORTED",
        };
    }
    // Pure JVM module.
    if (hasPlainJvmTest) {
        return {
            path: input.path,
            kind: "jvm",
            unitTestTask: "test",
            sourceSet: "test",
            allUnitTestTasks: ["test"],
            hasInstrumentedTests,
            status: "SUPPORTED",
        };
    }
    // Instrumented-only Android module (androidTest but no unit test task).
    if (hasInstrumentedTests) {
        return unsupported({
            code: "INSTRUMENTED_ONLY",
            detail: "Only instrumented/androidTest tasks found, no unit-test task. Instrumented tests are out of v1 scope.",
        });
    }
    return unsupported({
        code: "UNKNOWN_MODULE_KIND",
        detail: "Could not identify a supported unit-test task for this module.",
    });
}
