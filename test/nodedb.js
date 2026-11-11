// node:sqlite adapter matching the engine's db interface.
import { DatabaseSync } from "node:sqlite";

export function openDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  const cache = new Map();
  const stmt = sql => {
    let s = cache.get(sql);
    if (!s) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  const isRead = sql => /^\s*(SELECT|WITH)/i.test(sql);
  return {
    raw: db,
    async execute(sql, params) {
      const s = stmt(sql);
      if (isRead(sql)) return params ? s.all(params) : s.all();
      params ? s.run(params) : s.run();
      return [];
    },
    async executeMany(sql, list) {
      const s = stmt(sql);
      for (const p of list) s.run(p);
    },
    async transaction(fn) {
      db.exec("BEGIN");
      try { await fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}
