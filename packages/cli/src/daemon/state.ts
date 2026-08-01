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

  messages(sinceSeq = 0, limit = 200): StoredMessage[] {
    const all = [...this.messagesBySeq.values()]
      .filter((m) => m.seq > sinceSeq)
      .sort((a, b) => a.seq - b.seq);
    return all.slice(0, Math.max(1, limit));
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
      } else if (item.state === "handed_off" && item.claimed_by === sender) {
        item.state = "claimed";
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

  workItems(): WorkItemView[] {
    return [...this.items.values()];
  }

  /** The work item this member holds now, if any. */
  myActiveWorkItem(): string | undefined {
    for (const item of this.items.values()) {
      if (item.state === "claimed" && item.claimed_by === this.me) {
        return item.feature_tag;
      }
    }
    return undefined;
  }

  // ---- Claim notices ----

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
