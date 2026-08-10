// In-memory room state for one member daemon.
// Holds the ordered message cache, member presence, and a work item mirror.
// The relay stays authoritative. This state only serves local reads fast.
import type { ClaimResultFrame, PresenceFrame, StoredMessage } from "@saw/shared";

export interface MemberView {
  github_username: string;
  online: boolean;
  last_seen_at?: string;
}

export interface WorkItemView {
  feature_tag: string;
  state: "open" | "claimed" | "handed_off" | "done";
  claimed_by?: string;
}

export interface ClaimNotice {
  work_item: string;
  granted: boolean;
  claimed_by: string;
  at: string;
}

export class RoomState {
  private me: string;
  private messagesBySeq = new Map<number, StoredMessage>();
  private memberDir = new Map<string, MemberView>();
  private items = new Map<string, WorkItemView>();
  private notices: ClaimNotice[] = [];
  /** Arrival order of the claim that each item holds now. See `stampClaim`. */
  private claimOrder = new Map<string, number>();
  private claimTicks = 0;

  constructor(me: string, knownMembers: string[]) {
    this.me = me;
    for (const username of new Set([me, ...knownMembers])) {
      this.memberDir.set(username, { github_username: username, online: false });
    }
  }

  // ---- Messages ----

  /** Add one message. Returns false when the seq was already known. */
  addMessage(message: StoredMessage): boolean {
    if (this.messagesBySeq.has(message.seq)) return false;
    this.messagesBySeq.set(message.seq, message);
    this.noteMember(message.sender);
    this.applyItemTransition(message);
    return true;
  }

  /**
   * The OLDEST messages after a seq, in seq order.
   *
   * The window starts at `sinceSeq`, so it is contiguous. A caller that
   * moves a read cursor over this window never steps over a message it did
   * not receive. `inject()` and the unread count depend on that. A caller
   * that wants to show the room as it is now wants `recentMessages`.
   *
   * `workItem` narrows to one work item. It applies before `limit`, so a
   * bounded read returns that many messages OF THAT ITEM. Filtering after
   * the limit would answer with only the matches that happened to fall in
   * the first page, and a busy room would hide the item completely (T066).
   */
  messages(sinceSeq = 0, limit = 200, workItem?: string): StoredMessage[] {
    return this.orderedWindow(sinceSeq, workItem).slice(0, Math.max(1, limit));
  }

  /**
   * The NEWEST messages after a seq, in seq order, newest last.
   *
   * The client syncs from seq 0 at every connect and nothing evicts, so the
   * cache holds the whole room history. A bounded read of that history must
   * answer with its end. The front is the first day of the workspace, which
   * no reader asks for: it hid every message past the limit from the web
   * room and from `room_read` (T078, FR-007).
   *
   * Never move a read cursor over this window. It can start later than
   * `sinceSeq + 1`, so the messages it steps over would be lost.
   */
  recentMessages(sinceSeq = 0, limit = 200, workItem?: string): StoredMessage[] {
    return this.orderedWindow(sinceSeq, workItem).slice(-Math.max(1, limit));
  }

  /** Every cached message after a seq, filtered and sorted, with no limit. */
  private orderedWindow(sinceSeq: number, workItem?: string): StoredMessage[] {
    return [...this.messagesBySeq.values()]
      .filter(
        (m) => m.seq > sinceSeq && (workItem === undefined || m.work_item === workItem)
      )
      .sort((a, b) => a.seq - b.seq);
  }

  latestSeq(): number {
    let max = 0;
    for (const seq of this.messagesBySeq.keys()) if (seq > max) max = seq;
    return max;
  }

  // ---- Members and presence ----

  noteMember(username: string): void {
    if (!this.memberDir.has(username)) {
      this.memberDir.set(username, { github_username: username, online: false });
    }
  }

  applyPresence(frame: PresenceFrame): void {
    this.noteMember(frame.member);
    const view = this.memberDir.get(frame.member);
    if (view) {
      view.online = frame.online;
      view.last_seen_at = frame.last_seen_at;
    }
  }

  members(): MemberView[] {
    return [...this.memberDir.values()];
  }

  peer(): MemberView | undefined {
    return this.members().find((m) => m.github_username !== this.me);
  }

