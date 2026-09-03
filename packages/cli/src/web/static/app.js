// SAW room page logic. Talks only to the local daemon.
/* global WebSocket, document, fetch, location, setTimeout, URLSearchParams, Option,
   localStorage, Notification, window */

// The run token (T057). The daemon writes it into this document when it
// serves the page. Every call to the daemon presents it.
const tokenMeta = document.querySelector('meta[name="saw-token"]');
const TOKEN = tokenMeta ? tokenMeta.content : "";

/**
 * Call the local API with the run token.
 * The token rides in an Authorization header, which a cross-origin form
 * cannot set. The daemon refuses a call without it.
 */
function api(path, init) {
  const options = Object.assign({}, init || {});
  options.headers = Object.assign({}, (init && init.headers) || {}, {
    authorization: "Bearer " + TOKEN
  });
  return fetch(path, options);
}

const state = {
  me: null,
  status: null,
  // Is the push socket to the daemon open now? The composer needs it.
  socketOpen: false,
  seen: new Set(),
  // Every feed entry the page holds, in arrival order. Views render from
  // this list, so nothing refetches (T066).
  feedItems: [],
  // The thread is the organizing unit of the page (spec 002, FR-045).
  // mode is "waiting", "all", "broadcasts", or "thread"; threadId applies
  // to "thread". The page OPENS on "waiting" — both humans asked for the
  // same thing from two directions (seq 81, seq 85): the app must open on
  // YOU, not on everything.
  selection: { mode: "waiting", threadId: "" },
  // Which thread states the navigation lists, the way a tracker filters
  // its issue list. "all", or one of open/done/archived.
  threadFilter: "all",
  // The console's last read of /api/health. Null until the tab is opened.
  health: null,
  // Sessions the daemon knows about, seeded by the snapshot and kept
  // current by session events (T154).
  sessions: [],
  // ThreadView rows by id, from /api/status. Titles, claims, and counts.
  threadsById: new Map()
};

const $ = (id) => document.getElementById(id);

// ---- Connection state ----

/** What a failed call to the daemon means. The daemon is down or stopping. */
const DAEMON_DOWN = "The daemon did not answer. Is saw up still running?";

/**
 * The line under the composer that says why sending is off now.
 * The page makes it, because it belongs to the composer, not to one message.
 * The box above it keeps its own job: the reason one post failed.
 */
const offlineNote = el("div", "error");
offlineNote.id = "composer-offline";
offlineNote.hidden = true;
$("composer").appendChild(offlineNote);

/** Show one line in the composer error box. Text only, never markup. */
function showComposerError(text) {
  const box = $("composer-error");
  box.textContent = text;
  box.hidden = false;
}

/**
 * Say why the room cannot take a message now. Return "" when it can.
 *
 * A message leaves this machine through the relay. A composer that looks live
 * while the relay is down loses what the member writes, and the red relay pill
 * in the top bar is far from the box they type in.
 */
function offlineReason() {
  if (!state.socketOpen) return "Not connected to saw up. Your message cannot be sent.";
  if (state.status && !state.status.relay_connected) {
    return "The relay is not connected. Your message cannot reach your peer yet.";
  }
  return "";
}

/** Turn the send control on or off, and say why beside the text box. */
function renderComposerState() {
  const why = offlineReason();
  const send = $("send-btn");
  send.disabled = why !== "";
  send.style.opacity = why ? "0.5" : "";
  send.style.cursor = why ? "not-allowed" : "";
  send.title = why;
  offlineNote.textContent = why;
  offlineNote.hidden = why === "";
}

// ---- Rendering ----

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMessage(m) {
  // Addressed to this member: the message reads like a mention (FR-045).
  const mention = m.target && m.target === state.me && m.sender !== state.me;
  const wrap = el(
    "div",
    "msg" +
      (m.sender === state.me ? " mine" : "") +
      (mention ? " mention" : "") +
      // A companion answer is not its member and not their coding agent.
      // Saying so is the whole point of it having its own identity.
      (m.sender_kind === "companion" ? " from-companion" : "")
  );
  const head = el("div", "head");
  head.appendChild(el("span", "sender", m.sender));
  head.appendChild(el("span", "badge " + m.sender_kind, m.sender_kind));
  head.appendChild(el("span", "type " + m.type, m.type));
  if (m.target) head.appendChild(el("span", "target", "→ " + m.target));
  head.appendChild(el("span", "", "#" + m.seq + " · " + fmtTime(m.sent_at)));
  wrap.appendChild(head);
  wrap.appendChild(el("div", "body", m.body));
  const meta = el("div", "meta");
  (m.refs || []).forEach((r) => meta.appendChild(el("span", "ref", r.kind + ":" + r.value)));
  if (m.work_item) meta.appendChild(el("span", "work-item", m.work_item));
  if (meta.childNodes.length > 0) wrap.appendChild(meta);
  return wrap;
}

function renderNotice(n) {
  const cls = "notice" + (n.granted ? "" : " rejected");
  const text = n.granted
    ? `claim: "${n.work_item}" now held by ${n.claimed_by}`
    : `claim rejected: "${n.work_item}" is already held by ${n.claimed_by}`;
  return el("div", cls, text);
}

function appendToFeed(node) {
  const feed = $("feed");
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  feed.appendChild(node);
  if (nearBottom) feed.scrollTop = feed.scrollHeight;
}

function renderItem(item) {
  if (item.kind === "handoff") return renderHandoff(item.data);
  return item.kind === "message" ? renderMessage(item.data) : renderNotice(item.data);
}

