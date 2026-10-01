# Panel

**One agent implements. Other agents review. Your main agent verifies the evidence. You decide the scope.**

Panel is a [Claude Code](https://claude.com/claude-code) skill for coordinating coding agents that
already run in [Herdr](https://herdr.dev/docs/integrations/)-managed terminal panes. You give your
main agent a task and the panes it may use. It delegates the implementation, reads the actual
changes, collects independent reviews, and sends back one consolidated set of fixes.

This repository contains workflow instructions — not an agent runtime and not a hosted service. The
delegated agents are **real, already-running CLI sessions in sibling panes**, not Claude Code's
built-in subagents, and they may use different tools or models: Codex, ZCode, Antigravity (`agy`),
OpenCode, Pi, OMP, or anything else that accepts terminal prompts.

## Contents

- [Vocabulary](#vocabulary)
- [How it works](#how-it-works)
- [One review cycle](#one-review-cycle)
- [The round budget](#the-round-budget)
- [Why the extra review](#why-the-extra-review)
- [Install](#install)
- [Quick start](#quick-start)
- [Coordination and safety rules](#coordination-and-safety-rules)
- [Optional: ZCode state reporting](#optional-zcode-state-reporting)
- [Repository contents](#repository-contents)

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Pane** | One Herdr-managed terminal. Identified as `p4` inside a workspace or fully as `w3:p4`. |
| **Workspace** | The set of panes Herdr groups together. Pane numbers repeat between workspaces. |
| **Implementer** | The single pane allowed to write to the checkout during a cycle. |
| **Reviewer** | A read-only pane that reports cited findings and never edits, builds or commits. |
| **Brief** | The message sent into a pane. Long briefs live in a file; the pane gets one line with its path. |
| **Completion token** | A unique string the brief requires as the last line of output, proving *this* dispatch finished. |
| **Frozen tree** | The state under review. No writes or builds by anyone until every reviewer has reported. |
| **Cycle** | Implement → review → verify → decide. At most three implementation rounds inside one cycle. |

## How it works

```mermaid
flowchart TD
    classDef you fill:#fdf1e0,stroke:#c07817,color:#1b1b1b
    classDef main fill:#e9eefb,stroke:#33609c,color:#1b1b1b
    classDef writer fill:#e7f4ea,stroke:#2f7a45,color:#1b1b1b
    classDef reader fill:#f2eafb,stroke:#6b4a9c,color:#1b1b1b

    YOU["You<br/>task, documents, panes, scope decisions"]:::you
    BRIEF["Main agent<br/>resolve panes, route, write brief"]:::main
    IMPL["Implementer pane<br/>sole writer"]:::writer
    REVS["Reviewer panes<br/>read-only, one angle each"]:::reader
    REVIEW["Main agent<br/>read the real diff, open every citation"]:::main
    GATE["Main agent<br/>validation gate alone, from a clean state"]:::main
    DECIDE{"Accept, fix again,<br/>or ask you?"}:::main
    OUT["Handoff: evidence, caveats,<br/>reviewed file hashes"]:::you

    YOU --> BRIEF
    BRIEF -->|"brief + unique token"| IMPL
    BRIEF -.->|"read-only brief per angle"| REVS
    IMPL -->|"changes and evidence"| REVIEW
    REVS -.->|"cited findings"| REVIEW
    REVIEW --> GATE --> DECIDE --> OUT
```

The diagram shows a main agent plus sibling panes: one implements, and every other named pane reviews
the same frozen change from a different angle — specification fidelity for one, correctness and
boundaries for another. With two sibling panes there is one independent reviewer; with only one, the
main agent reviews the work itself and reports the missing cross-agent coverage.

### A round, step by step

1. **Validate the participants.** Check each pane's identity, working directory and readiness, and
   read the repository's own agent instructions before preparing any brief.
2. **Choose one implementer.** Route by the task's likely failure mode, not its size. An explicit
   `pane=` overrides routing. Agent preferences are starting heuristics, not model guarantees.
3. **Delegate a concrete brief.** Include scope, acceptance criteria, source documents, constraints,
   required evidence and a unique completion token. Long briefs go in a permitted scratch file
   rather than a multiline terminal paste.
4. **Wait for real completion.** Combine Herdr's state tracking with the completion token for that
   dispatch. An idle pane alone can mean a question or a permission prompt, not finished work.
5. **Review independently.** The main agent reads the actual diff in its own context. Other named
   panes review concurrently, each with a different question — specification omissions and wrong
   values, correctness and boundaries, or interface claims and test quality.
6. **Verify, then decide.** Open the cited sources, reproduce relevant behavior, and run the
   repository's full validation gate alone. Then send one merged fix brief to the same implementer,
   or accept with evidence and caveats.

## One review cycle

```mermaid
sequenceDiagram
    actor You
    participant Main as Main agent
    participant Impl as Implementer pane
    participant A as Reviewer A
    participant B as Reviewer B

    You->>Main: Task, documents, permitted panes
    Main->>Main: Resolve panes, route, read repo instructions
    Main->>Impl: Brief, evidence requirements, unique token
    Impl->>Impl: Implement and collect evidence
    Impl-->>Main: Report + unique completion token
    Note over Main,Impl: Implementation frozen — nobody writes or builds
    par Reviewer A — specification fidelity
        Main->>A: Requirements brief, read-only
        A-->>Main: Cited findings + token
    and Reviewer B — correctness and boundaries
        Main->>B: Different angle, read-only
        B-->>Main: Cited findings + token
    end
    Main->>Main: Read the diff and open every cited line
    Note over Main: Clean-state validation gate — alone, after both reviewers
    alt Verified defects, rounds remaining
        Main->>Impl: One consolidated fix brief
        Note over Main,Impl: The fix is reviewed exactly like the original
    else Acceptance criteria satisfied
        Main-->>You: Evidence, caveats and reviewed file hashes
    else Scope or permission decision
        Main->>You: Ask before proceeding
    end
```

Two rules in that diagram carry most of the weight. Reviewers run **concurrently and read-only**, so
they can work safely while the implementer still owns the tree — but the authoritative gate runs
**after** they report and **alone**, because two concurrent builds against one checkout produce
failures that look real and are not.

## The round budget

```mermaid
flowchart TD
    B["Brief"] --> W["Implement"] --> R["Review: diff, reviewers, clean-state gate"]
    R -->|"defects, rounds left"| F["One consolidated fix brief"]
    F --> R
    R -->|"clean"| A["Accept and hand off"]
    R -->|"defects after round three"| M["Main agent finishes it,<br/>then gets reviewed too"]
    M --> A
    R -->|"product or scope decision"| U["Ask the user"]
```

The cap governs **looping on the same findings**, not the total number of reviews. A genuinely fresh
defect starts a new cycle — but if every cycle turns up serious findings, the main agent says so and
names the gap in the brief or the review method rather than looping quietly. A fix round is the
second half of the round that produced it: reviewing a fix is never a fourth round.

## Why the extra review?

A green build does not prove the requirements were implemented, and several agents can agree on the
same wrong reading. Panel asks for checkable evidence rather than a vote:

- Open the cited source before turning a review finding into a fix instruction.
- Check both missing requirements and produced values that disagree with the specification.
- Verify that tests cover the changed code, fail for the intended reason when behavior breaks, and
  have not been weakened.
- Review fakes and mocks against the real provider contract; test allowed outcomes as well as denied ones.
- After a fix, inspect callers, changed expected values and regressions — not just the named symptom.
- Record reviewed file hashes so the eventual commit can be compared with the working tree that was
  actually reviewed.

## Install

### Prerequisites

- Claude Code as the main agent, with shell, file-reading and user-question tools available.
- Herdr running the participating terminal panes, with its CLI available to the main agent.
- At least one sibling coding-agent session, already started in the intended repository or worktree.
- Active Herdr state tracking for semantic waits. A completion-token fallback is documented for
  agents without a hook.
- Git and the target project's normal validation tools. Node.js is additionally required only for
  the optional ZCode hook below.

Panel does not start or authenticate the sibling agents for you. Their ordinary permissions,
provider access and usage charges still apply.

From the root of this checkout, copy the skill into your user-level Claude Code skills directory:

```sh
mkdir -p ~/.claude/skills/panel
cp panel/SKILL.md ~/.claude/skills/panel/SKILL.md
```

This replaces an existing installed copy, so preserve any local customizations first. Alternatively,
symlink the file so future repository updates are picked up automatically:

```sh
mkdir -p ~/.claude/skills/panel
ln -s "$(pwd)/panel/SKILL.md" ~/.claude/skills/panel/SKILL.md
```

The skill is self-contained: no separate delegation skill is required.

## Quick start

1. Open the target project in a Herdr workspace.
2. Start Claude Code in the main pane. Start one or more coding agents in sibling panes pointing at
   the same checkout, and leave them idle until assigned work.
3. Inspect what Herdr can see:

   ```sh
   herdr agent list
   herdr integration status
   ```

4. In the main agent, invoke `/panel` with real pane IDs and a concrete task.

**Single implementer, main-agent review:**

```text
/panel pane=p4 Fix the flaky sorting test in tests/sort.test.ts
```

**Route the implementation and use the remaining panes as reviewers:**

```text
/panel codex-pane=p5 zcoder-pane=p4 agy-pane=p3 Implement the serializer per docs/spec.md
```

**Fully qualified pane ID:**

```text
/panel pane=w3:p4 Add regression coverage for empty input
```

These IDs and paths are illustrative; replace them with your own. A bare `pN` resolves against the
main session's `HERDR_WORKSPACE_ID`, never against the currently focused workspace. Without that
environment value, supply a full `wX:pN` ID. The skill refuses to target its own pane.

Named pane arguments may appear in any order. `zcode-pane=` aliases `zcoder-pane=`, and
`gemini-pane=` and `antigravity-pane=` alias `agy-pane=`. Any other leading `<name>-pane=<id>`
argument identifies an additional candidate agent; the running agent is checked rather than inferred
from the label.

If you omit pane arguments, Panel asks you to choose — it does not silently recruit sessions. Fix
rounds always stay with the original implementer so its context is retained.

## Coordination and safety rules

- **One implementation writer per checkout.** Separate concurrent implementation tasks need separate
  worktrees. Reviewers do not edit, create files, stage or commit.
- **Review a frozen version.** Wait for every reviewer's dispatch-specific completion token before
  changing anything. Reviewers must not run builds or any command that writes shared output or caches.
- **Serialize validation.** No overlapping builds, cleanups, fix rounds or second gate jobs. Preserve
  complete logs and the real exit status; never hide a failure behind an output-filtering pipeline.
- **Keep humans in control.** Ask about ambiguity, broader scope, busy or wrong-directory panes and
  unapproved permissions. No blind approval of terminal dialogs, and no staging, committing or
  pushing without an explicit request.
- **Bound the fix loop.** A cycle has at most three implementation rounds, including the first. After
  round three the main agent finishes the remaining in-scope work and obtains independent review of
  its own changes.
- **Review the main agent too.** Manual finishes, and later fixes made in response to your feedback,
  are not exempt from independent review and final validation.
- **Keep private material out of handoffs.** Never send secrets or credentials in prompts, briefs or
  reports. Review logs and scratch files before sharing them, and do not commit coordination artifacts.

These are instructions followed by the agents, **not an enforced sandbox**. Review coverage, tool
access and runtime checks can be unavailable, and the final report must say so rather than imply a
pass. Multi-agent review adds latency and usage cost, so reserve the full panel for work that
benefits from independent scrutiny.

## Optional: ZCode state reporting

The bundled [`panel/herdr-zcode`](panel/herdr-zcode) plugin translates ZCode lifecycle hooks into
Herdr state reports, so the main agent can use semantic state tracking instead of repeatedly reading
the terminal screen when ZCode is not natively detected.

| ZCode event | Herdr state |
| --- | --- |
| `SessionStart` | `idle` |
| `UserPromptSubmit`, `PreToolUse` | `working` |
| `PermissionRequest` | `blocked` |
| `PostToolUse`, `PostToolUseFailure` | `working` |
| `Stop` | `idle` |

### Enable the plugin

1. Make the plugin directory available to ZCode. For example, from this repository root, create a
   local symlink if the destination does not already exist:

   ```sh
   mkdir -p ~/.zcode/plugins
   ln -s "$(pwd)/panel/herdr-zcode" ~/.zcode/plugins/herdr-zcode
   ```

2. In ZCode, open **Settings → Plugins**, add the local plugin source if needed, and enable
   `herdr-zcode`.
3. Confirm hooks are enabled in the user-level configuration (`~/.zcode/cli/config.json`). The plugin
   supplies `hooks/hooks.json`; do not register that file a second time in the plugin manifest or keep
   a duplicate manual registration of the same hook.
4. Start a **new ZCode session inside Herdr**. Hook configuration is captured at session startup, so an
   existing session may not load a newly enabled plugin.

The hook is a no-op outside Herdr. Inside a managed pane it uses `HERDR_ENV`, `HERDR_PANE_ID` and
`HERDR_BIN_PATH`, falling back to `herdr` on `PATH`. No machine-specific binary path or workspace ID
is bundled.

Verify with your actual ZCode pane ID:

```sh
herdr agent list
herdr agent get w3:p4
herdr agent wait w3:p4 --until idle
```

### Troubleshooting and limits

- **Missing from `herdr integration status`:** custom ZCode reporting may still be working. Inspect
  `herdr agent get` instead of assuming the hook needs installing.
- **Reported as `unknown`:** confirm Node.js is available, hooks are enabled, and the session was
  newly started inside Herdr. Inspect `herdr pane read w3:p4 --source detection` with your own pane ID.
- **`agent_not_ready` during dispatch:** registration can disappear while the process stays alive.
  Inspect the pane and confirm whether the prompt landed before retrying. The skill includes a
  direct-pane fallback with an anchored, unique completion token.
- **Idle without a token:** do not assume completion. Inspect for a question, a permission request or
  an exited agent.
- **Herdr server restart:** re-check the pane. This custom integration does not restore sessions, does
  not guarantee a release event when the agent process exits, and does not supply model, quota or task
  metadata.

See Herdr's [integration guide](https://herdr.dev/docs/integrations/) and ZCode's
[hooks guide](https://zcode.z.ai/en/docs/hooks) for the underlying mechanisms.

## Repository contents

| Path | Purpose |
| --- | --- |
| [`panel/SKILL.md`](panel/SKILL.md) | Full delegation, routing, review, verification and handoff instructions |
| [`panel/herdr-zcode/.zcode-plugin/plugin.json`](panel/herdr-zcode/.zcode-plugin/plugin.json) | Optional ZCode plugin manifest |
| [`panel/herdr-zcode/hooks/hooks.json`](panel/herdr-zcode/hooks/hooks.json) | Lifecycle event registrations |
| [`panel/herdr-zcode/hooks/report-herdr.mjs`](panel/herdr-zcode/hooks/report-herdr.mjs) | Node.js hook that reports state to Herdr |
| [`LICENSE`](LICENSE) | License terms |

The published workflow uses generic examples, not private project transcripts or personal
configuration. When updating it from a local copy, preserve the operational lessons without importing
names, private paths, ticket IDs, credentials or identifiable project details.