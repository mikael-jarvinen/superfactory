# superfactory: design

superfactory runs a fleet of Claude Code sessions against a team's repos: a lead the human talks to,
builders that each take one work item to a draft PR, and reviewers that read a PR fresh. This repo
is the program, a TypeScript package on Node with one `factory` CLI. Anything tied to a user, a
machine or a company lives in a workspace that the program reads. No absolute path, company, person
or agent name appears in the program.

## Program and workspace

- **The program** (this repo) is generic. It holds the state machine, the fleet, the message page,
  the PR gate, slot bookkeeping for local stacks, watchers, the scheduler and the hooks.
- **A workspace** is a directory the user owns and keeps in their own repo. It holds
  `factory.toml`, the content, the stack scripts, and at runtime `state/` and `logs/`. The content
  is the lead's instructions and skills, the builders' briefs, the reviewers' instructions and
  skills, and the watcher prompts.

Resolving the workspace, first match wins:
1. `--workspace`
2. `$FACTORY_WORKSPACE`
3. the nearest `factory.toml` walking up from the cwd, as git finds `.git`

Every session and job the program starts gets `FACTORY_WORKSPACE` in its environment, so hooks and
nested `factory` calls resolve to the same place.

## Package layout

```
src/
  cli.ts          entry point, one subcommand per module below
  config.ts       load and validate factory.toml into typed objects; expand ~, $VARS and
                  workspace-relative paths; one error per bad key, naming the key
  workspace.ts    resolution (above), state/, logs/, logs/run/
  state.ts        records, the transition graph, evidence rules, events.jsonl
  fleet.ts        agents from config; sessions via `claude agents --json`; any undocumented
                  daemon internals behind one function
  launch.ts       the `claude --bg` command line, appendix assembly, the READY handshake
  settings.ts     render each role's Claude Code settings at launch into logs/run/
  worktree.ts     worktree per work item, push over https, dirty and pushed checks
  messages.ts     say, messages, rotation
  notify.ts       desktop notification on macOS, nothing elsewhere
  board/          server.ts, inbox.ts, static/ (the page's HTML, CSS and JS as real files)
  gate/           ready.ts, send.ts, wait.ts, delta.ts, comment.ts, media.ts, demo.ts
  stacks/         engine.ts (slot registry, allocation, placement), contract.ts (calling scripts)
  tracker/        jira.ts (driven by config), none.ts
  watchers/       queue.ts, round.ts, relay.ts; prompts come from the workspace
  scheduler/      launchd.ts, rendering jobs from config
  hooks/          guard.ts, status.ts, no-dialogs.ts, no-side-channels.ts, run as `factory hook <name>`
  doctor.ts       checks derived from config, plus each stack's own `doctor` verb
templates/        role settings, launch prompts, the demo camera and Playwright config
test/             node:test suites
```

It needs Node 22 or later, since Playwright needs Node anyway and every Claude Code user has it.
`tsc` builds to `dist/`, and the package ships a `factory` bin, so installing it is
`npm install -g` from the repo. The only runtime dependency is `smol-toml`, because Node has no
TOML parser. Validation and argument parsing (`node:util` parseArgs) are hand-written rather than
pulled in. Hooks run through the same binary. Node takes about 50 ms to start, which is acceptable
on every tool call.

## factory.toml

`examples/factory.toml` is the full reference. Abbreviated:

```toml
[human]
name = "Alex"

[github]
org = "acme"
bots = ["coderabbitai", "Copilot"]

[paths]
repos = "~/src"                       # parent of the checkouts unless a repo says otherwise

[repos.web]
remote = "acme/web"
path = "web"                          # relative to paths.repos
base = "main"
gate_checks = ["lint", "test"]        # at least one must run, and every one that runs must pass
local_checks = ["npm run lint", "npm test"]

[repos.api]
remote = "acme/api"
base = "main"
gate_checks = ["test"]

[stacks.web]
repos = ["web"]
slots = 3
reserve = [0]                         # the human's own stack, never allocated
script = "stacks/web.sh"              # workspace-relative, see the stack contract

[stacks.backend]
repos = ["api", "web"]                # a slot holds one worktree per repo
slots = 2
pin = { bea = 1, cal = 2 }            # optional: a builder always gets the same slot

[roles.lead]
cwd = "lead"                          # workspace-relative; its CLAUDE.md and .claude/skills load
model = "opus"
effort = "high"
permission_mode = "bypassPermissions"
settings = "lead"                     # a template in the package, extended by config
extra_hooks = ["status"]

[roles.builder]
model = "opus"
permission_mode = "bypassPermissions"
settings = "builder"

[roles.reviewer]
cwd = "reviewers"
permission_mode = "auto"
settings = "readonly"

[[agents]]
name = "ada"
role = "lead"
remote_control = true

[[agents]]
name = "bea"
role = "builder"
stack = "backend"
appendix = ["briefs/backend.md", "repo:AGENTS.md"]

[tracker]
kind = "jira"                         # or "none"
site = "acme.atlassian.net"
queue_jql = 'assignee = currentUser() AND statusCategory = "To Do" AND sprint in openSprints()'
key_pattern = '^[A-Z][A-Z0-9]+-\d+$'

[tracker.status]                      # factory state -> the status the ticket should read
building = "In Progress"
colleague-review = "In Review"
done = "Done"

[board]
host = "localhost"
port = 8787

[gate]
prose_remark = 30                     # added comment lines that make the gate stop before sending

[watchers]
queue_every_minutes = 15
round_minute = 7
model = "sonnet"
relay_model = "haiku"
```