/** One handoff card. The claim moves only when the recipient accepts. */
function renderHandoff(h) {
  const thread = state.threadsById.get(h.thread_id);
  const div = el("div", "msg handoff-card");
  const label =
    h.state === "proposed"
      ? h.directed
        ? "directed handoff"
        : "handoff proposed"
      : "handoff " + h.state;
  div.appendChild(
    el(
      "div",
      "meta",
      `${label}: ${h.from_member} → ${h.to_member} on "${(thread && thread.title) || h.thread_id}" ` +
        `[tip ${h.tip_ref.kind}:${h.tip_ref.value}]`
    )
  );
  const answer = async (action) => {
    try {
      await api("/api/handoff", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, handoff_id: h.id })
      });
    } catch {
      showComposerError(DAEMON_DOWN);
    }
  };
  if (h.state === "proposed" && state.me === h.to_member) {
    const row = el("div", "handoff-actions");
    const accept = el("button", "", "Accept (needs your mode at edit)");
    accept.addEventListener("click", () => answer("accept"));
    const decline = el("button", "", "Decline");
    decline.addEventListener("click", () => answer("decline"));
    row.appendChild(accept);
    row.appendChild(decline);
    div.appendChild(row);
  }
  if (h.state === "proposed" && state.me === h.from_member) {
    const row = el("div", "handoff-actions");
    const withdraw = el("button", "", "Withdraw");
    withdraw.addEventListener("click", () => answer("withdraw"));
    row.appendChild(withdraw);
    div.appendChild(row);
  }
  return div;
}

// ---- Unread and waiting-on-you (the list lane: items 1 and 2 of seq 89) ----

// What the member has SEEN, kept in this browser only. A thread is seen up
// to a seq when its own view was open in a focused window - glancing the
// All-activity firehose does not count as reading a thread, so the
// aggregate views never mark anything seen. Broadcasts are a leaf view and
// live under the "" key.
const SEEN_KEY = "saw-last-seen";

function seenMap() {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY)) || {};
  } catch {
    return {};
  }
}

function markThreadSeen(threadId) {
  let top = 0;
  state.feedItems.forEach((i) => {
    if (i.kind !== "message") return;
    if ((i.data.thread_id || "") !== threadId) return;
    if (i.data.seq > top) top = i.data.seq;
  });
  if (top === 0) return;
  try {
    const seen = seenMap();
    if ((seen[threadId] || 0) < top) {
      seen[threadId] = top;
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
    }
  } catch {
    // A browser with no storage keeps working; the dots just stay lit.
  }
}

/** Unread facts for one thread ("" = broadcasts): count, and mentions. */
function unreadInfo(threadId) {
  const seenUpTo = seenMap()[threadId] || 0;
  let count = 0;
  let mentions = 0;
  state.feedItems.forEach((i) => {
    if (i.kind !== "message") return;
    if ((i.data.thread_id || "") !== threadId) return;
    if (i.data.seq <= seenUpTo) return;
    count += 1;
    if (i.data.target === state.me && i.data.sender !== state.me) mentions += 1;
  });
  return { count, mentions };
}

/**
 * Why one thread is waiting on THIS member, as plain reasons. Empty means
 * it is not. The definition is deliberately narrow: a mention you have not
 * read, an approval only you can give, a handoff only you can answer, or
 * news in work you own. Someone else's busy thread never lands here.
 */
function waitingReasons(t) {
  const reasons = [];
  const unread = unreadInfo(t.id);
  if (unread.mentions > 0) reasons.push("mentions you");
  if (t.claim_state === "done_proposed" && t.claimed_by === state.me) {
    reasons.push("your approval");
  }
  const handoff = state.feedItems.some(
    (i) =>
      i.kind === "handoff" &&
      i.data.state === "proposed" &&
      i.data.to_member === state.me &&
      i.data.thread_id === t.id
  );
  if (handoff) reasons.push("handoff to you");
  if (t.claimed_by === state.me && unread.count > 0 && unread.mentions === 0) {
    reasons.push("new in yours");
  }
  return reasons;
}

/** The threads waiting on this member, most recently active first. */
function waitingThreads() {
  return Array.from(state.threadsById.values())
    .map((t) => ({ thread: t, reasons: waitingReasons(t) }))
    .filter((w) => w.reasons.length > 0)
    .sort((a, b) => (b.thread.message_count || 0) - (a.thread.message_count || 0));
}

/** Does one feed entry belong to the view the member chose? */
function passesFilter(item) {
  if (state.selection.mode === "all") return true;
  if (state.selection.mode === "waiting") {
    // The waiting view shows the threads that need this member, whole, so
    // the message that made a thread waiting arrives with its context.
    if (item.kind === "notice") return false;
    const ids = new Set(waitingThreads().map((w) => w.thread.id));
    if (item.kind === "handoff") return ids.has(item.data.thread_id);
    return ids.has(item.data.thread_id || "");
  }
  // Claim notices carry no thread, so they live in the full view only.
  if (item.kind === "notice") return false;
  if (item.kind === "handoff") {
    if (state.selection.mode === "broadcasts") return false;
    return item.data.thread_id === state.selection.threadId;
  }
  const threadId = item.data.thread_id;
  if (state.selection.mode === "broadcasts") return !threadId;
  return threadId === state.selection.threadId;
}

/** Hold one entry, and show it when the filter allows it. */
function addItem(kind, data) {
  const item = { kind, data };
  state.feedItems.push(item);
  if (passesFilter(item)) appendToFeed(renderItem(item));
}

