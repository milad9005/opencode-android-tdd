/**
 * JDK toolchain discovery. The spike proved a JRE-only JAVA_HOME (no `javac`)
 * fails Gradle BEFORE compilation with an exit code indistinguishable from a
 * real test failure — so resolving a true JDK is a prerequisite the gate must
 * own, and a toolchain problem must surface as ENV_FAILURE, never RED.
 */

import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export interface Toolchain {
  javaHome: string;
  javacPath: string;
  version: string; // e.g. "21.0.10"
  toolchainId: string; // stable hash-ish id for redProof binding
}

export interface ToolchainResult {
  ok: boolean;
  toolchain?: Toolchain;
  reason?: string;
  candidatesTried: string[];
}

function javacIn(javaHome: string): string | undefined {
  const candidate = join(javaHome, "bin", process.platform === "win32" ? "javac.exe" : "javac");
  return existsSync(candidate) ? candidate : undefined;
}

function queryVersion(javacPath: string): string | undefined {
  try {
    const out = execFileSync(javacPath, ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const m = out.match(/javac\s+([0-9][0-9._]*)/);
    return m?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Enumerate candidate JDK homes in priority order without assuming any are valid:
 * explicit env, then common install roots (incl. Android Studio bundled JBR,
 * which the spike used when the system JAVA had no javac).
 */
function candidateHomes(env: Record<string, string | undefined>): string[] {
  const homes: string[] = [];
  const push = (p?: string) => {
    if (p && !homes.includes(p)) homes.push(p);
  };

  push(env.JAVA_HOME);
  push(env.JDK_HOME);

  const roots = [
    "/usr/lib/jvm",
    "/usr/local",
    "/opt",
    join(env.HOME ?? "", ".sdkman/candidates/java"),
    "/Library/Java/JavaVirtualMachines",
  ];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(root, e);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      push(full);
      // Android Studio layout: <root>/<studio>/jbr and macOS .jdk/Contents/Home
      push(join(full, "jbr"));
      push(join(full, "android-studio", "jbr"));
      push(join(full, "Contents", "Home"));
    }
  }
  return homes;
}

export function discoverToolchain(
  env: Record<string, string | undefined> = process.env,
): ToolchainResult {
  const candidates = candidateHomes(env);
  const tried: string[] = [];
  for (const home of candidates) {
    tried.push(home);
    const javacPath = javacIn(home);
    if (!javacPath) continue;
    const version = queryVersion(javacPath);
    if (!version) continue;
    return {
      ok: true,
      toolchain: {
        javaHome: home,
        javacPath,
        version,
        toolchainId: `jdk-${version}@${home}`,
      },
      candidatesTried: tried,
    };
  }
  return {
    ok: false,
    reason:
      "No JDK with `javac` found. A JRE-only JAVA_HOME cannot compile and will fail before tests run (classified ENV_FAILURE). Install a JDK (the project requires one) or point JAVA_HOME at one.",
    candidatesTried: tried,
  };
}
