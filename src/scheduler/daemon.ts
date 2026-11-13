// The scheduler off macOS: when each job is next due, whether it is running, and the doctor's and
// `schedule`'s view of it.
import type { Check } from "../check.js";
import { alive, startStamp } from "../stacks/process.js";
import type { Workspace } from "../workspace.js";
import { type Calendar, jobs } from "./launchd.js";
import { type JobRun, type SchedulerState, readState, stateFile } from "./state.js";

// The first minute strictly after `after` whose local wall clock matches a calendar. Minutes
// are walked in real time, so a repeated hour fires again and a skipped time waits a day.
export function nextDue(cal: Calendar[], after: Date): Date {
  if (!cal.length) throw new Error("nextDue: an empty calendar never fires");
  // to the minute in real time: setSeconds would resolve a repeated wall-clock time to its first
  // occurrence, a real hour back
  const d = new Date(Math.floor(after.getTime() / 60_000) * 60_000);
  // two days covers a daily calendar and any clock change
  for (let i = 0; i < 2 * 1440; i++) {
    d.setTime(d.getTime() + 60_000);
    if (cal.some((c) => c.Minute === d.getMinutes() && (c.Hour === undefined || c.Hour === d.getHours()))) return d;
  }
  throw new Error(`nextDue: no fire within two days of ${after.toISOString()}`);
}

// The recorded run is still going: its pid is alive and has the stamp taken at spawn, since the
// file survives a reboot and pids get reused. Without a stamp it goes by the pid alone. A failed
// lookup counts as alive and goes to onError, because a doubled `up` does damage.
export function runAlive(r: JobRun, onError: (e: unknown) => void = () => {}): boolean {
  if (!r.pid) return false;
  try {
    return r.stamp ? startStamp(r.pid) === r.stamp : alive(r.pid);
  } catch (e) {
    onError(e);
    return true;
  }
}

// Alive is a state file written within three checks by a process that still exists. A file left
// by a daemon that died, or by one on a machine that has since rebooted, is not.
export function daemonAlive(s: SchedulerState | null, now = Date.now()): s is SchedulerState {
  if (!s) return false;
  return now - Date.parse(s.at) <= 3 * s.checkSeconds * 1000 && alive(s.pid);
}

const FIX = "systemctl --user restart factory-scheduler, which reads config again";

// For the doctor: the daemon is up and has every job config asks for, and none it does not.
export function checks(ws: Workspace): Check[] {
  const s = readState(ws);
  if (!daemonAlive(s)) return [{ ok: false, what: `the scheduler, which runs the watchers' jobs (no fresh ${stateFile(ws)})`, fix: "systemctl --user start factory-scheduler" }];
  const want = jobs(ws);
  const out: Check[] = want.map((j) => (s.jobs[j.label] ? { ok: true, what: `scheduler job ${j.label}` } : { ok: false, what: `scheduler job ${j.label}`, fix: FIX }));
  for (const l of Object.keys(s.jobs).filter((l) => !want.some((j) => j.label === l)))
    out.push({ ok: false, what: `scheduler job ${l} gone, since config no longer runs it`, fix: FIX });
  return out;
}

// For the round and `schedule status`: one line per job.
export function loaded(ws: Workspace): string[] {
  const s = readState(ws);
  if (!daemonAlive(s)) return ["  scheduler NOT RUNNING -- systemctl --user status factory-scheduler"];
  return jobs(ws).map((j) => {
    const r = s.jobs[j.label];
    if (!r) return `  scheduler ${j.label} NOT SCHEDULED -- ${FIX}`;
    const running = r.pid ? ` running pid=${r.pid}` : "";
    return `  scheduler ${j.label} next=${r.due} last_exit=${r.lastExit ?? "-"}${running}`;
  });
}

// `schedule install|uninstall|status` off macOS. There is nothing to install, so install and
// uninstall say so and point at the daemon; status exits 1 when anything is missing.
export function schedule(ws: Workspace, verb: "install" | "uninstall" | "status", out: (line: string) => void = console.log): number {
  if (verb !== "status") {
    out(`off macOS the scheduler (factory schedule run) runs these jobs and nothing is ${verb}ed per job; it reads [watchers] when it starts: ${FIX}`);
    return 0;
  }
  const lines = loaded(ws);
  for (const l of lines) out(l);
  return lines.some((l) => /NOT (RUNNING|SCHEDULED)/.test(l)) ? 1 : 0;
}