  // ---- Work items ----

  /**
   * Mirror the relay's work item transitions from the message stream.
   * Messages arrive in seq order, so this mirror matches the relay's
   * decisions. The relay stays the authority through claim_result frames.
   */
  private applyItemTransition(message: StoredMessage): void {
    const tag = message.work_item;
    if (!tag) return;
    const item = this.items.get(tag) ?? { feature_tag: tag, state: "open" as const };
    const sender = message.sender;

    if (message.type === "intent") {
      if (item.state === "open") {
        item.state = "claimed";
        item.claimed_by = sender;
        this.stampClaim(tag);
      } else if (item.state === "handed_off" && item.claimed_by === sender) {
        item.state = "claimed";
        this.stampClaim(tag);
      }
    } else if (message.type === "handoff") {
      if (item.state === "claimed" && item.claimed_by === sender) {
        const other = this.members().find((m) => m.github_username !== sender);
        if (other) {
          item.state = "handed_off";
          item.claimed_by = other.github_username;
        }
      }
    } else if (message.type === "decision") {
      if (item.state === "claimed" && item.claimed_by === sender) {
        item.state = "done";
      }
    }
    this.items.set(tag, item);
  }

  /**
   * Record when an item became claimed, as an arrival order.
   *
   * The mirror reads the message stream in seq order, so a higher tick
   * always means a later claim. The `items` Map cannot answer this: its
   * order is the order the items were FIRST seen, so it names the oldest
   * claim for the rest of the session (T078).
   */
  private stampClaim(tag: string): void {
    this.claimTicks += 1;
    this.claimOrder.set(tag, this.claimTicks);
  }

  workItems(): WorkItemView[] {
    return [...this.items.values()];
  }

  /**
   * The work item this member holds now, if any.
   *
   * A member may hold more than one item, because nothing closes an item
   * for them. The newest claim is the one the run is about, so a run that
   * follows two claims is tagged with the second. When the newest claim is
   * later handed off or done, the earlier one it hid becomes the answer
   * again.
   */
  myActiveWorkItem(): string | undefined {
    let newest: string | undefined;
    let newestAt = -1;
    for (const item of this.items.values()) {
      if (item.state !== "claimed" || item.claimed_by !== this.me) continue;
      const at = this.claimOrder.get(item.feature_tag) ?? 0;
      if (at >= newestAt) {
        newestAt = at;
        newest = item.feature_tag;
      }
    }
    return newest;
  }

  // ---- Claim notices ----

  /**
   * Apply the relay's claim verdict to the mirror.
   *
   * The relay decides who holds a work item. This mirror guesses from the
   * message stream, and the guess is wrong when a claim loses a race: the
   * local `intent` already set `claimed_by` to this member. A later `intent`
   * from the winner cannot correct it, because the item is no longer `open`.
   * The verdict therefore wins, whether it granted the claim or refused it.
   */
  applyClaimResult(frame: ClaimResultFrame): void {
    const item = this.items.get(frame.work_item) ?? {
      feature_tag: frame.work_item,
      state: "open" as const
    };
    // Only the owner can be wrong here. The frame carries no state, and the
    // message stream already moved the item to handed_off or done where that
    // applies, so those states must stand.
    const wasClaimed = item.state === "claimed";
    const hadOwner = item.claimed_by;
    item.claimed_by = frame.claimed_by;
    if (item.state === "open") item.state = "claimed";
    // A verdict that hands the item to a new owner is a new claim, so it
    // takes a new arrival order. A verdict that only confirms what the
    // mirror already holds keeps the order of the claim it confirms.
    if (item.state === "claimed" && (!wasClaimed || hadOwner !== frame.claimed_by)) {
      this.stampClaim(frame.work_item);
    }
    this.items.set(frame.work_item, item);
  }

  addClaimNotice(frame: ClaimResultFrame): void {
    this.notices.push({
      work_item: frame.work_item,
      granted: frame.granted,
      claimed_by: frame.claimed_by,
      at: new Date().toISOString()
    });
    if (this.notices.length > 50) this.notices.shift();
  }

  recentClaimNotices(limit = 10): ClaimNotice[] {
    return this.notices.slice(-limit);
  }
}
