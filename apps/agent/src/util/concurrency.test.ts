import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "./concurrency.js";

describe("mapWithConcurrency", () => {
  it("returns results in the same order as the input", async () => {
    const items = [1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it("respects the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 25 }, (_, i) => i);
    await mapWithConcurrency(items, 10, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    expect(maxInFlight).toBeLessThanOrEqual(10);
    expect(maxInFlight).toBeGreaterThan(1); // sanity check: not sequential
  });

  it("propagates rejections from the worker", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("returns [] for empty input without invoking the worker", async () => {
    let calls = 0;
    const out = await mapWithConcurrency<number, number>([], 10, async (n) => {
      calls += 1;
      return n;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });
});
