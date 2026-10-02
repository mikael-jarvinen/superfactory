# superfactory

superfactory runs a fleet of Claude Code sessions against a team's repos: a lead the human talks to,
builders that each take one work item to a draft PR, and reviewers that read a PR fresh. This repo
is the program, a TypeScript package on Node with one `factory` CLI. Anything tied to a user, a
machine or a company lives in a workspace that the program reads.

## Install

You need Node 22 or later, Claude Code, the GitHub CLI `gh` (logged in), and git 2.31 or later.
macOS is the only platform built so far.

```sh
git clone <this repo> superfactory
cd superfactory
npm install
npm run build
npm install -g .
```

`npm install -g .` links the `factory` command to this clone. To upgrade, pull and run
`npm run build` again.

## Make a workspace

A workspace is a directory you own, best kept in a git repo of its own. It holds your config and
every instruction your sessions read. Start from the examples in this repo:

```sh
mkdir ~/fleet && cd ~/fleet
cp <clone>/examples/factory.toml .
cp -R <clone>/examples/prompts <clone>/examples/stacks .
```

Then edit `factory.toml`. The comments explain each key. Change every name in it: the human, the
GitHub org, the repos, the agents.

A workspace contains:

| File | When it is needed |
|---|---|
| `factory.toml` | Always. |
| `CLAUDE.md` in `roles.lead.cwd` | Always. The lead reads it first. Skills in `.claude/skills/` next to it load too. |
| `CLAUDE.md` in `roles.reviewer.cwd` | When config has a reviewer. |
| `prompts/round.md`, `prompts/relay.md` | Always. The relay prompt must contain `{text}`. |
| `prompts/queue.md` | When `tracker.kind` is not `"none"`. |
| Each file in an agent's `appendix` | When an agent names it. A `repo:` entry lives in the repo checkout instead. |
| Each `stacks.<name>.script` | When a stack names one. [examples/stacks/app.sh](examples/stacks/app.sh) is a minimal one to start from; the contract is in [docs/design.md](docs/design.md). |
| A settings or `mcp_config` file | When a role names one by path. |
| `demo.env` | Optional. See Demos below. |

The program writes `state/` and `logs/` in the workspace as it runs, unless `[paths]` puts them
elsewhere. Keep both out of git.

The program finds the workspace in this order: `--workspace <dir>`, then `$FACTORY_WORKSPACE`, then
the nearest `factory.toml` above the current directory.

### Demos

A builder can record a demo of its change with `factory demo`. This is optional. It needs
`@playwright/test` and its Chromium, and ffmpeg with libx264:

```sh
npm install -D @playwright/test      # in the workspace
npx playwright install chromium
brew install ffmpeg
```

`demo.env` holds `KEY=value` lines, such as the app's sign-in and base URL, which `factory demo`
passes to the spec. The doctor checks ffmpeg and Playwright only when the workspace has `demo.env`,
or when `@playwright/test` can be found from it.

## Check the machine

```sh
factory doctor
```

The doctor prints one line per check, `ok <what>` or `MISSING <what> [fix: <step>]`. The checks
come from your config: each repo's checkout and GitHub access, the files in the table above, the
board's port, the scheduled jobs, and the demo tools when you use demos. Each stack script's own
`doctor` lines follow, under the stack's name. The doctor only reads. It never installs or starts
anything. Fix each MISSING line as it says, and run it again until it exits 0.

The scheduled jobs are among the checks. Their fix is `factory schedule install`, which refuses
while a prompt they need is missing.

## Start

```sh
factory up
```

This starts the board and the lead. The board is at `http://<board.host>:<board.port>/`, and the
message page, where you talk to the lead, is at `/messages` under it. With `remote_control = true`
you can also reach the lead from Remote Control under its name.

## Commands, by who runs them

`factory --help` lists every command and option.

The human:

| Command | What it does |
|---|---|
| `factory doctor` | What this machine and workspace lack. |
| `factory up [--fresh]` | Start the board and the lead, and in the background any stack slot that does not answer. `--fresh` starts a new thread. |
| `factory down` | Stop every fleet session and the board. |
| `factory restart-lead [--fresh]` | Stop the lead, then `up`. |
| `factory status` | Sessions, and every open work item. |
| `factory messages [-n 20]` | The last messages on the message page. |
| `factory board [--stop]` | Start or stop the board alone. |
| `factory schedule install\|uninstall\|status` | The launchd jobs for the watchers. |

The lead:

| Command | What it does |
|---|---|
| `factory dispatch <agent> <KEY>` | Start a builder on a work item, in a worktree of its own. |
| `factory stop <agent>` | Stop a teammate. Refuses when work is uncommitted or unpushed. |
| `factory review` | Start the first free reviewer. |
| `factory state <KEY> <new-state>` | Move a work item. `factory state --list` shows every open one. |
| `factory drop <LOCAL-key>` | Delete a local work item's record. |
| `factory say "<text>"` | Post to the message page. |
| `factory board --inbox` | Follow the message page, for a monitor in the lead's session. |
| `factory pr-wait <repo> <n> <sha>` | Wait for the gate, then send the PR. |
| `factory pr-ready`, `pr-send`, `delta-range` | The gate's parts, one at a time. |
| `factory pr-comment ...` | Reply inside a review bot's thread. |

Builders, from their worktree:

| Command | What it does |
|---|---|
| `factory stack up` | Bring up the work item's local stack. |
| `factory stack url\|status\|down\|destroy` | Read it, stop it, or with `destroy` delete its data and free the slot. |
| `factory demo <KEY> --init` | Copy the demo template. |
| `factory demo <KEY> <spec.ts> [base-url]` | Record the demo. |
| `factory pr-media <repo> <n> --dir <media-dir>` | Put the demo into the PR body. |

Scripts and hooks. Nobody types these; they are listed so you can recognise them:

| Command | Who runs it |
|---|---|
| `factory watch queue`, `factory watch round` | The scheduled jobs. |
| `factory up` | The scheduled job, at login and twice an hour. |
| `factory hook <name>` | Claude Code, from the settings rendered into `logs/run/`. |
| `factory stack boot` | `factory up`, which starts it detached and logs to `logs/stacks/boot.log`. |
| `factory stack run-detached`, `factory stack wait-http` | Stack scripts. |
| `factory board --serve` | `factory board` and `factory up`, which start it detached. |

## How it works

[docs/design.md](docs/design.md) covers the program and workspace split, `factory.toml`, the stack
contract and the Claude Code integration.
