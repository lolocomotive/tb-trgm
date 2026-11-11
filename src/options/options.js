/* global messenger */
import { DEFAULT_OPTIONS, mergeOptions } from "./defaults.js";

const $ = id => document.getElementById(id);
const BOOLS = ["replaceQuickFilter", "sortByRelevance", "redirectGlobalSearch", "fuzzy", "indexBodies"];
const NUMS = ["fuzzyThreshold", "maxBodyChars", "rescanMinutes"];
let opts = structuredClone(DEFAULT_OPTIONS);

const save = () => messenger.storage.local.set({ options: opts });

async function load() {
  const { options } = await messenger.storage.local.get("options");
  opts = mergeOptions(options);
  for (const k of BOOLS) {
    $(k).checked = !!opts[k];
    $(k).addEventListener("change", () => { opts[k] = $(k).checked; save(); });
  }
  for (const k of NUMS) {
    $(k).value = opts[k];
    $(k).addEventListener("change", () => { opts[k] = Number($(k).value); save(); });
  }
  $("thresholdVal").textContent = opts.fuzzyThreshold;
  $("fuzzyThreshold").addEventListener("input", () => ($("thresholdVal").textContent = $("fuzzyThreshold").value));
  for (const f of ["attachments", "tags"]) {
    const cb = $(`qfb-${f}`);
    cb.checked = opts.qfbExtraFields[f] !== false;
    cb.addEventListener("change", () => { opts.qfbExtraFields[f] = cb.checked; save(); });
  }
}

const STATES = { starting: "starting", idle: "idle", scanning: "scanning folders", bodies: "reading message bodies" };

async function stats() {
  try {
    const s = await messenger.trigram.getStatus();
    const n = v => (v || 0).toLocaleString();
    $("stats").textContent = [
      `state:            ${STATES[s.state] || s.state}${s.state === "scanning" ? ` (${s.foldersDone}/${s.foldersTotal})` : ""}`,
      `messages:         ${n(s.docs)}`,
      `bodies indexed:   ${n(s.bodies)}  (${n(s.pending)} waiting, ${n(s.notOffline)} not available offline)`,
      `vocabulary:       ${n(s.words)} words`,
      `last folder scan: ${s.lastScan ? new Date(s.lastScan).toLocaleString() : "—"}`,
      s.error ? `error:            ${s.error}` : "",
    ].join("\n");
  } catch (e) {
    $("stats").textContent = `Not available: ${e.message || e}`;
  }
}

$("rescan").addEventListener("click", () => messenger.trigram.rescan());
$("reindex").addEventListener("click", () => {
  if (confirm("Delete the index and rebuild it from scratch?")) {
    messenger.trigram.reindex();
  }
});

load();
stats();
setInterval(stats, 1500);
