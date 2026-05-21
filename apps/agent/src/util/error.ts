// Coerces an unknown thrown value into a string for inclusion in
// `state.error`. Use at node boundaries (where `catch (err)` types `err`
// as `unknown`) to avoid the same one-liner in every node.

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
