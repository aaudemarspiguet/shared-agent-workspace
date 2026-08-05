// Work log schemas. The work log is the set of RunLogEntry records.
// Capture is automatic. Agents never write the log themselves.
import { z } from "zod";
import {
  findSmuggledContent,
  isValidBranchName,
  isValidCommitSha,
  MAX_LABEL_LENGTH,
  type RejectionReason
} from "./messages.js";

/** Caps the boundary enforces on a log entry. Over-limit is trimmed, not refused. */
export const MAX_WHY_TRIGGER_LENGTH = 1000;
export const MAX_TOOL_NAME_LENGTH = 100;
export const MAX_TOOLS_USED_KEYS = 100;

/**
 * The mechanical "what" of a run.
 * Counts and git refs only. File paths and file contents never appear here.
 */
export const RunWhatSchema = z
  .object({
    tools_used: z.record(z.string(), z.number().int().nonnegative()).default({}),
    branch: z.string().max(250).optional(),
    head: z.string().max(40).optional(),
    files_changed: z.number().int().nonnegative().optional()
  })
  .strict();
export type RunWhat = z.infer<typeof RunWhatSchema>;

/** The `what` keys the boundary keeps. Anything else is dropped, not refused. */
const KNOWN_WHAT_KEYS = new Set(["tools_used", "branch", "head", "files_changed"]);

/**
 * The wire form of `what`, deliberately looser than RunWhatSchema.
 *
 * No length caps, unknown keys pass the parse, and a tool count is `unknown`
 * until `validateLogEntry` judges it. A field the boundary would trim must
 * reach the boundary to be trimmed; failing the parse instead loses the whole
 * run, which trades FR-008 for FR-015 (T073).
 */
export const RunWhatWireSchema = z
  .object({
    tools_used: z.record(z.string(), z.unknown()).default({}),
    branch: z.string().optional(),
    head: z.string().optional(),
    files_changed: z.number().int().nonnegative().optional()
  })
  .passthrough();

/** The fields a daemon sends when it appends one run to the work log. */
export const RunLogEntryInputSchema = z.object({
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  what: RunWhatSchema,
  why_trigger: z.string().min(1).max(MAX_WHY_TRIGGER_LENGTH),
  work_item: z.string().min(1).max(MAX_LABEL_LENGTH).optional()
});
export type RunLogEntryInput = z.infer<typeof RunLogEntryInputSchema>;

/**
 * The wire form of a log entry: what the relay accepts off the socket.
 *
 * Only `started_at` and `ended_at` are enforced here. Without them there is
 * no run to record, so refusing the frame loses nothing. Every other rule is
 * applied by `validateLogEntry`, which trims rather than refuses.
 */
export const RunLogEntryWireSchema = z.object({
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  what: RunWhatWireSchema.default({}),
  why_trigger: z.string().default(""),
  work_item: z.string().optional()
});
export type RunLogEntryWire = z.infer<typeof RunLogEntryWireSchema>;

/** What replaces a `why_trigger` that carried smuggled content. */
export const REDACTED_WHY_TRIGGER = "[removed at the boundary]";

/** What replaces a `why_trigger` that arrived empty. Nothing was removed. */
export const MISSING_WHY_TRIGGER = "[no trigger recorded]";

/** A field of a log entry that the boundary may take something out of. */
export type LogRedactionField =
  | "why_trigger"
  | "work_item"
  | "what"
  | "what.branch"
  | "what.head"
  | "what.tools_used";

/** One thing the boundary took out of a log entry. */
export interface LogRedaction {
  field: LogRedactionField;
  reason: RejectionReason;
  /** Short description of what went. It never echoes the removed text. */
  summary: string;
}

export interface LogEntryValidation {
  /** The entry with every unsafe field removed. Always safe to store. */
  entry: RunLogEntryInput;
  /** Empty when nothing was removed. */
  redactions: LogRedaction[];
}

/** A tool name is one short token. A newline in it means it is not a name. */
function isPlausibleToolName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_TOOL_NAME_LENGTH) return false;
  // Control chars are what a multi-line payload needs, so the regex names them.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return findSmuggledContent(name) === null;
}

/**
 * Apply the boundary rules to one run log entry.
 *
 * A log entry is a member-to-member channel: the peer reads the whole entry
 * back through `peer_activity`. Every free-text field on it therefore gets
 * the same treatment a message body gets — `why_trigger` and `work_item`,
 * and the *keys* of `what.tools_used`, which the CLI copies from the tool
 * names on the sending member's own machine (FR-008, T070).
 *
 * This removes rather than rejects. Every run must be logged (FR-015), so
 * dropping the whole entry would trade one rule for another. The caller
 * records each redaction so the rejection still appears in the log (SC-005).
 */
