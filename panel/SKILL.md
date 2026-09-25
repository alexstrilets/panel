---
name: panel
description: "Hand a task to whatever coding agent is running in another herdr pane (codex, zcode, antigravity/agy, opencode, pi, omp, etc.), wait for it to finish, review the actual diff yourself in the current context, and loop fix rounds up to 3 times; if meaningful issues remain after 3 rounds, fix them yourself. Given several of codex-pane=, zcoder-pane= and agy-pane= it routes the task to whichever suits it best and turns the rest into concurrent read-only reviewers. Triggers on: /panel pane=<id> <prompt>, /panel codex-pane=<id> zcoder-pane=<id> agy-pane=<id> <prompt>, delegate to pane, send this to the agent in pane X."
---

# Panel — route a task across herdr panes, then cross-review it

The implementer isn't a Task-tool subagent — it's whatever real coding-agent CLI process is running in a sibling terminal pane (codex, zcode, antigravity's `agy`, opencode, pi, omp, or anything else running under herdr), driven through `herdr`'s socket API (`herdr agent ...`). You submit a prompt into that pane, wait for the real agent to finish, and review its real working-tree changes.

The core loop is **submit → wait → review the real diff → loop fix rounds up to 3** — plus **routing across more than one named agent pane**. With exactly one target, skip routing and run the workflow against that pane. Use routing when two or more of `codex-pane=`/`zcoder-pane=`/`agy-pane=` are available: it sends the task to whichever suits it better and puts the rest to work as concurrent read-only reviewers.

This skill is **agent-agnostic by design** — it targets a pane, not a specific tool. `herdr agent get <pane>` tells you what's actually running there; nothing in the workflow assumes codex or any other harness specifically. Semantic waiting requires an active state-tracking hook — without it, `herdr agent wait` cannot reliably see idle/working/blocked transitions. Check `herdr agent get` and, where applicable, `herdr integration status`; use **Driving a pane with no herdr integration** when no hook is active.

Review happens **in the current context, not a spawned subagent**. You (the session running this skill) already hold the task's scope and acceptance criteria — re-deriving that in a fresh subagent every round costs more than it saves, since the round-trip cost of a subagent is exactly re-establishing context you already have. Read the diff yourself with `git diff` / `git status` / `Read` and judge it directly.

## Input

Invocation is one line. Two forms:

**Explicit target** — `pane=<pane_id> <prompt text>`

- `pane=<pane_id>` must be the first token. A bare pane number (`pane=p4`) is resolved against
  the current workspace; a full `pane=w3:p4` is also accepted. See **Pane ids** below.
  Everything after the first space is the prompt, verbatim.
- If the prompt text is empty, ask the user what task to send.

**Routed** — one or more named agent panes, then the prompt:

```
codex-pane=<pane_id> zcoder-pane=<pane_id> agy-pane=<pane_id> <prompt text>
```

- All are optional and order-independent; any leading `<name>-pane=<id>` tokens are consumed as targets and everything after the last one is the prompt.
- Ids may be bare (`codex-pane=p5 zcoder-pane=p4 agy-pane=p3`) or fully qualified. See **Pane ids** below.
- `zcode-pane=` is accepted as an alias for `zcoder-pane=`; `gemini-pane=` and `antigravity-pane=` for `agy-pane=`.
- With **more than one** given, pick the implementer using **Routing** below, tell the user which you chose and why in one line, then run the normal workflow against that pane. **The panes you did not pick become the reviewers** — see **Cross-agent review**.
- With **one** given, use it — but if Routing says another kind suits the task better, say so in one line before proceeding. Don't refuse to run.
- Panes the user did not name still exist. When a review would benefit from a third reader, `herdr agent list` shows what else is running in this workspace; propose it rather than silently recruiting it.
- If `pane=` is also present, it wins outright — an explicit target is an instruction, not a hint.
- Fix rounds stay with the pane that did the work. Never move a half-finished task to another agent; its context lives in that session.

If no pane parameter is present, one is malformed, or a bare `pN` will not resolve, do not guess — run `herdr agent list` and ask the user to pick, even if only one agent is listed.

## Pane ids: a bare `pN` is allowed

Workspace ids are hard to look up and easy to misremember, so **a pane may be given as a bare
`pN`** (`codex-pane=p4`, `pane=p5`). It always means that pane **in the workspace this session is
running in** — which differs per project, so never carry a workspace id over from an earlier
session or another repo. A fully qualified `wX:pN` is accepted too and passes through untouched.

herdr exports the answer into every pane it runs, so there is nothing to infer:

```bash
resolve_pane() {
  case "$1" in
    w*:p*) T="$1" ;;
    p*)    T="${HERDR_WORKSPACE_ID:?not running under herdr — ask the user for a full wX:pN}:$1" ;;
    *)     echo "malformed pane id: $1" >&2; return 1 ;;
  esac
  [ "$T" = "$HERDR_PANE_ID" ] && { echo "refusing: $T is this session's own pane" >&2; return 1; }
  herdr pane get "$T" >/dev/null 2>&1 || { echo "no such pane: $T" >&2; return 1; }
  echo "$T"
}
```

`HERDR_WORKSPACE_ID` is the current workspace and `HERDR_PANE_ID` is this session's own pane. Use
them; do not derive the workspace from `cwd`, from the focused pane, or from `herdr pane list`
heuristics — those are proxies that break when a repo is open twice or focus moves.

Each failure is a stop, not a guess:

- **not running under herdr** — no `HERDR_WORKSPACE_ID`. Ask the user for a full `wX:pN`.
- **own pane** — the user named the pane this session occupies. Say so and ask which they meant.
- **no such pane** — that number does not exist here. Run `herdr pane list`, show what does exist
  in `$HERDR_WORKSPACE_ID`, and ask. A missing `p4` usually means they are picturing another
  workspace.

Resolve **before** the Step 0 identity check, and state the resolved `wX:pN` in your first message
so a wrong target is visible immediately rather than after the task has landed on it.

## Routing

Only relevant when more than one candidate pane was given. Route on what the task's *failure mode*
would be, not on which sounds fancier. Treat the named pairings below as starting heuristics, not
vendor guarantees or fixed model properties. Revise them from independently verified evidence in
the current environment; do not import private run histories. For another agent kind, apply the
same reasoning, say when you lack evidence, and prefer an idle candidate when no other factor decides.

**Prefer codex when a defect would be exploitable or silently corrupting:**

- authorization and access control — who may do what, tenancy scoping, session and role checks
- secrets handling, redaction, credential paths
- concurrency, transactions, isolation levels, locking, retry semantics
- infrastructure where a misconfiguration fails silently or far from its cause
- correctness-critical core logic that later work will sit on top of

**Prefer zcode when the deliverable is fidelity to written sources:**

- deriving values, taxonomies, enums or contracts from specification documents
- implementing a design or spec that already exists, against established conventions
- conventions, tooling, CI, lint and gate work
- anything where the docs might disagree with each other and someone must notice

**Prefer agy when the job is checking a claim against a source that already exists:**

- does this library actually support the option we configured, at the spelling we used?
- does every item in this list have a test / a handler / an entry on the other side?
- does each acceptance clause map to something that would fail if it broke?
- can this specific assertion fail at all, given what it compares?

An external, enumerable oracle makes this angle concrete: require file:line citations for option
names, return contracts and acceptance-to-test mappings. Source checking does not substitute for
walking a user flow. Assign runtime interaction review separately rather than treating an accurate
contract checklist as proof that a screen is usable.

**Distinguish deciding a boundary from touching one.** Reserve the correctness/security preference
for work that *decides* a security question; application code that merely consumes an established
boundary is fair game for either implementer, with the same verification requirements.

**Brief quality is a routing input.** Specification-oriented work needs concrete scope, constraints
and acceptance criteria. If the task cannot be specified tightly and needs interpretation, prefer
a candidate with verified judgment on ambiguous work — or tighten the brief before routing it.

**Overlap is fine.** When a task is genuinely both, prefer codex if a defect would be exploitable or
silently corrupting, zcode if it would be a wrong value faithfully implemented. When neither fits,
say so and pick an idle candidate. **Never route on task size**: a one-line authorization change
still has a correctness-critical failure mode.

**What decides your verification burden** is whether an agent's report matches reality. Verify
regardless, but use reproducible evidence to decide where to look more closely. Split that judgment
by role: an implementer's self-assessment and a reviewer's independently checkable citations are
different evidence. A weak self-report does not automatically invalidate a useful review finding.

**Severity calibration belongs in the brief.** Tell every reviewer to be conservative: a test
thinner than its name is generally a test-quality finding, not automatically a production blocker.
Ask for the user-visible consequence and re-derive severity rather than inheriting the label.

**Cautions for every pane, including opencode:**

- **A self-reported clean gate still needs a clean-state re-run.** If it cannot be reproduced,
  require investigation of the discrepancy rather than another assertion that it passed.
- **A scope decision is to be reported, not built.** An unrequested migration or shared-invariant
  exception needs the user's approval, even if it would make a test easier to write.
- **Budget for cost and latency.** Agree any task-specific limits with the user, brief tightly,
  and consolidate findings rather than dispatching redundant rounds. Read the permission-dialog
  guidance under **Guardrails** before driving an opencode pane.

## Tool requirements

- `Bash` — to run `herdr agent ...` commands and `git diff`/`git status` for review
- `Read` — to inspect changed files directly when the diff alone isn't enough context
- `AskUserQuestion` — for ambiguous scope or blocked-agent situations

## Guardrails

- The target pane's agent is the **only implementation writer** during rounds 1–3. Do not edit
  implementation files yourself until round 3's fix has been requested and still fails review.
  Briefs and review records are coordination artifacts, not permission to change the implementation.
- **One writer per working tree, always.** Never run two implementers against one checkout.
  Half-finished edits and clobbered build output create misleading failures. A second implementation
  lane needs its own worktree. Reviewers may read concurrently with each other, but review a frozen
  version: ownership stays with the implementer while writes pause for review.
- **Reviewers may read; they must not build.** State the off-limits commands explicitly. Builds,
  incremental typechecks and format-write commands can write generated output or caches; for
  example, `tsc -b` writes build output and `*.tsbuildinfo`. Do not assume a command is read-only
  because it is called a check or a test. Permit check-mode linters, formatters or tests only after
  confirming they do not modify the shared tree or collide on external resources. Unique test
  databases alone do not establish that all outputs are isolated. **You** run the authoritative
  clean-state gate alone after the reviewers have reported.
- **"Alone" includes the implementer and the next fix round.** Sequence it: implementer idle →
  reviewers complete → gate → read result → dispatch next round. Never overlap a gate with an
  in-flight fix, and re-run it after the last write, not before.

  **"Alone" excludes your own second job too.** Never have two gate/build jobs in flight against
  one checkout, or clean output while a preceding job may still use it. Do not sequence pipelines
  with a process-presence loop: short-lived build stages have gaps between them. Wait for the
  actual job's completion notification and exit status.

  **"Alone" excludes your edits while reviewers read.** Before any write, confirm **every**
  reviewer emitted its dispatch-specific completion token, not just one reviewer or an idle pane.
  Otherwise a verdict may cover mixed file versions. If an urgent change cannot wait, pause review,
  identify the changed files to every affected reviewer, and re-review the changed state; earlier
  findings on those lines are unverified.
- **Never pipe the gate through `tail`, `head` or `grep`.** A successful final pipeline command can
  hide a failing gate, and truncated logs lose counts and diagnostics. Capture the full output and
  gate status before reading selectively. For a repository whose documented gate is `pnpm check`:
  `pnpm check > "$LOG" 2>&1; gate_rc=$?; printf 'exit=%s\n' "$gate_rc"; exit "$gate_rc"`.
  Run this in the gate's dedicated shell job with a unique log path, not in an interactive shell
  you need to keep open. Use the actual repository gate, not this example blindly.
- **Exit code 127 is an execution problem, not a test verdict.** It commonly means command not
  found. In zsh, a scalar containing a command plus arguments is not automatically word-split;
  write the command explicitly or use a function/array. A gate may have run partially before a
  missing subcommand, but it did not complete successfully. Fix the invocation and re-run; 127
  never establishes that a mutation was caught by its intended assertion.
- Review is read-only: use `git diff` / `git status` / `Read`. Even a small fix belongs in the next
  instruction or the manual finish after round 3, not silently inside a review step.
- Before submitting, confirm `agent`, `agent_status` and `cwd` with `herdr agent get <pane>`.
  If the agent is not idle, ask before interrupting. A mismatched directory also needs confirmation.
- If integration status is **not installed** or **outdated**, warn before relying on state tracking.
  Offer `herdr integration install <name>` only with the user's confirmation of that local config
  change. Zcode can have an active custom hook without appearing in `herdr integration status`;
  check `herdr agent get` instead of treating absence as failure. An outdated row calls for
  corroborating state with the completion token, not an automatic assumption that the hook is broken.
- Never send secrets, `.env` contents or credentials in a pane prompt or brief.
- Do not stage, commit or push unless explicitly requested. Preserve unrelated working-tree changes.
- Max **3 review rounds per finding cycle**. Loop only for concrete, meaningful issues, not polish.
  Product or scope decisions always go back to the user, regardless of round count.
- **Driving opencode: expect in-app permission dialogs separate from herdr state tracking.**
  With an active hook, drive it through the normal semantic commands. Its access controls may
  prompt for external paths, including an external brief or build scratch directory. Such requests
  can recur across paths and rounds; a routine-looking request is still a permission decision.
  - Read `herdr agent read <pane> --lines 200 --source visible` to inspect the actual dialog when
    the default source refuses a blocked read. Expand the capture if the request is not visible.
  - **Ask the human unless the exact operation and scope are explicitly preauthorized.** Reading
    a brief is not authorization for writes, cleanup, secrets or unrelated paths. Inspect the
    requested action, path and available choices each time. If preauthorized, select the narrowest
    matching option only after verifying its label and focus; never blindly send Enter or assume
    that "Allow once" is the default. If focus or scope is unclear, ask the human to handle it.
  - Do not disable permissions, broaden sandbox rules or use an alternative command to bypass a
    blocked request. For a new brief, use an already permitted, repository-approved scratch
    location where possible. Do not relocate a blocked operation to evade its approval boundary.
    Keep scratch files out of commits and remove only artifacts created for this task after
    acceptance; never recursively remove an existing directory of unknown ownership.
- Quote prompt text carefully: it may contain quotes, backticks or newlines. Prefer single-quote
  escaping or the harness's safe argument handling over naive shell interpolation.
- **A long brief goes in a file, not down the wire.** Use read/write tools for the file, then send
  a single-line instruction with its safely quoted path. Multiline TUI input can submit prematurely.
  Prepare coordination files before review begins; do not use them to violate the tree freeze.
- **Verify claims yourself; never accept the agent's report as the verdict.** Apply the
  **Verification contract** even when the report is confident and detailed.

## Driving a pane with no herdr integration

**Use zcode's hook when it is active.** With the state-tracking integration enabled,
`herdr agent get` reports `agent: zcode` with a real `agent_status`, and the pane appears in
`herdr agent list`. Drive it with `herdr agent prompt` / `herdr agent wait` like other hooked agents.
Its state mapping is: new/cleared/compacted session and end-of-turn → `idle`; prompt submitted,
tool invoked, tool completed *or failed* → `working`; permission request → `blocked`.

Zcode integration caveats:

- It may be **absent from `herdr integration status`** because it is not natively detected. Do not
  treat that absence as proof the hook is missing; check `herdr agent get`.
- There is **no guaranteed release event when the process exits**, and sessions are **not restored
  after a herdr server restart**. `idle` alone cannot distinguish completion from a dead process.
  Require `idle` plus the current completion token, and re-check the pane after a server restart.
- **Registration can disappear; check immediately before each dispatch, not only at Step 0.**
  If `herdr agent prompt` returns `agent_not_ready: not an active named agent`, read the pane with
  `herdr pane read` before assuming the process died. If it is still alive, idle, and has not
  accepted the prompt, fall back to `herdr pane run` plus an anchored completion-token wait.
  Do not duplicate a dispatch that may already have landed.
- Model, token, quota and task metadata may be unavailable; do not infer them from absent fields.

Use the path below for an agent without an active hook. It may report `agent_status: unknown`,
may not appear in `herdr agent list`, and cannot reliably use semantic prompt/wait commands.
Find it with `herdr pane list`, validate its identity and working directory, and confirm it is ready:

1. Send with `herdr pane run <pane> "<one line>"` (sends the text plus Enter).
2. Ask the agent in the brief to print a unique completion token as the **last line, alone on its
   own line**, only after completing the requested work and evidence report.
3. Wait with an **anchored regex**, backgrounded when the harness supports it:
   `herdr pane wait-output <pane> --regex '(?m)^\s*TOKEN\s*$' --source recent-unwrapped --timeout <ms>`

Anchoring is not optional. A bare `--match TOKEN` can match an echoed plan mentioning the token
before work starts. If a wait returns and the working tree is unchanged, investigate before
concluding that the agent did nothing. An echoed brief is not completion evidence.

**Anchoring is also not sufficient: make every token unique per dispatch.** Scrollback still
contains previous rounds' tokens. Reusing `REVIEW_DONE` can make the next wait return immediately
while the reviewer is still reading. Include task, round, pane and a fresh suffix — for example,
`TASK_R2_P4_DONE_<nonce>` — and never reuse a token inside the session. If one was reused, require
an increase over the previously recorded count of standalone matches and corroborate the current
report; if that baseline is unknown, obtain a fresh completion acknowledgement instead.

Everything else — review, rounds, guardrails — is unchanged.

**Do not poll a pane's screen to track progress when the agent has a hook.** Use `herdr agent wait`.
Repeated screen reads waste turns and can miss a permission prompt outside the captured window.
Read once when the wait returns; for `blocked`, use the visible source and enough lines to see the
actual request. A hookless timeout is a reason to inspect, not a reason to assume completion.

## Verification contract

An agent's report is a claim, not a verdict. Demand evidence in the brief, then check the evidence
rather than the prose.

**In the brief (Step 1), require the agent to return:**

- the actual values it observed for anything it filters, matches or parses on — read from the real
  source, not assumed from a name;
- raw output of the full gate and its exit status, not just a summary;
- an explicit list of what it removed, renamed, worked around, or deliberately left undone;
- a self-audit against the governing documents and acceptance criteria, followed by the unique
  completion token for this dispatch.

**Before accepting (Step 2), verify independently — never from the diff alone:**

- Re-run the full gate yourself **from a clean state**, after all reviewers have finished and the
  implementer is idle. Use the repository's documented clean procedure for generated outputs and
  incremental caches; stale caches can produce false failures *and* false passes. Do not delete
  user work or unknown paths to obtain a clean state.
- For any claim about an interface it consumed, open the other side and confirm the shape matches.
- For new tests, **break the behavior they guard and confirm they fail for the expected reason**.
  Use an isolated disposable worktree or ask the sole implementer to run the probe, preserving
  the one-writer rule. Do not mutate the shared tree during review. Restore mutations, verify the
  restoration, and run the gate on the final unmutated state. A passing test alone does not prove
  that it would catch a regression; a command-launch failure is not a successful mutation probe.
- Confirm existing tests were not *weakened*: assertions loosened, cases deleted, or globs narrowed
  so new code escapes an existing sweep. A green suite alone does not establish this.
- **Confirm the gate actually covers the new code.** Read typecheck `include`/`exclude` settings
  and test-runner project globs. A source-only include can leave test files entirely untypechecked.
  State coverage gaps rather than calling an uncovered file verified.
- **Ask what the harness silences, not just what it runs.** Check permissive/no-errors DOM schemas,
  shallow rendering, mocks that replace the thing under test, `--passWithNoTests`, and module-name
  mappers pointing to empty stubs. These can hide whole classes of failures. Name the acceptance
  criteria they cannot verify and route those to runtime or end-to-end checks instead.
- **Visibility gated by role or permission gets a runtime check with one allowed and one denied
  identity.** Structural directives, guards and feature flags can be silently omitted by a lenient
  harness. A test of the permission list does not prove the element renders correctly. Name both
  test identities in the acceptance criteria without exposing credentials, and check both in the
  running app. The allow and deny cases are separate behaviors; one says nothing about the other.
- **A fake used by a contract suite needs its own review.** A shared suite against a real backend
  and a fake is only as honest as the fake's model of the provider. Ask which documented behaviors
  it models and whether the suite would fail if the adapter stopped supplying required inputs.
  For a generic example, a fake that always rejects duplicates cannot verify that the caller sends
  the condition the real provider requires to prevent replacement. Give fake fidelity its own
  review question; do not let it disappear into the category of test scaffolding.

**Verify a finding against the relevant pre-fix baseline, not only the current tree.** A runtime
check against code already repaired cannot distinguish a real defect from a false report. Record
what the baseline value was and compare the relevant versions. Use `HEAD` only if it really is the
reported version; otherwise preserve a pre-fix snapshot without disturbing unrelated work.
Treat "unproven — confirm at runtime" as an open item with an owner, never as a soft dismissal.

**Enumerate in both polarities, not just exhaustively.** A suite can enumerate every catalog item
and still exercise only denials. A fail-closed implementation can incorrectly reject legitimate
operations while every denial test passes. For each entry, ask whether a case passes only when
access is correctly *granted*, as well as whether forbidden access is denied. Exhaustive names
are not exhaustive outcomes.

**Reconcile the test count across rounds.** Compare reported counts with raw output and explain
changes. A decrease may reflect consolidation into an enumerating test or an accidentally deleted
case. An unchanged count may be legitimate when assertions were added to existing tests. Check
what changed and whether it fails under a relevant mutation; do not assume every behavior change
must increase the number of tests.

**Check the values, not only the shape.** Tables, constraints, wiring and mutation-sensitive tests
can all be structurally sound while derived values diverge from the specification. For each value
defined by a document, identify the document line that fixes it and compare the produced value.
Ask this separately from structural correctness or a reviewer may answer only the latter.

**A disclosed simplification is not an approved one.** Verify its consequence, not just whether
the description is accurate. Does the simplification defeat the purpose of the task or remove
information needed by an acceptance scenario? If so, disclosure does not authorize it; ask the user.

An agent that flags a gap it could not close is doing the right thing. A success claim you cannot
reproduce must go back with the specific discrepancy, not be accepted on confidence alone.

## Cross-agent review: the implementer never reviews itself

On specification-governed or expensive-to-get-wrong work, the implementer's report is one input,
your review is another, and independent reviewers supply additional evidence. An implementer's
self-audit does not count as the independent review of that same change.

For a user-supplied three-pane set, the default fan-out is:

- codex implemented → **zcode and agy review**, you review.
- zcode implemented → **codex and agy review**, you review.
- agy implemented → **codex and zcode review**, you review.

Apply the same rule to other named agents. **Use both non-implementing panes when both were
provided**, not just one. Independent readers can catch different blind spots even after your
own review and a clean gate. With fewer panes, use the available non-implementers; with only one
target, review in the current context and disclose the missing cross-agent coverage. Propose extra
panes to the user rather than silently recruiting them. Run reviewers concurrently on a frozen
working tree, never concurrently with implementation writes or builds.

**Give them different angles, not the same brief.** Identical briefs duplicate findings without
adding much coverage. Default angles:

- **zcode — specification fidelity, in both directions:** what documents require that nothing
  implements *and* nothing discloses (omission), and whether produced values match the documents
  (divergence).
- **codex — correctness and boundary review:** authorization, tenancy, concurrency, trust boundaries,
  and failure paths within the authorized task scope.
- **agy — source-backed claim checking:** dead code and prior-spec leftovers, interface claims
  checked against the other side, and tests whose assertions cannot fail.

Every brief still carries the read-only rule, already-reported findings, and the instruction to
report document conflicts rather than resolve them. Spend an additional dispatch on a new question,
not just another reader answering the same question.

**Assign the angle to the brief, not the agent.** The pairings are defaults, not inherent expertise.
When reviewers disagree, settle the finding with source evidence, a runtime check or an isolated
mutation probe rather than the reputation of the supposed specialist. Agreement is still multiple
claims, not independent confirmation of the behavior. The value is independent reasoning.

**Name the divergence half explicitly.** Cite the governing sections and ask which source line
fixes each derived value and whether the code matches it. A structural review alone will not
re-derive content from the specification.

**Open the cited line before a finding becomes an instruction.** A file:line citation is itself a
claim. Verify that the line actually says what the reviewer reports, not merely that code and some
expectation differ. Quote the governing line in the fix brief. Otherwise an implementer can change
both code and its oracle to satisfy a misread requirement while the tests stay green.

**"This is unreachable" is path-sensitive.** Removing a guard branch is not necessarily removing
dead code. Trace every input and caller, including paths not examined by the reviewer, and check
what the fallback does. A branch redundant on one operation may still handle a valid input on
another. Prefer a test establishing unreachability over deletion based on a partial trace.

**Merge before acting.** Wait for every reviewer, de-duplicate their findings, verify each yourself,
and send **one** consolidated fix instruction. Separate simultaneous fix briefs can conflict and
leave the implementer guessing which instruction governs.

**Verify severity, not just existence.** Is this a shipped defect or a test weaker than its name?
Rank by plausible production consequences and evidence, not the reviewer's label. A test that
catches an obvious break but misses a subtler mutation deserves improvement, not an automatic
blocker rating. State plainly when you regrade a finding and why.

**Weight reports by verified evidence, separately by role.** A reviewer supplies claims you can
inspect, so a noisy reviewer may still add value even when you would not rely on its implementation
self-assessment. Verify the claims instead of trusting or dismissing the entire report.

**The reviewer is read-only.** State it three ways: do not edit, do not create, do not stage or
commit; findings in the reply only. Also prohibit build/typecheck/format-write commands and any
other command with shared-tree side effects. Keep the reviewed tree frozen until every reviewer
has produced its dispatch-specific completion token.

**Brief from requirements, not your findings alone.** Supply authority documents, acceptance
criteria and invariants, and ask what nothing implements *and* nothing records as deferred.
Provide already-found items so the reviewer does not duplicate them, but ask it to challenge any
that do not hold. Tell it to **report conflicts, not resolve them**: choosing between disagreeing
documents is a scope decision, not a hidden implementation detail.

**Angles worth adding to every brief:**

- **New suppressions and whether their justification is true.** Inspect `eslint-disable`,
  `@ts-ignore`, `@ts-expect-error`, `.skip`, `xit`, and lint-config exemptions. Check whether a
  claimed existing constraint actually predates this task. A constraint introduced by the same
  change is not independent justification for suppressing a rule.
- **Blast radius versus stated scope.** Flag global styles, shared config, base classes and
  dependency-injection providers whose reach exceeds the task, even if they fix the local symptom.
  Broader consequences need an explicit decision rather than silent acceptance.
- **For "build X like existing Y", diff every new file against its source and explain deletions.**
  A new file can look complete while omitting behavior or styling the cloned code still needs.
  Give reviewers the file pairs explicitly and ask whether anything still depends on each removed
  line. Reading only additions does not establish parity.

**Ask the implementer to self-audit against the documents too**, before reporting: enumerate
sections and acceptance criteria and say whether each is satisfied and where, including requirements
not repeated in the brief. This complements, rather than replaces, independent review.

A passing suite is evidence about what the tests establish, not proof of every requirement.

## Reviewing a fix round

**Every fix round gets the same review the implementation got.** A small diff in already-reviewed
files is still new code. Fixes optimize for the instruction they received, often when attention is
lowest, and may change the tests or expected values that previously served as independent checks.

Run the same reviewer fan-out, with these angles:

- **Did the fix regress something previously correct?** Diff against the *pre-fix* state, not just
  `HEAD`, and inspect everything else that moved. Sweeps, renames and shared-helper refactors have
  broader risk than the reported symptom.
- **Was an expected value, oracle, fixture or snapshot changed to match the implementation?**
  Re-derive changed expectations from the document, schema or spec, never from the code diff.
  Code and its oracle changing together deserve particular scrutiny.
- **Did it fix the instance or the class?** Look for the same defect in siblings not named in the
  finding, and check that the generalization introduces nothing the documents do not require.
- **Is "done" actually done?** Check every fix-list item against the code, including items quietly
  dropped or declared out of scope without approval.
- **What did a deletion orphan?** Check unused exports, dead helpers, unreachable branches and
  surviving protections whose tests disappeared in the refactor.
- **Did you check the changed helper, or its callers?** Search every caller of changed shared
  functions. A corrected helper cannot fix a feature if a caller still supplies the wrong shape
  or an unnormalized value. Trace the behavior through its call sites, not only in isolation.

**Write fix instructions so they cannot be satisfied in a broken way.** When an invariant requires
one authoritative normalization point, mandate where it must hold rather than offering a menu of
per-call-site workarounds. A choice between a complete fix and a weaker local check authorizes the
weaker option. Name the invariant and its source of truth; ask the user if choosing it changes scope.

Give reviewers the findings the round should close and ask both whether each closed and what the
fix broke. Make clear that this round's fix is the subject, not a duplicate review of the original
implementation. Supply the pre-fix comparison and the governing requirements.

**The round budget does not waive fix review.** Reviewing a fix is the second half of the round
that produced it, not a fourth round. Fresh defects follow the cycle rule under Step 3.

## Default workflow

### Step 0 — Parse and validate target

1. Parse the targets and prompt. Resolve bare pane IDs, reject this session's own pane, and state
   the resolved targets. With multiple candidates, apply **Routing** and explain the choice in one
   line; an explicit `pane=` takes precedence.
2. Run `herdr agent get <pane>` for each participant and note `agent`, `agent_status` and `cwd`.
   If semantic registration is unavailable, use `herdr pane get` / `herdr pane list` and the
   hookless workflow above. An active zcode hook uses the ordinary semantic path, not the fallback
   merely because of the agent's name.
3. If a participant is busy or blocked, ask whether to wait, proceed with authorization, or pick
   another pane. Unknown state requires inspecting the pane and confirming readiness, not blindly
   sending text. Resolve directory mismatches before dispatch.
4. Check `herdr integration status` when uncertain about hook currency, with the zcode exception
   described above. Re-check registration immediately before each dispatch.
5. **Read the repository's own instructions before writing the brief**: `AGENTS.md`, `CLAUDE.md`,
   `.cursorrules`, and applicable directory-specific rules. Check allowed paths, gate commands,
   staging/commit restrictions and prohibited directories. Obtain any needed scope exception from
   the user before dispatch; a brief cannot silently override repository restrictions.
6. Record existing tracked, staged and untracked changes so unrelated work is not attributed to
   this task. Preserve a pre-round comparison for subsequent fix review without staging or committing.

### Step 1 — Submit task (round N, starts at 1)

1. Compose the exact brief:
   - **Round 1:** restate the user's task with concrete acceptance criteria, governing sources,
     constraints, allowed paths, evidence requirements and the dispatch-specific completion token.
     Ask first if scope is materially ambiguous.
   - **A mockup or reference screenshot is acceptance evidence, not decoration.** Do not recommend
     dropping or changing a depicted feature just because implementation or backing data is awkward.
     Ask for the written requirement and identify any proposed change as a deviation needing the
     user's approval. Reconcile conflicting sources rather than quietly choosing the easier one.
   - **Rounds 2/3:** send only the verified findings and exact fix instructions with files/lines and
     governing source quotations. Do not resend the entire task. Preserve applicable constraints
     and request a fresh completion token and evidence report.
   - **Requirements changing mid-round need an immediate amendment.** Write a separate brief naming
     the sections/items it overrides and stating that everything else stands. Use the harness's
     supported queued input; do not interrupt or inject text into a permission dialog. Confirm
     receipt or ask the user if safe delivery is unavailable. Amendments do not consume a review
     round, but invalidate reviews of the superseded state; verify the amendment actually landed.
2. Submit without blocking: `herdr agent prompt <pane> "<text>"`, without `--wait`, so state handling
   remains under your control. For a long brief, send only the one-line instruction to read it.
   If registration fails, inspect for a potentially accepted prompt before using the hookless path.
3. Wait with `herdr agent wait <pane> --until idle --until done --until blocked`. Use the harness's
   background-job facility, such as `run_in_background: true` where supported, and its completion
   notification rather than polling `herdr agent get`.
   **Fold token verification into the wait job when possible**: preserve the wait result and exit
   status, then capture the pane output and test for the exact standalone token from this dispatch.
   Report state and token presence separately; a later successful read must not mask a failed wait.
   Use the visible source for blocked panes. Do not use an unanchored substring count that can match
   the echoed brief. If the harness has no background facility, use a bounded wait and inspect its
   result instead of pretending a notification will arrive.
   The user may see an idle pane before your notification arrives. Say which verification remains
   rather than restarting checks merely because they say it looks finished.
4. Branch on the result:
   - **`blocked`:** read `herdr agent read <pane> --lines 200 --source visible`, surface the actual
     request, and pause the loop. Clarifications and approvals do not consume a fix round. Apply
     the permission guardrail: only an exact explicitly preauthorized action may be approved on
     the user's behalf; otherwise the human decides.
   - **`idle` / `done`:** require the unique token as the final standalone report line before Step 2.
     State tracks the TUI, not necessarily completion: a question, phase pause or permission prompt
     may also look idle. If the token is absent, read enough output to find why; do not treat a
     truncated capture, an old token or an unchanged tree as a verdict. Reconcile the token with
     the actual report and state; a blocked request remains blocked even if a token appears.
   - **Wait terminated without completion evidence:** inspect `herdr pane read <pane>`, partial work
     in `git status`, and whether the current token was printed. A shell prompt means the agent is
     gone, not finished. Once restart is authorized, send a **continuation brief**, not the original
     task: name what is on disk, what is missing, and that partial output is unreviewed and must be
     re-checked. A fresh session does not know what "carry on" means.

### Step 2 — Review the result (in the current context)

1. Read the implementer's report with `herdr agent read <pane> --lines 200`, expanding as needed.
   Treat it as a claim, not the verdict. Confirm completion before starting review.
2. Review the actual change here: `git -C <cwd> diff`, `git -C <cwd> diff --cached`,
   `git -C <cwd> status --short`, and `Read` for changed or untracked files and surrounding context.
   Compare with the recorded baseline so existing user changes are not mistaken for task output.
   Do not spawn a subagent to replace your own review; you already hold the scope and criteria.
3. For specification-governed or expensive-to-get-wrong work, dispatch the available named
   non-implementers as read-only reviewers, each with a different angle. Use both when both were
   supplied. Run your own reading review concurrently, but freeze writes and reserve the full gate
   until **every** reviewer has returned its unique completion token. Do not skip them just because
   your own reading found nothing. With no independent pane, disclose that limitation.
4. Apply the **Verification contract**: validate source citations, interface shapes, derived values,
   coverage, fake behavior and test strength. Run isolated mutation/runtime checks where applicable,
   then the authoritative clean-state gate alone on the final unchanged tree. Merge and de-duplicate
   findings, verify each one, and carry one consolidated list into Step 3.
5. **Repeat after every fix round**, using the pre-fix state and fix-review angles, not a lighter
   check because the diff is small. Judge whether the change satisfies this round's scope, risks
   regressions, lacks meaningful tests, adds unnecessary complexity, or remains ambiguous or unsafe
   to accept. Unavailable checks stay explicit caveats, not implied passes.

### Step 3 — Decide

- **Clean, with acceptance evidence satisfied:** approve the reviewed work, summarize changed files
  and validation, and proceed to Step 4. Approval does not authorize a commit or push.
- **Concrete issues, rounds used < 3:** return to Step 1 with the consolidated exact fix instruction
  (`round += 1`). Review the resulting fix with the same rigor as the original change.
- **Concrete issues after round 3:** stop looping on those findings. Once implementer and reviewers
  are finished, take sole-writer ownership and fix remaining in-scope issues with Edit/Write.
  Tell the user which issues required a manual finish and why. **Your fix gets independent review
  too** from non-authors, followed by the affected checks and clean-state gate.
- **Any driving-context edit gets that review, not only a round-3 finish.** A fix responding to the
  owner's review, a measured threshold adjustment or a documentation correction is still new work.
  Brief reviewers from the requirement and decision text, not your account of how you fixed it.
  The original implementer may review this later change because it did not author it.
- **After the loop, small driving-context fixes may be batched, not waived.** Keep a running list
  of owner/PR feedback and the resulting fixes. Mutation-check behavior changes where applicable
  and use appropriate checks for visual or prose changes. Before handoff for a push, send the batch
  to a non-author pane as one read-only review, using the original comments as its brief, then run
  the clean-state gate once. Individual probes cannot establish that fixes interact correctly.
  If no independent pane is available, ask for one and disclose the review gap rather than silently
  claiming independent approval.
- **Product or scope decision:** stop and ask the user, regardless of round count.

The three-round cap governs **looping on the same findings**. A genuinely fresh defect from a
cross-agent or owner review starts a new cycle, not an excuse to relabel an unresolved finding.
Do not quietly continue through repeated cycles of serious defects: tell the user, identify the
brief or review gap, and agree the next step and any budget limits.

**Rising severity across cycles is a signal to examine the review method.** A later serious finding
may expose an earlier shared blind spot rather than a regression. Check the pre-fix evidence before
attributing its origin. Name the missed review angle — such as examining helpers in isolation
without tracing their callers — instead of assuming the implementer made previously correct code worse.

### Step 4 — Hand off, then confirm the commit is what was reviewed

Everything above verifies the **working tree**. Partial staging, conflict resolution or applying
changes to the wrong branch can make the eventual commit differ. A green gate on the tree does not
prove the contents of a later commit.

- At approval, record the reviewed blob hash of **every added or modified file** using
  `git hash-object --path="<path>" -- "<path>"`, without `-w`, so the hash reflects the file's
  working-tree content with Git's applicable clean conversion. Record deletions explicitly and
  include file modes and rename paths when relevant. An unresolved conflict blocks approval.
  `git ls-files -s` shows the **index**, not unstaged reviewed content; use it only after confirming
  the index and reviewed tree are identical, never as a substitute for hashing unstaged files.
- Put this path/hash manifest in the handoff summary, alongside validation and any caveats. Include
  a one-line check the owner can run: `git ls-tree -r HEAD -- <reviewed-paths>`, substituting the
  actual safely quoted paths. Deleted paths should be absent. Account separately for symlinks or
  submodules rather than hashing their targets as ordinary files.
- When the owner says it is committed, or you next inspect the branch, compare that command's blob
  hashes and modes with the manifest. If the reviewed commit is not `HEAD`, use its confirmed ID.
  A mismatch is either an intended later edit needing review or work that did not make it into the
  commit; identify which before claiming the commit is verified.
- Never stage, commit or push to perform this comparison. If the eventual commit is unavailable,
  hand off the check as pending rather than implying it has already passed. Matching blobs can
  also demonstrate that a later repair faithfully restores the reviewed content.

**Review the owner's changes the same way when asked.** Mutation-check added assertions, including
assertions added to existing tests: confirm they fail for the intended reason under a relevant
isolated mutation. Preserve catalog-wide coverage rather than replacing it with hand-picked cases,
and confirm existing tests were not weakened. Treat requested review as an actual diff review, not automatic deference to its
author. If the owner's correction improves on your decision, explain why and update your judgment.

## Examples

The following pane IDs and paths are generic examples; resolve the user's actual targets.

`/panel pane=w3:p4 Fix the flaky sorting test in tests/sort.test.ts`

- Step 0: `herdr agent get w3:p4` confirms an idle agent in the intended checkout.
- Round 1: submit the brief with a unique token, wait, then verify state plus token.
- Review 1: inspect the real diff and evidence; identify a missed edge case.
- Round 2: send the exact fix instruction with a fresh token and wait for completion.
- Review 2: review the fix and run validation; if clean, approve and record reviewed hashes.
- Handoff: leave commits to the owner and later compare the committed blobs to the manifest.

The same flow works with an `agy`, `opencode`, `pi`, `omp` or other pane; use its actual registration
and the hookless fallback when necessary. No other delegation skill is required.

Routed, with reviewer fan-out:

`/panel codex-pane=p5 zcoder-pane=p4 agy-pane=p3 Implement the serializer per docs/spec.md`

- Resolve targets against `$HERDR_WORKSPACE_ID`; choose zcode for specification fidelity and say why.
- Round 1: brief it from the authority document, including concrete acceptance criteria and evidence.
- Review 1: dispatch codex for correctness/failure paths and agy for interface claims and test
  sensitivity. Both are read-only, with builds and other shared-tree writes forbidden. Read the
  diff yourself. After both unique completion tokens arrive, verify and consolidate the findings
  and run the clean-state gate alone.
- Round 2: send one consolidated instruction to the same implementer.
- Review 2: verify closure and look for regressions, tracing changed helpers through callers and
  re-deriving changed expectations from the spec. Fan the reviewers out again on the fix.
- Handoff: report acceptance evidence, caveats and reviewed hashes; compare the owner's later
  commit without committing anything yourself.
