/**
 * SQLite FTS5 trigram search engine.
 *
 * Environment-neutral: runs inside Thunderbird (via Sqlite.sys.mjs) and in
 * Node (via node:sqlite) for tests. It only needs a small adapter:
 *
 *   db.execute(sql, params?)        -> Promise<object[]>   (rows as plain objects)
 *   db.executeMany(sql, paramsList) -> Promise<void>
 *   db.transaction(async () => {})  -> Promise<void>
 *
 * Index layout
 * ------------
 * Every field is normalized (lower case, diacritics removed, every run of
 * non-alphanumerics collapsed to one space) and padded with a space on both
 * sides; list items are separated by two spaces. Because the FTS5 trigram
 * tokenizer keeps spaces, one index answers:
 *
 *     " doe "  whole word          (tier EXACT)
 *     " do"    word prefix          (tier SUBSTRING, used for 2-letter tokens)
 *     "oe"...  any substring >= 3   (tier SUBSTRING)
 *     " john doe "  whole phrase    (tier EXACT)
 *
 * Fuzzy matching: every distinct word goes into `words`, itself trigram
 * indexed. A query token is expanded to similar words (trigram similarity),
 * which are then looked up as whole words.
 *
 * Tiers (higher always ranks first):
 *   4 EXACT      whole word / whole phrase as typed
 *   3 SUBSTRING  contiguous substring as typed
 *   2 SCATTERED  every word exact, but not as one phrase
 *   1 FUZZY      at least one word only matched approximately
 */

export const FIELDS = [
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "attachments",
  "tags",
];
export const COLS = FIELDS.map(f => `f_${f}`);
const FIELD_WEIGHT = [3, 2, 1.5, 1.5, 4, 1, 2, 3];
export const TIER = { FUZZY: 1, SCATTERED: 2, SUBSTRING: 3, EXACT: 4 };
export const BODY = { PENDING: 0, DONE: 1, NOT_OFFLINE: 2, FAILED: 3 };

const MAX_WORD_LEN = 48;
const WORD_RE = /[\p{L}\p{N}]+/gu;
const MARKS_RE = /\p{M}+/gu;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

export function normalize(text) {
  if (!text) {
    return "";
  }
  return String(text).normalize("NFKD").replace(MARKS_RE, "").toLowerCase();
}

export function tokenize(text) {
  return normalize(text).match(WORD_RE) || [];
}

/** Normalized, padded representation of a field value (string or list). */
export function indexText(value) {
  const items = Array.isArray(value) ? value : [value];
  const parts = [];
  for (const item of items) {
    const toks = tokenize(item);
    if (toks.length) {
      parts.push(toks.join(" "));
    }
  }
  return parts.length ? ` ${parts.join("  ")} ` : "";
}

/** Normalize keeping a map back to original offsets (for highlighting). */
export function normalizeWithMap(text) {
  let norm = "";
  const map = [];
  let i = 0;
  for (const ch of text) {
    const n = ch.normalize("NFKD").replace(MARKS_RE, "").toLowerCase();
    for (let k = 0; k < n.length; k++) {
      map.push(i);
    }
    norm += n;
    i += ch.length;
  }
  map.push(text.length);
  return { norm, map };
}

function paddedTrigrams(word) {
  const s = ` ${word} `;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) {
    out.add(s.slice(i, i + 3));
  }
  return out;
}

/** Trigram similarity of a query token to a vocabulary word (0..1). */
export function similarity(token, word) {
  const Q = paddedTrigrams(token);
  const I = [...Q].filter(t => !t.includes(" "));
  const W = paddedTrigrams(word);
  let p = 0;
  let ic = 0;
  for (const t of Q) {
    if (W.has(t)) {
      p++;
    }
  }
  for (const t of I) {
    if (W.has(t)) {
      ic++;
    }
  }
  const sim = Math.max(p / Q.size, I.length ? ic / I.length : 0);
  const lenPenalty =
    Math.abs(word.length - token.length) / Math.max(word.length, token.length);
  return sim * (1 - 0.3 * lenPenalty);
}

