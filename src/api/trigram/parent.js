/* eslint-disable no-var */
/* global ExtensionAPI, ChromeUtils, Services, Ci, Cr, PathUtils */
"use strict";

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { MessageTextFilter } = ChromeUtils.importESModule(
  "resource:///modules/QuickFilterManager.sys.mjs"
);
var { ThreadPaneColumns } = ChromeUtils.importESModule(
  "chrome://messenger/content/ThreadPaneColumns.mjs"
);
var { XULStoreUtils } = ChromeUtils.importESModule(
  "resource:///modules/XULStoreUtils.sys.mjs"
);
var { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
var { Sqlite } = ChromeUtils.importESModule(
  "resource://gre/modules/Sqlite.sys.mjs"
);
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
var { MimeParser } = ChromeUtils.importESModule(
  "resource:///modules/mimeParser.sys.mjs"
);
var { Gloda } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaPublic.sys.mjs"
);
var { GlodaIndexer } = ChromeUtils.importESModule(
  "resource:///modules/gloda/GlodaIndexer.sys.mjs"
);

// Experiment sandboxes don't always expose these web globals; borrow them
// from a system module's global.
const MODULE_GLOBAL = Components.utils.getGlobalForObject(MimeParser);
const b64decode = typeof atob === "function" ? atob : MODULE_GLOBAL.atob;
const Decoder = typeof TextDecoder === "function" ? TextDecoder : MODULE_GLOBAL.TextDecoder;

const TERM_ID = "trigram-search@lolocomotive#match";
const COLUMN_ID = "trigramRelevanceCol";
const WINDOW_LISTENER_ID = "trigram-search-global-search";
const ORIGINAL = Symbol.for("trigram-search.original");
const DB_FILE = "trigram-search.sqlite";
const NATIVE = "native";
const CACHE_LIMIT = 30;
const MAX_RAW_BYTES = 2 * 1024 * 1024;
const MAX_GLOBAL_RESULTS = 5000;
const TIER_LABELS = ["", "fuzzy", "all words", "substring", "exact"];

/** Quick filter toggle button -> index fields. */
const FIELD_MAP = {
  sender: ["from"],
  recipients: ["to", "cc", "bcc"],
  subject: ["subject"],
  body: ["body"],
};
const ALL_FIELDS = ["from", "to", "cc", "bcc", "subject", "body", "attachments", "tags"];

/** Scopes in which the custom term can be evaluated locally. */
const LOCAL_SCOPES = new Set(
  ["offlineMail", "onlineManual", "localNews", "localNewsJunk", "localNewsBody", "localNewsJunkBody"]
    .map(n => Ci.nsMsgSearchScope[n])
    .filter(v => v !== undefined)
);

const state = {
  config: {
    enabled: true,
    sortByRelevance: false,
    redirectGlobalSearch: true,
    extraFields: ["attachments", "tags"],
    fuzzy: true,
    fuzzyThreshold: 0.4,
    indexBodies: true,
    maxBodyChars: 20000,
    rescanMinutes: 30,
  },
  /** key -> Map(msgid -> rank) | NATIVE */
  cache: new Map(),
  pending: new Set(),
  /** Rank maps the Relevance column reads from, most recent first. */
  rankMaps: [],
  lastApplied: new WeakMap(),
  savedSort: new WeakMap(),
};

/** Engine module, SearchEngine instance, Sqlite connection. */
let E = null;
let engine = null;
let conn = null;
let resHost = null;
let stopped = false;

