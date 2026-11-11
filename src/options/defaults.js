// Shared by the background script and the options page.
export const DEFAULT_OPTIONS = {
  replaceQuickFilter: true,
  sortByRelevance: false,
  redirectGlobalSearch: true,
  qfbExtraFields: { attachments: true, tags: true },
  fuzzy: true,
  fuzzyThreshold: 0.4,
  indexBodies: true,
  maxBodyChars: 20000,
  rescanMinutes: 30,
};

export function mergeOptions(stored) {
  const o = structuredClone(DEFAULT_OPTIONS);
  for (const [k, v] of Object.entries(stored || {})) {
    o[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...o[k], ...v } : v;
  }
  return o;
}

