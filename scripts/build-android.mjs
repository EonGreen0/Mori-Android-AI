import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];

function gradleProxyArgs(envName, scheme) {
  const envValue = [process.env[envName.toLowerCase()], process.env[envName]]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  if (!envValue) return [];

  let proxy;
  try {
    proxy = new URL(envValue);
  } catch {
    process.stderr.write(`${envName} is not a usable proxy URL; configure the proxy in local Gradle settings if needed.\n`);
    return [];
  }

  const authority = envValue.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1] || "";
  if (proxy.username || proxy.password || authority.includes("@")) {
    process.stderr.write(`${envName} contains proxy authentication, which is not forwarded; configure the proxy in local Gradle settings if needed.\n`);
    return [];
  }
  if (
    !["http:", "https:"].includes(proxy.protocol) ||
    !proxy.hostname ||
    proxy.pathname !== "/" ||
    proxy.search ||
    proxy.hash
  ) {
    process.stderr.write(`${envName} must be an unauthenticated http(s) proxy URL; configure the proxy in local Gradle settings if needed.\n`);
    return [];
  }

  const hostname = proxy.hostname.replace(/^\[|\]$/g, "");
  const port = proxy.port || (proxy.protocol === "https:" ? "443" : "80");
  return [`-D${scheme}.proxyHost=${hostname}`, `-D${scheme}.proxyPort=${port}`];
}

if (mode !== "debug" && mode !== "release") {
  process.stderr.write("Usage: node scripts/build-android.mjs <debug|release>\n");
  process.exitCode = 2;
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const androidRoot = path.join(root, "android");
  const capacitorCli = path.join(root, "node_modules", "@capacitor", "cli", "bin", "capacitor");
  const wrapperJar = path.join(androidRoot, "gradle", "wrapper", "gradle-wrapper.jar");

  function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit" });
    if (result.error) {
      process.stderr.write(`${command}: ${result.error.message}\n`);
      process.exitCode = 1;
      return false;
    }
    if (result.status !== 0) {
      process.stderr.write(`${command} exited with status ${result.status ?? "unknown"}\n`);
      process.exitCode = result.status || 1;
      return false;
    }
    return true;
  }

  if (!existsSync(capacitorCli)) {
    process.stderr.write(`Capacitor CLI not found: ${capacitorCli}\n`);
    process.exitCode = 1;
  } else if (!existsSync(wrapperJar)) {
    process.stderr.write(`Gradle wrapper JAR not found: ${wrapperJar}\n`);
    process.exitCode = 1;
  } else if (run(process.execPath, [capacitorCli, "sync", "android"], root)) {
    const java = process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
      : "java";
    const task = mode === "debug" ? "assembleDebug" : "assembleRelease";
    run(java, [
      ...gradleProxyArgs("HTTP_PROXY", "http"),
      ...gradleProxyArgs("HTTPS_PROXY", "https"),
      "-classpath",
      wrapperJar,
      "org.gradle.wrapper.GradleWrapperMain",
      task,
      "--console=plain",
      "--no-daemon",
    ], androidRoot);
  }
}