/** Draw the feed again from the entries the page holds. No refetch. */
function renderFeed() {
  const feed = $("feed");
  feed.textContent = "";
  const items = state.feedItems.filter(passesFilter);
  items.forEach((item) => feed.appendChild(renderItem(item)));
  if (items.length === 0 && state.selection.mode === "waiting") {
    // The best thing this view can say. An empty inbox is a state worth
    // designing for, not an accident.
    feed.appendChild(el("div", "empty", "Nothing is waiting on you."));
  }
  feed.scrollTop = feed.scrollHeight;
}

function addMessage(m) {
  if (state.seen.has(m.seq)) return;
  state.seen.add(m.seq);
  addItem("message", m);
  // Reading happens where the member is: a message landing in the thread
  // they have open, in a focused window, is seen on arrival. Anywhere
  // else, the list relights so its dot can say so.
  const key = m.thread_id || "";
  const open =
    (state.selection.mode === "thread" && state.selection.threadId === key) ||
    (state.selection.mode === "broadcasts" && key === "");
  if (open && document.hasFocus()) {
    markThreadSeen(key);
  } else if (state.me) {
    renderThreads(Array.from(state.threadsById.values()));
  }
}

function renderStatus(status) {
  state.status = status;
  state.me = status.me;
  $("workspace-name").textContent = status.workspace;

  const members = $("members");
  members.textContent = "";
  status.members.forEach((m) => {
    const item = el("span", "member" + (m.github_username === status.me ? " me" : ""));
    const dot = el("span", "dot" + (m.online ? " online" : ""));
    item.appendChild(dot);
    item.appendChild(el("span", "", m.github_username));
    if (m.paused) item.appendChild(el("span", "paused-tag", "paused"));
    members.appendChild(item);
  });

  const relay = $("relay-dot");
  relay.className = "relay " + (status.relay_connected ? "on" : "off");
  renderComposerState();

  const pauseBtn = $("pause-btn");
  pauseBtn.hidden = false;
  pauseBtn.textContent = status.paused ? "Resume my agent" : "Pause my agent";
  pauseBtn.className = "pause" + (status.paused ? " paused" : "");

  const target = $("msg-target");
  const current = target.value;
  target.textContent = "";
  target.appendChild(new Option("to: everyone", ""));
  status.members
    .filter((m) => m.github_username !== status.me)
    .forEach((m) => target.appendChild(new Option("to: " + m.github_username, m.github_username)));
  target.value = current;

  renderThreads(status.threads || []);
  renderThreadHeader();
  // A status arrives on every event. Redraw the console only while it is
  // the panel on screen.
  const consolePanel = $("console");
  if (consolePanel && consolePanel.classList.contains("active")) renderConsole();
}

// ---- Sessions, auto mode, and the two approvals (T154, T155, US9) ----
//
// Every control here is self-directed. A member turns on THEIR OWN auto
// mode, declares THEIR OWN readiness, and approves THEIR OWN agent's
// proposal. Nothing on this surface writes another member's consent, and
// nothing offers a control that would be refused if pressed — an approve
// button on someone else's proposal would be a lie about who decides.

const SESSION_OVER = ["concluded", "ended"];

// Where a failed session control explains itself. It belongs beside the
// control, not in the composer's error box at the far end of the pane: the
// member pressed a button at the top of the thread and would never see an
// explanation printed at the bottom.
let sessionErrorBox = null;

function showSessionError(text) {
  if (!sessionErrorBox) {
    showComposerError(text);
    return;
  }
  sessionErrorBox.textContent = text;
  sessionErrorBox.hidden = false;
}

/** The thread's session that has not concluded or ended, if any. */
function activeSessionFor(threadId) {
  return state.sessions
    .filter((s) => s.thread_id === threadId && !SESSION_OVER.includes(s.state))
    .slice(-1)[0];
}

/** Replace one session in the page's list, keeping arrival order. */
function upsertSession(session) {
  const at = state.sessions.findIndex((s) => s.id === session.id);
  if (at === -1) state.sessions.push(session);
  else state.sessions[at] = session;
}

