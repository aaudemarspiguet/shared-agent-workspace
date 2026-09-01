# Quickstart results: spec 002

## Pre-change test baseline (T085)

Recorded before any 002 implementation work, so a later run has a fixed
point of comparison (T142 checks against this table).

| Date | Branch | Platform | Result | Notes |
|------|--------|----------|--------|-------|
| 2026-08-27 | 002 spec branch | Windows | 218/227 | Nine known failures: seven are T081 POSIX-only test-harness assumptions (issue #98), two are T056 credential-ACL gaps (issue #60). Product faults: none known. |
| 2026-08-30 | main (spec 002 merged) | macOS | 229/229 | Includes the two relay-tunnel tests added by PR #107. |

| 2026-08-31 | 002 implementation stack (through Phase 4, PR #177) | macOS | 276/276 | T142 check: every pre-change test still passes; the 17 added tests cover migration, thread routing, modes, authority, and handoffs. |
| 2026-09-01 | main at b7b3b47 (through #198, #204, #209) | Windows | 296/296 | T142 check. First Windows measurement since the 2026-08-27 baseline, so the nine failures recorded there are confirmed gone rather than assumed. |
| 2026-09-01 | T138 branch | Windows | 298/298 | The two tests T138 adds, both for `thread_state_set`, which had none at all. The ref-binding mode gate is asserted inside an existing case, so it moves no count. |

The Windows measurement is Amogh's, taken on the 002 spec branch on
2026-08-27. The macOS measurement is from the merge day. The CI job added
by T084 (`.github/workflows/tests.yml`) reports both platforms on every
push, so this table stops being the only record.

## Two-machine quickstart scenarios (T141)

Not run yet. The eight scenarios run after Phase 4 lands, on two machines,
and their outcome is recorded here.
