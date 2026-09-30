// A stand-in for the claude CLI, for the watcher tests. `agents --json` lists no sessions. A `-p`
// run logs its args and its prompt, then answers with the next reply from a list, the last one
// repeating, so a test says what each disposable session prints and checks what it was asked.
//
//   FAKE_CLAUDE_REPLIES  JSON file: [{ "stdout": "...", "status": 0 }, ...]
//   FAKE_CLAUDE_LOG      each -p call as one JSON line: { "args": [...], "prompt": "..." }
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "agents") {
  process.stdout.write("[]");
  process.exit(0);
}
if (args[0] !== "-p") process.exit(1);
const prompt = readFileSync(0, "utf8");
appendFileSync(process.env.FAKE_CLAUDE_LOG as string, JSON.stringify({ args, prompt }) + "\n");
const file = process.env.FAKE_CLAUDE_REPLIES as string;
const replies = JSON.parse(readFileSync(file, "utf8")) as { stdout?: string; status?: number }[];
const counter = file + ".count";
const i = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
writeFileSync(counter, String(i + 1));
const reply = replies[Math.min(i, replies.length - 1)] ?? {};
process.stdout.write(reply.stdout ?? "");
process.exit(reply.status ?? 0);
