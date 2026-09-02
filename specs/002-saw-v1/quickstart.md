# Quickstart: Validating threads and collaboration modes

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-08-27

This guide proves User Stories 7, 8 and 9 end to end. It is a validation
guide, not an implementation guide — the contracts are in
[contracts/threads-and-modes.md](./contracts/threads-and-modes.md) and the
entities are in [data-model.md](./data-model.md).

## Prerequisites

- Two machines, or two clones with two members. One member hosts the relay.
- Node.js with the workspace installed: `npm install` at the repo root.
- An existing **v0** workspace with messages under at least two work-item tags,
  plus a few messages under no tag. Scenario A validates the upgrade, so do not
  start from an empty store.
- Both members' coding tools connected: `saw up` on each machine.

## Baseline before you start

```bash
npm test
```

Record the number. Measured on branch `002-saw-v1` on 2026-08-27, the baseline
is **218/227 on Windows**. The nine failures are POSIX assumptions in CLI test
harnesses — seven in `up-resolve.test.ts` (T081, issue #98) and two in
`config.test.ts` (T056, issue #60) — not product faults.

`README.md` quotes 205/214, which is `main`'s figure. This branch carries extra
tests from PR #103, so the total differs while the nine failures are the same
nine. Use the branch number you measure, not the README's.

**Threads and modes must not move that number.** If it drops, the cause is the
change under test.

---

## Scenario A — the upgrade loses nothing (US7, FR-009(a), SC-008)

Run the migration by upgrading the hosting member first.

Then confirm:

1. Every historic work-item tag is queryable as a thread.
2. Each thread holds its own messages, in their original order, with their
   original timestamps.
3. Messages that carried no tag are in one `general` thread per workspace.
4. Tags differing only by case or spacing became **one** thread, and the merge
   is recorded.
5. Claim state carried over: a v0 claim on tag `X` is a claim on the thread
   migrated from `X`.
6. Zero messages and zero log entries were lost.
7. Every migrated thread starts at mode `edit` for every member — **not**
   `comment`. This is deliberate: v0 agents claim work items by posting an
   `intent` carrying the tag, so defaulting migrated threads to `comment` would
   silently remove a capability every member already had (research R3).

Run the migration a second time and confirm it does not run again (FR-035).

## Scenario B — threads are isolated (US7, SC-014)

1. Post into thread 1. Read thread 2. The message is not there.
2. Post a project broadcast. Both members receive it with no thread.
3. Claim thread 1. Confirm thread 2's claim state is unchanged.
4. Have both members claim thread 2 at once. Exactly one wins; the loser is told
   who holds it.
5. Bind two refs from one workspace to thread 1. Both appear, each naming its
   workspace.
6. Confirm an agent's delivery covers the threads its member takes part in plus
   broadcasts, and nothing else.

## Scenario C — modes restrain the agent (US8, SC-015)

On member A's machine:

1. Set thread 1 to `view`. Ask the agent to post. It does not post; it reports
   the mode and tells its member. The denial is recorded.
2. Ask the agent to claim. Same result.
3. Set thread 1 to `comment`. The agent posts. It still cannot claim.
4. Set thread 1 to `edit`. The agent claims and works.
5. Confirm the agent in `view` **still reads** the thread and can answer its
   member's questions from it. A mode governs doing, not seeing — delivery is
   FR-012's mute, a separate control.
6. Pause member A while thread 1 is `edit`. Every later tool call is denied.
   Pause outranks mode.

## Scenario D — nobody sets anyone else's mode (US8, SC-016)

This is the one genuine boundary between members, so test it adversarially.

1. From member B's CLI, try every route to set member A's mode. There is no
   such operation on either surface.
2. Send a hand-crafted mode write naming member A as the target, from B's
   credential, directly to the relay. The relay refuses it.
3. Confirm the refusal is recorded.

Everything else about modes restrains only the caller's own agent, so it needs
no adversarial test — a member who bypasses their own mode has changed their
mind, not attacked anyone (research R1).

## Scenario E — authority binds the record, not the agent (US8, SC-020, SC-021)

1. From a member **without** authority, post with `force: "binding"`. It is
   rejected with a reason, recorded, and **not** silently downgraded.
2. From a member **with** authority, post with `force: "advisory"`. It settles
   nothing and reads as a proposal — authority permits binding, it does not
   impose it.
3. From a member with authority, post a `binding` decision on a thread the other
   member is working in.
4. On the other machine, confirm: the thread shows the matter settled and
   attributable; the agent surfaces the decision to its member on its next run;
   and **zero runs started** on that machine because of it.
5. Confirm the receiving member can dispute the decision in the thread.
6. Post a second, contradicting binding decision. The later one settles it, the
   earlier stays visible as superseded, and nothing is deleted.

## Scenario F — two members work one thread (US8, SC-017)

1. Both members set thread 1 to `edit`.
2. Each prompts their own agent once.
3. The agents agree a plan in the thread and split it into claims.
4. Each works on a branch under its **own** member prefix and pushes.
5. Both refs bind to the thread, each naming its workspace.
6. The branches meet in a git merge or a pull request.
7. Confirm the relay carried **zero** bytes of code, file content, or diff — only
   refs and messages.

## Scenario G — handoff is a lifecycle (US8, SC-022)

1. Propose a handoff from A to B. Confirm the claim has **not** moved.
2. With B's mode at `comment`, confirm B cannot accept and that B's agent
   surfaces it.
3. B raises their mode to `edit` and accepts. The claim moves; the transfer is
   recorded.
4. Propose another handoff and decline it. The claim returns to A.
5. Propose a third and withdraw it. Same.
6. Propose a handoff to a member outside the thread's scope. It fails with a
   plain reason.
7. Confirm every transition is attributable and visible to the thread's scope.

## Scenario H — no agent runs itself (SC-019)

Across every scenario above, confirm the totals:

- Zero runs of any member's agent started from another member's action.
- Zero runs started without that member's own prompt.

This is the v1 boundary, as Scenarios A to H exercise it: outside a consented
session, no agent runs itself and no member's action starts another member's
agent.

Auto mode is no longer deferred. It shipped in v1 under FR-050 and FR-042(a),
where a session is authorised by each member's own standing consent for their
own agent alone. That does not waive the boundary — it satisfies it — and
Scenario I is where the satisfied form is checked. The property is unchanged
and absolute in both: no path exists by which a member who has not given that
consent has their agent started, their machine used, or their budget spent.

## Scenario I — a consented session runs itself, and only then (US9, SC-025..SC-029)

Scenarios A to H predate User Story 9. They validate threads, modes,
authority and handoff; not one of them exercises auto mode, sessions, wakes,
budgets, convergence, or the companion. Run this one too, or the phase 6
stack ships across two machines unvalidated by any live scenario.

Both members start with auto mode **off**, which is the shipped default.

**Nobody's agent starts without their own consent.**

1. Member A posts an ordinary message to a thread. Confirm A's own agent
   wakes within one turn, and that **zero** runs start on B's machine.
2. B's agent posts to the same thread. Confirm **zero** runs start on A's
   machine. An agent's message wakes nobody (SC-025).
3. A turns auto mode on for one thread; B leaves it off. Confirm this alone
   starts no session and no run: consent is per member, and one side's
   consent is not an agreement.

**A session needs two yeses, and the readiness order does not matter.**

4. Both members turn auto mode on for the thread and state the task.
5. A declares readiness. Confirm no session starts on one readiness alone.
6. B declares readiness. Confirm the session starts on the **second** ready,
   and that it would have started the same way had B gone first.
7. Confirm both agents take autonomous turns — at least three each — and
   that every run sits on its own member's machine and budget (SC-026).

**One side's consent is not the other's.**

8. End the session. Turn auto mode off for B only, and start again with A
   alone in auto mode. Confirm A's agent completes autonomous turns while
   **zero** runs start on B's machine (SC-027).

**The stopping controls actually stop it.**

9. With a session live, B pauses their agent. Confirm the pause takes effect
   at once and outranks auto mode — a paused member's agent takes no turn,
   and their own typing does not resume it.
10. Set a low turn budget and let a member reach it. Confirm the session
    suspends rather than overrunning, and that the budget is enforced on the
    member's own side as well as at the relay.
11. Confirm **either** human can end the session, and that the record says
    who ended it (FR-051).

**A human concludes the work, not an agent.**

12. Let an agent propose convergence. Confirm the proposal carries its
    summary and refs, and that the session does **not** conclude on it.
13. Confirm the proposal concludes only when its **own** member approves,
    and that the other member cannot approve it (SC-029).
14. Post a human-authored `decision` on a claim. Confirm it concludes in
    that same post, with no second confirmation asked for.

**The companion answers with the coding tool closed.**

15. Close A's coding tool entirely. Leave `saw up` running.
16. B asks a question on a thread, addressed to A.
17. Confirm A's companion answers from the thread record, posting as itself
    and attributed to A (SC-028).
18. Confirm the companion performed **zero** claims, **zero** ref bindings,
    and **zero** binding posts, and that the run appears once in the work
    log.
19. Have a real answer arrive during the grace period and confirm the
    companion stays silent — a person answering is what it defers to.

**The boundary still holds.**

20. Repeat Scenario H's totals over this scenario: outside a session, zero
    runs started from another member's action; inside one, every run traces
    to its own member's standing consent, declared through their own
    auto-mode control and readiness (FR-019, FR-042a).

---

## Recording results

Record the outcome in `quickstart-results.md` in this directory, following the
shape 001 used. State the date, the members, the machines, and the test-suite
number before and after. A scenario that was not run is recorded as not run —
never as passed.
