/** Two patches as one: objects merge key by key, anything else takes the later value. */
export function mergePatch<T extends object>(a: T, b: T): T {
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = typeof v === 'object' && v !== null && !Array.isArray(v) && typeof cur === 'object' && cur !== null && !Array.isArray(cur) ? mergePatch(cur as object, v as object) : v;
  }
  return out as T;
}
