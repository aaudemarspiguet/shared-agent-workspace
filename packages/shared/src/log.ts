// Work log schemas. The work log is the set of RunLogEntry records.
// Capture is automatic. Agents never write the log themselves.
import { z } from "zod";
import {
  findSmuggledContent,
  isValidBranchName,
  isValidCommitSha,
  type RejectionReason
} from "./messages.js";

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

/** The fields a daemon sends when it appends one run to the work log. */
export const RunLogEntryInputSchema = z.object({
  started_at: z.string().datetime(),
  ended_at: z.string().datetime(),
  what: RunWhatSchema,
  why_trigger: z.string().min(1).max(1000),
  work_item: z.string().min(1).max(100).optional()
});
export type RunLogEntryInput = z.infer<typeof RunLogEntryInputSchema>;

/** What replaces a `why_trigger` that carried smuggled content. */
export const REDACTED_WHY_TRIGGER = "[removed at the boundary]";

/** One thing the boundary took out of a log entry. */
export interface LogRedaction {
  field: "why_trigger" | "what.branch" | "what.head";
  reason: RejectionReason;
  summary: string;
}

export interface LogEntryValidation {
  /** The entry with every unsafe field removed. Always safe to store. */
  entry: RunLogEntryInput;
  /** Empty when nothing was removed. */
  redactions: LogRedaction[];
}

/**
 * Apply the boundary rules to one run log entry.
 *
 * A log entry is a member-to-member channel: the peer reads `why_trigger`
 * back through `peer_activity`. The CLI fills that field with the human's
 * verbatim prompt, so a pasted diff would cross the boundary (FR-008).
 *
 * This removes rather than rejects. Every run must be logged (FR-015), so
 * dropping the whole entry would trade one rule for another. The caller
 * records each redaction so the rejection still appears in the log (SC-005).
 */
export function validateLogEntry(input: RunLogEntryInput): LogEntryValidation {
  const redactions: LogRedaction[] = [];
  const what = { ...input.what };

  const smuggled = findSmuggledContent(input.why_trigger);
  if (smuggled) {
    redactions.push({
      field: "why_trigger",
      reason: "content_smuggling",
      summary: smuggled
    });
  }

  // A branch name and a commit SHA are the only pointers to code that may
  // cross. Anything else in those fields is not a ref (Principle II).
  if (what.branch !== undefined && !isValidBranchName(what.branch)) {
    redactions.push({
      field: "what.branch",
      reason: "invalid_ref",
      summary: "branch name is not a valid git ref"
    });
    delete what.branch;
  }
  if (what.head !== undefined && !isValidCommitSha(what.head)) {
    redactions.push({
      field: "what.head",
      reason: "invalid_ref",
      summary: "head is not a valid commit sha"
    });
    delete what.head;
  }

  return {
    entry: {
      ...input,
      what,
      why_trigger: smuggled ? REDACTED_WHY_TRIGGER : input.why_trigger
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
