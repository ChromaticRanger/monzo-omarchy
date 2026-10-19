// monzo-omarchy: a small Monzo Developer API client for the Omarchy bar plugin.
// No dependencies; run with Node's built-in TypeScript type stripping.
//
//   monzo-omarchy login [--reconfigure]   OAuth login (+ approve in the Monzo app)
//   monzo-omarchy refresh                 fetch data, write snapshot.json
//   monzo-omarchy status                  print the current snapshot
//   monzo-omarchy debug                   dump raw /accounts and balances (for checking Flex)
//   monzo-omarchy logout                  revoke the token and forget it
//
// Exit codes: 0 ok, 2 needs login, 1 any other error.

import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const API = "https://api.monzo.com";
const AUTH = "https://auth.monzo.com/";
const DEFAULT_REDIRECT = "http://localhost:47821/callback";
const DAYS = 7;

const home = homedir();
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(home, ".config"), "monzo-omarchy");
const STATE_DIR = join(process.env.XDG_STATE_HOME || join(home, ".local", "state"), "monzo-omarchy");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TOKENS_FILE = join(STATE_DIR, "tokens.json");
const SNAPSHOT_FILE = join(STATE_DIR, "snapshot.json");
const LOCK_FILE = join(STATE_DIR, "refresh.lock");

type Config = { clientId: string; clientSecret: string; redirectUri: string };
type Tokens = { accessToken: string; refreshToken: string; expiresAt: number; userId: string };

type Account = {
  kind: "personal" | "flex";
  label: string;
  id: string;
  available: boolean;      // false when the API can't give a meaningful balance
  balance: number | null;  // minor units
  totalBalance: number | null;
  spendToday: number | null;
  currency: string;
  note: string;
};
type Pot = { id: string; name: string; balance: number; currency: string; goal: number | null; locked: boolean };
type Tx = {
  id: string; account: "personal" | "flex"; created: string; amount: number; currency: string;
  name: string; category: string; emoji: string; pending: boolean; declined: boolean; notes: string;
};
type Snapshot = {
  version: 1;
  status: "ok" | "needs_login" | "error";
  error: string;
  updatedAt: string;   // last successful refresh
  attemptedAt: string; // last attempt of any kind
  sinceDays: number;
  accounts: Account[];
  pots: Pot[];
  transactions: Tx[];
};

class NeedsLogin extends Error {}
class ApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string) {
    super(`${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.status = status;
    this.body = body;
  }
}

const CATEGORY_EMOJI: Record<string, string> = {
  eating_out: "🍽️", groceries: "🛒", transport: "🚆", cash: "💵", bills: "🧾",
  entertainment: "🎬", shopping: "🛍️", holidays: "✈️", personal_care: "💅", family: "👪",
  charity: "🎗️", finances: "💰", gifts: "🎁", transfers: "🔁", savings: "🐷",
  income: "💷", expenses: "💼", general: "💳",
};

// ---------- files ----------

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return null; }
}

function writeJsonSecure(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

function emptySnapshot(): Snapshot {
  return { version: 1, status: "needs_login", error: "", updatedAt: "", attemptedAt: "", sinceDays: DAYS, accounts: [], pots: [], transactions: [] };
}

function writeStatus(status: Snapshot["status"], error: string): void {
  const prev = readJson<Snapshot>(SNAPSHOT_FILE) || emptySnapshot();
  writeJsonSecure(SNAPSHOT_FILE, { ...prev, status, error, attemptedAt: new Date().toISOString() });
}

// ---------- terminal prompts ----------

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) (rl as any)._writeToOutput = () => {};
    rl.once("line", (line: string) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(line);
    });
  });
}

// ---------- auth ----------

function loadConfig(): Config {
  const cfg = readJson<Config>(CONFIG_FILE);
  if (!cfg || !cfg.clientId || !cfg.clientSecret) throw new NeedsLogin("not configured: run `monzo-omarchy login`");
  return cfg;
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${API}/oauth2/token`, { method: "POST", body: new URLSearchParams(params) });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) throw new NeedsLogin(`token request rejected (${res.status}): ${text.slice(0, 200)}`);
    throw new ApiError(res.status, text, "/oauth2/token");
  }
  const j = JSON.parse(text);
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || "",
    expiresAt: Date.now() + Number(j.expires_in || 0) * 1000,
    userId: j.user_id || "",
  };
}

