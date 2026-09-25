/**
 * Auto-start unit tests — injectable ping + spawn, no real processes or server.
 */
import type { ChildProcess } from "node:child_process";
import type { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ensureAppRunning } from "../../src/mcp/launch.js";

type SpawnFn = typeof spawn;

function fakeChild(on: () => void = () => {}): ChildProcess {
    return {
        on,
        unref: on,
        stdout: undefined,
        stderr: undefined,
        pid: 4242,
    } as unknown as ChildProcess;
}

describe("ensureAppRunning", () => {
    it("does nothing when the app is already reachable", async () => {
        let spawns = 0;
        const res = await ensureAppRunning({
            baseUrl: "http://127.0.0.1:8000",
            ping: async () => true,
            spawnNode: (() => {
                spawns++;
                return fakeChild();
            }) as unknown as SpawnFn,
        });
        expect(res).toEqual({ started: false, ok: true });
        expect(spawns).toBe(0);
    });

    it("spawns start.mjs when loopback is down, then reports ok once reachable", async () => {
        let probes = 0;
        const seenArgs: Array<string[]> = [];
        const res = await ensureAppRunning({
            baseUrl: "http://127.0.0.1:9000",
            ping: async (url) => {
                probes++;
                expect(url).toBe("http://127.0.0.1:9000");
                return probes > 1;
            },
            spawnNode: ((agent: string, args: string[]) => {
                seenArgs.push([agent, ...args]);
                return fakeChild();
            }) as unknown as SpawnFn,
            timeoutMs: 2_000,
        });
        expect(res.ok).toBe(true);
        expect(res.started).toBe(true);
        expect(res.pid).toBe(4242);
        expect(seenArgs.length).toBe(1);
        expect(seenArgs[0]![1]).toMatch(/start\.mjs$/);
    });

    it("never spawns for a remote host", async () => {
        let called = false;
        const res = await ensureAppRunning({
            baseUrl: "https://inspector.example.com",
            ping: async () => false,
            spawnNode: (() => {
                called = true;
                return fakeChild();
            }) as unknown as SpawnFn,
        });
        expect(res).toEqual({ started: false, ok: false });
        expect(called).toBe(false);
    });

    it("reports failure when the app never comes up", async () => {
        const res = await ensureAppRunning({
            baseUrl: "http://127.0.0.1:8000",
            ping: async () => false,
            spawnNode: (() => fakeChild()) as unknown as SpawnFn,
            timeoutMs: 100,
        });
        expect(res.started).toBe(true);
        expect(res.ok).toBe(false);
    });
});