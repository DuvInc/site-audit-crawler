// A crawl database handle (see schema.mjs) over a Cloudflare Durable Object's SQLite storage, so every
// step of the audit runs inside a Durable Object as it does on a laptop.
//   const db = durableObjectDb(this.ctx.storage);
//   db.exec(SCHEMA); await initCrawl(db, { start, fetch });
// Differences it hides: no BEGIN/COMMIT (transactionSync instead), parameters must not be undefined
// or booleans, and statements are not prepared ahead (the storage caches them itself).
const bind = (params) => params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v));

/** @param {{ sql: { exec: Function }, transactionSync: Function }} storage  a DurableObjectStorage */
export function durableObjectDb(storage) {
  const sql = storage.sql;
  return {
    exec(query) {
      sql.exec(query);
    },
    prepare(query) {
      return {
        all: (...p) => sql.exec(query, ...bind(p)).toArray(),
        get: (...p) => sql.exec(query, ...bind(p)).toArray()[0],
        iterate: (...p) => sql.exec(query, ...bind(p)),
        run: (...p) => {
          const cursor = sql.exec(query, ...bind(p));
          cursor.toArray();
          return { changes: cursor.rowsWritten };
        },
      };
    },
    transaction(fn) {
      return storage.transactionSync(fn);
    },
    close() {},
  };
}