const status = {
  state: "starting",
  ready: false, // first header scan finished
  foldersDone: 0,
  foldersTotal: 0,
  bodiesThisSession: 0,
  lastScan: null,
  error: null,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const tick = () => new Promise(r => setTimeout(r, 0));

/** Run fn over items, yielding to the event loop every ~30 ms. */
async function sliced(items, fn) {
  let t0 = Date.now();
  for (const item of items) {
    if (stopped) {
      return;
    }
    await fn(item);
    if (Date.now() - t0 > 30) {
      await tick();
      t0 = Date.now();
    }
  }
}

function* mail3PaneWindows() {
  yield* Services.wm.getEnumerator("mail:3pane");
}

function* about3Panes() {
  for (const win of mail3PaneWindows()) {
    const tabmail = win.document.getElementById("tabmail");
    for (const tab of tabmail?.tabInfo || []) {
      if (tab.mode?.name !== "mail3PaneTab") {
        continue;
      }
      const w = tab.chromeBrowser?.contentWindow;
      if (w?.quickFilterBar) {
        yield w;
      }
    }
  }
}

function findAbout3Pane(session) {
  for (const w of about3Panes()) {
    try {
      if (w.gViewWrapper?.search?.session === session) {
        return w;
      }
    } catch (e) {
      // window going away
    }
  }
  return null;
}

function getFolder(uri) {
  try {
    return MailServices.folderLookup.getFolderForURL(uri);
  } catch (e) {
    return null;
  }
}

function releaseDatabases(folders) {
  for (const f of folders) {
    try {
      if (!MailServices.mailSession.IsFolderOpenInWindow(f)) {
        f.msgDatabase = null;
      }
    } catch (e) {
      // ignore
    }
  }
}

function setStatusBar(text) {
  for (const win of mail3PaneWindows()) {
    try {
      win.MsgStatusFeedback?.showStatusString(text);
    } catch (e) {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

/** Column names of a SELECT, in order (aliases or last path segment). */
function selectColumns(sql) {
  const m = sql.match(/^\s*SELECT\s+([\s\S]*?)\s+FROM\s/i);
  if (!m) {
    return [];
  }
  const cols = [];
  let depth = 0;
  let cur = "";
  for (const ch of m[1]) {
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
    if (ch === "," && depth === 0) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols.map(c => {
    const as = c.match(/\bAS\s+(\w+)\s*$/i);
    return as ? as[1] : c.trim().split(".").pop();
  });
}

async function openDatabase() {
  const path = PathUtils.join(PathUtils.profileDir, DB_FILE);
  conn = await Sqlite.openConnection({ path, extensions: ["fts5"] });
  await conn.execute("PRAGMA journal_mode = WAL");
  await conn.execute("PRAGMA synchronous = NORMAL");
  const nameCache = new Map();
  const adapter = {
    async execute(sql, params) {
      const rows = await conn.executeCached(sql, params);
      if (!rows?.length) {
        return [];
      }
      let names = nameCache.get(sql);
      if (!names) {
        names = selectColumns(sql);
        nameCache.set(sql, names);
      }
      return rows.map(r => {
        const o = {};
        names.forEach((n, i) => (o[n] = r.getResultByIndex(i)));
        return o;
      });
    },
    async executeMany(sql, list) {
      if (list.length) {
        await conn.executeCached(sql, list);
      }
    },
    async transaction(fn) {
      await conn.executeTransaction(fn);
    },
  };
  engine = new E.SearchEngine(adapter);
  await engine.init();
}

// ---------------------------------------------------------------------------
// Reading messages
// ---------------------------------------------------------------------------

function decodeHeader(s) {
  if (!s) {
    return "";
  }
  try {
    return MailServices.mimeConverter.decodeMimeHeader(s, null, false, true);
  } catch (e) {
    return s;
  }
}

function tagNames(keywords) {
  const out = [];
  for (const k of (keywords || "").split(" ")) {
    if (!k) {
      continue;
    }
    try {
      const t = MailServices.tags.getTagForKey(k);
      if (t) {
        out.push(t);
      }
    } catch (e) {
      // not a tag (e.g. $Forwarded)
    }
  }
  return out;
}

function bodyAvailable(hdr) {
  if (hdr.flags & Ci.nsMsgMessageFlags.Partial) {
    return false;
  }
  try {
    return hdr.folder.hasMsgOffline(hdr.messageKey);
  } catch (e) {
    return false;
  }
}

function headerFields(hdr) {
  const keywords = hdr.getStringProperty("keywords") || "";
  let subject = hdr.mime2DecodedSubject || "";
  if (hdr.flags & Ci.nsMsgMessageFlags.HasRe) {
    subject = `Re: ${subject}`;
  }
  return {
    keywords,
    fields: {
      from: hdr.mime2DecodedAuthor || "",
      to: hdr.mime2DecodedRecipients || "",
      cc: decodeHeader(hdr.ccList),
      bcc: decodeHeader(hdr.bccList),
      subject,
      body: "",
      attachments: [],
      tags: tagNames(keywords),
    },
  };
}

function hdrDoc(hdr, withBody = false) {
  const { keywords, fields } = headerFields(hdr);
  let bodyState =
    state.config.indexBodies && bodyAvailable(hdr) ? E.BODY.PENDING : E.BODY.NOT_OFFLINE;
  if (withBody && bodyState === E.BODY.PENDING) {
    try {
      Object.assign(fields, readMessage(hdr));
      bodyState = E.BODY.DONE;
    } catch (e) {
      // leave it to the body loop
    }
  }
  return {
    folder: hdr.folder.URI,
    msgkey: hdr.messageKey,
    msgid: hdr.messageId || "",
    date: Math.floor(hdr.date / 1000),
    tagkeys: keywords,
    bodyState,
    fields,
  };
}

let decodeErrorLogged = false;
function decodeTransfer(data, cte, charset) {
  cte = String(cte || "").toLowerCase().trim();
  if (cte !== "base64" && cte !== "quoted-printable") {
    return data; // jsmime already converted it to unicode
  }
  try {
    const bin =
      cte === "base64"
        ? b64decode(data.replace(/[^A-Za-z0-9+/=]/g, ""))
        : data
            .replace(/=\r?\n/g, "")
            .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0) & 0xff);
    let decoder;
    try {
      decoder = new Decoder(charset || "utf-8");
    } catch (e) {
      decoder = new Decoder("utf-8");
    }
    return decoder.decode(bytes);
  } catch (e) {
    if (!decodeErrorLogged) {
      decodeErrorLogged = true;
      console.error("trigram-search: cannot decode body part", e);
    }
    return "";
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function htmlToText(html) {
  return html
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? " ";
    });
}

function filenameOf(headers) {
  let name = headers.contentType?.get("name") || "";
  if (!name) {
    const disp = headers.get("content-disposition");
    const raw = Array.isArray(disp) ? disp[0] : disp || "";
    const ext = raw.match(/filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i);
    if (ext) {
      try {
        name = decodeURIComponent(ext[2].replace(/"/g, ""));
      } catch (e) {
        name = ext[2];
      }
    } else {
      const m = raw.match(/filename\s*=\s*("([^"]*)"|[^;]+)/i);
      name = m ? (m[2] ?? m[1]).trim() : "";
    }
  }
  // Only RFC 2047 encoded-words need decoding; RFC 2231 names are done above.
  return name.includes("=?") ? decodeHeader(name) : name;
}

/** Extract text and attachment names from a raw message. */
function extractMessage(raw, maxChars) {
  const plain = [];
  const html = [];
  const attachments = [];
  const parts = new Map();
  MimeParser.parseSync(
    raw,
    {
      startPart(num, headers) {
        const type = (headers.contentType?.type || "text/plain").toLowerCase();
        if (type.startsWith("multipart/")) {
          return;
        }
        const disp = String(headers.get("content-disposition") || "").toLowerCase();
        const name = filenameOf(headers);
        const isAttachment = disp.startsWith("attachment") || (name && !type.startsWith("text/"));
        if (name) {
          attachments.push(name);
        }
        if (!isAttachment && (type === "text/plain" || type === "text/html")) {
          parts.set(num, {
            type,
            cte: headers.get("content-transfer-encoding"),
            charset: headers.contentType?.get("charset"),
            data: "",
          });
        }
      },
      deliverPartData(num, data) {
        const p = parts.get(num);
        if (p && p.data.length < maxChars * 4) {
          p.data += data;
        }
      },
      endPart(num) {
        const p = parts.get(num);
        if (!p) {
          return;
        }
        parts.delete(num);
        const text = decodeTransfer(p.data, p.cte, p.charset);
        (p.type === "text/html" ? html : plain).push(text);
      },
    },
    { bodyformat: "nodecode", strformat: "unicode", stripcontinuations: true }
  );
  const text = plain.length ? plain.join("\n") : htmlToText(html.join("\n"));
  return {
    body: text.replace(/\s+/g, " ").trim().slice(0, maxChars),
    attachments,
  };
}

function readMessage(hdr) {
  const stream = hdr.folder.getMsgInputStream(hdr);
  let raw = "";
  try {
    // available() only reports what is buffered; read until EOF.
    let n;
    while (raw.length < MAX_RAW_BYTES && (n = stream.available()) > 0) {
      raw += NetUtil.readInputStreamToString(stream, Math.min(n, MAX_RAW_BYTES - raw.length));
    }
  } finally {
    stream.close();
  }
  return extractMessage(raw, state.config.maxBodyChars);
}

/** Full set of fields for a header (re-reading the body when possible). */
function fullDoc(hdr) {
  const { keywords, fields } = headerFields(hdr);
  let bodyState = E.BODY.NOT_OFFLINE;
  if (state.config.indexBodies && bodyAvailable(hdr)) {
    try {
      Object.assign(fields, readMessage(hdr));
      bodyState = E.BODY.DONE;
    } catch (e) {
      bodyState = E.BODY.FAILED;
    }
  }
  return { keywords, fields, bodyState };
}

// ---------------------------------------------------------------------------
// Indexer
// ---------------------------------------------------------------------------

function indexableFolders() {
  const out = [];
  for (const f of MailServices.accounts.allFolders) {
    if (
      f.isServer ||
      f.getFlag(Ci.nsMsgFolderFlags.Virtual) ||
      f.getFlag(Ci.nsMsgFolderFlags.ImapNoselect)
    ) {
      continue;
    }
    out.push(f);
  }
  return out;
}

async function idsForLocations(folderURI, keys) {
  const out = new Map();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500).map(Number).filter(Number.isFinite);
    if (!chunk.length) {
      continue;
    }
    const rows = await engine.db.execute(
      `SELECT id, msgkey FROM msgs WHERE folder = :f AND msgkey IN (${chunk.join(",")})`,
      { f: folderURI }
    );
    for (const r of rows) {
      out.set(r.msgkey, r.id);
    }
  }
  return out;
}

async function scanFolder(folder) {
  let db;
  try {
    db = folder.msgDatabase;
  } catch (e) {
    // Summary (.msf) missing or out of date: ask Thunderbird to rebuild it
    // (local folders) and rescan once that is done.
    try {
      folder.QueryInterface(Ci.nsIMsgLocalMailFolder).getDatabaseWithReparse(
        {
          QueryInterface: ChromeUtils.generateQI(["nsIUrlListener"]),
          OnStartRunningUrl() {},
          OnStopRunningUrl() {
            scheduleScan(1000);
          },
        },
        null
      );
    } catch (e2) {
      // not a local folder, or reparse already running
    }
    return false;
  }
  if (!db) {
    return false;
  }
  const existing = new Map();
  for (const r of await engine.db.execute(
    "SELECT id, msgkey, tagkeys, body_state FROM msgs WHERE folder = :f",
    { f: folder.URI }
  )) {
    existing.set(r.msgkey, r);
  }
  let add = [];
  const retag = [];
  const nowOffline = [];
  let n = 0;
  for (const hdr of db.enumerateMessages()) {
    if (stopped) {
      return false;
    }
    const ex = existing.get(hdr.messageKey);
    if (!ex) {
      // Read the body right away (~0.1 ms from the local store) so each
      // message is inserted into the index once.
      add.push(hdrDoc(hdr, true));
    } else {
      existing.delete(hdr.messageKey);
      if ((ex.tagkeys || "") !== (hdr.getStringProperty("keywords") || "")) {
        retag.push([ex.id, hdr]);
      }
      if (ex.body_state === E.BODY.NOT_OFFLINE && state.config.indexBodies && bodyAvailable(hdr)) {
        nowOffline.push(ex.id);
      }
    }
    if (add.length >= 500) {
      await engine.addDocs(add);
      add = [];
      status.indexedThisScan = (status.indexedThisScan || 0) + 500;
      setStatusBar(`Trigram index: ${folder.localizedName || folder.name} – ${status.indexedThisScan.toLocaleString()} messages indexed…`);
    }
    if (++n % 100 === 0) {
      await tick();
    }
  }
  await engine.addDocs(add);
  await engine.deleteIds([...existing.values()].map(e => e.id));
  if (retag.length) {
    await reindexRows(retag);
  }
  for (let i = 0; i < nowOffline.length; i += 500) {
    await engine.db.execute(
      `UPDATE msgs SET body_state = ${E.BODY.PENDING} WHERE id IN (${nowOffline.slice(i, i + 500).join(",")})`
    );
  }
  return true;
}

/** Rebuild rows completely from their headers. [[id, hdr], ...] */
async function reindexRows(pairs) {
  const updates = [];
  await sliced(pairs, async ([id, hdr]) => {
    try {
      const { keywords, fields, bodyState } = fullDoc(hdr);
      updates.push({ id, fields, bodyState, tagkeys: keywords });
    } catch (e) {
      // header vanished
    }
  });
  await engine.updateDocs(updates);
}

let scanning = null;
let scanTimer = null;

function scheduleScan(delayMs) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanAll(), delayMs);
}

async function scanAll() {
  if (scanning) {
    return scanning;
  }
  scanning = (async () => {
    status.state = "scanning";
    status.error = null;
    for (const w of about3Panes()) {
      wrapQuickFilterBar(w);
    }
    let failed = 0;
    try {
      const folders = indexableFolders();
      status.foldersTotal = folders.length;
      status.foldersDone = 0;
      status.indexedThisScan = 0;
      const live = new Set(folders.map(f => f.URI));
      for (const folder of folders) {
        if (stopped) {
          return;
        }
        try {
          if (!(await scanFolder(folder))) {
            failed++;
          }
        } catch (e) {
          console.error(`trigram-search: scanning ${folder.URI} failed`, e);
          failed++;
        }
        releaseDatabases([folder]);
        status.foldersDone++;
        setStatusBar(`Trigram index: scanning folders ${status.foldersDone}/${status.foldersTotal}…`);
      }
      // Rows of folders that no longer exist.
      for (const { folder } of await engine.db.execute("SELECT DISTINCT folder FROM msgs")) {
        if (!live.has(folder)) {
          const ids = await engine.db.execute("SELECT id FROM msgs WHERE folder = :f", { f: folder });
          await engine.deleteIds(ids.map(r => r.id));
        }
      }
      status.lastScan = Date.now();
      if (status.indexedThisScan) {
        const st = await engine.stats();
        setStatusBar(`Trigram index up to date: ${st.docs.toLocaleString()} messages.`);
      }
      if (!status.ready) {
        status.ready = true;
        invalidateQuickFilter();
      }
    } catch (e) {
      console.error("trigram-search: scan failed", e);
      status.error = String(e);
    } finally {
      scanning = null;
      status.state = "idle";
      if (!stopped) {
        scheduleScan(failed ? 60 * 1000 : Math.max(5, state.config.rescanMinutes) * 60 * 1000);
        bodyLoop();
      }
    }
  })();
  return scanning;
}

let bodyLoopRunning = false;

async function bodyLoop() {
  if (bodyLoopRunning || stopped || !state.config.indexBodies) {
    return;
  }
  bodyLoopRunning = true;
  status.state = "bodies";
  let changed = false;
  try {
    const cols = E.COLS.filter(c => c !== "f_body");
    while (!stopped && state.config.indexBodies) {
      const rows = await engine.db.execute(
        `SELECT id, folder, msgkey, tagkeys, ${cols.join(", ")} FROM msgs
          WHERE body_state = ${E.BODY.PENDING} ORDER BY date DESC LIMIT 300`
      );
      if (!rows.length) {
        break;
      }
      const updates = [];
      const touched = new Set();
      await sliced(rows, async row => {
        const fields = E.SearchEngine.fieldsOf(row);
        let bodyState = E.BODY.FAILED;
        try {
          const folder = getFolder(row.folder);
          if (folder) {
            touched.add(folder);
            const hdr = folder.GetMessageHeader(row.msgkey);
            if (!bodyAvailable(hdr)) {
              bodyState = E.BODY.NOT_OFFLINE;
            } else {
              Object.assign(fields, readMessage(hdr));
              bodyState = E.BODY.DONE;
            }
          }
        } catch (e) {
          // missing header or unreadable message
        }
        updates.push({ id: row.id, fields, bodyState });
      });
      await engine.updateDocs(updates);
      releaseDatabases(touched);
      status.bodiesThisSession += updates.length;
      changed = true;
      const s = await engine.stats();
      setStatusBar(`Trigram index: reading message bodies, ${s.pending.toLocaleString()} left…`);
    }
  } catch (e) {
    console.error("trigram-search: body indexing failed", e);
    status.error = String(e);
  } finally {
    bodyLoopRunning = false;
    if (status.state === "bodies") {
      status.state = "idle";
    }
    if (changed && !stopped) {
      const s = await engine.stats().catch(() => null);
      if (s) {
        setStatusBar(`Trigram index up to date: ${s.docs.toLocaleString()} messages.`);
      }
      invalidateQuickFilter();
    }
  }
}

// ---------------------------------------------------------------------------
// Live updates (nsIMsgFolderListener)
// ---------------------------------------------------------------------------

const live = {
  adds: [],
  deletes: [], // [folderURI, key]
  moves: [], // [srcURI, srcKey, dstURI, dstKey]
  retag: [],
  renames: [], // [oldURI, newURI]
  folderDeletes: [],
  timer: null,
  flushing: false,
};

function scheduleFlush() {
  if (!live.timer) {
    live.timer = setTimeout(flushLive, 1000);
  }
}

const folderListener = {
  QueryInterface: ChromeUtils.generateQI(["nsIMsgFolderListener"]),
  msgAdded(hdr) {
    live.adds.push(hdr);
    scheduleFlush();
  },
  msgsDeleted(hdrs) {
    for (const h of hdrs) {
      live.deletes.push([h.folder.URI, h.messageKey]);
    }
    scheduleFlush();
  },
  msgsMoveCopyCompleted(isMove, src, destFolder, dest) {
    if (isMove && dest?.length === src.length) {
      src.forEach((s, i) => live.moves.push([s.folder.URI, s.messageKey, destFolder.URI, dest[i].messageKey]));
    } else {
      if (isMove) {
        for (const s of src) {
          live.deletes.push([s.folder.URI, s.messageKey]);
        }
      }
      // Destination headers (if known now) are indexed as new messages;
      // otherwise msgAdded fires for them later.
      for (const d of dest || []) {
        live.adds.push(d);
      }
    }
    scheduleFlush();
  },
  msgKeyChanged(oldKey, newHdr) {
    const uri = newHdr.folder.URI;
    live.moves.push([uri, oldKey, uri, newHdr.messageKey]);
    scheduleFlush();
  },
  msgPropertyChanged(hdr, property) {
    if (property === "keywords") {
      live.retag.push(hdr);
      scheduleFlush();
    }
  },
  folderDeleted(folder) {
    live.folderDeletes.push(folder.URI);
    scheduleFlush();
  },
  folderMoveCopyCompleted(isMove, srcFolder, destFolder) {
    if (isMove) {
      live.renames.push([srcFolder.URI, `${destFolder.URI}/${srcFolder.URI.split("/").pop()}`]);
      scheduleFlush();
    } else {
      scheduleScan(5000);
    }
  },
  folderRenamed(oldFolder, newFolder) {
    live.renames.push([oldFolder.URI, newFolder.URI]);
    scheduleFlush();
  },
};

function folderPrefixClause(param) {
  return `(folder = :${param} OR substr(folder, 1, length(:${param}) + 1) = :${param} || '/')`;
}

async function flushLive() {
  live.timer = null;
  if (live.flushing || !engine || stopped) {
    if (!stopped) {
      scheduleFlush();
    }
    return;
  }
  live.flushing = true;
  try {
    const db = engine.db;
    for (const uri of live.folderDeletes.splice(0)) {
      const ids = await db.execute(`SELECT id FROM msgs WHERE ${folderPrefixClause("f")}`, { f: uri });
      await engine.deleteIds(ids.map(r => r.id));
    }
    for (const [oldURI, newURI] of live.renames.splice(0)) {
      await db.execute(
        `UPDATE msgs SET folder = :n || substr(folder, length(:f) + 1) WHERE ${folderPrefixClause("f")}`,
        { f: oldURI, n: newURI }
      );
    }
    // Moves keep the indexed content: only the location changes.
    for (const [su, sk, du, dk] of live.moves.splice(0)) {
      const [src] = await db.execute("SELECT id FROM msgs WHERE folder = :f AND msgkey = :k", { f: su, k: sk });
      if (!src) {
        continue; // never indexed; msgAdded covers the destination
      }
      const [dup] = await db.execute("SELECT id FROM msgs WHERE folder = :f AND msgkey = :k", { f: du, k: dk });
      if (dup && dup.id !== src.id) {
        await engine.deleteIds([dup.id]);
      }
      await db.execute("UPDATE msgs SET folder = :du, msgkey = :dk WHERE id = :id", { du, dk, id: src.id });
    }
    const dels = live.deletes.splice(0);
    const byFolder = new Map();
    for (const [uri, key] of dels) {
      if (!byFolder.has(uri)) {
        byFolder.set(uri, []);
      }
      byFolder.get(uri).push(key);
    }
    for (const [uri, keys] of byFolder) {
      await engine.deleteIds([...(await idsForLocations(uri, keys)).values()]);
    }
    // New messages (skip ones already indexed, e.g. reported twice).
    const adds = live.adds.splice(0);
    const groups = new Map();
    for (const h of adds) {
      try {
        const uri = h.folder.URI;
        if (!groups.has(uri)) {
          groups.set(uri, new Map());
        }
        groups.get(uri).set(h.messageKey, h);
      } catch (e) {
        // stale header
      }
    }
    for (const [uri, hdrs] of groups) {
      const known = await idsForLocations(uri, [...hdrs.keys()]);
      const docs = [];
      for (const [key, h] of hdrs) {
        if (!known.has(key)) {
          try {
            docs.push(hdrDoc(h, true));
          } catch (e) {
            // ignore
          }
        }
      }
      await engine.addDocs(docs);
    }
    // Tag changes.
    const retag = [];
    for (const h of live.retag.splice(0)) {
      try {
        const ids = await idsForLocations(h.folder.URI, [h.messageKey]);
        if (ids.size) {
          retag.push([[...ids.values()][0], h]);
        }
      } catch (e) {
        // ignore
      }
    }
    await reindexRows(retag);
    invalidateQuickFilter();
    bodyLoop();
  } catch (e) {
    console.error("trigram-search: applying live update failed", e);
  } finally {
    live.flushing = false;
  }
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

function searchOpts(fields) {
  return {
    fields,
    threshold: state.config.fuzzyThreshold,
    fuzzy: state.config.fuzzy,
  };
}

function rankMapOf(results) {
  const map = new Map();
  for (const r of results) {
    if (!map.has(r.msgid)) {
      map.set(r.msgid, r.rank);
    }
  }
  return map;
}

function pushRankMap(map) {
  state.rankMaps = [map, ...state.rankMaps.filter(m => m !== map)].slice(0, 8);
}

function rankOf(hdr) {
  const id = hdr.messageId;
  for (const m of state.rankMaps) {
    const r = m.get(id);
    if (r) {
      return r;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Quick filter integration
// ---------------------------------------------------------------------------

function fieldsFromStates(states) {
  const fields = [];
  for (const [name, on] of Object.entries(states || {})) {
    if (on && FIELD_MAP[name]) {
      fields.push(...FIELD_MAP[name]);
    }
  }
  return fields;
}

function makeKey(filterValue) {
  if (!filterValue?.text) {
    return null;
  }
  const fields = fieldsFromStates(filterValue.states);
  if (!fields.length) {
    return null;
  }
  for (const f of state.config.extraFields) {
    if (!fields.includes(f)) {
      fields.push(f);
    }
  }
  return JSON.stringify({ q: filterValue.text, f: fields });
}

function currentKey(win) {
  try {
    return makeKey(win.quickFilterBar._filterer?.filterValues?.text);
  } catch (e) {
    return null;
  }
}

function refreshWindowsFor(key) {
  for (const w of about3Panes()) {
    if (currentKey(w) === key) {
      try {
        w.quickFilterBar.updateSearch();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

function setResult(key, value) {
  state.pending.delete(key);
  state.cache.delete(key);
  state.cache.set(key, value);
  while (state.cache.size > CACHE_LIMIT) {
    state.cache.delete(state.cache.keys().next().value);
  }
  refreshWindowsFor(key);
}

function request(key) {
  if (state.pending.has(key)) {
    return;
  }
  if (!engine || !status.ready) {
    state.cache.set(key, NATIVE);
    return;
  }
  state.pending.add(key);
  const { q, f } = JSON.parse(key);
  engine
    .search(q, searchOpts(f))
    .then(results => setResult(key, rankMapOf(results)))
    .catch(e => {
      console.error("trigram-search: search failed", e);
      setResult(key, NATIVE);
    });
}

function invalidateQuickFilter() {
  const active = new Set();
  for (const w of about3Panes()) {
    const k = currentKey(w);
    if (k) {
      active.add(k);
    }
  }
  for (const k of [...state.cache.keys()]) {
    if (!active.has(k) || state.cache.get(k) === NATIVE) {
      state.cache.delete(k);
    }
  }
  state.pending.clear();
  for (const k of active) {
    if (state.cache.has(k)) {
      request(k); // old results stay visible until the new ones arrive
    } else {
      refreshWindowsFor(k);
    }
  }
}

const termImpl = {
  match(hdr, value) {
    const res = state.cache.get(value);
    return res instanceof Map && res.has(hdr.messageId);
  },
};

function installTerm() {
  let existing = null;
  try {
    existing = MailServices.filters.getCustomTerm(TERM_ID);
  } catch (e) {
    // not registered
  }
  if (existing?.wrappedJSObject) {
    existing.wrappedJSObject.impl = termImpl;
    return;
  }
  // The filter service cannot unregister terms, so the registered object
  // survives add-on reloads and delegates to the current implementation.
  const term = {
    id: TERM_ID,
    name: "Trigram fuzzy match (Quick Filter)",
    needsBody: false,
    impl: termImpl,
    QueryInterface: ChromeUtils.generateQI(["nsIMsgSearchCustomTerm"]),
    getEnabled() {
      return false; // keep it out of the filter / saved-search editors
    },
    getAvailable(scope) {
      return !!this.impl && LOCAL_SCOPES.has(scope);
    },
    getAvailableOperators(scope, length) {
      if (length && typeof length === "object") {
        length.value = 1;
      }
      return [Ci.nsMsgSearchOp.Contains];
    },
    match(hdr, value) {
      return this.impl ? this.impl.match(hdr, value) : false;
    },
  };
  term.wrappedJSObject = term;
  MailServices.filters.addCustomTerm(term);
}

function uninstallTerm() {
  try {
    const t = MailServices.filters.getCustomTerm(TERM_ID);
    if (t?.wrappedJSObject) {
      t.wrappedJSObject.impl = null;
    }
  } catch (e) {
    // ignore
  }
}

function pushTerm(aTermCreator, aTerms, key) {
  const term = aTermCreator.createTerm();
  term.attrib = Ci.nsMsgSearchAttrib.Custom;
  term.customId = TERM_ID;
  const value = term.value;
  value.attrib = Ci.nsMsgSearchAttrib.Custom;
  value.str = key;
  term.value = value;
  term.op = Ci.nsMsgSearchOp.Contains;
  term.booleanAnd = true;
  aTerms.push(term);
}

function installColumn() {
  try {
    ThreadPaneColumns.removeCustomColumn(COLUMN_ID);
  } catch (e) {
    // not there
  }
  ThreadPaneColumns.addCustomColumn(COLUMN_ID, {
    name: "Relevance",
    hidden: true,
    sortable: true,
    resizable: true,
    textCallback(hdr) {
      const r = rankOf(hdr);
      return r ? TIER_LABELS[Math.floor(r / 100000000)] || "" : "";
    },
    sortCallback(hdr) {
      return rankOf(hdr);
    },
  });
}

function sortIsOurs(vw) {
  return vw?._sort?.[0]?.[2] === COLUMN_ID;
}

function applyRelevanceSort(win) {
  const vw = win.gViewWrapper;
  if (!vw?.dbView || vw.showGroupedBySort) {
    return;
  }
  const descending = Ci.nsMsgViewSortOrder.descending;
  if (sortIsOurs(vw)) {
    if (vw._sort[0][1] !== descending) {
      return; // the user flipped it on purpose
    }
  } else {
    state.savedSort.set(win, {
      folderURI: vw.displayedFolder?.URI,
      sort: vw._sort.map(s => [...s]),
    });
  }
  try {
    vw.sort(COLUMN_ID, descending);
    win.threadPane?.restoreSortIndicator?.();
  } catch (e) {
    console.error("trigram-search: relevance sort failed", e);
  }
}

function restoreSort(win) {
  const vw = win.gViewWrapper;
  if (!vw?.dbView || !sortIsOurs(vw) || vw.isSynthetic) {
    state.savedSort.delete(win);
    return;
  }
  const saved = state.savedSort.get(win);
  state.savedSort.delete(win);
  try {
    const s = saved && saved.folderURI === vw.displayedFolder?.URI ? saved.sort[0] : null;
    if (s && s[2] && s[2] !== COLUMN_ID) {
      vw.sort(s[2], s[1]);
    } else {
      vw.sort("dateCol", Ci.nsMsgViewSortOrder.descending);
    }
    win.threadPane?.restoreSortIndicator?.();
  } catch (e) {
    console.error("trigram-search: restoring sort failed", e);
  }
}

function sortListener(win) {
  return {
    onSearchStart() {
      return null;
    },
    onSearchMessage() {},
    onSearchDone(curState) {
      win.setTimeout(() => applyRelevanceSort(win), 0);
      return [curState, false, false];
    },
  };
}

function unwrap(fn) {
  while (fn && fn[ORIGINAL]) {
    fn = fn[ORIGINAL];
  }
  return fn;
}

let saved = null;

function patchQuickFilter() {
  const origAppend = unwrap(MessageTextFilter.appendTerms);
  saved = {
    appendTerms: origAppend,
    bodyDefault: MessageTextFilter._defaultStates.body,
    bodyDefState: MessageTextFilter.textFilterDefs.body?.defaultState,
  };

  function appendTerms(aTermCreator, aTerms, aFilterValue) {
    const native = () => origAppend.call(this, aTermCreator, aTerms, aFilterValue);
    if (!state.config.enabled) {
      return native();
    }
    const win = findAbout3Pane(aTermCreator);
    if (win) {
      wrapQuickFilterBar(win);
    }
    const key = makeKey(aFilterValue);
    if (!key) {
      if (win && sortIsOurs(win.gViewWrapper)) {
        win.setTimeout(() => restoreSort(win), 0);
      }
      return native();
    }
    let res = state.cache.get(key);
    if (res === undefined) {
      request(key);
      res = state.cache.get(key);
    }
    if (res === undefined) {
      // Only reached if updateSearch() was not wrapped yet: keep showing the
      // previous results until the new ones arrive.
      const prev = win && state.lastApplied.get(win);
      pushTerm(aTermCreator, aTerms, prev && state.cache.get(prev) instanceof Map ? prev : key);
      return undefined;
    }
    if (res === NATIVE) {
      return native();
    }
    state.cache.delete(key);
    state.cache.set(key, res);
    pushRankMap(res);
    if (win) {
      state.lastApplied.set(win, key);
    }
    pushTerm(aTermCreator, aTerms, key);
    return state.config.sortByRelevance && win ? sortListener(win) : undefined;
  }
  appendTerms[ORIGINAL] = origAppend;

  MessageTextFilter.appendTerms = appendTerms;
  MessageTextFilter._defaultStates.body = true;
  if (MessageTextFilter.textFilterDefs.body) {
    MessageTextFilter.textFilterDefs.body.defaultState = true;
  }
}

function unpatchQuickFilter() {
  if (!saved) {
    return;
  }
  MessageTextFilter.appendTerms = saved.appendTerms;
  if (saved.bodyDefault) {
    MessageTextFilter._defaultStates.body = true;
  } else {
    delete MessageTextFilter._defaultStates.body;
  }
  if (MessageTextFilter.textFilterDefs.body) {
    MessageTextFilter.textFilterDefs.body.defaultState = saved.bodyDefState;
  }
  saved = null;
}

/**
 * Don't touch the message list until the results for the new text are ready,
 * so it is rebuilt once per query instead of flickering through an
 * intermediate state.
 */
function wrapQuickFilterBar(win) {
  const qfb = win.quickFilterBar;
  if (!qfb || qfb.updateSearch[ORIGINAL]) {
    return;
  }
  const orig = qfb.updateSearch;
  function updateSearch(...args) {
    if (installed && state.config.enabled) {
      const key = currentKey(win);
      if (key && !state.cache.has(key)) {
        request(key);
        if (!state.cache.has(key)) {
          return undefined; // setResult() calls us again when ready
        }
      }
    }
    return orig.apply(this, args);
  }
  updateSearch[ORIGINAL] = orig;
  qfb.updateSearch = updateSearch;

  // Thunderbird persists each folder's sort; never leave a folder sorted by
  // relevance when no trigram filter is active.
  const fixSort = () => {
    if (installed && sortIsOurs(win.gViewWrapper) && !currentKey(win) && !win.gViewWrapper.isSynthetic) {
      restoreSort(win);
    }
  };
  win.addEventListener("folderURIChanged", fixSort);
  win._trigramFixSort = fixSort;
  fixSort();
}

function unwrapQuickFilterBar(win) {
  const qfb = win.quickFilterBar;
  if (qfb?.updateSearch?.[ORIGINAL]) {
    qfb.updateSearch = qfb.updateSearch[ORIGINAL];
  }
  if (win._trigramFixSort) {
    win.removeEventListener("folderURIChanged", win._trigramFixSort);
    delete win._trigramFixSort;
  }
}

// ---------------------------------------------------------------------------
// Global search. Thunderbird opens its full-screen search page (or the list
// view) with a Gloda searcher; we hand it a searcher with the same interface
// whose messages come from the trigram index. This covers the global search
// box, Enter in the Quick Filter, the Quick Filter's "search everywhere" hint
// and the search box on the results page itself.
// ---------------------------------------------------------------------------

/** Headers for the best results (deduplicated by Message-ID). */
async function resultHeaders(results, limit) {
  const top = [];
  const seen = new Set();
  for (const r of results) {
    if (!seen.has(r.msgid)) {
      seen.add(r.msgid);
      top.push(r);
      if (top.length >= limit * 1.2) {
        break;
      }
    }
  }
  const loc = new Map();
  const ids = top.map(r => r.id);
  for (let i = 0; i < ids.length; i += 1000) {
    for (const r of await engine.db.execute(
      `SELECT id, folder, msgkey FROM msgs WHERE id IN (${ids.slice(i, i + 1000).join(",")})`
    )) {
      loc.set(r.id, r);
    }
  }
  const hdrs = [];
  for (const r of top) {
    if (hdrs.length >= limit) {
      break;
    }
    const l = loc.get(r.id);
    try {
      const hdr = l && getFolder(l.folder)?.GetMessageHeader(l.msgkey);
      if (hdr) {
        hdrs.push(hdr);
      }
    } catch (e) {
      // stale row; the next scan cleans it up
    }
  }
  return hdrs;
}

class TrigramMsgSearcher {
  constructor(searchString, hdrs, ranks) {
    this.isTrigram = true;
    this.listener = null;
    this.searchString = searchString;
    this.fulltextTerms = E.parseQuery(searchString).groups.flatMap(alts =>
      alts.map(a => a.tokens.join(" "))
    );
    this.andTerms = true;
    this.hdrs = hdrs;
    this.ranks = ranks;
    this.query = null;
    this.collection = null;
    this.scores = null;
    this.completed = false;
  }
  get retrievalLimit() {
    return this.hdrs.length;
  }
  getCollection(aListenerOverride, aData) {
    if (aListenerOverride) {
      this.listener = aListenerOverride;
    }
    this.scores = null;
    this.completed = false;
    this.collection = Gloda.getMessageCollectionForHeaders(this.hdrs, this, aData);
    this.query = this.collection.query;
    return this.collection;
  }
  onItemsAdded(aItems, aCollection) {
    const scores = aItems.map(item => this.ranks.get(item.headerMessageID) || 0);
    this.scores = this.scores ? this.scores.concat(scores) : scores;
    this.listener?.onItemsAdded(aItems, aCollection);
  }
  onItemsModified(aItems, aCollection) {
    this.listener?.onItemsModified(aItems, aCollection);
  }
  onItemsRemoved(aItems, aCollection) {
    this.listener?.onItemsRemoved(aItems, aCollection);
  }
  onQueryCompleted(aCollection) {
    this.completed = true;
    this.listener?.onQueryCompleted(aCollection);
  }
}

/** Fallback when Gloda indexing is off: a 3-pane tab on a synthetic view. */
class TrigramSyntheticView {
  constructor(hdrs, ranks) {
    this.hdrs = hdrs;
    this.ranks = ranks;
    this.viewType = "trigram";
    this.customColumns = [];
    this.defaultSort = state.config.sortByRelevance
      ? [[Ci.nsMsgViewSortType.byCustom, Ci.nsMsgViewSortOrder.descending, COLUMN_ID]]
      : [[Ci.nsMsgViewSortType.byDate, Ci.nsMsgViewSortOrder.descending, "dateCol"]];
  }
  search(listener, done) {
    pushRankMap(this.ranks);
    listener.onNewSearch();
    for (const h of this.hdrs) {
      try {
        listener.onSearchHit(h, h.folder);
      } catch (e) {
        // header went away
      }
    }
    listener.onSearchDone(Cr.NS_OK);
    done?.();
  }
  abortSearch() {}
  getMsgHdrForMessageID(id) {
    return this.hdrs.find(h => h.messageId == id) || null;
  }
  getPersistedSetting(setting) {
    try {
      return JSON.parse(Services.prefs.getCharPref(`extensions.trigram-search.view.${setting}`));
    } catch (e) {
      return setting === "columns" ? this.DEFAULT_COLUMN_STATES : undefined;
    }
  }
  setPersistedSetting(setting, value) {
    Services.prefs.setCharPref(`extensions.trigram-search.view.${setting}`, JSON.stringify(value));
  }
}
TrigramSyntheticView.prototype.DEFAULT_COLUMN_STATES = {
  threadCol: { visible: true },
  flaggedCol: { visible: true },
  subjectCol: { visible: true },
  correspondentCol: { visible: true },
  dateCol: { visible: true },
  locationCol: { visible: true },
};

function wantsTrigramSearch(mode, args) {
  return (
    installed &&
    engine &&
    status.ready &&
    state.config.redirectGlobalSearch &&
    (mode === "glodaFacet" || mode === "glodaTableList") &&
    args?.searcher &&
    !args.searcher.isTrigram &&
    typeof args.searcher.searchString === "string" &&
    args.searcher.searchString.trim()
  );
}

async function openTrigramSearch(tabmail, openTab, mode, args) {
  const query = args.searcher.searchString.trim();
  try {
    const results = await engine.search(query, searchOpts(ALL_FIELDS));
    const ranks = rankMapOf(results);
    pushRankMap(ranks);
    if (GlodaIndexer.enabled) {
      const limit = Services.prefs.getIntPref("mailnews.database.global.search.msg.limit", 1000);
      const hdrs = await resultHeaders(results, limit);
      openTab.call(tabmail, mode, { ...args, searcher: new TrigramMsgSearcher(query, hdrs, ranks) });
    } else {
      const hdrs = await resultHeaders(results, MAX_GLOBAL_RESULTS);
      openTab.call(tabmail, "mail3PaneTab", {
        folderPaneVisible: false,
        syntheticView: new TrigramSyntheticView(hdrs, ranks),
        title: query,
      });
    }
  } catch (e) {
    console.error("trigram-search: global search failed, using Gloda", e);
    openTab.call(tabmail, mode, args);
  }
}

function wrapTabmail(win) {
  const tabmail = win.document.getElementById("tabmail");
  if (!tabmail || tabmail.openTab[ORIGINAL]) {
    return;
  }
  const orig = tabmail.openTab;
  function openTab(mode, args, ...rest) {
    if (wantsTrigramSearch(mode, args)) {
      openTrigramSearch(this, orig, mode, args);
      return null;
    }
    return orig.call(this, mode, args, ...rest);
  }
  openTab[ORIGINAL] = orig;
  tabmail.openTab = openTab;

  // Wrap Quick Filter bars as 3-pane tabs show up.
  const monitor = {
    monitorName: "trigramSearch",
    onTabTitleChanged() {},
    onTabClosing() {},
    onTabPersist() {},
    onTabRestored() {},
    onTabOpened(tab) {
      monitor.onTabSwitched(tab);
    },
    onTabSwitched(tab) {
      const w = tab?.chromeBrowser?.contentWindow;
      if (w?.quickFilterBar) {
        wrapQuickFilterBar(w);
      }
    },
  };
  tabmail.registerTabMonitor(monitor);
  tabmail._trigramMonitor = monitor;
}

function unwrapTabmail(win) {
  const tabmail = win.document.getElementById("tabmail");
  if (tabmail?.openTab?.[ORIGINAL]) {
    tabmail.openTab = tabmail.openTab[ORIGINAL];
  }
  if (tabmail?._trigramMonitor) {
    tabmail.unregisterTabMonitor(tabmail._trigramMonitor);
    delete tabmail._trigramMonitor;
  }
}

/** Default the results page to date order unless the user picked one. */
function applyFacetSortDefault() {
  const PREF = "gloda.facetview.sortby";
  const OURS = "extensions.trigram-search.facetSortSet";
  if (Services.prefs.prefHasUserValue(PREF) && !Services.prefs.getBoolPref(OURS, false)) {
    return; // the user chose a sort on the results page
  }
  // 3 = date (sticky), 2 = relevance (sticky): the page remembers changes.
  Services.prefs.setIntPref(PREF, state.config.sortByRelevance ? 2 : 3);
  Services.prefs.setBoolPref(OURS, true);
}

function installWindowListener() {
  ExtensionSupport.registerWindowListener(WINDOW_LISTENER_ID, {
    chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
    onLoadWindow(win) {
      wrapTabmail(win);
    },
    onUnloadWindow(win) {
      unwrapTabmail(win);
    },
  });
}

function uninstallWindowListener() {
  ExtensionSupport.unregisterWindowListener(WINDOW_LISTENER_ID);
  for (const win of mail3PaneWindows()) {
    unwrapTabmail(win);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let installed = false;

function install(extension) {
  if (installed) {
    return;
  }
  installed = true;
  stopped = false;

  // Load the engine module from the add-on (fresh URL each time so an
  // updated add-on never gets a stale cached module).
  resHost = `trigram-search-${Date.now().toString(36)}`;
  Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler)
    .setSubstitution(resHost, extension.rootURI);
  E = ChromeUtils.importESModule(`resource://${resHost}/engine/engine.sys.mjs`);

  installTerm();
  installColumn();
  patchQuickFilter();
  installWindowListener();
  for (const w of about3Panes()) {
    wrapQuickFilterBar(w);
  }
  MailServices.mfn.addListener(
    folderListener,
    MailServices.mfn.msgAdded |
      MailServices.mfn.msgsDeleted |
      MailServices.mfn.msgsMoveCopyCompleted |
      MailServices.mfn.msgKeyChanged |
      MailServices.mfn.msgPropertyChanged |
      MailServices.mfn.folderDeleted |
      MailServices.mfn.folderMoveCopyCompleted |
      MailServices.mfn.folderRenamed
  );

  openDatabase()
    .then(async () => {
      status.state = "idle";
      // 3-pane tabs restored at startup exist by now.
      for (const w of about3Panes()) {
        wrapQuickFilterBar(w);
      }
      // The index persists across sessions: use it right away; the scan
      // only reconciles what changed while Thunderbird was closed.
      if ((await engine.stats()).docs > 0) {
        status.ready = true;
        invalidateQuickFilter();
      }
      scheduleScan(3000);
    })
    .catch(e => {
      console.error("trigram-search: cannot open database", e);
      status.error = String(e);
    });
}

function uninstall(isAppShutdown) {
  if (!installed) {
    return;
  }
  installed = false;
  stopped = true;
  clearTimeout(scanTimer);
  clearTimeout(live.timer);
  live.timer = null;
  try {
    MailServices.mfn.removeListener(folderListener);
  } catch (e) {
    // ignore
  }
  const c = conn;
  conn = null;
  engine = null;
  const close = () => c?.close().catch(() => {});
  (scanning || Promise.resolve()).finally(close);

  if (isAppShutdown) {
    return;
  }
  unpatchQuickFilter();
  uninstallWindowListener();
  uninstallTerm();
  for (const w of about3Panes()) {
    unwrapQuickFilterBar(w);
    restoreSort(w);
    if (currentKey(w)) {
      try {
        w.quickFilterBar.updateSearch();
      } catch (e) {
        // ignore
      }
    }
  }
  try {
    ThreadPaneColumns.removeCustomColumn(COLUMN_ID);
  } catch (e) {
    // ignore
  }
  state.cache.clear();
  state.pending.clear();
  state.rankMaps = [];
  try {
    Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler)
      .setSubstitution(resHost, null);
  } catch (e) {
    // ignore
  }
}

this.trigram = class extends ExtensionAPI {
  onStartup() {
    install(this.extension);
  }

  onShutdown(isAppShutdown) {
    uninstall(isAppShutdown);
  }

  getAPI(context) {
    install(context.extension);
    return {
      trigram: {
        async configure(config) {
          const before = JSON.stringify(state.config);
          for (const k of Object.keys(state.config)) {
            if (config[k] !== undefined && config[k] !== null) {
              state.config[k] = config[k];
            }
          }
          applyFacetSortDefault();
          if (JSON.stringify(state.config) === before) {
            return;
          }
          state.cache.clear();
          state.pending.clear();
          for (const w of about3Panes()) {
            if (!state.config.sortByRelevance || !state.config.enabled) {
              restoreSort(w);
            }
            if (currentKey(w)) {
              try {
                w.quickFilterBar.updateSearch();
              } catch (e) {
                // ignore
              }
            }
          }
          if (state.config.indexBodies && engine) {
            // Messages skipped while body indexing was off.
            scheduleScan(1000);
          }
        },

        async getStatus() {
          const s = engine ? await engine.stats() : { docs: 0, bodies: 0, pending: 0, notOffline: 0, words: 0 };
          return { ...status, ...s };
        },

        async rescan() {
          scheduleScan(0);
        },

        async reindex() {
          if (!engine) {
            return;
          }
          await scanning;
          await engine.clear();
          status.ready = false;
          state.cache.clear();
          scheduleScan(0);
        },

        async search(query, fields) {
          if (!engine) {
            return [];
          }
          return (await engine.search(query, searchOpts(fields || ALL_FIELDS))).map(r => ({
            msgid: r.msgid,
            tier: r.tier,
            rank: r.rank,
          }));
        },

        async enableAllQuickFilterFields() {
          const all = {};
          for (const name of Object.keys(MessageTextFilter.textFilterDefs)) {
            all[name] = true;
          }
          XULStoreUtils.setValue("messenger", "quickFilter", "textFilters", JSON.stringify(all));
          for (const w of about3Panes()) {
            const tv = w.quickFilterBar._filterer?.filterValues?.text;
            if (tv?.states) {
              Object.assign(tv.states, all);
              try {
                w.quickFilterBar.reflectFiltererState();
              } catch (e) {
                // ignore
              }
            }
          }
        },
      },
    };
  }
};

// Unused-import guard for linters.
void ExtensionCommon;
