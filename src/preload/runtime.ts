import { contextBridge, ipcRenderer } from "electron";
import { applyRuntimeSimulation, runtimeArgumentPrefix, validateRuntime } from "../shared/runtime";

const argument = process.argv.find((value) => value.startsWith(runtimeArgumentPrefix));
if (argument) {
  const initial = process.argv.includes("--platypus-live-runtime") ? ipcRenderer.sendSync("runtime:current")
    : JSON.parse(decodeURIComponent(argument.slice(runtimeArgumentPrefix.length)));
  const apply = (value: unknown) => contextBridge.executeInMainWorld({ func: applyRuntimeSimulation, args: [validateRuntime(value)] });
  apply(initial);
  if (process.argv.includes("--platypus-live-runtime")) ipcRenderer.on("runtime:update", (_event, value: unknown) => apply(value));
}
