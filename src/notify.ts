import { spawn } from "node:child_process";

// Ring the machine when a message is posted: osascript on macOS, nothing elsewhere. Never fatal;
// the message is already written. SF_NOTIFY=0 mutes it, SF_NOTIFY_SOUND names the sound.
export function notify(title: string, subtitle: string, body: string, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin" || env.SF_NOTIFY === "0") return;
  const sound = env.SF_NOTIFY_SOUND ?? "Glass";
  const q = (v: string) => '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
  const script = `display notification ${q(body)} with title ${q(title)} subtitle ${q(subtitle)}` + (sound ? ` sound name ${q(sound)}` : "");
  try {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no osascript
  }
}
