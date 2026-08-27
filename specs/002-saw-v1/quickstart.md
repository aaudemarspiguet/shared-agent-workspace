# Quickstart: Validating threads and collaboration modes

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Date**: 2026-08-27

This guide proves User Story 7 and User Story 8 end to end. It is a validation
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

Record the number. The current baseline is **205/214 on Windows** and 214/214
elsewhere. The nine failures are POSIX assumptions in CLI test harnesses
(T081 issue #98 accounts for seven, T056 issue #60 for two), not product
faults. **Threads and modes must not move that number**; if it drops, the cause
is the change under test.

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

This is the v1 boundary. Continuous mode is deferred to v2 (FR-042(a)) and
nothing in v1 may ship a path around it.

---

## Recording results

Record the outcome in `quickstart-results.md` in this directory, following the
shape 001 used. State the date, the members, the machines, and the test-suite
number before and after. A scenario that was not run is recorded as not run —
never as passed.