async function refreshTokens(cfg: Config, tokens: Tokens): Promise<Tokens> {
  if (!tokens.refreshToken) throw new NeedsLogin("access token expired and no refresh token: run `monzo-omarchy login`");
  const next = await tokenRequest({
    grant_type: "refresh_token",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: tokens.refreshToken,
  });
  // Refresh tokens are single-use: persist the new pair immediately.
  writeJsonSecure(TOKENS_FILE, next);
  return next;
}

async function validTokens(cfg: Config): Promise<Tokens> {
  const tokens = readJson<Tokens>(TOKENS_FILE);
  if (!tokens || !tokens.accessToken) throw new NeedsLogin("not logged in: run `monzo-omarchy login`");
  if (tokens.expiresAt - 120_000 > Date.now()) return tokens;
  return refreshTokens(cfg, tokens);
}

// ---------- API ----------

type Query = Array<[string, string]>;

async function rawGet(path: string, query: Query, accessToken: string): Promise<Response> {
  const qs = new URLSearchParams();
  for (const [k, v] of query) qs.append(k, v);
  const url = `${API}${path}${query.length ? "?" + qs.toString() : ""}`;
  return fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
}

function makeApi(cfg: Config, initial: Tokens) {
  let tokens = initial;
  let refreshed = false;
  return async function get(path: string, query: Query = []): Promise<any> {
    let res = await rawGet(path, query, tokens.accessToken);
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      tokens = await refreshTokens(cfg, tokens);
      res = await rawGet(path, query, tokens.accessToken);
    }
    const text = await res.text();
    if (res.status === 401) throw new NeedsLogin(`unauthorised on ${path}: run \`monzo-omarchy login\``);
    if (!res.ok) throw new ApiError(res.status, text, path);
    return JSON.parse(text);
  };
}

// ---------- refresh ----------

function acquireLock(): boolean {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(LOCK_FILE, "wx", 0o600));
      return true;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      // A crashed refresh must not wedge us forever.
      try { if (Date.now() - statSync(LOCK_FILE).mtimeMs > 60_000) rmSync(LOCK_FILE, { force: true }); else return false; } catch { /* raced */ }
    }
  }
  return false;
}

async function listTransactions(get: (p: string, q?: Query) => Promise<any>, accountId: string, sinceIso: string): Promise<any[]> {
  const out: any[] = [];
  let since = sinceIso;
  for (let page = 0; page < 20; page++) {
    const r = await get("/transactions", [["account_id", accountId], ["since", since], ["limit", "100"], ["expand[]", "merchant"]]);
    const batch: any[] = r.transactions || [];
    out.push(...batch);
    if (batch.length < 100) break;
    since = batch[batch.length - 1].id;
  }
  return out;
}

function normaliseTx(t: any, account: Tx["account"], potNames: Record<string, string>): Tx {
  const merchant = t.merchant && typeof t.merchant === "object" ? t.merchant : null;
  let name: string = (merchant && merchant.name) || (t.counterparty && t.counterparty.name) || t.description || "";
  const potId: string = (t.metadata && t.metadata.pot_id) || (String(t.description || "").startsWith("pot_") ? t.description : "");
  if (potId) name = `${t.amount < 0 ? "To" : "From"} ${potNames[potId] || "pot"}`;
  return {
    id: t.id,
    account,
    created: t.created,
    amount: Number(t.amount) || 0,
    currency: t.currency || "GBP",
    name: name.trim(),
    category: t.category || "general",
    emoji: (merchant && merchant.emoji) || CATEGORY_EMOJI[t.category] || "💳",
    pending: !t.settled,
    declined: !!t.decline_reason,
    notes: t.notes || "",
  };
}

