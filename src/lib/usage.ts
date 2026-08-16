/**
 * Emits one line per billable call to `/var/lib/usage/<app>.jsonl`.
 *
 * The other half of this lives in the gtfoo repo, which reads every app's file
 * and renders `/admin/usage`. This is an interface with another agent, so the
 * field names below are theirs, not ours.
 *
 * The contract is `gtfoo/docs/usage-tracking.md` — tracked, durable, and the
 * place to look first. `Call` in `gtfoo/src/lib/usage.ts` is the types; read
 * both, because the doc carries the two rules the types cannot express (UTC
 * timestamps, and the 4096-byte line limit below). Do not take the schema from
 * correspondence: mail is explicitly ephemeral, and recovering it from a
 * deleted letter's git history is not a repeatable plan.
 *
 * Append-only JSONL rather than a shared database: no app can block another,
 * and a crash mid-write costs exactly one line. A single `write` with `O_APPEND`
 * under the pipe-buffer size is atomic on Linux, so four apps appending to the
 * same directory cannot interleave a line — which is the property that makes
 * this safe without any coordination between them.
 *
 * Telemetry must never break the thing it measures. Every failure in here is
 * swallowed: a full disk, a directory that does not exist yet, a read-only
 * mount. The caller cannot tell whether the write happened, by design.
 */
import { appendFile } from "node:fs/promises";
import path from "node:path";

/** Field names and types are the reader's contract. Do not rename. */
export interface UsageCall {
  ts: string;
  app: string;
  provider: string;
  /** The model that ACTUALLY answered, never the alias that was asked for. */
  model?: string;
  /** What the call was for, e.g. "rate-lookup". Ours to choose. */
  op?: string;
  requests?: number;
  in_tokens?: number;
  out_tokens?: number;
  /** Non-token billing: credits, characters. Null for LLM calls. */
  units?: number | null;
  /**
   * Estimated dollars, or NULL when the call has no dollar cost — which is the
   * right answer on a free tier. Never write 0: "$0.00" beside a provider you
   * depend on implies a measurement nobody took.
   */
  usd?: number | null;
  status?: "ok" | "rate_limited" | "error";
}

/**
 * Read per call rather than captured at import. Next loads `.env.local` around
 * module initialisation, so a module-level constant can capture the default
 * before the real value exists — a difference that would only show up in
 * production, as a log written to the wrong path.
 */
function dir(): string {
  return process.env.USAGE_DIR ?? "/var/lib/usage";
}
function app(): string {
  return process.env.USAGE_APP ?? "carpark";
}

/**
 * Set once the directory turns out to be missing or unwritable, so a box where
 * collection isn't set up yet logs a single line instead of one per call.
 * The directory lives under /var/lib and is created by the droplet agent; this
 * app runs unprivileged and cannot make it itself.
 */
let disabled: string | null = null;

export function usageFile(): string {
  return path.join(dir(), `${app()}.jsonl`);
}

/**
 * Append one call. Resolves whether or not anything was written.
 *
 * Callers should record a line per ATTEMPT, not per eventual success. A 429 on
 * one model followed by a success on the next is two lines, and the failed one
 * carries more information than the success: on a free tier, `rate_limited` is
 * the only trustworthy signal of where the undocumented ceiling actually sits.
 */
export async function recordUsage(
  call: Omit<UsageCall, "ts" | "app"> & Partial<Pick<UsageCall, "ts" | "app">>,
): Promise<void> {
  if (disabled) return;
  const line: UsageCall = {
    // ISO-8601 UTC. The reader compares this lexicographically against a cutoff
    // string, so a local-time or offset-bearing stamp would silently sort wrong.
    ts: call.ts ?? new Date().toISOString(),
    app: call.app ?? app(),
    ...call,
  };
  try {
    // JSON.stringify omits undefined keys, so optional fields simply vanish
    // rather than appearing as nulls the reader would have to interpret.
    await appendFile(usageFile(), JSON.stringify(line) + "\n", { mode: 0o644 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "EROFS") {
      disabled = code;
      console.warn(
        `[usage] ${usageFile()} is not writable (${code}); usage emission is off ` +
          `for this process. The directory is created box-side, not by this app.`,
      );
      return;
    }
    // Anything else is unexpected but still not worth failing a user request
    // over — log it once per occurrence and carry on.
    console.warn(`[usage] could not append: ${String(err)}`);
  }
}

/** Whether a 429 / quota error should be recorded as `rate_limited` rather than `error`. */
export function isRateLimit(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /quota|rate.?limit|429|resource.?exhausted|exhausted/i.test(m);
}

/** Test seam — `disabled` is process-wide and would otherwise leak between tests. */
export function resetUsageState(): void {
  disabled = null;
}
