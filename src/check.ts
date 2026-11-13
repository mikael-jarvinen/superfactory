// One line of `factory doctor`: `ok <what>`, or `MISSING <what> [fix: <step>]`.
export interface Check {
  ok: boolean;
  what: string;
  fix?: string;
}