/**
 * Parse a query, mirroring Thunderbird's quick filter syntax:
 *   foo bar   -> foo AND bar          "foo bar" -> exact phrase
 *   foo|bar   -> foo OR bar
 * Punctuation splits words ("john.doe" -> john AND doe), but the whole
 * unquoted query is also tried as a phrase to decide the exact tiers.
 */
export function parseQuery(query) {
  let s = String(query || "").trim().replace(/\s*\|\s*/g, "|");
  const groups = [];
  const all = [];
  let syntax = false;
  while (s) {
    if (s.startsWith('"')) {
      syntax = true;
      let end = s.indexOf('"', 1);
      if (end === -1) {
        end = s.length;
      }
      const tokens = tokenize(s.slice(1, end));
      if (tokens.length) {
        groups.push([{ tokens, phrase: true }]);
      }
      s = s.slice(end + 1).trim();
      continue;
    }
    const m = s.match(/^[^\s"]+/);
    if (!m) {
      s = s.slice(1);
      continue;
    }
    s = s.slice(m[0].length).trim();
    const parts = m[0].split("|");
    if (parts.length > 1) {
      syntax = true;
      const alts = parts
        .map(p => tokenize(p))
        .filter(t => t.length)
        .map(tokens => ({ tokens, phrase: tokens.length > 1 }));
      if (alts.length) {
        groups.push(alts);
      }
    } else {
      for (const t of tokenize(parts[0])) {
        groups.push([{ tokens: [t], phrase: false }]);
        all.push(t);
      }
    }
  }
  return { groups, fullPhrase: !syntax && all.length > 1 ? all : null };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS msgs (
     id INTEGER PRIMARY KEY,
     folder TEXT NOT NULL,
     msgkey INTEGER NOT NULL,
     msgid TEXT,
     date INTEGER,
     body_state INTEGER NOT NULL DEFAULT 0,
     tagkeys TEXT,
     ${COLS.map(c => `${c} TEXT`).join(", ")}
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS msgs_loc ON msgs(folder, msgkey)`,
  `CREATE INDEX IF NOT EXISTS msgs_body ON msgs(body_state, date)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
     ${COLS.join(", ")},
     content='', contentless_delete=1,
     tokenize='trigram case_sensitive 1'
   )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS fwd USING fts5(
     ${COLS.join(", ")},
     content='', contentless_delete=1,
     tokenize='unicode61 remove_diacritics 0'
   )`,
  `CREATE TABLE IF NOT EXISTS words (id INTEGER PRIMARY KEY, w TEXT NOT NULL UNIQUE)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS wfts USING fts5(
     w, content='', tokenize='trigram case_sensitive 1'
   )`,
  `CREATE TRIGGER IF NOT EXISTS words_ai AFTER INSERT ON words BEGIN
     INSERT INTO wfts(rowid, w) VALUES (new.id, ' ' || new.w || ' ');
   END`,
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v)`,
];

const INSERT_MSG = `INSERT INTO msgs (id, folder, msgkey, msgid, date, body_state, tagkeys, ${COLS.join(", ")})
  VALUES (:id, :folder, :msgkey, :msgid, :date, :body_state, :tagkeys, ${COLS.map(c => `:${c}`).join(", ")})`;
const INSERT_FTS = `INSERT INTO fts (rowid, ${COLS.join(", ")}) VALUES (:id, ${COLS.map(c => `:${c}`).join(", ")})`;
const INSERT_FWD = `INSERT INTO fwd (rowid, ${COLS.join(", ")}) VALUES (:id, ${COLS.map(c => `:${c}`).join(", ")})`;

function q(s) {
  return `"${s.replace(/"/g, '""')}"`;
}

export class SearchEngine {
  constructor(db) {
    this.db = db;
    this.nextId = 1;
    this._expandCache = new Map();
  }

  async init() {
    for (const sql of SCHEMA) {
      await this.db.execute(sql);
    }
    const [row] = await this.db.execute("SELECT max(id) AS m FROM msgs");
    this.nextId = (row?.m || 0) + 1;
  }

  /**
   * Insert documents.
   *
   * @param {Array<{folder:string, msgkey:number, msgid:string, date:number,
   *   bodyState:number, tagkeys:string, fields:object}>} docs
   * @returns {number[]} assigned ids
   */
  async addDocs(docs) {
    if (!docs.length) {
      return [];
    }
    const msgRows = [];
    const ftsRows = [];
    const words = new Set();
    const ids = [];
    for (const d of docs) {
      const id = this.nextId++;
      ids.push(id);
      const m = {
        id,
        folder: d.folder,
        msgkey: d.msgkey,
        msgid: d.msgid || "",
        date: d.date || 0,
        body_state: d.bodyState ?? BODY.PENDING,
        tagkeys: d.tagkeys || "",
      };
      const f = { id };
      FIELDS.forEach((name, i) => {
        const v = d.fields[name];
        // Bodies are only indexed, not stored (they are re-read from the
        // message store when a row has to be rebuilt).
        m[COLS[i]] = name === "body" ? null : Array.isArray(v) ? v.join("\n") : v || "";
        f[COLS[i]] = this._collect(indexText(v), words);
      });
      msgRows.push(m);
      ftsRows.push(f);
    }
    await this.db.transaction(async () => {
      await this.db.executeMany(INSERT_MSG, msgRows);
      await this.db.executeMany(INSERT_FTS, ftsRows);
      await this.db.executeMany(INSERT_FWD, ftsRows);
      await this._addWords(words);
    });
    return ids;
  }

  /** Replace the content of existing documents (e.g. once the body is read). */
  async updateDocs(updates) {
    if (!updates.length) {
      return;
    }
    const msgRows = [];
    const ftsRows = [];
    const words = new Set();
    for (const u of updates) {
      const m = { id: u.id, body_state: u.bodyState ?? BODY.DONE, tagkeys: u.tagkeys ?? null };
      const f = { id: u.id };
      FIELDS.forEach((name, i) => {
        const v = u.fields[name];
        // Bodies are only indexed, not stored (they are re-read from the
        // message store when a row has to be rebuilt).
        m[COLS[i]] = name === "body" ? null : Array.isArray(v) ? v.join("\n") : v || "";
        f[COLS[i]] = this._collect(indexText(v), words);
      });
      msgRows.push(m);
      ftsRows.push(f);
    }
    await this.db.transaction(async () => {
      await this.db.executeMany(
        `UPDATE msgs SET body_state = :body_state, tagkeys = coalesce(:tagkeys, tagkeys),
           ${COLS.map(c => `${c} = :${c}`).join(", ")} WHERE id = :id`,
        msgRows
      );
      const idRows = ftsRows.map(r => ({ id: r.id }));
      await this.db.executeMany("DELETE FROM fts WHERE rowid = :id", idRows);
      await this.db.executeMany("DELETE FROM fwd WHERE rowid = :id", idRows);
      await this.db.executeMany(INSERT_FTS, ftsRows);
      await this.db.executeMany(INSERT_FWD, ftsRows);
      await this._addWords(words);
    });
  }

  /** Stored (display) fields of a document as {from: ..., ...}. */
  static fieldsOf(row) {
    const out = {};
    FIELDS.forEach((name, i) => {
      const v = row[COLS[i]] || "";
      out[name] = name === "attachments" || name === "tags" ? (v ? v.split("\n") : []) : v;
    });
    return out;
  }

  async deleteIds(ids) {
    if (!ids.length) {
      return;
    }
    const rows = ids.map(id => ({ id }));
    await this.db.transaction(async () => {
      await this.db.executeMany("DELETE FROM msgs WHERE id = :id", rows);
      await this.db.executeMany("DELETE FROM fts WHERE rowid = :id", rows);
      await this.db.executeMany("DELETE FROM fwd WHERE rowid = :id", rows);
    });
  }

  async clear() {
    await this.db.transaction(async () => {
      await this.db.execute("DELETE FROM msgs");
      await this.db.execute("DELETE FROM fts");
      await this.db.execute("DELETE FROM fwd");
      await this.db.execute("DELETE FROM words");
      await this.db.execute("DELETE FROM wfts");
    });
    this.nextId = 1;
    this._expandCache.clear();
  }

  _collect(text, words) {
    for (const w of text.split(" ")) {
      if (w && w.length <= MAX_WORD_LEN) {
        words.add(w);
      }
    }
    return text;
  }

  async _addWords(words) {
    if (!words.size) {
      return;
    }
    await this.db.executeMany(
      "INSERT OR IGNORE INTO words (w) VALUES (:w)",
      [...words].map(w => ({ w }))
    );
    this._expandCache.clear();
  }

  /**
   * Vocabulary words similar to `token` (excluding words containing it,
   * which the substring query already finds).
   */
  async expand(token, threshold, max = 30) {
    if (token.length < 4) {
      return [];
    }
    const ck = `${token}\u0000${threshold}`;
    if (this._expandCache.has(ck)) {
      return this._expandCache.get(ck);
    }
    const tris = [...paddedTrigrams(token)];
    const rows = await this.db.execute(
      `SELECT words.w AS w FROM wfts JOIN words ON words.id = wfts.rowid
        WHERE wfts MATCH :m ORDER BY rank LIMIT 3000`,
      { m: tris.map(q).join(" OR ") }
    );
    const scored = [];
    for (const { w } of rows) {
      if (w.includes(token)) {
        continue;
      }
      const s = similarity(token, w);
      if (s >= threshold) {
        scored.push([w, s]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    const out = scored.slice(0, max).map(([w]) => w);
    if (this._expandCache.size > 500) {
      this._expandCache.clear();
    }
    this._expandCache.set(ck, out);
    return out;
  }

  /**
   * Run one MATCH expression; returns Map id -> score. bm25 is only computed
   * for result sets small enough for it to be cheap and meaningful.
   */
  async _match(table, expr, colFilter, weights) {
    const m = { m: `${colFilter} : (${expr})` };
    const rows = await this.db.execute(
      `SELECT rowid AS id FROM ${table} WHERE ${table} MATCH :m`,
      m
    );
    const out = new Map();
    if (rows.length > 3000) {
      for (const r of rows) {
        out.set(r.id, 0);
      }
      return out;
    }
    for (const r of await this.db.execute(
      `SELECT rowid AS id, -bm25(${table}, ${weights}) AS s FROM ${table} WHERE ${table} MATCH :m`,
      m
    )) {
      out.set(r.id, r.s);
    }
    return out;
  }

  /** Expressions for a token sequence, best tier first. */
  _exprs(tokens) {
    const phrase = tokens.join(" ");
    // Whole words / word phrases come from the word index (cheap term
    // lookups); substrings from the trigram index.
    const out = [[TIER.EXACT, "fwd", q(phrase)]];
    if (phrase.length >= 3) {
      out.push([TIER.SUBSTRING, "fts", q(phrase)]);
    } else if (phrase.length === 2) {
      out.push([TIER.SUBSTRING, "fts", q(` ${phrase}`)]);
    }
    return out;
  }

  /**
   * Search.
   *
   * @param {string} query
   * @param {object} [opts]
   * @param {string[]} [opts.fields] - fields to search (default: all)
   * @param {number} [opts.threshold=0.4] - fuzzy similarity threshold
   * @param {boolean} [opts.fuzzy=true]
   * @returns {Promise<Array<{id, msgid, date, tier, score, rank}>>} best first
   */
  async search(query, opts = {}) {
    const threshold = opts.threshold ?? 0.4;
    const fuzzy = opts.fuzzy ?? true;
    const sel = (opts.fields || FIELDS).filter(f => FIELDS.includes(f));
    if (!sel.length) {
      return [];
    }
    const colFilter = `{${sel.map(f => COLS[FIELDS.indexOf(f)]).join(" ")}}`;
    const weights = FIELD_WEIGHT.join(", ");
    const { groups, fullPhrase } = parseQuery(query);
    if (!groups.length) {
      return [];
    }

    let acc = null; // id -> {tier, score}
    for (const alts of groups) {
      const res = new Map();
      for (const alt of alts) {
        const tiers = this._exprs(alt.tokens);
        if (fuzzy && !alt.phrase && alt.tokens.length === 1) {
          const similar = await this.expand(alt.tokens[0], threshold);
          if (similar.length) {
            tiers.push([TIER.FUZZY, "fwd", similar.map(q).join(" OR ")]);
          }
        }
        for (const [tier, table, expr] of tiers) {
          const hits = await this._match(table, expr, colFilter, weights);
          for (const [id, s] of hits) {
            const cur = res.get(id);
            if (!cur || tier > cur.tier) {
              res.set(id, { tier, score: s });
            }
          }
        }
      }
      if (acc === null) {
        acc = res;
      } else {
        const next = new Map();
        for (const [id, r] of res) {
          const cur = acc.get(id);
          if (cur) {
            next.set(id, { tier: Math.min(cur.tier, r.tier), score: cur.score + r.score });
          }
        }
        acc = next;
      }
      if (!acc.size) {
        return [];
      }
    }

    if (fullPhrase) {
      // "Exact" means the query as typed; scattered words drop to tier 2.
      const phraseTier = new Map();
      for (const [tier, table, expr] of this._exprs(fullPhrase)) {
        for (const id of (await this._match(table, expr, colFilter, weights)).keys()) {
          if (!phraseTier.has(id)) {
            phraseTier.set(id, tier);
          }
        }
      }
      for (const [id, r] of acc) {
        const pt = phraseTier.get(id);
        if (pt) {
          r.tier = pt;
        } else if (r.tier >= TIER.SUBSTRING) {
          r.tier = TIER.SCATTERED;
        }
      }
    }

    // Attach msgid/date.
    const ids = [...acc.keys()];
    const meta = new Map();
    for (let i = 0; i < ids.length; i += 5000) {
      const chunk = ids.slice(i, i + 5000);
      const rows = await this.db.execute(
        `SELECT id, msgid, date FROM msgs WHERE id IN (${chunk.join(",")})`
      );
      for (const r of rows) {
        meta.set(r.id, r);
      }
    }
    const n = groups.length;
    const out = [];
    for (const [id, r] of acc) {
      const m = meta.get(id);
      if (!m) {
        continue;
      }
      const score = Math.max(0, r.score / n);
      out.push({
        id,
        msgid: m.msgid,
        date: m.date,
        tier: r.tier,
        score,
        // Unsigned 32-bit (Thunderbird custom column sort value).
        rank: r.tier * 100000000 + Math.round(Math.min(score, 99.99) * 1000000),
      });
    }
    out.sort((a, b) => b.rank - a.rank || b.date - a.date);
    return out;
  }

  /**
   * Returns a function text -> [[start, end], ...] highlighting what the
   * query matches (tokens as substrings, fuzzy variants as whole words).
   */
  async highlighter(query, threshold = 0.4, fuzzy = true) {
    const { groups } = parseQuery(query);
    const tokens = new Set();
    const variants = new Set();
    for (const alts of groups) {
      for (const alt of alts) {
        alt.tokens.forEach(t => tokens.add(t));
        if (fuzzy && !alt.phrase && alt.tokens.length === 1) {
          (await this.expand(alt.tokens[0], threshold)).forEach(w => variants.add(w));
        }
      }
    }
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const res = [];
    if (tokens.size) {
      res.push(new RegExp([...tokens].sort((a, b) => b.length - a.length).map(esc).join("|"), "gu"));
    }
    if (variants.size) {
      res.push(
        new RegExp(`(?<![\\p{L}\\p{N}])(?:${[...variants].map(esc).join("|")})(?![\\p{L}\\p{N}])`, "gu")
      );
    }
    return text => {
      if (!text || !res.length) {
        return [];
      }
      const { norm, map } = normalizeWithMap(text);
      const ranges = [];
      for (const re of res) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(norm))) {
          ranges.push([map[m.index], map[m.index + m[0].length]]);
        }
      }
      ranges.sort((a, b) => a[0] - b[0]);
      const merged = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) {
          last[1] = Math.max(last[1], r[1]);
        } else {
          merged.push([...r]);
        }
      }
      return merged;
    };
  }

  async stats() {
    const [m] = await this.db.execute(
      `SELECT count(*) AS docs,
              sum(body_state = ${BODY.DONE}) AS bodies,
              sum(body_state = ${BODY.PENDING}) AS pending,
              sum(body_state = ${BODY.NOT_OFFLINE}) AS notOffline
         FROM msgs`
    );
    const [w] = await this.db.execute("SELECT count(*) AS words FROM words");
    return {
      docs: m.docs || 0,
      bodies: m.bodies || 0,
      pending: m.pending || 0,
      notOffline: m.notOffline || 0,
      words: w.words || 0,
    };
  }
}
