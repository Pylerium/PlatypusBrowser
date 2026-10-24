import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type LaunchProcess = (executable: string, args: readonly string[]) => ChildProcessWithoutNullStreams;

// Never inherit master-key variables, Node injection flags, or Electron runtime switches.
export const launchProcess: LaunchProcess = (executable, args) => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_[A-Z_]+|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|SDL_[A-Z_]+|NO_PROXY)$/i.test(key)) env[key] = value;
  }
  const displayIndex = args.indexOf("-display");
  const interactive = displayIndex >= 0 && args[displayIndex + 1] !== "none";
  // SW_HIDE also hides GTK's first VM window on Windows, not just a console.
  return spawn(executable, [...args], { shell: false, windowsHide: !interactive, env, stdio: ["pipe", "pipe", "pipe"] });
};

export async function runTool(launch: LaunchProcess, executable: string, args: readonly string[], timeoutMs = 30000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = launch(executable, args);
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => stop(new Error("QEMU image operation timed out.")), timeoutMs);
    child.stdin.on("error", () => undefined);
    child.stdin.end();
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      stdout += chunk.toString("utf8");
      if (stdout.length > 1024 * 1024) { stdout = ""; stop(new Error("QEMU image output exceeded its limit.")); }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8192); });
    child.on("error", (error) => { failure = error; });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`QEMU image operation failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
}
