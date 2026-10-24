const out = { node: process.version };
try {
  const { DatabaseSync } = require("node:sqlite");
  out.hasNodeSqlite = true;
  const db = new DatabaseSync(":memory:");
  out.sqliteVersion = db.prepare("select sqlite_version() v").get().v;
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='unicode61')");
    db.prepare("INSERT INTO t(body) VALUES (?)").run("知枢知识中心 FTS5 全文检索知识库");
    const rows = db.prepare("SELECT body FROM t WHERE t MATCH ?").all("知识库");
    out.fts5 = true; out.fts5Match = rows.length;
  } catch (e) { out.fts5 = false; out.fts5Error = String(e.message).slice(0,200); }
  try { db.exec("CREATE VIRTUAL TABLE t2 USING fts5(body, tokenize='trigram')"); out.trigram = true; }
  catch (e) { out.trigram = false; out.trigramError = String(e.message).slice(0,120); }
} catch (e) { out.hasNodeSqlite = false; out.err = String(e.message).slice(0,200); }
console.log(JSON.stringify(out, null, 1));
