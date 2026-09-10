---
name: panel
description: "Hand a task to whatever coding agent is running in another herdr pane (codex, zcode, antigravity/agy, opencode, pi, omp, etc.), wait for it to finish, review the actual diff yourself in the current context, and loop fix rounds up to 3 times; if meaningful issues remain after 3 rounds, fix them yourself. Given several of codex-pane=, zcoder-pane= and agy-pane= it routes the task to whichever suits it best and turns the rest into concurrent read-only reviewers. Triggers on: /panel pane=<id> <prompt>, /panel codex-pane=<id> zcoder-pane=<id> agy-pane=<id> <prompt>, delegate to pane, send this to the agent in pane X."
---

# Panel — route a task across herdr panes, then cross-review it

The implementer isn't a Task-tool subagent — it's whatever real coding-agent CLI process is running in a sibling terminal pane (codex, zcode, antigravity's `agy`, opencode, pi, omp, or anything else running under herdr), driven through `herdr`'s socket API (`herdr agent ...`). You submit a prompt into that pane, wait for the real agent to finish, and review its real working-tree changes.

Same core loop as `task-exec`, plus **routing across more than one named agent pane**. If you have exactly one target, `task-exec` is the simpler skill — use it. Use this one when two or more of `codex-pane=`/`zcoder-pane=`/`agy-pane=` are available: it sends the task to whichever suits it better and puts the rest to work as concurrent read-only reviewers.

This skill is **agent-agnostic by design** — it targets a pane, not a specific tool. `herdr agent get <pane>` tells you what's actually running there; nothing in the workflow assumes codex or any other harness specifically. The only requirement is that herdr has a current state-tracking hook installed for that agent (`herdr integration status`) — without it, `herdr agent wait` can't reliably see idle/working/blocked transitions.

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
would be, not on which sounds fancier. These leanings come from observed runs, not vendor claims —
revise them as evidence accumulates.

**Send to codex when a defect would be exploitable or silently corrupting:**

- authorization and access control — who may do what, tenancy scoping, session and role checks
- secrets handling, redaction, credential paths
- concurrency, transactions, isolation levels, locking, retry semantics
- infrastructure with footguns, where a misconfiguration fails silently or far from its cause
- correctness-critical core logic that later work will sit on top of

It has repeatedly defended boundaries nobody asked it to (validating an inbound header against log
injection; rejecting a pooled endpoint where a direct one was required), and its self-reports have
matched independent verification.

**Send to zcode when the deliverable is fidelity to written sources:**

- deriving values, taxonomies, enums or contracts from specification documents
- implementing a design or spec that already exists, against established conventions
- conventions, tooling, CI, lint and gate work
- anything where the docs might disagree with each other and someone must notice

It reads authority documents closely, finds conflicts unprompted, and writes better test structure
than the brief specifies — including tests that guard its own deliberate shortcuts, so a corner it
cut cannot drift silently. It has diagnosed subtle build-configuration faults correctly (a CommonJS
package that an ESM build could import types from but not runtime values) and surfaced them as
decisions to hand back rather than working around them quietly.

**Send to agy when the job is checking a claim against a source that already exists:**

- does this library actually support the option we configured, at the spelling we used?
- does every item in this list have a test / a handler / an entry on the other side?
- does each acceptance clause map to something that would fail if it broke?
- can this specific assertion fail at all, given what it compares?

Observed on an auth-library integration task: given the "tests that cannot fail" angle, it opened
the vendored auth library's source and confirmed several configured options, a middleware's
return-value contract, a migration's column names, and an audit-log signature — every one with a
file:line citation, every one correct. That clean negative result is worth real money on a task
whose protections fail *silently* if a key is misspelled. It also mapped every acceptance clause in
the task to its tests and named the unmapped ones, and it alone spotted that a parity test compared
unknown-vs-unknown and wrong-vs-wrong but never the two failure modes against each other.

Its weakness is the complement: **it does not simulate a user.** On that same run it declared "P1
findings: none — the production behavior is functional" while a P1 sat in a file inside its scope —
a submit button that stayed disabled forever after one wrong password. It found a *P3* in that very
file. So agy is strong where the oracle is external and enumerable, and weak where you have to walk
a flow in your head and ask "and then what happens to the person?". Do not give it "is this screen
usable"; do give it "is every one of these twelve paths actually tested".

**A softened earlier rule.** "Security-sensitive work always goes to codex" was too broad. zcode has
written a careful client against a trust boundary unprompted — forcing `credentials` after the
caller's spread so it cannot be widened, and dropping a caught network error precisely because the
thrown value can carry URLs. Reserve codex for work that *decides* a security question;
application code that merely touches a boundary is fair game for either.

**Brief quality is a routing input.** zcode's best runs follow briefs that state scope, constraints
and acceptance concretely and leave little ambiguity; there is less evidence about its judgment
under a vague brief. If the task cannot be specified tightly and will need interpretation, that
weighs toward codex — or toward tightening the brief first.

**Overlap is fine.** When a task is genuinely both, prefer codex if a defect would be exploitable or
silently corrupting, zcode if it would be a wrong value faithfully implemented. When neither fits,
say so and pick the idle one.

**Never route on task size.** A one-line change to an authorization check still goes to codex.

**What actually decides your verification burden** is whether an agent's report matches reality.
codex and zcode self-reports have held up under independent checking; one agy run reported thorough
verification alongside a bug that 500'd every route its two tested URLs did not touch. Verify
regardless (see Guardrails), but weight where you look.

**Split that judgment by role, though — agy's reliability is not one number.** As an *implementer*
self-reporting on its own work it has overclaimed. As a *reviewer*, on the auth-library task above,
every finding it filed was accurate on inspection, because a reviewer's output is a set of citations
you can open rather than a claim about work it has already done. Reserve the distrust for its
self-assessment, not for its reading of someone else's code.

**Severity calibration follows the brief, for agy specifically.** On one task its severities ran hot
(two test-quality issues filed P1). On another, the brief said "be conservative about severity; a
test thinner than its name is P2, not P1" — and it filed no P1s at all and graded accurately. One
sentence in the brief fixed a trait previously recorded as a fixed property of the agent. Say it
explicitly every time rather than discounting afterwards.

## Tool requirements

- `Bash` — to run `herdr agent ...` commands and `git diff`/`git status` for review
- `Read` — to inspect changed files directly when the diff alone isn't enough context
- `AskUserQuestion` — for ambiguous scope or blocked-agent situations

## Guardrails

- The target pane's agent is the **only writer** to the working tree during rounds 1–3. Do not Edit/Write files yourself until round 3's fix has been requested and still fails review.
- **One writer per working tree, always.** Never run two implementer panes against the same
  checkout — they delete each other's build output and each inherits failures caused by the other's
  half-finished work, which you then debug as if they were real. Give the second lane its own git
  worktree. *Read-only reviewer* panes are the exception and are safe to run concurrently — with
  each other and with the implementer — but only for reading. See the next bullet.
- **Reviewers may read; they must not build.** "Read-only" is an instruction to the agent, not an
  enforced property, and a reviewer asked to verify something naturally reaches for the project's
  gate. Build, typecheck and format-write commands write to the shared tree (in a TS monorepo:
  `pnpm check`, `pnpm build`, `pnpm typecheck` — `tsc -b` writes `dist`, `dist-types` and every
  `*.tsbuildinfo` — and `prettier --write`). Two reviewers running those against one checkout
  clobber each other's incremental cache and produce *false* failures, which is worse than not
  running the check at all: you debug a phantom. Tell every reviewer explicitly which commands are
  off-limits. Reading, linters and formatters in `--check` mode, and test runners are safe (a test
  harness that creates its own uniquely-named database per run does not collide). **You** run the
  authoritative clean-state gate alone, after the reviewers have reported — not while they work.
- **"Alone" includes the implementer, and includes the round you are about to dispatch.** The
  concurrency rule is easy to apply to reviewers and then break yourself. Observed here: the
  driving context started a full lint+test gate, then dispatched a round-3 fix into the same
  checkout seconds later. The implementer renamed a selector and edited a template while jest was
  running; the output came back interleaved and truncated, with lint output cut mid-path straight
  into the test log, and had to be thrown away. Sequence it: implementer idle → gate → read result
  → dispatch next round. Never overlap a gate with a pending or in-flight fix round, and re-run the
  gate after the last write lands, not before.
- Review is read-only: use `git diff` / `git status` / `Read` to judge the change. Don't Edit/Write during a review step, even to "just fix the small thing" — that belongs in the next round's fix instruction, or to Step 3's manual-fix fallback after round 3.
- Before submitting, confirm the target with `herdr agent get <pane>`. Note which `agent` it reports. If `agent_status` is not `idle`, stop and ask the user before interrupting whatever it's already doing.
- If `herdr integration status` shows the pane's agent as **not installed** or **outdated**, warn the user before relying on `--wait`/state detection — offer to run `herdr integration install <name>` first (a local config change; confirm before running). **Exception: zcode does not appear in `herdr integration status` at all** even though it has a working hook; check `herdr agent get` for it instead, and do not offer to install anything on the strength of that absence. An `outdated` row is also not automatically a problem — codex has run `outdated` here while reporting idle/working/blocked correctly; treat it as a reason to corroborate with a completion token, not to stop.
- Confirm the pane's `cwd` matches the repo/worktree you expect. A mismatched `cwd` means the task would land in the wrong place — ask before proceeding if it doesn't match.
- Never put secrets, `.env` contents, or credentials into the prompt text sent to the pane.
- Max **3 review rounds**. Don't keep looping on optional polish — only loop on concrete, meaningful issues.
- If a review finding requires a product/scope decision (not a straightforward bug), stop and ask the user regardless of round count.
- Quote the prompt text carefully when building the `herdr` shell command (it may contain quotes, backticks, or newlines) — prefer a single-quoted string with `'\''` escaping, or write it to a temp file and pass `"$(cat file)"`, over naive double-quoting.
- **A long brief goes in a file, not down the wire.** Write it to the scratchpad and send one line telling the agent to read that path. Multi-line text sent into a TUI can submit early on the first newline.
- **Verify the agent's claims yourself; never accept its report as the verdict.** Re-run the acceptance checks from a clean state. An agent's confident summary and a broken build coexist comfortably — one run here shipped a report of thorough curl verification alongside a bug that 500'd every route its two tested URLs didn't touch.

## Driving a pane with no herdr integration

**zcode no longer needs this path.** As of 10 September 2026 it has a state-tracking hook: `herdr agent get` reports `agent":"zcode"` with a real `agent_status`, it appears in `herdr agent list`, and `herdr agent prompt` / `herdr agent wait --until idle --until working --until blocked` drive it exactly like codex and agy. Its state mapping: new/cleared/compacted session and end-of-turn → `idle`; prompt submitted, tool invoked, tool completed *or failed* → `working`; permission request → `blocked`.

Three zcode caveats that do **not** go away, and that shape how you use it:

- It is **absent from `herdr integration status`** (no native process detection). Do not read that command's silence as "not installed" for a zcode pane — `herdr agent get` is the authority.
- There is **no guaranteed release event when the process exits**, and sessions are **not restored after a herdr server restart**. So `--until idle` cannot perfectly distinguish "finished this turn" from "the process died". Keep asking for a completion token as the last line and treat `idle` **plus** the token as the real signal; re-check the pane after any herdr restart.
- Model, token, quota and task metadata are not reported for zcode, so its rows carry none of the `tokens` fields the other agents show.

Use the path below for any agent that still has no hook. Such an agent reports `agent_status: unknown`, may not appear in `herdr agent list` at all, and cannot be driven by `herdr agent prompt` / `herdr agent wait`. Find it with `herdr pane list` instead:

1. Send with `herdr pane run <pane> "<one line>"` (sends the text plus Enter).
2. Ask the agent, in the brief, to print a unique completion token as the **last line, alone on its own line**.
3. Wait with an **anchored regex**, backgrounded:
   `herdr pane wait-output <pane> --regex '(?m)^\s*TOKEN\s*$' --source recent-unwrapped --timeout <ms>`

Anchoring is not optional. A bare `--match TOKEN` fires on the agent echoing its own plan back into the pane ("12. Report; print TOKEN"), reporting completion while the work has not started. If a wait returns and the working tree is unchanged, suspect exactly this before believing the agent did nothing.

Everything else — review, rounds, guardrails — is unchanged.

**Do not poll a pane's screen to track progress when the agent has a hook.** `herdr agent wait` is the mechanism; repeated `herdr agent read` in a loop burns turns and reads a truncated window, so a permission prompt below the fold looks like "no prompt" and the loop spins. Wait on the state, then read the pane **once** when the wait returns — and if it returns `blocked`, read enough lines to actually see the prompt before deciding.

## Verification contract

An agent's report is a claim, not a verdict. Two halves make it cheap to check: demand evidence in
the brief, then check the evidence rather than the prose.

**In the brief (Step 1), require the agent to return:**

- the actual values it observed for anything it filters, matches or parses on — read from the real
  source, not assumed from a name;
- raw output of the full gate, not a summary of it;
- an explicit list of what it removed, renamed, worked around, or deliberately left undone.

**Before accepting (Step 2), verify independently — never from the diff alone:**

- re-run the full gate yourself **from a clean state**; delete build output and incremental caches
  first, because a stale `tsbuildinfo` produces false failures *and* false passes;
- for any claim about an interface it consumed, open the other side and confirm the shape matches;
- for new tests, **break the code they guard and confirm they fail.** A passing test proves nothing
  about whether it would catch a regression, and this is the check most often skipped;
- confirm existing tests were not *weakened* — assertions loosened, cases deleted, globs narrowed
  so new code escapes an existing sweep — rather than only that the suite is green;
- **confirm the gate actually covers the new code.** A green gate is evidence only about what it
  compiles and runs. Read the `include`/`exclude` globs of the typecheck projects and the test
  runner's project globs before believing a pass. Observed here: a repo's `tsconfig.json` used
  `include: ["src/**/*"]`, so no test file had ever been typechecked — type errors sat invisible in
  the test suite of every previously "green" task, and the new work inherited that blind spot.
- **Ask what the test harness silences, not just what it runs.** Globs are one blind spot; the
  harness's own leniency settings are a worse one, because they make a whole *class* of defect
  unfailable. Observed here, in a component-framework repo: specs used a permissive schema that
  suppresses unknown-element errors, and the test runner mapped a shared UI package to an empty
  module. The implementer added a new dialog element to a template for a component that had **no
  selector at all** — it had only ever been instantiated dynamically. The element matched nothing,
  the schema swallowed the error, the modal never rendered, and the view reference for it stayed
  undefined so the call site threw. Every suite stayed green through two agent self-reports and
  one reviewer pass. Equivalents to look for: permissive/no-errors DOM schemas, shallow rendering,
  module mocks that stub the very thing under test, `--passWithNoTests`, and any module-name mapper
  pointing at an empty stub. When you find one, say explicitly which acceptance criteria it cannot
  verify, and route those to a runtime or e2e check instead.

**Verify a finding against a clean baseline, never against the current tree.** When you downgrade a
reviewer's finding to "unproven — confirm at runtime", the confirmation must compare against `HEAD`
(or a stash), because by the time you look, someone may already have fixed it — and a fixed tree
and a never-broken tree are indistinguishable from the outside. Observed here: a reviewer reported
that portalling a modal out of its overlay container would push other floating panels behind it.
The driving context correctly regraded it to "unproven" (the reviewer's stacking argument was
incomplete) and sent it for a runtime check. The check came back showing the overlay container at a
very high explicit stacking value, which was read as evidence the concern had always been baseless
— and reported to the owner as a non-issue. It was not: the implementer had *added* that stacking
override as a global change during the browser session, after the owner spotted the bug. The finding was real, the
regrade was right as process, and the conclusion was still wrong. Two habits prevent it: state
explicitly what the baseline value *was* before accepting a runtime observation, and treat
"unproven" as an open item with an owner, never as a soft dismissal.

**Check the values, not only the shape.** This is the check that survives everything above. A
review can confirm the structure is right — tables, constraints, wiring, tests that fail when
mutated — while every derived *value* in it diverges from what the specification says. Those look
identical from a diff and identical from a gate. For anything the documents define, name the
document line that fixes the value and check the produced value against it. Ask it as its own
question, separately from "is the structure right", because a reviewer given only the structural
frame will answer only the structural question.

**A disclosed simplification is not an approved one.** Agents that report honestly will tell you
what they simplified — and that disclosure reads as diligence, so it tends to be accepted on sight
and then verified only for *accuracy* ("is it true that this is simplified?") rather than for
*consequence*. Ask the second question every time: does this simplification defeat the purpose the
task exists for? Observed here: an agent correctly disclosed that a fixture's hash projection was
"fixture data, not the production computation", a cross-agent review confirmed the disclosure held,
and both missed that the omitted fields made the fixture unusable for the one scenario it was built
to provide.

An agent that flags a gap it could not close is doing the right thing; one that reports success on
a claim you cannot reproduce is not. Send the second kind back naming the specific gap.

## Cross-agent review: the implementer never reviews itself

On work that matters — anything governed by a specification, anything where a defect is expensive
or silent — the implementer's own report is one input, your review is a second, and **the other
agent's review is a third**. Use all three. Whoever implemented does not review.

- codex implemented → **zcode and agy review**, you review.
- zcode implemented → **codex and agy review**, you review.
- agy implemented → **codex and zcode review**, you review.

**Use both non-implementing panes, not one.** A third independent reader is worth the dispatch: an
observed run here had the driving context's own review and a green clean gate find nothing, after
which a single cross-agent pass found three P2 defects and its re-review of the fixes found three
more. That is not one agent being special — it is that a review conducted against your own
understanding reproduces your own blind spots, and each additional reader has a real chance at a
different class of defect. Run them concurrently; they are read-only, so they do not collide (per
the build rule in Guardrails).

**Give them different angles, not the same brief.** Identical briefs produce heavily overlapping
findings and double your verification load for little new coverage. Split by the agent's observed
strength: give **zcode** specification fidelity — **both** halves of it, since they are different
questions: what the documents require that nothing implements *and* nothing discloses (omission),
and whether the values the code actually produces match what the documents define (divergence).
Give **codex** the adversarial pass — tenancy, authorization, concurrency, trust boundaries, what
breaks. Give **agy** the third angle the task suggests (dead code and prior-spec leftovers,
interface claims checked against the other side, tests that cannot fail). Every brief still carries
the read-only rule, the already-reported items, and the report-conflicts-don't-resolve-them rule.
Evidence that the *split* is what pays, not the headcount: on one interface task every reader
returned a **disjoint** defect class. zcode alone found a required event shape the interface could
not express — its brief asked what the documents require that nothing implements. agy alone found
a tautological assertion comparing two freshly generated UUIDs — its brief asked which tests cannot
fail. The driving context alone found a disclosed simplification that destroyed evidence — it asked
what a simplification *costs*. Nothing overlapped. A third reader handed the same brief would
mostly have duplicated one of the others, so spend the dispatch on a new question, not a new pane.

**Name the divergence half explicitly or nobody runs it.** Reviewers answer the question you asked.
In an observed five-round run, three review passes — the implementer's self-audit, a cross-agent
review, and the driving context's own — all examined structure, because structure was what the
briefs described; the only P1 defects were content diverging from the specification, and the owner
found all of them. Cite the governing sections in the brief and ask, for each derived value, which
line fixes it and whether the code matches.

**Merge before acting.** De-duplicate the reviewers' findings, verify each one yourself, then send
**one** consolidated fix round to the implementer. Never dispatch two fix rounds from two reviews —
that puts two sets of instructions against one tree, and the implementer cannot tell which to
believe when they overlap.

**Verify severity, not just existence.** Reviewers inflate it, and an inflated grade survives the
merge unless you re-derive it yourself. Observed on the same task: a reviewer filed two P1s that
were really P2s — the implementer's own mutation probes had already turned both of those tests red,
so they caught the obvious break and missed a subtler one. That is *thinner than its name claims*,
not *blocks*. The findings were real and worth fixing; the ranking was not, and the driving context
passed the inflation straight through to the owner. Ask of each finding: is this a shipped defect,
or a test weaker than its name? Rank by what reaches production, and say plainly when you regrade a
reviewer — an inflated P1 spends the owner's attention on the wrong item.

**Weight reports by track record, but use noisy reviewers anyway.** An agent whose self-reports have
been unreliable is disqualifying as an *implementer* and much less so as a *reviewer*: a reviewer's
output is a set of claims you verify before acting on, so its failure mode degrades to wasted
verification time rather than shipped defects. Use it; do not trust its self-assessment. This is why
agy earns a reviewer slot despite the implementer-side evidence in **Routing**.

**The reviewer is read-only.** State it three ways in the brief: do not edit, do not create, do not
stage or commit; findings in the reply only. This is not politeness — a reviewer that writes turns
into a second writer in one working tree, and two writers produce phantom failures each blames on
the other. A read-only reviewer can safely run while the implementer still owns the tree.

**Brief the reviewer from the requirements, not from your findings.** This is the whole point. A
review conducted against your brief reproduces your brief's blind spots; the defects that survive
round after round are precisely the ones no brief mentioned. So hand the reviewer the authority
documents, the acceptance criteria and the invariants, and ask what nothing implements *and*
nothing records as deferred. That category — neither built nor disclosed — is where the expensive
findings live.

Do give it the list of already-found items, with instructions not to re-report them but to say so
if one does not actually hold. That converts prior findings into a verification target instead of
noise.

Tell the reviewer to **report conflicts, not resolve them**. A reviewer that quietly picks the
easier reading of two disagreeing documents launders a design decision into an implementation
detail.

**Two angles worth adding to every brief, because reviewers reliably miss both.** Both were missed
by two independent reviewers here and surfaced only from the driving context's own checking:

- **Newly-added suppressions, and whether their justification is true.** Any `eslint-disable`,
  `@ts-ignore`, `@ts-expect-error`, `.skip`, `xit`, or lint-config exemption the diff introduces.
  Ask not only whether it is warranted but whether its stated reason is *factually accurate*.
  Observed here: an implementer set a component selector that violated the lib's mandatory prefix
  rule and suppressed the rule with the comment "this selector is part of the existing template
  contract" — the template line in question was one the same agent had written a round earlier. A
  self-created constraint used to justify silencing a rule is a reliable tell, and the resulting
  exemption outlives the ticket.
- **Blast radius versus stated scope.** Flag any change whose reach exceeds the task, especially
  global styles, shared config, base classes and DI providers — even when it is a correct fix.
  Observed here: a local dropdown-stacking bug was fixed with an app-wide global stacking override
  on the shared overlay container, which silently reorders *every* overlay against *every* modal in
  the application. Defensible, in scope, and exactly the kind of decision the owner should make
  consciously rather than discover later.

**Ask the implementer to self-audit against the documents too**, before it reports: enumerate the
governing sections and acceptance criteria and state, for each, whether the implementation
satisfies it and where — *including requirements your brief never mentioned*. In practice this
surfaces gaps the agent would otherwise leave silent, and it costs one paragraph of brief.

**Why this is worth the extra pass.** Observed here across five rounds on one specification-heavy
task: every round, an independent review found P1 defects that brief-based verification had passed
— a rejection flow rolled back by its own rejection, one party acting as author, approver and
reviewer on a matter requiring independence, a derived record that silently omitted relationships
it was supposed to govern. Each had a green full gate over it. A passing suite is evidence about
the tests, not about the requirements.

## Reviewing a fix round

**Every fix round gets the same review the implementation got.** Not a lighter one. This is the
step most likely to be skipped, because by round 2 or 3 the file has already been read by three
people, the diff is small, and the mental model says "it's correct now, we're just closing
findings". That model is wrong, and the evidence is direct: on one task a round-3 fix sweeping a
whole permissions matrix flattened a distinction the source document draws — one role's *denied*
action became indistinguishable from two roles' *allowed* action — and the exhaustive oracle
passed, because the expected value had been updated alongside the implementation. Nobody had been
asked to review the fix. It was caught by chance.

A fix round is *more* dangerous than the original, for three reasons: it is written under
instruction rather than from the requirements, so the agent optimizes for satisfying the finding;
it touches code every reviewer has already blessed, so attention is lowest exactly where change is
newest; and it frequently edits the **tests and expected values** that were the safety net for the
code it is changing.

So run the same fan-out, with these angles instead of the round-1 ones:

- **Did the fix regress something that was previously correct?** Diff the fix against the
  *pre-fix* state of the same files, not against HEAD, and ask what else moved. A fix with a wide
  blast radius — a sweep, a rename, a refactor of a shared helper — is the high-risk shape.
- **Was an expected value, oracle row, fixture or snapshot edited to match the new implementation
  rather than the source of truth?** This is the signature failure of a fix round, and it converts
  a test into a mirror. Re-derive the changed expectation from the document, schema or spec — never
  from the diff. If an oracle row and the code changed in the same commit, that row is suspect by
  default.
- **Did it fix the instance or the class?** The finding named one symptom. Ask whether the same
  defect exists in the siblings the finding did not name, and whether the fix's own generalization
  (if it made one) introduced anything the documents do not require.
- **Is "done" actually done?** Check each item of the fix list against the code, not against the
  agent's report of it. Items quietly dropped, or marked out-of-scope without saying so, are common.
- **What did a deletion orphan?** Subtractive rounds leave unused exports, dead helpers, unreachable
  branches — and, worse, protections that survived the refactor but lost the test that covered them.

Give the reviewers the list of findings the round was supposed to close, and ask them to verify each
was actually closed *and* to look for what the fix broke. Tell them explicitly that the fix is the
subject under review, not the original implementation — otherwise they re-review the whole change
and re-report round-1 findings.

**The round budget does not govern this.** Reviewing a fix is not a fourth round; it is the second
half of the round that produced the fix. If that review finds a fresh defect, see the cycle rule
under Step 3.

## Default workflow

### Step 0 — Parse and validate target

1. Parse the target(s) and the prompt text from the invocation line. With `codex-pane=`/`zcoder-pane=` both present, apply **Routing** now and state the choice in one line.
2. `herdr agent get <pane>` — confirm it resolves; note `agent`, `agent_status`, `cwd`. If it does not resolve or reports `agent_status: unknown`, fall back to `herdr pane get`/`herdr pane list` and use **Driving a pane with no herdr integration**. zcode reports normally here now, so a zcode pane goes down the ordinary `herdr agent prompt`/`herdr agent wait` path — do not send it to the fallback out of habit.
3. If `agent_status` isn't `idle`, tell the user and ask whether to proceed anyway, wait, or pick a different pane.
4. If `cwd` doesn't match the repo you're operating in, confirm with the user before proceeding.
5. If unsure whether this agent's herdr integration is current, `herdr integration status` and check the row matching the `agent` name from step 2.
6. **Read the repo's own agent instructions before writing the brief** — `AGENTS.md`, `CLAUDE.md`,
   `.cursorrules`, or whatever the repo carries. Shared monorepos routinely restrict agents to a
   subset of projects, forbid staging or committing, or ban whole directories, and the pane's agent
   *will* read them and stop. Observed here: a brief required edits in two libraries that
   `AGENTS.md` placed off-limits; the implementer refused and asked for authorization, costing a
   full round trip and a round of owner decisions — and the driving context had already violated the
   same rule by writing a file into one of those libraries while planning. Check the constraints
   first, and where the task genuinely needs an exception, get the owner's authorization *before*
   dispatching rather than after the agent blocks on it.

### Step 1 — Submit task (round N, starts at 1)

1. Compose the exact text to send:
   - **Round 1**: the user's task, restated with concrete acceptance criteria. If the request is materially ambiguous, ask the user before dispatching — don't let the agent guess at scope.
   - **Round 2/3**: only the specific review findings from the previous round, phrased as an exact fix instruction referencing files/lines. Don't re-send the whole original task.
   - **Requirements that change mid-round: amend immediately, don't wait for the round to end.**
     When the owner redefines the target while the agent is working, send an amendment the moment
     you have it — the agent is otherwise busy implementing something you already know is wrong.
     Write it to a file like any other brief, name exactly which sections and item numbers it
     overrides, and state that everything unmentioned still stands; then send one line pointing at
     it. Observed here: three amendments landed mid-round and the agent picked them up cleanly, one
     of them arriving just before it would have implemented a fix the owner had superseded.
     Amendments do not consume a round — the round-3 cap governs looping on findings, not owner
     re-scoping. Do re-verify afterwards that the amendments actually landed, since a mid-round
     redefinition invalidates any review you did of the earlier state.
2. Submit without blocking: `herdr agent prompt <pane> "<text>"` (no `--wait` — we control the wait ourselves for better state handling).
3. Wait for it to settle without blocking your own turn — run as a background Bash command:
   `herdr agent wait <pane> --until idle --until done --until blocked`
   with `run_in_background: true`. You'll get a completion notification when it returns; don't poll `herdr agent get` in a loop.
4. When notified, branch on the resulting state:
   - **`blocked`** — the agent needs input (a permission prompt, a clarifying question). Read its output with `herdr agent read <pane> --lines 200`, surface it to the user, and stop the loop here. This isn't a "fix" round; it needs a human (or you, on the user's behalf) to unblock the pane directly.
   - **`idle` / `done`** — **check the completion token before believing it.** `agent_status` tracks
     the TUI, not the work: an agent that stops to ask a question, or pauses between phases, reports
     `idle`/`done` too. The token you asked for in the brief is the only signal the agent itself
     emitted on finishing. Observed here: a round-2 wait returned `done` with the token absent — the
     agent was sitting on a permission prompt, mid-task. Another returned `done` with an unchanged
     working tree because the agent had stopped on a scope conflict. `grep -c '<TOKEN>'` over
     `herdr agent read`, and if it is absent treat the state as suspect and read the pane before
     proceeding to Step 2.
   - **the wait died without a completion token** — your session was resumed, the machine rebooted,
     the task was killed, or the pane's agent exited mid-run. Never read this as "the agent finished"
     or as "the agent did nothing". Check three things before deciding: `herdr pane read <pane>` (a
     shell prompt means the agent is gone, not idle), `git status` for partial work, and whether the
     completion token was ever printed. Then **restart with a continuation brief** rather than
     resending the original: state what is already on disk, what is still missing, and that the
     partial work is the agent's own unreviewed output to re-check rather than to trust. A fresh
     session has none of the prior context, so an unqualified "carry on" makes it guess.

