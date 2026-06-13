// Spike harness for tdd_doctor — validates module discovery + support-matrix
// against REAL VeroAndroid task output plus synthetic UNSUPPORTED cases.
// JS port of src/gradle/discover.ts (kept in sync by hand for the spike).

// ---- real captured task output (abridged, from discover_modules.txt) -------
const ANDROID_TASKS = `
testDebugUnitTest - Run unit tests for the debug build.
testFeatureUnitTest - Run unit tests for the feature build.
testQaUnitTest - Run unit tests for the qa build.
testReleaseUnitTest - Run unit tests for the release build.
test - Run unit tests for all variants.
compileDebugUnitTestKotlin - Compiles the debugUnitTest kotlin.
connectedAndroidTest - Installs and runs instrumentation tests for all flavors on connected devices.
allDevicesCheck - Runs all device checks on all managed devices defined in the TestOptions dsl.
deviceAndroidTest - Installs and runs instrumentation tests using all Device Providers.
`;
const JVM_TASKS = `
test - Runs the test suite.
testClasses - Assembles test classes.
`;
// synthetic: product flavor variant (testFreeDebugUnitTest) — not a plain build type
const FLAVOR_TASKS = `
testFreeDebugUnitTest - Run unit tests for the freeDebug build.
testPaidDebugUnitTest - Run unit tests for the paidDebug build.
connectedAndroidTest - ...
`;
// synthetic: instrumented-only (no unit test task)
const INSTRUMENTED_ONLY_TASKS = `
connectedAndroidTest - Installs and runs instrumentation tests.
deviceAndroidTest - ...
`;
// synthetic: KMP source sets present
const KMP_TASKS = `
testDebugUnitTest - Run unit tests for the debug build.
commonTestClasses - Assembles common test classes.
compileKotlinAndroidUnitTest - ...
`;

// ---- JS port of discover.ts -------------------------------------------------
const RE_TASK_LINE = /^([A-Za-z][A-Za-z0-9]*)\b/;
const RE_ANDROID_UNIT_TEST = /^test([A-Z][A-Za-z0-9]*)UnitTest$/;
const RE_INSTRUMENTED = /^(connectedAndroidTest|connected[A-Z][A-Za-z0-9]*AndroidTest|deviceAndroidTest|allDevicesCheck)$/;
const RE_KMP_TASK =
  /(compileKotlin(?:Metadata|Jvm|Ios|Android(?=UnitTest)|Desktop|Native|Js|Wasm)|commonTestClasses|commonMainClasses|metadataMainClasses|iosX64Test|iosArm64Test|iosSimulatorArm64Test|jvmTest\b|allTests\b)/;

function extractTaskNames(stdout) {
  const names = new Set();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("=") || line.startsWith("-")) continue;
    const m = line.match(RE_TASK_LINE);
    if (!m) continue;
    const name = m[1];
    if (line === name || line.startsWith(name + " ") || line.startsWith(name + " -")) names.add(name);
  }
  return [...names];
}
const isPlainBuildType = (variant, known) => known.some((bt) => variant.toLowerCase() === bt.toLowerCase());

function discoverModule({ path, tasksStdout, knownBuildTypes }) {
  const known = knownBuildTypes ?? ["debug", "feature", "qa", "release"];
  const tasks = extractTaskNames(tasksStdout);
  const androidUnit = tasks.filter((t) => RE_ANDROID_UNIT_TEST.test(t));
  const hasJvmTest = tasks.includes("test") && androidUnit.length === 0;
  const instrumented = tasks.some((t) => RE_INSTRUMENTED.test(t));
  const kmp = RE_KMP_TASK.test(tasksStdout);

  const uns = (code, detail) => ({ path, status: "UNSUPPORTED", code, detail, instrumented });

  if (kmp) return uns("KMP_SOURCE_SETS", "KMP source sets");
  if (androidUnit.length) {
    const variants = androidUnit.map((t) => t.match(RE_ANDROID_UNIT_TEST)[1]);
    const flavored = variants.filter((v) => !isPlainBuildType(v, known));
    if (flavored.length) return uns("PRODUCT_FLAVORS", `flavors: ${flavored.join(",")}`);
    const debug = androidUnit.find((t) => t === "testDebugUnitTest");
    if (!debug) return uns("NO_UNIT_TEST_TASK", androidUnit.join(","));
    return { path, status: "SUPPORTED", kind: "android", unitTestTask: debug, instrumented };
  }
  if (hasJvmTest) return { path, status: "SUPPORTED", kind: "jvm", unitTestTask: "test", instrumented };
  if (instrumented) return uns("INSTRUMENTED_ONLY", "only instrumented tasks");
  return uns("UNKNOWN_MODULE_KIND", "no supported unit-test task");
}

// ---- cases ------------------------------------------------------------------
const cases = [
  { name: ":common:regex (android)",   tasks: ANDROID_TASKS,           expect: "SUPPORTED",   task: "testDebugUnitTest" },
  { name: ":core:logger:jvm (jvm)",    tasks: JVM_TASKS,               expect: "SUPPORTED",   task: "test" },
  { name: "flavored android",          tasks: FLAVOR_TASKS,            expect: "UNSUPPORTED", code: "PRODUCT_FLAVORS" },
  { name: "instrumented-only",         tasks: INSTRUMENTED_ONLY_TASKS, expect: "UNSUPPORTED", code: "INSTRUMENTED_ONLY" },
  { name: "kmp module",                tasks: KMP_TASKS,               expect: "UNSUPPORTED", code: "KMP_SOURCE_SETS" },
];

let pass = 0;
console.log("\n=== tdd_doctor DISCOVERY SPIKE — real VeroAndroid + synthetic ===\n");
for (const c of cases) {
  const r = discoverModule({ path: c.name, tasksStdout: c.tasks });
  let ok = r.status === c.expect;
  if (ok && c.expect === "SUPPORTED") ok = r.unitTestTask === c.task;
  if (ok && c.expect === "UNSUPPORTED") ok = r.code === c.code;
  if (ok) pass++;
  const detail = r.status === "SUPPORTED" ? `task=${r.unitTestTask} kind=${r.kind}` : `code=${r.code}`;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name.padEnd(28)} ${r.status.padEnd(12)} ${detail}`);
}
console.log(`\n${pass}/${cases.length} correct\n`);
process.exit(pass === cases.length ? 0 : 1);
