// Work log schemas. The work log is the set of RunLogEntry records.
// Capture is automatic. Agents never write the log themselves.
import { z } from "zod";

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
