import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(config.databasePath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
}

function runMigrations(db: Database.Database): void {
  const sql = readFileSync(join(MIGRATIONS_DIR, "001-initial.sql"), "utf-8");
  db.exec(sql);

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY);
  `);
  const applied = db.prepare("SELECT name FROM _migrations WHERE name = ?");
  const insert = db.prepare("INSERT INTO _migrations (name) VALUES (?)");

  if (!applied.get("002-review-support")) {
    try {
      const m002 = readFileSync(
        join(MIGRATIONS_DIR, "002-review-support.sql"),
        "utf-8",
      );
      db.exec(m002);
    } catch (err) {
      if (!String(err).includes("duplicate column")) throw err;
    }
    insert.run("002-review-support");
  }

  if (!applied.get("003-indexes")) {
    const m003 = readFileSync(
      join(MIGRATIONS_DIR, "003-indexes.sql"),
      "utf-8",
    );
    db.exec(m003);
    insert.run("003-indexes");
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