The program carries no text addressed to a named person. Every instruction a session reads comes
from the workspace.

## The stack contract

The program owns the slots. The workspace owns what a slot runs.

**The engine** (`stacks/engine.ts`):
- keeps a registry per stack in `state/stacks/<stack>.json`, mapping each slot to its worktree per
  repo and when it was created
- allocates in this order: the worktree's existing slot, the agent's pinned slot, a free slot, a
  slot whose worktree vanished (reclaimed by calling the script's `destroy`), then a yieldable slot
  held by the stack's own idle worktree
- places multi-repo stacks, handing a borrowed repo back to its slot's own worktree
- guards against a reserved slot, another builder's slot, and a worktree with no builder
- runs detached processes with pid files, kills a process tree, and waits for readiness and port
  release, offered to scripts as `factory stack run-detached` and `factory stack wait-http`
- exports the TSV the board reads

**A stack script** is called as `<script> <verb>`, with this environment:
- `FACTORY_STACK`, `FACTORY_SLOT`
- for each repo in the stack, upper-cased, `FACTORY_WORKTREE_<REPO>` (the slot's worktree) and
  `FACTORY_CHECKOUT_<REPO>` (the human's main checkout)
- `FACTORY_SLOT_DIR`, a directory the script owns for this slot's files
- `FACTORY_WORKSPACE`, `FACTORY_LOG_DIR`

Verbs:
- `up`, `down`, `destroy`, `url`
- `status`, which prints `name<TAB>url<TAB>health` rows for the board
- `doctor`, which prints `ok|MISSING <what> [fix: <step>]` lines for the stack's own needs on the
  machine, such as a container runtime, hostnames or certificates

Exit 0 is success. Otherwise the stderr is shown.

Builders run `factory stack up [--slot N]` from their worktree. Ports, hostnames, databases and
container projects are the script's business, derived from `FACTORY_SLOT`.

## Claude Code integration

- Settings are rendered at every launch into `logs/run/settings-<agent>.json`, from the role's
  template plus config. Hook commands name the `factory` binary. Write directories and path rules
  are computed from the workspace. Tracked files carry no absolute paths.
- Sessions use `--bg`, `--remote-control`, `--add-dir` (before the prompt, since it is variadic),
  `--append-system-prompt-file`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `autoMemoryEnabled: false`,
  `crossSessionInbound`, `isolatePeerMachines`, and a READY handshake on first contact. Each
  worktree gets its own https push config, so pushes never depend on an ssh agent.
- The claude binary is `$CLAUDE_BIN`, else `claude` on PATH, else `~/.local/bin/claude`.

## Names

The lead is found by `role = "lead"`, and `factory restart-lead` restarts it. Messages from the human
have kind `human`, and the board shows `human.name`. Agent names exist only in `factory.toml`.

## Platform

macOS first. launchd, osascript and dscacheutil sit behind `scheduler/`, `notify.ts` and the
workspace's stack scripts, so Linux can be added later without touching anything else. Linux is
not built now.

## Build order

Each step is one reviewable change, built and tested against a temporary workspace.

1. Package, config and workspace resolution; state, fleet, launch, worktree and messages; the
   `status`, `state`, `dispatch`, `stop`, `review`, `say`, `messages`, `sessions`, `drop`, `up`,
   `down` and `restart-lead` subcommands.
2. Settings rendering, and the hooks.
3. The board: server, inbox, static assets.
4. The gate: ready, send, wait, delta, comment, media, demo.
5. Stacks: the engine and the contract.
6. Tracker, watchers and scheduler.
7. Doctor and the README.

## Tests

node:test, with no test framework dependency. Tests cover:
- the state machine walked through every transition
- workspace resolution
- config validation messages
- the guard's allow and refuse table
- stack placement and hand-back

Add a test where a mechanism is subtle, not one per permutation.
