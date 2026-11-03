import type { PGlite } from "@electric-sql/pglite";
import { warn } from "@/utils/log";

export interface PGliteMaintenanceOptions {
    checkpointIntervalMs?: number;
    vacuumIntervalMs?: number;
}

export interface PGliteMaintenance {
    /** Resolves once the startup pass (CHECKPOINT, VACUUM, CHECKPOINT) has finished. */
    initial: Promise<void>;
    /** Cancels the timers and waits for an in-flight statement to finish. */
    stop: () => Promise<void>;
}

const DEFAULT_CHECKPOINT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_VACUUM_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Does the housekeeping a regular Postgres server would do in the background.
 *
 * PGlite runs Postgres in single-user mode inside this process, so there is no
 * checkpointer and no autovacuum:
 * - without CHECKPOINT, pg_wal is never recycled and grows by every byte ever
 *   written (max_wal_size has no effect). With periodic checkpoints it stays
 *   at a handful of segments. WAL that already piled up is not deleted by
 *   the first checkpoint: Postgres keeps those segments for reuse and only
 *   drops them as new WAL is written past them;
 * - without VACUUM, rows removed by deletes (e.g. session deletion) never
 *   become reusable, so the data files only grow.
 *
 * Runs CHECKPOINT, VACUUM, CHECKPOINT immediately, then CHECKPOINT every
 * checkpointIntervalMs and VACUUM (ANALYZE) every vacuumIntervalMs.
 * pg.exec() takes PGlite's transaction mutex, so these never interleave with
 * a running transaction.
 * Failures are logged and retried on the next tick.
 */
export function pgliteMaintenance(pg: PGlite, opts: PGliteMaintenanceOptions = {}): PGliteMaintenance {
    const checkpointIntervalMs = opts.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    const vacuumIntervalMs = opts.vacuumIntervalMs ?? DEFAULT_VACUUM_INTERVAL_MS;
    let isStopped = false;
    let queue: Promise<void> = Promise.resolve();

    const run = (statements: string[]): Promise<void> => {
        queue = queue.then(async () => {
            for (const statement of statements) {
                if (isStopped) {
                    return;
                }
                try {
                    await pg.exec(statement);
                } catch (e) {
                    warn({ module: "pglite-maintenance" }, `${statement} failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        });
        return queue;
    };

    const initial = run(["CHECKPOINT", "VACUUM (ANALYZE)", "CHECKPOINT"]);
    const checkpointTimer = setInterval(() => void run(["CHECKPOINT"]), checkpointIntervalMs);
    const vacuumTimer = setInterval(() => void run(["VACUUM (ANALYZE)", "CHECKPOINT"]), vacuumIntervalMs);

    return {
        initial,
        stop: async () => {
            isStopped = true;
            clearInterval(checkpointTimer);
            clearInterval(vacuumTimer);
            await queue;
        },
    };
}
