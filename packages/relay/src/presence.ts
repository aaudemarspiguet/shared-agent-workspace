// Live connection registry and presence broadcasts.
// Presence is in-memory only. It is derived from live sockets and ping/pong.
import type { WebSocket } from "ws";
import type { ServerFrame } from "@saw/shared";
import type { RelayStore } from "./store.js";

interface Connection {
  ws: WebSocket;
  workspaceId: string;
  memberId: string;
  username: string;
  lastSeenAt: string;
  alive: boolean;
}

export class ConnectionRegistry {
  private byMember = new Map<string, Connection>();

  add(ws: WebSocket, workspaceId: string, memberId: string, username: string): void {
    // One live connection per member. A new connection replaces the old one.
    const old = this.byMember.get(memberId);
    if (old && old.ws !== ws) old.ws.close();
    this.byMember.set(memberId, {
      ws,
      workspaceId,
      memberId,
      username,
      lastSeenAt: new Date().toISOString(),
      alive: true
    });
  }

  remove(ws: WebSocket): Connection | undefined {
    for (const [memberId, conn] of this.byMember) {
      if (conn.ws === ws) {
        this.byMember.delete(memberId);
        return conn;
      }
    }
    return undefined;
  }

  touch(memberId: string): void {
    const conn = this.byMember.get(memberId);
    if (conn) {
      conn.lastSeenAt = new Date().toISOString();
      conn.alive = true;
    }
  }

  isOnline(memberId: string): boolean {
    return this.byMember.has(memberId);
  }

  lastSeen(memberId: string): string | undefined {
    return this.byMember.get(memberId)?.lastSeenAt;
  }

  sendTo(memberId: string, frame: ServerFrame): void {
    const conn = this.byMember.get(memberId);
    if (conn && conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(JSON.stringify(frame));
    }
  }

  /**
   * Send a frame to every member of a workspace.
   * Paused members do not receive `message` frames. They catch up with `sync`
   * after resume, in seq order. Other frame kinds always go through.
   */
  broadcast(
    store: RelayStore,
    workspaceId: string,
    frame: ServerFrame,
    opts: { excludeMemberId?: string } = {}
  ): void {
    for (const member of store.members(workspaceId)) {
      if (member.id === opts.excludeMemberId) continue;
      if (frame.kind === "message" && store.isPaused(member.id)) continue;
      this.sendTo(member.id, frame);
    }
  }

  broadcastPresence(store: RelayStore, workspaceId: string, username: string, online: boolean): void {
    this.broadcast(store, workspaceId, {
      kind: "presence",
      member: username,
      online,
      last_seen_at: new Date().toISOString()
    });
  }

  /**
   * Tell one member the current presence of everyone else in the workspace.
   *
   * A presence broadcast only reaches sockets that are already open, and
   * nothing replayed it afterwards, so the member who connected *second*
   * never learned the first was there and read them as offline for the whole
   * session. Sent on `hello`, the same way `sync` replays missed messages
   * (FR-011a, T037, T074).
   */
  sendPresenceSnapshot(store: RelayStore, workspaceId: string, memberId: string): void {
    for (const member of store.members(workspaceId)) {
      if (member.id === memberId) continue;
      this.sendTo(memberId, {
        kind: "presence",
        member: member.github_username,
        online: this.isOnline(member.id),
        // A member who has never connected has no last-seen time of their
        // own. Joining the workspace is the last thing known about them.
        last_seen_at: this.lastSeen(member.id) ?? member.joined_at
      });
    }
  }

  /** Ping every live socket. Sockets that missed the last pong are closed. */
  pingAll(): void {
    for (const conn of this.byMember.values()) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }

  /** Drop every live socket. Used on shutdown, before the store closes. */
  closeAll(): void {
    for (const conn of this.byMember.values()) conn.ws.terminate();
    this.byMember.clear();
  }

  markAlive(ws: WebSocket): void {
    for (const conn of this.byMember.values()) {
      if (conn.ws === ws) {
        conn.alive = true;
        conn.lastSeenAt = new Date().toISOString();
      }
    }
  }
}
