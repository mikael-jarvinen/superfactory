// A stand-in for the gh CLI, put first on PATH by test/gate.test.ts. It answers from a routes file
// and logs every call, so a test can say what GitHub returns and check what was asked of it.
//
//   FAKE_GH_ROUTES  JSON: { "<args joined by spaces>": Reply | Reply[] }. The longest key that
//                   prefixes the call wins. A list is answered in order, its last reply repeating.
//                   No route is a failed call, which is what an unreadable answer looks like.
//   FAKE_GH_LOG     each call's args, one JSON array per line
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface Reply {
  status?: number;
  stdout?: unknown;
  stderr?: string;
}

const args = process.argv.slice(2);
const call = args.join(" ");
const routesFile = process.env.FAKE_GH_ROUTES as string;
appendFileSync(process.env.FAKE_GH_LOG as string, JSON.stringify(args) + "\n");
const routes = JSON.parse(readFileSync(routesFile, "utf8")) as Record<string, Reply | Reply[]>;
const key = Object.keys(routes).filter((k) => call.startsWith(k)).sort((a, b) => b.length - a.length)[0];
if (key === undefined) {
  process.stderr.write(`fake gh: no route for: ${call}\n`);
  process.exit(1);
}
let reply = routes[key] as Reply | Reply[];
if (Array.isArray(reply)) {
  const counts = routesFile + ".counts";
  const seen = existsSync(counts) ? (JSON.parse(readFileSync(counts, "utf8")) as Record<string, number>) : {};
  const i = seen[key] ?? 0;
  seen[key] = i + 1;
  writeFileSync(counts, JSON.stringify(seen));
  reply = reply[Math.min(i, reply.length - 1)] as Reply;
}
const out = reply.stdout;
if (out !== undefined) process.stdout.write(typeof out === "string" ? out : JSON.stringify(out));
if (reply.stderr) process.stderr.write(reply.stderr);
process.exit(reply.status ?? 0);