/** POST to the daemon and say so plainly when it refuses. */
async function sessionCall(path, body) {
  let res;
  try {
    res = await api(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch {
    showSessionError(DAEMON_DOWN);
    return false;
  }
  if (res.ok) return true;
  const answer = await res.json().catch(() => ({}));
  // The daemon refuses these now rather than reporting a success it did
  // not achieve, so there is a real reason to show. Say it plainly.
  showSessionError(
    (answer.error && answer.error.message) || "the daemon refused that control"
  );
  return false;
}

function button(label, className, onClick) {
  const b = el("button", className, label);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * The claim's approve control (T155, FR-052, SC-029).
 *
 * An agent's decision is a proposal; a human's own post concludes. So this
 * appears only on the member's own claim, and only while it is proposed.
 * Approval is self-directed: no member may approve another's, which is why
 * the other side sees a plain sentence rather than a control.
 */
function renderClaimApproval(thread) {
  if (thread.claim_state !== "done_proposed") return null;
  const box = el("div", "approval");
  if (thread.claimed_by !== state.me) {
    box.appendChild(
      el("span", "approval-note", `${thread.claimed_by}'s agent proposed this done. Theirs to approve.`)
    );
    return box;
  }
  box.appendChild(el("span", "approval-note", "Your agent proposes this work is done."));
  box.appendChild(
    button("Approve and close", "approve", async () => {
      await sessionCall("/api/claim/approve", { thread_id: thread.id });
    })
  );
  return box;
}

/** One member's turn budget. The number is the member's own ceiling. */
function turnBox(member) {
  const box = el("span", "turn-box");
  const used = member.turns_used || 0;
  const max = member.max_turns || 0;
  box.appendChild(el("span", "turn-who", member.member));
  const count = el("span", "turn-count", `${used}/${max}`);
  if (max > 0 && used >= max) count.classList.add("spent");
  box.appendChild(count);
  box.title = member.ready_at
    ? `ready since ${fmtTime(member.ready_at)}`
    : "has not declared readiness yet";
  if (!member.ready_at) box.classList.add("not-ready");
  return box;
}

/** The convergence proposal, and who may conclude it. */
function renderConvergence(session) {
  const c = session.convergence;
  if (!c) return null;
  const box = el("div", "approval");
  box.appendChild(el("div", "converge-summary", c.summary));
  (c.refs || []).forEach((r) => box.appendChild(el("span", "ref", r.kind + ":" + r.value)));
  if (c.approved_by) {
    box.appendChild(
      el("span", "approval-note", `Approved by ${c.approved_by} at ${fmtTime(c.approved_at)}.`)
    );
    return box;
  }
  if (c.proposed_by === state.me) {
    box.appendChild(el("span", "approval-note", "Your agent proposes the work has converged."));
    box.appendChild(
      button("Approve and conclude", "approve", async () => {
        await sessionCall("/api/session/approve", { session_id: session.id });
      })
    );
  } else {
    box.appendChild(
      el("span", "approval-note", `${c.proposed_by}'s agent proposed convergence. Theirs to approve.`)
    );
  }
  return box;
}

/** The readiness control: the task, this member's budget, and the yes. */
function renderReadiness(thread) {
  const box = el("div", "readiness");
  const task = document.createElement("input");
  task.type = "text";
  task.className = "task-input";
  task.maxLength = 600;
  task.placeholder = "what the two agents will work on";
  const turns = document.createElement("input");
  turns.type = "number";
  turns.className = "turns-input";
  turns.min = "1";
  turns.max = "500";
  turns.value = "50";
  turns.title = "your own turn budget for this session";
  box.appendChild(task);
  box.appendChild(turns);
  box.appendChild(
    button("I'm ready", "ready-btn", async () => {
      const body = { thread_id: thread.id };
      const text = task.value.trim();
      if (text) body.task = text;
      const n = Number(turns.value);
      if (Number.isFinite(n) && n > 0) body.max_turns = n;
      if (await sessionCall("/api/session/ready", body)) task.value = "";
    })
  );
  box.appendChild(
    el(
      "div",
      "readiness-note",
      "A session starts when both members are ready. Either of you can end it."
    )
  );
  return box;
}

/**
 * The session panel under the thread header.
 *
 * It is deliberately quiet until it has something to say: with auto mode off
 * and no session, it is one toggle. Auto mode is the consent, readiness is
 * the yes, and the panel shows them in that order because that is the order
 * the rules apply in.
 */
function renderSessionPanel(thread) {
  const panel = el("div", "session-panel");
  sessionErrorBox = el("div", "session-error");
  sessionErrorBox.hidden = true;

  const claimApproval = renderClaimApproval(thread);
  if (claimApproval) panel.appendChild(claimApproval);

  const row = el("div", "session-row");
  const on = thread.my_auto_mode === true;
  row.appendChild(
    button(on ? "auto mode: on" : "auto mode: off", "auto-toggle" + (on ? " on" : ""), async () => {
      await sessionCall("/api/auto-mode", { thread_id: thread.id, enabled: !on });
    })
  );

  const session = activeSessionFor(thread.id);
  if (session) {
    row.appendChild(el("span", "badge session-state", session.state));
    if (session.task) row.appendChild(el("span", "session-task", session.task));
    (session.members || []).forEach((m) => row.appendChild(turnBox(m)));
    row.appendChild(
      button("End session", "end-btn", async () => {
        await sessionCall("/api/session/end", { session_id: session.id });
      })
    );
  } else if (on) {
    row.appendChild(el("span", "session-hint", "auto mode is on for you"));
  }
  panel.appendChild(row);

  if (session) {
    const converge = renderConvergence(session);
    if (converge) panel.appendChild(converge);
  } else if (on) {
    panel.appendChild(renderReadiness(thread));
  }

  // A session that finished still owes the room an account of who stopped it.
  const last = state.sessions
    .filter((s) => s.thread_id === thread.id && SESSION_OVER.includes(s.state))
    .slice(-1)[0];
  if (!session && last) {
    const by =
      last.ended_by === "budget"
        ? "ended when a turn budget ran out"
        : `${last.state} by ${last.ended_by || "someone"}`;
    panel.appendChild(el("div", "session-past", `Last session ${by}.`));
  }

  panel.appendChild(sessionErrorBox);
  return panel;
}

// ---- Thread navigation and the thread header (T145/T146, FR-045) ----

/** How a claim reads to a person. Claims are assignees (FR-045). */
function claimLabel(thread) {
  if (thread.claim_state === "open" || !thread.claimed_by) return "";
  return thread.claimed_by;
}

/** The word next to the assignee, when the claim is not simply held. */
function claimNote(thread) {
  if (thread.claim_state === "done") return "done";
  if (thread.claim_state === "done_proposed") return "awaiting approval";
  if (thread.claim_state === "handed_off") return "handoff open";
  return "";
}

/** One assignee chip: initial and name, the way a tracker shows an owner. */
function assigneeChip(who) {
  const chip = el("span", "assignee");
  chip.appendChild(el("span", "avatar", who.slice(0, 1).toUpperCase()));
  chip.appendChild(el("span", "", who));
  chip.title = "assignee — holds the claim on this thread";
  return chip;
}

/** The state chips above the list. A tracker filters by state; so does this. */
function renderThreadFilters(threads) {
  const box = $("thread-filters");
  box.textContent = "";
  const counts = { all: threads.length, open: 0, done: 0, archived: 0 };
  threads.forEach((t) => {
    if (counts[t.state] !== undefined) counts[t.state] += 1;
  });
  ["all", "open", "done", "archived"].forEach((name) => {
    // A state nobody is using is noise. "all" and "open" always show, so
    // the control never empties out.
    if (counts[name] === 0 && name !== "all" && name !== "open") return;
    const chip = el("button", "chip" + (state.threadFilter === name ? " on" : ""));
    chip.type = "button";
    chip.textContent = name + " " + counts[name];
    chip.addEventListener("click", () => {
      state.threadFilter = name;
      renderThreads(Array.from(state.threadsById.values()));
    });
    box.appendChild(chip);
  });
}

/**
 * The primary navigation: threads with visible states and claims that read
 * like assignees (T145, FR-045). The flat feed is not the structure here —
 * it is the first entry in this list, one view among the threads.
 */
function renderThreads(threads) {
  state.threadsById = new Map(threads.map((t) => [t.id, t]));
  const list = $("thread-list");
  list.textContent = "";
  renderThreadFilters(threads);

  const row = (label, mode, threadId, build) => {
    const div = el("div", "thread-row");
    div.setAttribute("role", "option");
    const selected =
      state.selection.mode === mode &&
      (mode !== "thread" || state.selection.threadId === threadId);
    if (selected) div.classList.add("selected");
    div.setAttribute("aria-selected", selected ? "true" : "false");
    div.appendChild(el("span", "thread-title", label));
    if (build) build(div);
    div.addEventListener("click", () => {
      state.selection = { mode, threadId: threadId || "" };
      // Opening a leaf view is reading it. The aggregate views are a
      // glance, and a glance marks nothing seen.
      if (mode === "thread") markThreadSeen(threadId);
      if (mode === "broadcasts") markThreadSeen("");
      renderThreads(Array.from(state.threadsById.values()));
      renderThreadHeader();
      renderFeed();
    });
    return div;
  };

  // The saved views. "Waiting on you" leads because it is the question
  // both humans open the app to answer; the flat feed stays reachable, as
  // a view over threads.
  const views = el("div", "thread-views");
  const waiting = waitingThreads();
  views.appendChild(
    row("Waiting on you", "waiting", "", (div) => {
      if (waiting.length > 0) {
        div.appendChild(el("span", "waiting-count", String(waiting.length)));
      }
    })
  );
  views.appendChild(row("All activity", "all", ""));
  views.appendChild(
    row("Broadcasts", "broadcasts", "", (div) => {
      const b = unreadInfo("");
      if (b.count > 0) div.appendChild(el("span", "unread-dot" + (b.mentions ? " strong" : "")));
    })
  );
  list.appendChild(views);

  const shown = threads
    .slice()
    .filter((t) => state.threadFilter === "all" || t.state === state.threadFilter)
    // Open work first, then by how much is happening in it.
    .sort((a, b) => {
      const rank = (t) => (t.state === "open" ? 0 : t.state === "done" ? 1 : 2);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.message_count || 0) - (a.message_count || 0);
    });

  if (shown.length === 0) {
    list.appendChild(el("div", "empty", "No threads in this filter."));
  }

  shown.forEach((t) => {
    list.appendChild(
      row(t.title, "thread", t.id, (div) => {
        // The red dot (item 1 of seq 89). Every thread with unread gets
        // one; a mention of you, or news in work you own, gets the strong
        // form - shrey's rule and amogh's ask, one dot.
        const unread = unreadInfo(t.id);
        if (unread.count > 0) {
          const strong = unread.mentions > 0 || t.claimed_by === state.me;
          const dot = el("span", "unread-dot" + (strong ? " strong" : ""));
          dot.title =
            unread.count +
            " unread" +
            (unread.mentions > 0 ? ", mentions you" : "") +
            (t.claimed_by === state.me ? ", yours" : "");
          div.classList.add("unread");
          div.appendChild(dot);
        }
        const meta = el("span", "thread-meta");
        if (t.state !== "open") meta.appendChild(el("span", "badge state", t.state));
        const who = claimLabel(t);
        if (who) meta.appendChild(assigneeChip(who));
        const note = claimNote(t);
        if (note) meta.appendChild(el("span", "badge claim-note", note));
        if (t.message_count) meta.appendChild(el("span", "count", String(t.message_count)));
        div.appendChild(meta);
      })
    );
  });

  // The selected thread can disappear (archived elsewhere). Fall back to
  // the home view, which is the waiting one.
  if (
    state.selection.mode === "thread" &&
    !state.threadsById.has(state.selection.threadId)
  ) {
    state.selection = { mode: "waiting", threadId: "" };
    renderThreadHeader();
    renderFeed();
  }
}

/**
 * The header above the conversation: what this thread is, where it stands,
 * who holds it, and the one control that is the member's own to set.
 *
 * The mode control lives here rather than on every list row. It is per
 * thread, it applies to the member's own agent only, and a dropdown on every
 * row of the navigation reads as a bulk-edit affordance it is not.
 */
function renderThreadHeader() {
  const head = $("thread-header");
  head.textContent = "";

  if (state.selection.mode !== "thread") {
    const label =
      state.selection.mode === "broadcasts"
        ? "Broadcasts — messages sent to no single thread"
        : state.selection.mode === "waiting"
          ? "Waiting on you — mentions, approvals, handoffs, and news in your work"
          : "All activity — every thread, newest last";
    head.appendChild(el("span", "thread-head-title", label));
    return;
  }

  const t = state.threadsById.get(state.selection.threadId);
  if (!t) return;

  head.appendChild(el("span", "thread-head-title", t.title));
  const meta = el("span", "thread-head-meta");
  meta.appendChild(el("span", "badge " + t.type, t.type.replace("_", " ")));
  meta.appendChild(el("span", "badge state", t.state));
  const who = claimLabel(t);
  if (who) meta.appendChild(assigneeChip(who));
  else if (t.type === "work_item") meta.appendChild(el("span", "assignee none", "unassigned"));
  const note = claimNote(t);
  if (note) meta.appendChild(el("span", "badge claim-note", note));
  (t.refs || []).forEach((binding) => {
    const r = binding.ref || binding;
    if (r && r.kind) meta.appendChild(el("span", "ref", r.kind + ":" + r.value));
  });
  head.appendChild(meta);

  // Your own mode on the thread (T121). It restrains your own agent only;
  // there is no control for the other member's, by design.
  const modeBox = el("span", "thread-head-mode");
  modeBox.appendChild(el("span", "mode-label", "my agent:"));
  const mode = document.createElement("select");
  mode.className = "mode-select";
  mode.title = "your agent's mode on this thread (yours only)";
  ["view", "comment", "edit"].forEach((m) => mode.appendChild(new Option(m, m)));
  mode.value = t.my_mode || "comment";
  mode.addEventListener("change", async () => {
    try {
      await api("/api/thread/mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ thread_id: t.id, mode: mode.value })
      });
    } catch {
      showComposerError(DAEMON_DOWN);
    }
  });
  modeBox.appendChild(mode);
  head.appendChild(modeBox);

  // The session controls sit under the header, not in it: they are the
  // thread's live state rather than its identity, and they grow tall.
  const panel = renderSessionPanel(t);
  if (panel) head.appendChild(panel);
}

$("thread-new").addEventListener("click", () => {
  const form = $("thread-form");
  form.hidden = !form.hidden;
  if (!form.hidden) $("thread-title").focus();
});

$("thread-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("thread-title").value.trim();
  if (!title) return;
  let res;
  try {
    res = await api("/api/thread/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: $("thread-type").value, title })
    });
  } catch {
    showComposerError(DAEMON_DOWN);
    return;
  }
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) {
    showComposerError((answer.error && answer.error.message) || "the thread was not opened");
    return;
  }
  $("thread-title").value = "";
  $("thread-form").hidden = true;
  if (answer.thread) {
    state.threadsById.set(answer.thread.id, answer.thread);
    state.selection = { mode: "thread", threadId: answer.thread.id };
    renderThreads(Array.from(state.threadsById.values()));
    renderFeed();
  }
});

