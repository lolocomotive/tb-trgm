/* global messenger */
// All indexing and searching happens in the experiment (api/trigram/parent.js).
// The background only forwards options.

import { mergeOptions } from "../options/defaults.js";

async function push(options) {
  await messenger.trigram.configure({
    enabled: options.replaceQuickFilter,
    sortByRelevance: options.sortByRelevance,
    redirectGlobalSearch: options.redirectGlobalSearch,
    extraFields: Object.keys(options.qfbExtraFields).filter(f => options.qfbExtraFields[f]),
    fuzzy: options.fuzzy,
    fuzzyThreshold: Number(options.fuzzyThreshold),
    indexBodies: options.indexBodies,
    maxBodyChars: Math.round(Number(options.maxBodyChars)),
    rescanMinutes: Math.round(Number(options.rescanMinutes)),
  });
}

// First install: search every Quick Filter field (Thunderbird ships with
// Body off).
messenger.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    messenger.trigram.enableAllQuickFilterFields().catch(console.error);
  }
});

messenger.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.options) {
    push(mergeOptions(changes.options.newValue)).catch(console.error);
  }
});

messenger.storage.local
  .get("options")
  .then(({ options }) => push(mergeOptions(options)))
  .catch(console.error);