### Step 2 — Review the result (in the current context)

1. `herdr agent read <pane> --lines 200` to see what the agent reported it did — treat this as a claim, not a verdict.
2. Apply the **Verification contract** above — a clean-state gate run, interface shapes checked
   against the other side, new tests mutation-checked, existing tests confirmed not weakened.
   Then review the actual working-tree change yourself, right here: `git -C <cwd> diff` / `git -C <cwd> status --short`, and `Read` any changed file where the diff alone doesn't give enough context (e.g. to check surrounding logic or a moved block). Don't spawn a subagent for this — you already hold the task's scope and acceptance criteria from Step 1, so re-deriving that context in a fresh agent every round is pure overhead.
3. On specification-governed or expensive-to-get-wrong work, dispatch **both** non-implementing
   agents as read-only reviewers now, each with its own angle (see **Cross-agent review** above),
   and read their findings alongside your own. Run them concurrently with each other; run your own
   *reading* review in parallel too, but save the clean-state gate until they report, so nothing
   writes to the tree while they work. Do not skip the reviewers because your own review came back
   clean; that is precisely the case where they pay. Merge and de-duplicate their findings, verify
   each yourself, and carry one consolidated list into Step 3.
4. **Do this again after every fix round, not only after round 1.** A fix round is reviewed the
   same way the implementation was — see **Reviewing a fix round** above. Skipping it because the
   diff is small is how a regression ships.