// ---- Live channel ----

/**
 * The socket did not open. Decide whether this page holds a dead token.
 *
 * Each run of saw up makes a new token, so a page left open across a restart
 * can never connect again. Ask for the page again: when the daemon answers
 * with a different token, load the page again to pick it up. When the daemon
 * does not answer, it is down, and the ordinary retry is right.
 */
async function recoverAfterFailedConnect() {
  try {
    const res = await fetch("/", { cache: "no-store" });
    if (!res.ok) return;
    const html = await res.text();
    if (html.indexOf('content="' + TOKEN + '"') === -1) location.reload();
  } catch {
    // The daemon is down. Keep the token and keep retrying.
  }
}

function connect() {
  // A browser cannot set a header on a WebSocket handshake. The token goes in
  // a subprotocol instead of the address, so it stays out of logs and out of
  // any address the member copies. The server selects the plain "saw" name.
  const ws = new WebSocket(`ws://${location.host}/ws`, ["saw.token." + TOKEN, "saw"]);
  let opened = false;
  ws.onopen = () => {
    opened = true;
    state.socketOpen = true;
    renderComposerState();
  };
  ws.onmessage = (raw) => {
    let data;
    try {
      data = JSON.parse(raw.data);
    } catch {
      return;
    }
    if (data.kind === "snapshot") {
      $("feed").textContent = "";
      state.seen.clear();
      state.feedItems = [];
      // Who "me" is must be known before the replay renders, or no old
      // message addressed to this member would read as a mention.
      if (data.status) state.me = data.status.me;
      state.sessions = data.sessions || [];
      (data.messages || []).forEach(addMessage);
      (data.notices || []).forEach((n) => addItem("notice", n));
      renderStatus(data.status);
      // The waiting view judges messages BY THEIR THREADS, and the replay
      // above ran before renderStatus filled the thread map - so the feed
      // must be drawn once more, now that it can answer.
      renderFeed();
      return;
    }
    if (data.kind === "event") {
      const event = data.event || {};
      if (event.kind === "message" && event.message) {
        addMessage(event.message);
        // Only a LIVE arrival can ping. Snapshot replay never lands here,
        // so a reconnect does not re-announce the whole backlog.
        notifyPing(event.message);
      }
      if (event.kind === "claim_result" && event.claim) {
        addItem("notice", event.claim);
      }
      // The daemon has always emitted this; the page ignored it until T154.
      // It is what makes turn counts and state changes live.
      if (event.kind === "session" && event.session) {
        upsertSession(event.session);
        renderThreadHeader();
      }
      if (event.kind === "handoff" && event.handoff) {
        state.feedItems = state.feedItems.filter(
          (i) => !(i.kind === "handoff" && i.data.id === event.handoff.id)
        );
        state.feedItems.push({ kind: "handoff", data: event.handoff });
        renderFeed();
      }
      if (data.status) renderStatus(data.status);
    }
  };
  ws.onclose = () => {
    state.socketOpen = false;
    renderComposerState();
    setTimeout(connect, 1500);
    if (!opened) void recoverAfterFailedConnect();
  };
}

