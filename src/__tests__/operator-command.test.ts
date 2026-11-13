/**
 * --provision, --setup, --configure and --pick-model refuse while an agent
 * holds the state database (the agent could otherwise run them through exec
 * and rewrite its own keys or mode), and the interactive ones refuse
 * without a terminal.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operatorCommandRefusal } from "../setup/operator-command.js";

const REPO = path.resolve(__dirname, "../..");

describe("operatorCommandRefusal", () => {
  let dir: string;
  let dbPath: string;
  let holder: ChildProcess | undefined;

  beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "operator-command-")));
    dbPath = path.join(dir, "state.db");
  });

  afterAll(() => {
    holder?.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an interactive command without a terminal", () => {
    expect(operatorCommandRefusal("--configure", { interactive: true, isTTY: false, dbPath })).toMatch(/needs a terminal/);
  });

  it("allows a command when no agent holds the database", () => {
    expect(operatorCommandRefusal("--configure", { interactive: true, isTTY: true, dbPath })).toBeNull();
    expect(operatorCommandRefusal("--provision", { interactive: false, isTTY: false, dbPath })).toBeNull();
  });

  it("refuses every operator command while another process holds the instance lock", { timeout: 20_000 }, async () => {
    // The same exclusive SQLite lock acquireInstanceLock takes.
    const script = `
      const Database = require("better-sqlite3");
      const db = new Database(process.argv[1], { timeout: 0 });
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE");
      db.exec("CREATE TABLE IF NOT EXISTS t (x)");
      process.stdout.write("locked\\n");
      setInterval(() => {}, 1000);
    `;
    holder = spawn(process.execPath, ["-e", script, `${dbPath}.lock`], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      let err = "";
      holder!.stderr!.on("data", (d) => (err += String(d)));
      holder!.stdout!.on("data", (d) => String(d).includes("locked") && resolve());
      holder!.once("exit", () => reject(new Error(`lock holder exited: ${err}`)));
    });
    for (const command of ["--provision", "--setup", "--configure", "--pick-model"]) {
      const refusal = operatorCommandRefusal(command, { interactive: command !== "--provision", isTTY: true, dbPath });
      expect(refusal, command).toMatch(/is running on .*Stop it before/);
    }
  });
});