async function refresh(): Promise<Snapshot> {
  const cfg = loadConfig();
  const get = makeApi(cfg, await validTokens(cfg));

  const all: any[] = ((await get("/accounts")).accounts || []).filter((a: any) => !a.closed);
  const personalRaw = all.find((a) => a.type === "uk_retail");
  const flexRaw = all.find((a) => a.type === "uk_monzo_flex");

  const accounts: Account[] = [];
  if (personalRaw) {
    const b = await get("/balance", [["account_id", personalRaw.id]]);
    accounts.push({
      kind: "personal", label: "Personal", id: personalRaw.id, available: true,
      balance: b.balance, totalBalance: b.total_balance, spendToday: b.spend_today, currency: b.currency || "GBP", note: "",
    });
  }
  if (flexRaw) {
    let b: any = null;
    let note = "";
    try { b = await get("/balance", [["account_id", flexRaw.id]]); } catch (e: any) { note = e instanceof ApiError ? `HTTP ${e.status}` : String(e.message || e); }
    // Flex reports the amount owed as a negative balance (verified Oct 2026).
    const real = !!b && typeof b.balance === "number";
    accounts.push({
      kind: "flex", label: "Flex", id: flexRaw.id, available: real,
      balance: real ? b.balance : null, totalBalance: null, spendToday: null,
      currency: (b && b.currency) || "GBP", note: real ? "" : (note || "Not available via API"),
    });
  }

  let pots: Pot[] = [];
  const potNames: Record<string, string> = {};
  if (personalRaw) {
    const r = await get("/pots", [["current_account_id", personalRaw.id]]);
    pots = (r.pots || []).filter((p: any) => !p.deleted).map((p: any) => {
      potNames[p.id] = p.name;
      return { id: p.id, name: p.name, balance: p.balance, currency: p.currency || "GBP", goal: p.goal_amount ?? null, locked: !!p.locked };
    });
  }

  const sinceIso = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const transactions: Tx[] = [];
  for (const [raw, kind] of [[personalRaw, "personal"], [flexRaw, "flex"]] as Array<[any, Tx["account"]]>) {
    if (!raw) continue;
    let list: any[] = [];
    try { list = await listTransactions(get, raw.id, sinceIso); } catch (e) {
      if (kind === "personal") throw e; // Flex transactions are best-effort
    }
    for (const t of list) {
      if (Number(t.amount) === 0 && !t.decline_reason) continue; // card checks etc.
      transactions.push(normaliseTx(t, kind, potNames));
    }
  }
  transactions.sort((a, b) => b.created.localeCompare(a.created));

  const now = new Date().toISOString();
  const snap: Snapshot = { version: 1, status: "ok", error: "", updatedAt: now, attemptedAt: now, sinceDays: DAYS, accounts, pots, transactions };
  writeJsonSecure(SNAPSHOT_FILE, snap);
  return snap;
}

// ---------- login ----------

function waitForCode(redirect: URL, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    const finish = (err: Error | null, code?: string) => {
      clearTimeout(timer);
      for (const s of servers) s.close();
      err ? reject(err) : resolve(code!);
    };
    const timer = setTimeout(() => finish(new Error("timed out waiting for the browser redirect")), 5 * 60_000);
    const handler = (req: any, res: any) => {
      const url = new URL(req.url || "/", redirect.origin);
      if (url.pathname !== redirect.pathname) { res.writeHead(404).end(); return; }
      const page = (msg: string) => `<!doctype html><meta charset="utf-8"><title>Monzo</title><body style="font-family:sans-serif;padding:3em"><h2>${msg}</h2></body>`;
      if (url.searchParams.get("state") !== state) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("State mismatch. Login aborted."));
        finish(new Error("OAuth state mismatch"));
        return;
      }
      const code = url.searchParams.get("code");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(page("No authorisation code received."));
        finish(new Error("no code in redirect"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(page("Done. Now approve access in the Monzo app, then close this tab."));
      finish(null, code);
    };
    const port = Number(redirect.port || 80);
    // "localhost" may resolve to IPv4 or IPv6 in the browser; listen on both loopbacks only.
    let listening = 0;
    for (const host of ["127.0.0.1", "::1"]) {
      const s = createServer(handler);
      s.on("error", () => { /* e.g. no IPv6 loopback */ });
      s.listen(port, host, () => { listening++; });
      servers.push(s);
    }
    setTimeout(() => { if (listening === 0) finish(new Error(`could not listen on port ${port}`)); }, 1500);
  });
}