5. Judge it against this standard:
   - Did the change satisfy this round's scope?
   - Any correctness or regression risk?
   - Tests missing or insufficient?
   - Unnecessary complexity introduced?
   - Anything still ambiguous or unsafe to merge?

### Step 3 — Decide

- **Clean** (no concrete issues) → approve, summarize changed files + validation, done.
- **Concrete issues, rounds used < 3** → go back to Step 1 with an exact fix instruction covering only the findings (round += 1). When that fix lands, review it — **Reviewing a fix round** above is not optional and not lighter than the first review.
- **Concrete issues, this was round 3** → stop looping. Fix the remaining issues yourself directly with Edit/Write, then re-run whatever validation/tests are affected. Tell the user the pane's agent needed a manual finish after 3 rounds and summarize exactly what you changed and why. **Your own fix gets reviewed too** — you are now the implementer, so the same rule applies: you are the last person who should be trusted to judge it, and the non-implementing panes are still available and still read-only.
- **Findings require a product/scope decision** → stop and ask the user, regardless of round count.

The 3-round cap governs *looping on the same findings*. Fresh defects from a cross-agent review or
an owner review start a new cycle rather than exhausting the budget — but if each cycle keeps
finding P1s, say so plainly to the user rather than quietly continuing; that pattern is evidence
about the brief or the review method, not just about the code.

