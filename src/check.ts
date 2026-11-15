// One line of `factory doctor`: `ok <what>`, `MISSING <what> [fix: <step>]`, or `NOT CHECKED <what>`
// for what this machine cannot look at, which is not missing.
export type Status = "ok" | "missing" | "unchecked";

export interface Check {
  status: Status;
  what: string;
  fix?: string;
}

export const okIf = (found: boolean): Status => (found ? "ok" : "missing");
