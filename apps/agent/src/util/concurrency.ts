// Bounded-concurrency Array.map. Preserves input order in the output.
// Workers are seeded with `limit` initial tasks; each completion picks up
// the next unstarted index. Rejections propagate; the helper doesn't
// catch.
//
// Used by `nodes/search-trials.ts` (repurposing channel) and
// `nodes/pre-filter.ts` (Stage 2 LLM-as-judge). Both want the same
// behavior so the helper lives here, not in the nodes.

export async function mapWithConcurrency<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  if (items.length === 0) return [];
  const out: U[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return out;
}
