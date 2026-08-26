/**
 * Discord のチャンネルからメッセージを取得して log.txt を書き出す。
 * GitHub Actions から15分ごとに実行される想定。
 *
 * 必要な環境変数:
 *   DISCORD_BOT_TOKEN  … Bot のトークン（GitHub Secrets に入れる。絶対にコミットしない）
 *
 * 設定ファイル: sync.config.json
 *
 * 既定では「日付 と 役職」だけを書き出し、本文は書き出さない。
 * 公開リポジトリに個人名や設計内容が出ないようにするため。
 * 本文が必要な場合は sync.config.json の includeBody を true にすること
 *   （その場合はリポジトリを private にすること）。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://discord.com/api/v10";
const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CONFIG_PATH = "sync.config.json";
const OUT = "log.txt";

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`${CONFIG_PATH} がありません。sync.config.example.json をコピーして作ってください。`);
    process.exit(0);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
}

/** Discord のユーザーを役職名に置き換える。未登録なら汎用ラベル。 */
function toRole(msg, roles, fallback) {
  const id = msg.author?.id;
  if (id && roles[id]) return roles[id];
  return fallback;
}

/** 1チャンネル分のメッセージを新しい順に取得 */
async function fetchMessages(channelId, limit) {
  const res = await fetch(`${API}/channels/${channelId}/messages?limit=${limit}`, {
    headers: { Authorization: `Bot ${TOKEN}` }
  });
  if (res.status === 401) throw new Error("トークンが無効です（401）");
  if (res.status === 403) throw new Error(`チャンネル ${channelId} を読む権限がありません（403）`);
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || 5);
    console.log(`レート制限。${retry}秒待機します`);
    await new Promise(r => setTimeout(r, retry * 1000));
    return fetchMessages(channelId, limit);
  }
  if (!res.ok) throw new Error(`取得に失敗しました（${res.status}）`);
  return res.json();
}

function ymd(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

/** 本文を1行に潰し、長すぎる場合は切る */
function flatten(text, max) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/<@!?\d+>/g, "@メンバー")   // メンション除去
    .replace(/https?:\/\/\S+/g, "[URL]") // URL除去
    .trim()
    .slice(0, max);
}

async function main() {
  const cfg = loadConfig();
  const roles = cfg.roles || {};
  const fallback = cfg.fallbackRole || "メンバー";
  const includeBody = cfg.includeBody === true;
  const limit = Math.min(Math.max(cfg.perChannelLimit || 30, 1), 100);

  if (!TOKEN) {
    console.log("DISCORD_BOT_TOKEN が未設定です。log.txt はそのままにします。");
    console.log("→ Botの用意ができるまでは手動編集で運用してください。");
    process.exit(0);
  }

  const rows = [];
  for (const ch of cfg.channels || []) {
    const id = typeof ch === "string" ? ch : ch.id;
    const label = (typeof ch === "object" && ch.label) || "";
    try {
      const msgs = await fetchMessages(id, limit);
      for (const m of msgs) {
        if (m.author?.bot) continue;              // Botの発言は無視
        const body = flatten(m.content, cfg.bodyMaxChars || 160);
        if (!includeBody && !body && !m.attachments?.length) continue;
        rows.push({
          ts: m.timestamp,
          date: ymd(m.timestamp),
          role: toRole(m, roles, fallback),
          label,
          body
        });
      }
      console.log(`${id}${label ? `（${label}）` : ""}: ${msgs.length}件`);
    } catch (e) {
      console.error(`${id}: ${e.message}`);
    }
  }

  if (!rows.length) {
    console.log("取得できたメッセージがありません。log.txt は更新しません。");
    process.exit(0);
  }

  rows.sort((a, b) => new Date(a.ts) - new Date(b.ts));

  const head = [
    "# このファイルは GitHub Actions が自動生成しています。手で編集しても次回の同期で上書きされます。",
    `# 最終同期: ${new Date().toISOString()}`,
    includeBody
      ? "# 本文つき。個人名・URL・メンションは除去済み。"
      : "# 本文は書き出していません（公開リポジトリのため）。板は「日付 役職」の行だけを読みます。",
    ""
  ];

  const body = rows.map(r => {
    const line = `${r.date} ${r.role}${r.label ? ` [${r.label}]` : ""}`;
    return includeBody && r.body ? `${line}\n${r.body}\n` : line;
  });

  writeFileSync(OUT, head.concat(body).join("\n") + "\n", "utf8");
  console.log(`log.txt を更新しました（${rows.length}件）`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
