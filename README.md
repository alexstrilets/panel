# panel

A [Claude Code](https://claude.com/claude-code) skill for collaborative agent work in herdr-managed terminal panes: one agent implements, the others critique, you adjudicate.

## What it does

`/panel` hands a task to whatever coding agent is running in another herdr pane (codex, zcode, antigravity/agy, opencode, pi, omp, etc.), waits for it to finish, and reviews the actual diff itself — in the calling session's own context, not a spawned subagent, so the review keeps the task's original scope and acceptance criteria in view.

Given more than one candidate pane (`codex-pane=`, `zcoder-pane=`, `agy-pane=`), it routes the implementation to whichever agent best suits the task's failure mode — security/correctness-critical work to one, spec-fidelity work to another, claim-checking work to a third — and turns the panes it didn't pick into concurrent, read-only cross-reviewers.

It loops fix rounds up to three times on concrete review findings; if meaningful issues remain after three rounds, it finishes the fix itself rather than looping indefinitely.

## Install

Copy `panel/SKILL.md` into your Claude Code skills directory (e.g. `~/.claude/skills/panel/SKILL.md`), or symlink it. It requires Herdr to be running the sibling agent panes it drives.

### Enable ZCode state reporting in Herdr

ZCode is not currently a native Herdr agent. The bundled `panel/herdr-zcode` plugin bridges the two by translating ZCode hook events into Herdr semantic state reports. This lets the panel agent use `herdr agent list` and `herdr agent wait` without repeatedly reading the ZCode pane.

The integration reports these states:

| ZCode event | Herdr state |
| --- | --- |
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse` | `working` |
| `PermissionRequest` | `blocked` |
| `PostToolUse`, `PostToolUseFailure` | `working` |
| `Stop` | `idle` |

Install it as a local ZCode plugin:

1. Copy or symlink `panel/herdr-zcode` into a local ZCode plugin location, for example:

   ```sh
   mkdir -p ~/.zcode/plugins
   ln -sfn "$(pwd)/panel/herdr-zcode" ~/.zcode/plugins/herdr-zcode
   ```

2. In ZCode, open Settings → Plugins, add the local plugin source if it is not already listed, and enable `herdr-zcode`.
3. Confirm that ZCode hooks are enabled in the user-level ZCode configuration (`~/.zcode/cli/config.json`). The plugin supplies the hook definitions; do not duplicate the same `hooks/hooks.json` path in the plugin manifest.
4. Start a new ZCode session. ZCode snapshots hook configuration when a session starts, so an already-running session will not necessarily load the plugin.

The hook is a no-op outside Herdr. Inside a Herdr pane it uses `HERDR_PANE_ID`, `HERDR_BIN_PATH`, and `HERDR_ENV`, so no workspace or pane IDs need to be hard-coded.

Verify the integration from any Herdr-aware terminal:

```sh
herdr agent list
herdr agent get <zcode-pane-id>
herdr agent wait <zcode-pane-id> --until idle
```

If the pane still appears as `unknown`, check that ZCode was started inside Herdr and inspect the detection snapshot with `herdr pane read <zcode-pane-id> --source detection`. A Herdr server restart is not required when enabling the plugin. The ZCode session must be newly started, and Herdr’s built-in detector still will not list ZCode as a native agent.

The integration reports lifecycle state and does not provide native ZCode session restoration, process-exit release, model metadata, or quota metadata. Herdr documents this custom integration mechanism in its [integration guide](https://herdr.dev/docs/integrations/), and ZCode documents plugin hooks in its [hooks guide](https://zcode.z.ai/en/docs/hooks).

## Usage

In herdr start your main agent in one the workspace, I usually use claude with opus 5 , then open 3 additional panes and start your other agetns there. My choice is usually agy, zcode and codex (running luna on xhigh).
In the main coding agent prompt /panel <task description>

```
/panel <task>
/panel codex-pane=<id> zcoder-pane=<id> agy-pane=<id> <task>
```

See `panel/SKILL.md` for the full workflow, routing heuristics, and guardrails.