// ---- Composer (T036) ----

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = $("msg-body").value.trim();
  $("composer-error").hidden = true;
  if (!body) return;
  // The send control is off, but a keyboard can still submit a form.
  if (offlineReason()) return;
  const payload = {
    type: $("msg-type").value,
    body,
    sender_kind: "human"
  };
  if (state.selection.mode === "thread") payload.thread_id = state.selection.threadId;
  const target = $("msg-target").value;
  if (target) payload.target = target;

  // The daemon can go down between two keystrokes. A rejected fetch must not
  // escape this handler: the message would vanish with no word to the member.
  let res;
  try {
    res = await api("/api/post", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
    showComposerError(DAEMON_DOWN + " Your text is still here.");
    return;
  }
  if (res.ok) {
    $("msg-body").value = "";
    return;
  }
  const answer = await res.json().catch(() => ({}));
  showComposerError(
    (answer.error && `${answer.error.code}: ${answer.error.message}`) || "post failed"
  );
});

// ---- Pings (FR-045: an addressed message can reach the member) ----

// Two consents stack here, deliberately. The toggle is the member's own
// preference, local to this browser. The permission is the browser's, and
// asking for it needs a click — a page cannot ask idly. A ping shows only
// when both say yes; the title badge needs neither, because a changed tab
// title announces nothing outside the member's own tab bar.
const PING_PREF = "saw-pings";
const BASE_TITLE = document.title;
let unseenPings = 0;

