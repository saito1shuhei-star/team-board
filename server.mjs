/**
 * Discord に常時接続して、投稿された瞬間に板へ push するサーバー。
 *
 *   node server.mjs
 *
 * 1プロセスで次の3つをやる:
 *   1. Discord Gateway に接続して新着メッセージを受信
 *   2. 起動時に各チャンネルの直近を取り込む（バックフィル）
 *   3. 板（index.html）と API を配信する
 *
 * 環境変数:
 *   DISCORD_BOT_TOKEN … Bot のトークン（.env か環境変数で渡す。コミットしないこと）
 *   PORT              … 待ち受けポート（既定 8787）
 *
 * 設定: sync.config.json（channels / rolesByName / roles）
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CONFIG_PATH = "sync.config.json";

/* ---------------- 設定 ---------------- */

if (!existsSync(CONFIG_PATH)) {
  console.error(`${CONFIG_PATH} がありません。sync.config.example.json をコピーして作ってください。`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const channels = new Map(
  (cfg.channels || []).map(c => [typeof c === "string" ? c : c.id, (typeof c === "object" && c.label) || ""])
);
const roles = cfg.roles || {};
const fallbackRole = cfg.fallbackRole || "メンバー";
const includeBody = cfg.includeBody !== false;   // サーバー運用では既定で本文あり
const backfill = Math.min(Math.max(cfg.perChannelLimit || 30, 1), 100);
const bodyMax = cfg.bodyMaxChars || 300;

const byName = (() => {
  const idx = {};
  for (const k of Object.keys(cfg.rolesByName || {})) {
    const v = cfg.rolesByName[k];
    idx[k.trim()] = v;
    idx[k.replace(/[\s　]/g, "")] = v;
  }
  return idx;
})();

function toRole(author, member) {
  if (author?.id && roles[author.id]) return roles[author.id];
  for (const key of [author?.username, author?.globalName, member?.nickname]) {
    if (!key) continue;
    const raw = String(key).trim();
    const variants = [
      raw,
      raw.replace(/[[(（【].*$/, "").trim(),
      raw.replace(/[\s　]/g, ""),
      raw.replace(/[[(（【].*$/, "").replace(/[\s　]/g, "")
    ];
    for (const v of variants) if (v && byName[v]) return byName[v];
  }
  return fallbackRole;
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/<@!?\d+>/g, "@メンバー")
    .replace(/https?:\/\/\S+/g, "[URL]")
    .trim()
    .slice(0, bodyMax);
}

/* ---------------- 状態 ---------------- */

const state = {
  seen: {},          // 役職 → 最終発言日 YYYY-MM-DD
  messages: [],      // 新しい順に最大500件
  connected: false,
  lastEventAt: null
};

function ymd(d) {
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function record(msg) {
  if (msg.author?.bot) return false;
  if (!channels.has(msg.channelId)) return false;

  const role = toRole(msg.author, msg.member);
  const date = ymd(msg.createdTimestamp);
  let changed = false;

  if (!state.seen[role] || date > state.seen[role]) {
    state.seen[role] = date;
    changed = true;
  }

  state.messages.unshift({
    id: msg.id,
    date,
    ts: msg.createdTimestamp,
    role,
    label: channels.get(msg.channelId) || "",
    body: includeBody ? clean(msg.content) : ""
  });
  if (state.messages.length > 500) state.messages.length = 500;

  state.lastEventAt = new Date().toISOString();
  return changed;
}

/* ---------------- SSE ---------------- */

const clients = new Set();

function broadcast() {
  const payload = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

function snapshot() {
  return {
    seen: state.seen,
    connected: state.connected,
    lastEventAt: state.lastEventAt,
    latest: state.messages.slice(0, 40)
  };
}

/* ---------------- HTTP ---------------- */

const MIME = { ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8" };

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/api/state") {
    res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
    res.end(JSON.stringify(snapshot()));
    return;
  }

  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive"
    });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  // 静的配信
  const name = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const file = join(process.cwd(), name);
  if (!file.startsWith(process.cwd()) || !existsSync(file)) {
    res.writeHead(404, { "content-type": MIME[".txt"] });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
});

/* ---------------- Discord ---------------- */

async function start() {
  if (!TOKEN) {
    console.error("DISCORD_BOT_TOKEN が未設定です。");
    console.error("  PowerShell: $env:DISCORD_BOT_TOKEN=\"...\"; node server.mjs");
    console.error("  bash      : DISCORD_BOT_TOKEN=... node server.mjs");
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    partials: [Partials.Message, Partials.Channel]
  });

  client.on("messageCreate", msg => {
    if (record(msg)) {
      console.log(`[new] ${ymd(msg.createdTimestamp)} ${toRole(msg.author, msg.member)}`);
    }
    broadcast();
  });

  client.once("clientReady", async c => {
    state.connected = true;
    console.log(`Discord に接続しました（${c.user.tag}）`);
    console.log(`監視チャンネル: ${channels.size}件`);

    for (const [id, label] of channels) {
      try {
        const ch = await c.channels.fetch(id);
        const msgs = await ch.messages.fetch({ limit: backfill });
        let n = 0;
        for (const m of [...msgs.values()].reverse()) if (record(m)) n++;
        console.log(`  ${label || id}: ${msgs.size}件 取り込み`);
      } catch (e) {
        console.error(`  ${label || id}: 読めません（${e.message}）`);
      }
    }
    broadcast();
    console.log(`\n板: http://localhost:${PORT}/`);
  });

  client.on("error", e => console.error("Discord エラー:", e.message));
  client.on("shardDisconnect", () => { state.connected = false; broadcast(); });
  client.on("shardResume", () => { state.connected = true; broadcast(); });

  await client.login(TOKEN);
}

server.listen(PORT, () => {
  console.log(`HTTP 起動: http://localhost:${PORT}/`);
  if (includeBody) {
    console.log("※ 本文つきで配信します。この URL を外部に公開しないでください。");
  }
  start().catch(e => { console.error(e); process.exit(1); });
});
