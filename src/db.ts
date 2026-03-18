import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    _db = new Database(config.databasePath);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
}

const NUMBERED_MIGRATIONS = [
  "002-review-support",
  "003-indexes",
  "004-workspace-config",
  "005-parent-project",
  "006-run-labels",
];

function runMigrations(db: Database.Database): void {
  db.exec(readFileSync(join(MIGRATIONS_DIR, "001-initial.sql"), "utf-8"));

  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)");
  const applied = db.prepare("SELECT name FROM _migrations WHERE name = ?");
  const insert = db.prepare("INSERT INTO _migrations (name) VALUES (?)");

  for (const name of NUMBERED_MIGRATIONS) {
    if (applied.get(name)) continue;
    try {
      db.exec(readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf-8"));
    } catch (err) {
      if (!String(err).includes("duplicate column")) throw err;
    }
    insert.run(name);
  }
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = undefined;
  }
}
