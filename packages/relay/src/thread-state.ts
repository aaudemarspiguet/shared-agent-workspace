// Who may move a thread between open, done, and archived (spec 002 FR-010,
// CHK005). Answered by the founders on 2026-08-31, unenforced until T138.
//
// The rule splits along the two axes FR-005 already draws. Concluding work is
// work authority, so it belongs to the member holding the claim. Archiving
// manages the container, so it is administration and belongs to the owner.
// Reopening is neither: any member of the scope may do it, because a thread
// nobody may reopen is a thread that can be closed against its own scope.
//
// This lives in one function on purpose. There are two ways a thread's state
// moves — the `thread_state_set` frame and a post arriving into a done
// thread — and #208 is what happens when a rule of this shape is written
// inline on one path and forgotten on the other.
import type { StoredThread, ThreadState } from "@saw/shared";
import type { MemberRow, ThreadClaimRow } from "./store.js";

/**
 * Returns the refusal to send the member, or null when the move is allowed.
 *
 * `claim` is the thread's claim row, absent for a thread that takes no
 * claims (a brainstorm or general thread) or one nobody has claimed. A
 * thread with no claim holder has no work authority to concentrate, so any
 * member of the scope may conclude it.
 */
export function threadStateRefusal(
  thread: StoredThread,
  claim: ThreadClaimRow | undefined,
  member: MemberRow,
  next: ThreadState
): string | null {
  if (thread.state === next) return null;

  // Archived is read-only until an owner unarchives it. Stated before the
  // per-target rules because it governs the thread whatever the target is.
  if (thread.state === "archived") {
    if (member.role !== "creator") {
      return (
        `thread "${thread.title}" is archived and only the owner can unarchive it. ` +
        `Ask the owner to reopen it.`
      );
    }
    if (next !== "open") {
      return (
        `thread "${thread.title}" is archived. Unarchive it to open first, ` +
        `then move it where you want it.`
      );
    }
    return null;
  }

  if (next === "archived") {
    if (member.role !== "creator") {
      return (
        `archiving thread "${thread.title}" is an owner power: it manages the ` +
        `container, not the work in it. Mark it done instead, or ask the owner.`
      );
    }
    return null;
  }

  if (next === "done") {
    const holder = claim?.claimed_by;
    if (holder && holder !== member.github_username) {
      return (
        `thread "${thread.title}" is claimed by ${holder}, so it concludes on ` +
        `their word rather than yours. Ask them to close it, or take the claim ` +
        `through a handoff first.`
      );
    }
    return null;
  }

  // next === "open": reopening. Any member of the scope, by design.
  return null;
}