function pingPref() {
  try {
    return localStorage.getItem(PING_PREF) === "on";
  } catch {
    return false;
  }
}

function renderPingButton() {
  const btn = $("ping-btn");
  if (typeof Notification === "undefined") {
    btn.hidden = true;
    return;
  }
  if (Notification.permission === "denied") {
    btn.textContent = "pings blocked";
    btn.title = "the browser blocks notifications for this page; allow them in site settings";
    btn.disabled = true;
    btn.classList.remove("on");
    return;
  }
  const on = pingPref() && Notification.permission === "granted";
  btn.textContent = on ? "pings: on" : "pings: off";
  btn.classList.toggle("on", on);
}

$("ping-btn").addEventListener("click", async () => {
  if (typeof Notification === "undefined") return;
  const on = pingPref() && Notification.permission === "granted";
  try {
    if (on) {
      localStorage.setItem(PING_PREF, "off");
    } else {
      const answer = await Notification.requestPermission();
      localStorage.setItem(PING_PREF, answer === "granted" ? "on" : "off");
    }
  } catch {
    // A browser with no storage still gets the session's permission state.
  }
  renderPingButton();
});

/**
 * One live message addressed to this member, from the other side. The
 * title badge counts whenever the page is not focused; the desktop
 * notification additionally needs the toggle and the permission.
 */
function notifyPing(m) {
  if (!state.me || m.target !== state.me || m.sender === state.me) return;
  if (document.hasFocus()) return;
  unseenPings += 1;
  document.title = "(" + unseenPings + ") " + BASE_TITLE;
  if (pingPref() && typeof Notification !== "undefined" && Notification.permission === "granted") {
    const body = m.body.length > 140 ? m.body.slice(0, 140) + "…" : m.body;
    // The tag keeps a reconnect race from stacking duplicate toasts for
    // one message: same seq, same toast.
    const note = new Notification(m.sender + " → you in SAW", { body, tag: "saw-ping-" + m.seq });
    note.onclick = () => window.focus();
  }
}

window.addEventListener("focus", () => {
  unseenPings = 0;
  document.title = BASE_TITLE;
});

// ---- Pause control (T037) ----

$("pause-btn").addEventListener("click", async () => {
  if (!state.status) return;
  // The button text only changes when the daemon sends the new status back.
  // Without this guard a dead daemon leaves the button silent and unchanged.
  try {
    const res = await api("/api/pause", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: !state.status.paused })
    });
    if (!res.ok) showComposerError("The daemon refused the pause control.");
  } catch {
    showComposerError(DAEMON_DOWN);
  }
});

// ---- The developer console (T147, FR-047) ----
//
// Monitor and configure: is the connection up and how does it reach the
// relay, is this repository's agent integration actually wired, who is in
// the workspace, and what has this member's agent been allowed to do.
// Every value comes from the daemon. Nothing here is inferred from a
// hopeful default, because a console that reports health it did not measure
// is worse than no console at all.

/** One label/value line in a console card. `tone` paints the value. */
function consoleRow(label, value, tone) {
  const row = el("div", "row-item");
  row.appendChild(el("span", "row-label", label));
  row.appendChild(el("span", "row-value" + (tone ? " " + tone : ""), value));
  return row;
}

/** Fill one card, or say plainly that the answer is not available. */
function fillCard(id, build) {
  const box = $(id);
  box.textContent = "";
  build(box);
}

