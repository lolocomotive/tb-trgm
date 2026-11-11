const { Sqlite } = ChromeUtils.importESModule("resource://gre/modules/Sqlite.sys.mjs");
const c = await Sqlite.openConnection({ path: PathUtils.join(PathUtils.profileDir, "trigram-search.sqlite"), readOnly: true, extensions: ["fts5"] });
const q = async (sql) => (await c.execute(sql)).map(r => { const o = {}; for (let i = 0; i < r.numEntries; i++) o[i] = r.getResultByIndex(i); return o; });
const out = {
  states: await q("SELECT body_state, count(*) FROM msgs GROUP BY body_state"),
  words: await q("SELECT count(*) FROM words"),
  samples: await q("SELECT f_subject, f_attachments, f_tags, body_state FROM msgs WHERE f_subject IN ('Base64 body','QP latin1 body','HTML only','Your invoice')"),
  status: window.document.getElementById("statusText")?.value || window.document.getElementById("statusText")?.textContent,
};
await c.close();
return out;
