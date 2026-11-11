import test from "node:test";
import assert from "node:assert/strict";
import { SearchEngine, parseQuery, indexText, normalizeWithMap, TIER, BODY } from "../src/engine/engine.sys.mjs";
import { openDb } from "./nodedb.js";

async function fixture() {
  const e = new SearchEngine(openDb());
  await e.init();
  const doc = (k, f, date) => ({ folder: "mailbox://x/Inbox", msgkey: k, msgid: `m${k}`, date, bodyState: BODY.DONE, fields: f });
  await e.addDocs([
    doc(1, { from: "John Doe <john.doe@example.com>", subject: "Quarterly report", body: "Please receive the attached numbers." }, 1),
    doc(2, { from: "Jane Roe <jane@corp.io>", subject: "Re: report draft", body: "I recieve too many emails about Zürich." }, 2),
    doc(3, { from: "Bob <bob@x.org>", subject: "Lunch", body: "unrelated content here", attachments: ["invoice-2024.pdf"] }, 3),
    doc(4, { from: "Alice <alice@x.org>", to: "John Doe <john.doe@example.com>", subject: "Doe family reunion", body: "John, the Doe family meets" }, 4),
  ]);
  return e;
}
const keys = r => r.map(x => x.msgid);

test("indexText pads and separates list items", () => {
  assert.equal(indexText("Hello, Wörld!"), " hello world ");
  assert.equal(indexText(["a.pdf", "b c"]), " a pdf  b c ");
  assert.equal(normalizeWithMap("Zü").norm, "zu");
});

test("parseQuery", () => {
  const p = parseQuery('foo "bar baz" a|b');
  assert.equal(p.groups.length, 3);
  assert.equal(p.groups[1][0].phrase, true);
  assert.equal(p.groups[2].length, 2);
  assert.equal(p.fullPhrase, null);
  assert.deepEqual(parseQuery("john.doe").fullPhrase, ["john", "doe"]);
});

test("substring inside a word", async () => {
  const r = await (await fixture()).search("uarter");
  assert.deepEqual(keys(r), ["m1"]);
  assert.equal(r[0].tier, TIER.SUBSTRING);
});

test("typo: exact first, fuzzy after", async () => {
  const r = await (await fixture()).search("receive");
  assert.deepEqual(keys(r), ["m1", "m2"]);
  assert.equal(r[0].tier, TIER.EXACT);
  assert.equal(r[1].tier, TIER.FUZZY);
});

test("diacritics", async () => {
  assert.deepEqual(keys(await (await fixture()).search("zurich")), ["m2"]);
});

test("address as phrase", async () => {
  const r = await (await fixture()).search("john.doe@example");
  assert.deepEqual(keys(r).sort(), ["m1", "m4"]);
  assert.ok(r.every(x => x.tier >= TIER.SUBSTRING), JSON.stringify(r));
});

test("scattered words rank below phrase", async () => {
  const e = await fixture();
  const r = await e.search("family john");
  // "family john" never appears as a phrase
  assert.ok(r.every(x => x.tier === TIER.SCATTERED), JSON.stringify(r));
  const p = await e.search("john doe");
  assert.ok(p.every(x => x.tier === TIER.EXACT), JSON.stringify(p));
});

test("field selection", async () => {
  const e = await fixture();
  assert.deepEqual(keys(await e.search("doe", { fields: ["subject"] })), ["m4"]);
  assert.deepEqual(keys(await e.search("invoice", { fields: ["body"] })), []);
  assert.deepEqual(keys(await e.search("invoice", { fields: ["attachments"] })), ["m3"]);
});

test("OR, quoted phrase, short tokens", async () => {
  const e = await fixture();
  assert.deepEqual(keys(await e.search("lunch|reunion")).sort(), ["m3", "m4"]);
  assert.deepEqual(keys(await e.search('"family meets"')), ["m4"]);
  assert.deepEqual(keys(await e.search('"meets family"')), []);
  assert.deepEqual(keys(await e.search("lu")), ["m3"]); // 2-letter prefix
  assert.deepEqual(keys(await e.search("pdf")), ["m3"]);
});

test("update and delete", async () => {
  const e = await fixture();
  const [{ id }] = await e.search("lunch");
  await e.updateDocs([{ id, fields: { from: "Bob", subject: "Lunch", body: "kubernetes cluster" } }]);
  assert.deepEqual(keys(await e.search("kubernets")), ["m3"]);
  await e.deleteIds([id]);
  assert.deepEqual(keys(await e.search("lunch")), []);
  assert.equal((await e.stats()).docs, 3);
});

test("highlighter", async () => {
  const e = await fixture();
  const hl = await e.highlighter("recieve");
  const text = "Please receive it; I recieve.";
  assert.deepEqual(hl(text).map(([a, b]) => text.slice(a, b)), ["receive", "recieve"]);
});

test("perf: 30k synthetic docs", async () => {
  const e = new SearchEngine(openDb());
  await e.init();
  const syll = ["ka","lo","mi","ne","ru","to","sa","vi","de","pa","qu","or","ex","an","ti","ber","gen","son","ul","fy","wo","ze","ch","st"];
  let seed = 7;
  const rnd = n => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const word = () => { let w = ""; const l = 1 + rnd(4); for (let i = 0; i < l; i++) w += syll[rnd(syll.length)]; return w; };
  const words = Array.from({ length: 60000 }, word);
  const pick = () => words[Math.floor(words.length * Math.pow(rnd(1e6) / 1e6, 3))];
  const text = n => Array.from({ length: n }, pick).join(" ");
  let t = Date.now();
  for (let b = 0; b < 30; b++) {
    const docs = [];
    for (let i = 0; i < 1000; i++) {
      const k = b * 1000 + i;
      docs.push({ folder: "f", msgkey: k, msgid: "m" + k, date: k, fields: { from: text(2), to: text(3), subject: text(6), body: text(250) } });
    }
    await e.addDocs(docs);
  }
  const build = Date.now() - t;
  const timings = [];
  for (const q of ["kalomich", "bersonti", "ka", "tisa vide", "qurtopam", "kalo mine ruto"]) {
    t = performance.now();
    const r = await e.search(q);
    timings.push(`${q}: ${r.length} hits ${(performance.now() - t).toFixed(0)}ms`);
  }
  console.log(`index 30k docs: ${build}ms;`, timings.join("; "));
});