**Rising severity across cycles is a signal about the reviews, not the code.** If round 1 and 2 find
only P2s and a later reviewer finds P1s, the code did not get worse between rounds — the earlier
reviews shared a frame that could not see that class of defect. Say so, and name the frame, rather
than reporting it as the implementer regressing.

**Review the owner's own changes the same way.** When the user hands back edits and asks you to
check them, the deference reflex is to read them as decisions rather than as a diff. Run the same
verification: mutation-check the assertions they added, confirm their "stronger" test did not
replace a catalog sweep with a hand-list, confirm no existing test was weakened. Being asked to
review is being asked to actually review. Where their call overrode yours and theirs was better,
say so plainly and say why — that is how the routing and decline heuristics here get corrected.

## Example

`/panel pane=w3:p4 Fix the flaky timeline test in apps/web/src/lib/timeline.spec.ts`

- Step 0: `herdr agent get w3:p4` → `codex`, idle, `cwd` matches the repo.
- Round 1: submit task, wait in background, agent goes idle.
- Review 1: `git diff` shows a missed edge case in the fix.
- Round 2: submit the exact fix instruction, wait, agent goes idle.
- Review 2: clean → approve, summarize files changed and validation run.

The same flow works unchanged with `pane=` pointing at an `agy` (antigravity), `opencode`, `pi`, or `omp` pane instead — only the `agent` field reported by `herdr agent get` differs.

Routed, with the reviewer fan-out:

`/panel codex-pane=p5 zcoder-pane=p4 agy-pane=p3 Implement TASK-42 per implementation-plan.md`

- Step 0: resolve `p3`/`p4`/`p5` against `$HERDR_WORKSPACE_ID`; Routing picks **zcode** (spec
  fidelity — fixtures derived from the data model, an invariant suite over decided constraints).
  Say so in one line.
- Round 1: brief zcode from the authority documents, wait in background.
- Review 1: dispatch **codex** (adversarial: tenancy, grants, what breaks) and **agy** (leftovers,
  interface claims, tests that cannot fail) concurrently as read-only reviewers, each told not to
  run build/typecheck/format-write commands. Read the diff yourself meanwhile. When both report,
  run the clean-state gate alone, merge and de-duplicate their findings, verify each.
- Round 2: send zcode **one** consolidated fix instruction covering the surviving findings.
- Review 2: review the **fix** — not the whole change again. Confirm each finding actually closed,
  and hunt what the fix broke: re-derive from the spec any expected/oracle row the fix touched,
  since a row edited in the same round as the code it guards has stopped being an independent
  check. Fan the reviewers out again with those angles.