export function validateLogEntry(input: RunLogEntryWire): LogEntryValidation {
  const redactions: LogRedaction[] = [];

  // ---- why_trigger ----
  let whyTrigger = input.why_trigger;
  const smuggled = findSmuggledContent(whyTrigger);
  if (smuggled) {
    redactions.push({
      field: "why_trigger",
      reason: "content_smuggling",
      summary: smuggled
    });
    whyTrigger = REDACTED_WHY_TRIGGER;
  } else if (whyTrigger.length > MAX_WHY_TRIGGER_LENGTH) {
    redactions.push({
      field: "why_trigger",
      reason: "payload_too_large",
      summary: `why over ${MAX_WHY_TRIGGER_LENGTH} chars, trimmed`
    });
    whyTrigger = whyTrigger.slice(0, MAX_WHY_TRIGGER_LENGTH);
  }
  // An empty why is not a removal, so it records no redaction. Telling this
  // case apart from the two placeholders above is T060.
  if (whyTrigger.trim().length === 0) whyTrigger = MISSING_WHY_TRIGGER;

  // ---- work_item ----
  let workItem = input.work_item;
  if (workItem !== undefined) {
    const inItem = findSmuggledContent(workItem);
    if (inItem) {
      redactions.push({ field: "work_item", reason: "content_smuggling", summary: inItem });
      workItem = undefined;
    } else if (workItem.length > MAX_LABEL_LENGTH) {
      redactions.push({
        field: "work_item",
        reason: "payload_too_large",
        summary: `work item over ${MAX_LABEL_LENGTH} chars, trimmed`
      });
      workItem = workItem.slice(0, MAX_LABEL_LENGTH);
    }
    if (workItem !== undefined && workItem.trim().length === 0) workItem = undefined;
  }

  // ---- what.tools_used ----
  const tools: Record<string, number> = {};
  let unsafeNames = 0;
  let badCounts = 0;
  let overflow = 0;
  for (const [name, count] of Object.entries(input.what.tools_used)) {
    if (!isPlausibleToolName(name)) {
      unsafeNames += 1;
      continue;
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      badCounts += 1;
      continue;
    }
    if (Object.keys(tools).length >= MAX_TOOLS_USED_KEYS) {
      overflow += 1;
      continue;
    }
    tools[name] = count;
  }
  if (unsafeNames > 0) {
    redactions.push({
      field: "what.tools_used",
      reason: "content_smuggling",
      summary: `${unsafeNames} tool name(s) removed: over ${MAX_TOOL_NAME_LENGTH} chars or not a name`
    });
  }
  if (badCounts > 0) {
    redactions.push({
      field: "what.tools_used",
      reason: "not_json",
      summary: `${badCounts} tool entry(s) removed: the value is not a count`
    });
  }
  if (overflow > 0) {
    redactions.push({
      field: "what.tools_used",
      reason: "payload_too_large",
      summary: `${overflow} tool name(s) removed: over ${MAX_TOOLS_USED_KEYS} entries`
    });
  }

  // ---- what.branch, what.head, and anything else ----
  const what: RunWhat = { tools_used: tools };
  if (input.what.files_changed !== undefined) what.files_changed = input.what.files_changed;

  // A branch name and a commit SHA are the only pointers to code that may
  // cross. Anything else in those fields is not a ref (Principle II).
  // Both checks also bound the length, so an over-long value lands here.
  if (input.what.branch !== undefined) {
    if (isValidBranchName(input.what.branch)) {
      what.branch = input.what.branch;
    } else {
      redactions.push({
        field: "what.branch",
        reason: "invalid_ref",
        summary: "branch name is not a valid git ref"
      });
    }
  }
  if (input.what.head !== undefined) {
    if (isValidCommitSha(input.what.head)) {
      what.head = input.what.head;
    } else {
      redactions.push({
        field: "what.head",
        reason: "invalid_ref",
        summary: "head is not a valid commit sha"
      });
    }
  }

  // An unknown key inside `what` is a free-text channel with no rules at all.
  // It is dropped, not refused, and the count is logged — never the key.
  const unknownKeys = Object.keys(input.what).filter((k) => !KNOWN_WHAT_KEYS.has(k));
  if (unknownKeys.length > 0) {
    redactions.push({
      field: "what",
      reason: "not_json",
      summary: `${unknownKeys.length} unknown key(s) removed`
    });
  }

  return {
    entry: {
      started_at: input.started_at,
      ended_at: input.ended_at,
      what,
      why_trigger: whyTrigger,
      ...(workItem !== undefined ? { work_item: workItem } : {})
    },
    redactions
  };
}

/** How a stored entry was produced. */
export const LOG_SOURCES = ["hook_stop", "boundary_rejection", "system"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** A stored work log entry, as the relay returns it. */
export interface StoredLogEntry {
  id: string;
  member: string;
  started_at: string;
  ended_at: string;
  what: RunWhat;
  why_trigger: string;
  work_item: string; // "unassigned" when no work item is known
  source: LogSource;
}

/** Query filters for the work log. */
export const LogQuerySchema = z.object({
  member: z.enum(["me", "peer", "any"]).default("any"),
  work_item: z.string().optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(200).default(50)
});
export type LogQuery = z.infer<typeof LogQuerySchema>;
