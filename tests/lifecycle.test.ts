import { describe, expect, test } from "bun:test";
import { drain } from "../src/lifecycle";

describe("drain", () => {
  test("idle before timeout drains and stops gently exactly once", async () => {
    const stops: boolean[] = [];
    // A sleep that never resolves proves the idle arm wins on its own.
    const sleep = (_ms: number): Promise<void> => new Promise(() => {});
    const outcome = await drain({
      timeoutMs: 1000,
      stop: (force) => stops.push(force),
      waitForIdle: () => Promise.resolve(),
      sleep,
    });
    expect(outcome).toBe("drained");
    expect(stops).toEqual([false]);
  });

  test("idle never reached times out and force-stops", async () => {
    const stops: boolean[] = [];
    const outcome = await drain({
      timeoutMs: 20,
      stop: (force) => stops.push(force),
      waitForIdle: () => new Promise(() => {}),
    });
    expect(outcome).toBe("timeout");
    expect(stops).toEqual([false, true]);
  });

  test("a zero timeout force-stops instead of hanging", async () => {
    const stops: boolean[] = [];
    const outcome = await drain({
      timeoutMs: 0,
      stop: (force) => stops.push(force),
      waitForIdle: () => new Promise(() => {}),
    });
    expect(outcome).toBe("timeout");
    expect(stops).toEqual([false, true]);
  });
});
