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

/**
 * Discord のユーザーを役職名に置き換える。未登録なら汎用ラベル。
 * 引ける順: ユーザーID → username → global_name → サーバー内表示名(nick)
 * ユーザーIDを集めるのが面倒なので、表示名でも引けるようにしてある。
 */
function toRole(msg, roles, byName, fallback) {
  const a = msg.author || {};
  if (a.id && roles[a.id]) return roles[a.id];
  for (const key of [a.username, a.global_name, msg.member && msg.member.nick]) {
    if (!key) continue;
    // 「亀井 達朗 [おさかな]」のような装飾を落として照合する
    const variants = [];
    const raw = String(key).trim();
    variants.push(raw);
    variants.push(raw.replace(/[[(（【].*$/, "").trim());   // 括弧以降を落とす
    variants.push(raw.replace(/[\s　]/g, ""));
    variants.push(raw.replace(/[[(（【].*$/, "").replace(/[\s　]/g, ""));
    for (const v of variants) if (v && byName[v]) return byName[v];
  }
  return fallback;
}

/** 表記ゆれ（空白の有無）を吸収した索引を作る */
function buildNameIndex(names) {
  const idx = {};
  for (const k of Object.keys(names || {})) {
    const v = names[k];
    idx[k.trim()] = v;
    idx[k.replace(/[\s　]/g, "")] = v;
  }
  return idx;
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
  const byName = buildNameIndex(cfg.rolesByName);
  const fallback = cfg.fallbackRole || "メンバー";
  const includeBody = cfg.includeBody === true;
  const limit = Math.min(Math.max(cfg.perChannelLimit || 30, 1), 100);

  if (!TOKEN) {
    console.log("DISCORD_BOT_TOKEN が未設定です。log.txt はそのままにします。");
    console.log("→ Botの用意ができるまでは手動編集で運用してください。");
    process.exit(0);
  }

  const rows = [];
  const unmapped = new Set();
  for (const ch of cfg.channels || []) {
    const id = typeof ch === "string" ? ch : ch.id;
    const label = (typeof ch === "object" && ch.label) || "";
    try {
      const msgs = await fetchMessages(id, limit);
      for (const m of msgs) {
        if (m.author?.bot) continue;              // Botの発言は無視
        const body = flatten(m.content, cfg.bodyMaxChars || 160);
        if (!includeBody && !body && !m.attachments?.length) continue;
        const role = toRole(m, roles, byName, "");
        if (!role) unmapped.add(m.author?.global_name || m.author?.username || "?");
        rows.push({
          ts: m.timestamp,
          date: ymd(m.timestamp),
          role: role || fallback,
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

  if (unmapped.size) {
    console.log(`\n役職表に無い人が ${unmapped.size} 名います（"${fallback}" として出力しました）:`);
    for (const n of unmapped) console.log(`  - ${n}`);
    console.log("sync.config.json の rolesByName に追記すると役職名で出ます。");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
