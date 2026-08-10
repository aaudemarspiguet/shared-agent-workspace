// SAW room page logic. Talks only to the local daemon.
/* global WebSocket, document, fetch, location, setTimeout, URLSearchParams, Option */

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
  // Every feed entry the page holds, in arrival order. The work item filter
  // renders from this list, so it never refetches (T066).
  feedItems: [],
  // mode is "all", "untagged", or "item". tag applies to "item" only.
  filter: { mode: "all", tag: "" },
  // The work item tags the filter control shows now.
  filterTags: null
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
  const wrap = el("div", "msg" + (m.sender === state.me ? " mine" : ""));
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
  return item.kind === "message" ? renderMessage(item.data) : renderNotice(item.data);
}

/** Does one feed entry pass the work item filter the user chose? */
function passesFilter(item) {
  if (state.filter.mode === "all") return true;
  const tag = item.data.work_item;
  if (state.filter.mode === "untagged") return !tag;
  return tag === state.filter.tag;
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
  state.feedItems
    .filter(passesFilter)
    .forEach((item) => feed.appendChild(renderItem(item)));
  feed.scrollTop = feed.scrollHeight;
}

function addMessage(m) {
  if (state.seen.has(m.seq)) return;
  state.seen.add(m.seq);
  addItem("message", m);
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

  renderFilterOptions(status.work_items);
}

// ---- Work item filter (T066) ----

// The mode, not the value, decides how an option filters. A work item tag can
// be any text, so the value alone cannot tell the default options from a tag.
function filterOption(label, mode, tag) {
  const option = new Option(label, tag);
  option.dataset.mode = mode;
  return option;
}

/** Fill the filter with the work items the page knows. Keep the choice. */
function renderFilterOptions(workItems) {
  const select = $("room-filter");
  const tags = (workItems || []).map((w) => w.feature_tag).sort();
  const key = tags.join("\n");
  if (key === state.filterTags) return;
  state.filterTags = key;
  select.textContent = "";
  select.appendChild(filterOption("all work items", "all", ""));
  select.appendChild(filterOption("untagged", "untagged", "untagged"));
  tags.forEach((tag) => select.appendChild(filterOption(tag, "item", tag)));

  const options = Array.from(select.options);
  const index = options.findIndex(
    (o) =>
      o.dataset.mode === state.filter.mode &&
      (state.filter.mode !== "item" || o.value === state.filter.tag)
  );
  select.selectedIndex = index >= 0 ? index : 0;
  if (index < 0) {
    // The chosen work item is gone. Go back to the full room.
    state.filter = { mode: "all", tag: "" };
    renderFeed();
  }
}

$("room-filter").addEventListener("change", (e) => {
  const option = e.target.selectedOptions[0];
  if (!option) return;
  state.filter = { mode: option.dataset.mode || "all", tag: option.value };
  renderFeed();
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
      (data.messages || []).forEach(addMessage);
      (data.notices || []).forEach((n) => addItem("notice", n));
      renderStatus(data.status);
      return;
    }
    if (data.kind === "event") {
      const event = data.event || {};
      if (event.kind === "message" && event.message) addMessage(event.message);
      if (event.kind === "claim_result" && event.claim) {
        addItem("notice", event.claim);
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
  const workItem = $("msg-work-item").value.trim();
  if (workItem) payload.work_item = workItem;
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

// ---- Tabs and log browser (T043) ----

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(tab.dataset.tab).classList.add("active");
    if (tab.dataset.tab === "log") loadLog();
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
connect();