async function login(args: string[]): Promise<void> {
  let cfg = readJson<Config>(CONFIG_FILE);
  if (!cfg || args.includes("--reconfigure")) {
    console.log("Enter the details of your OAuth client from developers.monzo.com.");
    const clientId = (await ask("Client ID: ")).trim();
    const clientSecret = (await ask("Client secret (input hidden): ", true)).trim();
    const redirectUri = (await ask(`Redirect URL [${DEFAULT_REDIRECT}]: `)).trim() || DEFAULT_REDIRECT;
    if (!clientId || !clientSecret) throw new Error("client ID and secret are required");
    cfg = { clientId, clientSecret, redirectUri };
    writeJsonSecure(CONFIG_FILE, cfg);
    console.log(`Saved ${CONFIG_FILE} (mode 600).`);
  }

  const redirect = new URL(cfg.redirectUri);
  const state = randomBytes(16).toString("hex");
  const authUrl = `${AUTH}?` + new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", state }).toString();
  const codePromise = waitForCode(redirect, state);
  console.log("\nOpening your browser to log in to Monzo. If it doesn't open, visit:\n" + authUrl + "\n");
  try {
    const opener = spawn("xdg-open", [authUrl], { detached: true, stdio: "ignore" });
    opener.on("error", () => { /* no xdg-open: URL printed above */ });
    opener.unref();
  } catch { /* URL printed above */ }

  const code = await codePromise;
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    code,
  });
  writeJsonSecure(TOKENS_FILE, tokens);
  if (!tokens.refreshToken) console.warn("Warning: no refresh token issued. Is the client set to Confidential?");

  console.log("Logged in. Now approve access in the Monzo app (check for a push notification)...");
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    const res = await rawGet("/accounts", [], tokens.accessToken);
    if (res.ok) break;
    if (res.status !== 403) throw new ApiError(res.status, await res.text(), "/accounts");
    if (Date.now() > deadline) throw new Error("timed out waiting for approval in the Monzo app");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("Approved. Fetching data...");
  printStatus(await refresh());
}

async function logout(): Promise<void> {
  const tokens = readJson<Tokens>(TOKENS_FILE);
  if (tokens && tokens.accessToken) {
    try { await fetch(`${API}/oauth2/logout`, { method: "POST", headers: { Authorization: `Bearer ${tokens.accessToken}` } }); } catch { /* best effort */ }
  }
  rmSync(TOKENS_FILE, { force: true });
  writeStatus("needs_login", "logged out");
  console.log("Logged out.");
}

// ---------- output ----------

function money(minor: number | null, currency = "GBP"): string {
  if (minor === null || minor === undefined) return "n/a";
  return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(minor / 100);
}

function printStatus(s: Snapshot | null): void {
  if (!s) { console.log("No snapshot yet. Run `monzo-omarchy login`."); return; }
  console.log(`Status: ${s.status}${s.error ? ` (${s.error})` : ""}  updated: ${s.updatedAt || "never"}`);
  for (const a of s.accounts) console.log(`  ${a.label.padEnd(10)} ${a.available ? money(a.balance, a.currency) : a.note}`);
  for (const p of s.pots) console.log(`    pot ${p.name.padEnd(20)} ${money(p.balance, p.currency)}`);
  console.log(`  ${s.transactions.length} transactions in the last ${s.sinceDays} days`);
  for (const t of s.transactions.slice(0, 5))
    console.log(`    ${t.created.slice(0, 16).replace("T", " ")}  ${t.emoji} ${t.name.padEnd(24).slice(0, 24)} ${money(t.amount, t.currency).padStart(10)}${t.account === "flex" ? "  [Flex]" : ""}${t.pending ? "  (pending)" : ""}`);
}

async function debug(): Promise<void> {
  const cfg = loadConfig();
  const get = makeApi(cfg, await validTokens(cfg));
  const accounts = (await get("/accounts")).accounts || [];
  for (const a of accounts) {
    let bal: unknown;
    try { bal = await get("/balance", [["account_id", a.id]]); } catch (e: any) { bal = String(e.message || e); }
    let txCount: unknown;
    try { txCount = (await get("/transactions", [["account_id", a.id], ["since", new Date(Date.now() - DAYS * 86_400_000).toISOString()]])).transactions.length; } catch (e: any) { txCount = String(e.message || e); }
    console.log(JSON.stringify({ type: a.type, closed: a.closed, description: a.description, balance: bal, transactions7d: txCount }, null, 2));
  }
}

// ---------- main ----------

async function main(): Promise<number> {
  const [cmd = "status", ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "login": await login(args); return 0;
      case "logout": await logout(); return 0;
      case "status": printStatus(readJson<Snapshot>(SNAPSHOT_FILE)); return 0;
      case "debug": await debug(); return 0;
      case "refresh": {
        if (!acquireLock()) { console.error("refresh already running"); return 0; }
        try { await refresh(); } finally { rmSync(LOCK_FILE, { force: true }); }
        return 0;
      }
      default:
        console.error("usage: monzo-omarchy login [--reconfigure] | refresh | status | debug | logout");
        return 1;
    }
  } catch (e: any) {
    const msg = String(e && e.message ? e.message : e);
    if (e instanceof NeedsLogin) {
      if (cmd === "refresh") writeStatus("needs_login", msg);
      console.error(msg);
      return 2;
    }
    if (cmd === "refresh") writeStatus("error", msg);
    console.error(`error: ${msg}`);
    return 1;
  }
}

main().then((code) => process.exit(code));
