// Protocol/image-tool fixture. This is not a VM or a QEMU compatibility test.
const fs = require("node:fs");
const readline = require("node:readline");
const [role, ...args] = process.argv.slice(2);
if (role === "img") {
  if (args[0] === "create") {
    const image = { format: "qcow2", "backing-filename": args[args.indexOf("-b") + 1], "backing-filename-format": args[args.indexOf("-F") + 1] };
    fs.writeFileSync(args.at(-1), JSON.stringify(image));
  } else if (args[0] === "info") {
    const filename = args.at(-1);
    process.stdout.write(filename.endsWith(".raw") ? JSON.stringify({ format: "raw" }) : fs.readFileSync(filename, "utf8"));
  } else process.exit(2);
} else {
  const mode = process.env.FAKE_MODE;
  const address = args[args.indexOf("-qmp") + 1];
  const socket = address?.startsWith("tcp:") ? require("node:net").connect(Number(address.split(":")[2]), "127.0.0.1") : undefined;
  const input = socket ?? process.stdin;
  const output = socket ?? process.stdout;
  socket?.on("error", () => process.exit(8));
  process.stderr.write("fake QEMU diagnostic\n");
  if (mode === "startup-crash") process.exit(7);
  if (mode === "malformed") output.write("invalid JSON\n");
  else if (mode !== "no-greeting") {
    const greeting = JSON.stringify({ QMP: { version: { qemu: { major: 9, minor: 2, micro: 0 } }, capabilities: [] } }) + "\r\n";
    output.write(greeting.slice(0, 11));
    setTimeout(() => output.write(greeting.slice(11)), 5);
  }
  let running = false;
  let statusQueries = 0;
  readline.createInterface({ input }).on("line", (line) => {
    const command = JSON.parse(line);
    if (command.execute === "query-status" && ++statusQueries > 1 && mode === "unresponsive-control") return;
    if (command.execute === "cont") running = true;
    output.write(JSON.stringify({ id: command.id, return: command.execute === "query-status" ? { running, status: running ? "running" : "paused" } : {} }) + "\r\n");
    if (command.execute === "cont" && mode === "crash") setTimeout(() => process.exit(7), 40);
    if (command.execute === "cont" && mode === "guest-exit") setTimeout(() => process.exit(0), 40);
    if (command.execute === "cont" && mode === "disconnect") setTimeout(() => output.end(), 40);
    if (command.execute === "system_powerdown" && mode !== "ignore-powerdown" && mode !== "ignore-all") setTimeout(() => process.exit(0), 5);
    if (command.execute === "quit" && mode !== "ignore-all") setTimeout(() => process.exit(0), 5);
  });
  // Keep the protocol fixture alive until shutdown or a signal.
  setInterval(() => {}, 1000);
}