function renderConsole() {
  const status = state.status;
  const health = state.health;

  fillCard("console-connection", (box) => {
    box.appendChild(
      status && status.relay_connected
        ? consoleRow("Relay", "connected", "good")
        : consoleRow("Relay", "not connected", "bad")
    );
    box.appendChild(
      state.socketOpen
        ? consoleRow("Daemon", "saw up is serving this page", "good")
        : consoleRow("Daemon", "no live channel", "bad")
    );
    if (health) {
      box.appendChild(
        consoleRow(
          "Transport",
          health.relay_transport === "tunnel" ? "tunnel (iroh ticket)" : "direct address"
        )
      );
      const pending = health.log_spool_pending || 0;
      box.appendChild(
        consoleRow(
          "Run log spool",
          pending === 0 ? "empty" : pending + " run(s) held for reconnect",
          pending === 0 ? "good" : "warn"
        )
      );
    }
    if (status) {
      box.appendChild(
        consoleRow("Your agent", status.paused ? "paused" : "running", status.paused ? "warn" : "good")
      );
    }
  });

  fillCard("console-repo", (box) => {
    if (!health) {
      box.appendChild(consoleRow("Repository", "not read yet"));
      return;
    }
    box.appendChild(consoleRow("Workspace", health.workspace || "—"));
    box.appendChild(consoleRow("Remote", health.repo_remote || "—"));
    box.appendChild(consoleRow("Checkout", health.repo_root || "—"));
    // The prefix is the boundary: this member may push only under it.
    box.appendChild(consoleRow("Your branch prefix", health.branch_prefix || "—"));
  });

  fillCard("console-integration", (box) => {
    if (!health || !health.integration) {
      box.appendChild(consoleRow("Hooks", "not read yet"));
      return;
    }
    const integration = health.integration;
    box.appendChild(
      integration.ok
        ? consoleRow("Hooks", "all four wired to this checkout", "good")
        : consoleRow("Hooks", "needs attention", "bad")
    );
    (integration.hooks || []).forEach((hook) => {
      const value = !hook.wired
        ? "not wired"
        : hook.current
          ? "wired"
          : "wired to another checkout";
      const tone = !hook.wired ? "bad" : hook.current ? "good" : "warn";
      box.appendChild(consoleRow(hook.event, value, tone));
    });
    if (!integration.settings_readable) {
      box.appendChild(
        consoleRow("Settings file", "missing or unreadable — run saw up", "bad")
      );
    }
    const path = el("div", "row-note", integration.settings_path || "");
    box.appendChild(path);
  });

  fillCard("console-members", (box) => {
    if (!status) {
      box.appendChild(consoleRow("Members", "not read yet"));
      return;
    }
    status.members.forEach((m) => {
      const marks = [];
      marks.push(m.online ? "online" : "offline");
      if (m.paused) marks.push("paused");
      if (m.github_username === status.me) marks.push("you");
      box.appendChild(
        consoleRow(m.github_username, marks.join(" · "), m.online ? "good" : "")
      );
    });
  });

  fillCard("console-modes", (box) => {
    const threads = state.status ? state.status.threads || [] : [];
    if (threads.length === 0) {
      box.appendChild(consoleRow("Modes", "no threads yet"));
      return;
    }
    // This member's own mode per thread, and nothing about the other
    // member's: no member may set another's, and showing a control that
    // cannot act would misrepresent the rule (FR-041, SC-016).
    threads.forEach((t) => {
      box.appendChild(consoleRow(t.title, t.my_mode || "comment"));
    });
  });
}

/** Read the console's own endpoint, then draw. Never throws at the caller. */
async function loadConsole() {
  try {
    const res = await api("/api/health");
    if (res.ok) state.health = await res.json();
  } catch {
    // The daemon is down. renderConsole says so from socket state alone.
    state.health = null;
  }
  renderConsole();
}

// ---- Tabs and the work log (T043) ----

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.add("active");
    // The console reads live state, so it is read when it is opened rather
    // than kept warm behind a hidden panel.
    if (tab.dataset.tab === "console") {
      void loadConsole();
      void loadLog();
    }
  });
});

function renderEntry(entry) {
  const wrap = el(
    "div",
    "entry" + (entry.source === "boundary_rejection" ? " rejection" : "")
  );
  const head = el("div", "head");
  head.appendChild(el("span", "member", entry.member));
  head.appendChild(el("span", "", fmtTime(entry.started_at) + " → " + fmtTime(entry.ended_at)));
  if (entry.work_item) head.appendChild(el("span", "work-item", entry.work_item));
  head.appendChild(el("span", "badge", entry.source));
  wrap.appendChild(head);
  wrap.appendChild(el("div", "why", entry.why_trigger));
  const what = entry.what || {};
  const tools = Object.entries(what.tools_used || {})
    .map(([k, v]) => `${k}×${v}`)
    .join(" ");
  const parts = [];
  if (tools) parts.push(tools);
  if (what.branch) parts.push(`${what.branch}@${(what.head || "").slice(0, 7)}`);
  if (what.files_changed !== undefined) parts.push(`${what.files_changed} files changed`);
  if (parts.length > 0) wrap.appendChild(el("div", "what", parts.join(" · ")));
  return wrap;
}

async function loadLog() {
  const list = $("log-list");
  list.textContent = "";
  const params = new URLSearchParams();
  params.set("member", $("log-member").value);
  const workItem = $("log-work-item").value.trim();
  if (workItem) params.set("work_item", workItem);
  params.set("limit", "100");
  // The tab opens this. A rejected fetch here left the list empty with no word.
  let data;
  try {
    const res = await api("/api/log?" + params.toString());
    if (!res.ok) {
      const why = "The log is not available. Is the relay connected?";
      list.appendChild(el("div", "empty", why));
      return;
    }
    data = await res.json();
  } catch {
    list.appendChild(el("div", "empty", DAEMON_DOWN));
    return;
  }
  const entries = data.entries || [];
  if (entries.length === 0) {
    list.appendChild(el("div", "empty", "No recorded activity for this filter."));
    return;
  }
  entries.slice().reverse().forEach((entry) => list.appendChild(renderEntry(entry)));
}

$("log-refresh").addEventListener("click", loadLog);
$("log-work-item").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    loadLog();
  }
});

// The composer stays off until the socket opens and the relay reports in.
renderComposerState();
renderPingButton();
renderThreadHeader();
connect();
