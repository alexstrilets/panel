# panel

A [Claude Code](https://claude.com/claude-code) skill for collaborative agent work in herdr-managed terminal panes: one agent implements, the others critique, you adjudicate.

## What it does

`/panel` hands a task to whatever coding agent is running in another herdr pane (codex, zcode, antigravity/agy, opencode, pi, omp, etc.), waits for it to finish, and reviews the actual diff itself — in the calling session's own context, not a spawned subagent, so the review keeps the task's original scope and acceptance criteria in view.

Given more than one candidate pane (`codex-pane=`, `zcoder-pane=`, `agy-pane=`), it routes the implementation to whichever agent best suits the task's failure mode — security/correctness-critical work to one, spec-fidelity work to another, claim-checking work to a third — and turns the panes it didn't pick into concurrent, read-only cross-reviewers.

It loops fix rounds up to three times on concrete review findings; if meaningful issues remain after three rounds, it finishes the fix itself rather than looping indefinitely.

## Install

Copy `panel/SKILL.md` into your Claude Code skills directory (e.g. `~/.claude/skills/panel/SKILL.md`), or symlink it. It requires herdr to be running the sibling agent panes it drives.

## Usage

```
/panel pane=<id> <task>
/panel codex-pane=<id> zcoder-pane=<id> agy-pane=<id> <task>
```

See `panel/SKILL.md` for the full workflow, routing heuristics, and guardrails.
