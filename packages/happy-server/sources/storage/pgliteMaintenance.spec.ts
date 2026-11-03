import { PGlite } from "@electric-sql/pglite";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pgliteMaintenance } from "./pgliteMaintenance";

function walSegmentCount(dataDir: string): number {
    return fs.readdirSync(path.join(dataDir, "pg_wal")).filter(name => /^[0-9A-F]{24}$/.test(name)).length;
}

describe("pgliteMaintenance", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps pg_wal from growing with every write", async () => {
        const walSegmentsAfterChurn = async (withMaintenance: boolean): Promise<number> => {
            const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-maintenance-"));
            const pg = new PGlite(dataDir);
            try {
                await pg.exec("CREATE TABLE blob (id serial PRIMARY KEY, body text)");
                const maintenance = withMaintenance
                    ? pgliteMaintenance(pg, { checkpointIntervalMs: 50, vacuumIntervalMs: 60_000 })
                    : null;
                await maintenance?.initial;
                // Random text so compression cannot hide the WAL volume.
                for (let i = 0; i < 20; i++) {
                    await pg.exec("INSERT INTO blob (body) SELECT md5(random()::text) || md5(random()::text) FROM generate_series(1, 25000)");
                    await pg.exec("DELETE FROM blob");
                    await new Promise(resolve => setTimeout(resolve, 60));
                }
                await maintenance?.stop();
                return walSegmentCount(dataDir);
            } finally {
                await pg.close();
                fs.rmSync(dataDir, { recursive: true, force: true });
            }
        };

        const without = await walSegmentsAfterChurn(false);
        const withMaintenance = await walSegmentsAfterChurn(true);
        // PGlite has no checkpointer, so every written byte stays in pg_wal.
        expect(without).toBeGreaterThan(80);
        expect(withMaintenance).toBeLessThan(without / 4);
    }, 120_000);

    it("makes space freed by deletes reusable", async () => {
        const tableSizeAfterRefill = async (withMaintenance: boolean): Promise<{ before: number; after: number }> => {
            const pg = new PGlite();
            try {
                const fill = "INSERT INTO blob (body) SELECT md5(g::text) FROM generate_series(1, 5000) g";
                const size = async (): Promise<number> =>
                    Number((await pg.query<{ size: number }>("SELECT pg_relation_size('blob') AS size")).rows[0].size);
                await pg.exec("CREATE TABLE blob (id serial PRIMARY KEY, body text)");
                await pg.exec(fill);
                const before = await size();
                await pg.exec("DELETE FROM blob");
                if (withMaintenance) {
                    const maintenance = pgliteMaintenance(pg);
                    await maintenance.initial;
                    await maintenance.stop();
                }
                await pg.exec(fill);
                return { before, after: await size() };
            } finally {
                await pg.close();
            }
        };

        // No autovacuum in PGlite: without VACUUM the refill lands in new pages.
        const without = await tableSizeAfterRefill(false);
        expect(without.after).toBeGreaterThanOrEqual(without.before * 2);
        const withMaintenance = await tableSizeAfterRefill(true);
        expect(withMaintenance.after).toBe(withMaintenance.before);
    });

    it("checkpoints and vacuums on their own intervals until stopped", async () => {
        vi.useFakeTimers();
        const exec = vi.fn().mockResolvedValue([]);
        const maintenance = pgliteMaintenance({ exec } as unknown as PGlite, {
            checkpointIntervalMs: 1_000,
            vacuumIntervalMs: 10_000,
        });
        await maintenance.initial;
        expect(exec.mock.calls.map(c => c[0])).toEqual(["CHECKPOINT", "VACUUM (ANALYZE)", "CHECKPOINT"]);
        exec.mockClear();

        await vi.advanceTimersByTimeAsync(3_000);
        expect(exec.mock.calls.map(c => c[0])).toEqual(["CHECKPOINT", "CHECKPOINT", "CHECKPOINT"]);
        exec.mockClear();

        await vi.advanceTimersByTimeAsync(7_000);
        expect(exec.mock.calls.map(c => c[0])).toContain("VACUUM (ANALYZE)");
        exec.mockClear();

        await maintenance.stop();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(exec).not.toHaveBeenCalled();
    });

    it("keeps running after a failed pass", async () => {
        vi.useFakeTimers();
        const exec = vi.fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValue([]);
        const maintenance = pgliteMaintenance({ exec } as unknown as PGlite, {
            checkpointIntervalMs: 1_000,
            vacuumIntervalMs: 60_000,
        });
        await expect(maintenance.initial).resolves.toBeUndefined();
        exec.mockClear();

        await vi.advanceTimersByTimeAsync(1_000);
        expect(exec).toHaveBeenCalledWith("CHECKPOINT");
        await maintenance.stop();
    });
});
