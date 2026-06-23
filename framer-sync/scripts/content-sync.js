// content-sync.js — TVING 광고정보센터 일일 동기화 (v2: GitHub data/*.csv 직결)
//
//   GitHub(raw) data/lineup.csv + data/meta.csv
//     → 스키마 보장(구필드 제거·신필드 생성, 멱등)
//     → 해시 diff 증분 upsert (공식 포스터 포함)
//     → 소스에 없는 항목 삭제(전체 조정)
//     → 변경 시 publish + deploy  ← Server API CMS 쓰기는 publish 해야 영속화됨
//
//   node --env-file=.env scripts/content-sync.js               # 증분 동기화 + 게시
//   node --env-file=.env scripts/content-sync.js --force       # 해시 무시 전체 upsert
//   node --env-file=.env scripts/content-sync.js --no-publish  # 미게시(영속화 안 됨, 디버그용)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Papa from "papaparse";
import { connect } from "framer-api";

// ── 설정 ──
// SOURCE_BASE: http(s) URL 또는 로컬 디렉토리 경로.
//   - GitHub Actions(이 레포 checkout)에서는 "../data" 지정 → 방금 푸시된 커밋을
//     raw URL 캐시(~5분) 지연 없이 그대로 읽음.
//   - 외부/로컬 실행 시 기본값(raw URL) 사용.
const SOURCE_BASE = process.env.SOURCE_BASE
  || "https://raw.githubusercontent.com/doeunchoi/tving-intel/main/data";
const COLLECTION_NAME = process.env.FRAMER_COLLECTION_NAME || "Content";
const STATE_PATH = new URL("../state/content-state.json", import.meta.url).pathname;
const SCHEMA_VERSION = "lineup-v3"; // v3: platform/synopsis/preview·시청 URL/Wavve 플래그 7필드 추가

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const PUBLISH = !args.includes("--no-publish");

// ── 스키마 정의 (lineup.csv 기준) ─────────────────────────────────────────
// 구(더미/시트 시절) 필드 — 존재하면 제거
const FIELDS_TO_REMOVE = [
  "Top 20 Rank", "Previous Rank", "Is New", "Recommended",
  "Is TVING Special", "Air Period", "Start Month", "End Month", "Peak Month",
  "Ad Info", "Target Audience", "Ad Products", "Brand Fit", "Sales Points",
  "Audience Female %", "Audience Male %",
  "Age 18-24 %", "Age 25-34 %", "Age 35-44 %", "Age 45+ %",
];
// 신규 필드 — 없으면 생성 (이름이 디자인 바인딩 키이므로 변경 금지)
const FIELDS_TO_ADD = [
  { type: "enum", name: "Status", cases: [{ name: "onair" }, { name: "soon" }] },
  { type: "string", name: "Sub Genres" },
  { type: "string", name: "Rating" },
  { type: "date", name: "Premiere" },
  { type: "string", name: "Premiere Month" }, // "6월" — Coming Soon 월별 그룹 필터용
  { type: "string", name: "Days" },
  { type: "boolean", name: "Is Original" },
  { type: "boolean", name: "Is TVING Only" },
  { type: "boolean", name: "Is Special" },
  { type: "string", name: "Updated At" }, // meta.csv updated_at (사이트 "데이터 기준일" 표기용)
  // v3 신규 (lineup.csv 신규 컬럼)
  { type: "string", name: "Platform" }, // t/tw/w → TVING/TVING·Wavve/Wavve
  { type: "string", name: "Synopsis" },
  { type: "link", name: "Preview URL" },
  { type: "link", name: "TVING URL" },
  { type: "link", name: "Wavve URL" },
  { type: "boolean", name: "Is Wavve Original" },
  { type: "boolean", name: "Is Wavve Only" },
];

// platform 코드 → 표시 라벨
const PLATFORM_LABEL = { t: "TVING", tw: "TVING·Wavve", w: "Wavve" };

// Framer 가 서버측에서 가져올 수 있는 공식 포스터 CDN 만 허용.
// (namu.wiki 등 비공식 출처는 403 으로 업로드 실패 → 스킵)
const POSTER_OK = /^https?:\/\/(image\.tving\.com|image\.wavve\.com)\//i;
// 유지(기존): Content Info(divider), Sort Order, Poster, Title, Genre, Cast, Episodes, Special Link

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

// ── 소스 읽기 ──
async function fetchCsv(file, requiredCols) {
  let text;
  if (/^https?:\/\//.test(SOURCE_BASE)) {
    const url = `${SOURCE_BASE}/${file}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`${file} 가져오기 실패 (HTTP ${res.status}) — ${url}`);
    text = await res.text();
  } else {
    // 로컬 디렉토리 모드 (Actions checkout 등)
    const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", SOURCE_BASE, file);
    text = fs.readFileSync(p, "utf8");
  }
  text = text.replace(/^﻿/, "");
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() });
  const headers = parsed.meta?.fields || [];
  const missing = requiredCols.filter((c) => !headers.includes(c));
  if (missing.length) throw new Error(`${file}: 필수 컬럼 누락 [${missing.join(", ")}] — 실제 헤더: [${headers.join(", ")}]`);
  return parsed.data;
}

const asBool = (v) => /^(1|true|y|yes)$/i.test(String(v || "").trim());

// 포스터 URL 에서 프로그램 코드 추출 → 불변 슬러그 (제목 변경에도 안전)
function slugOf(row) {
  const m = String(row.poster_url || "").match(/\/(P\d+)\.(jpg|png|webp)/i);
  if (m) return m[1].toLowerCase();
  // 폴백: 제목 슬러그화 (코드가 없을 때만)
  return "t-" + String(row.title).toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "");
}

// lineup 행 → 논리 레코드 { slug, fields: { 필드명: [type, value] } }
function buildRecord(row, index, updatedAt) {
  const premiereRaw = (row.premiere || "").trim(); // "2026-05-11" 또는 "7월"(미정) 등
  const isISO = /^\d{4}-\d{2}-\d{2}$/.test(premiereRaw);
  const premiere = isISO ? premiereRaw : null; // date 필드는 유효 ISO 만, 아니면 비움
  const month = isISO
    ? `${parseInt(premiereRaw.split("-")[1], 10)}월`
    : /^\d{1,2}월$/.test(premiereRaw)
      ? premiereRaw // "7월" 같은 월 표기는 그대로 Premiere Month 로
      : "";
  const episodes = String(row.episodes || "").trim();
  const specialUrl = (row.special_url || "").trim();
  return {
    slug: slugOf(row),
    fields: {
      Title: ["string", row.title],
      Status: ["enum", String(row.status || "onair").trim().toLowerCase()], // 케이스명 → id 변환은 업서트 시
      Genre: ["string", row.genre || ""],
      "Sub Genres": ["string", row.sub_genres || ""],
      Rating: ["string", row.rating || ""],
      Cast: ["string", row.cast || ""],
      Premiere: ["date", premiere || null],
      "Premiere Month": ["string", month],
      Days: ["string", row.days || ""],
      Episodes: episodes && /^\d+$/.test(episodes) ? ["number", parseInt(episodes, 10)] : null,
      "Is Original": ["boolean", asBool(row.is_original)],
      "Is TVING Only": ["boolean", asBool(row.is_tving_only)],
      "Is Special": ["boolean", asBool(row.is_special)],
      "Special Link": ["link", specialUrl || null],
      Poster: POSTER_OK.test((row.poster_url || "").trim()) ? ["image", (row.poster_url || "").trim()] : null,
      "Sort Order": ["number", index + 1],
      "Updated At": ["string", updatedAt || ""],
      // v3 신규
      Platform: ["string", PLATFORM_LABEL[(row.platform || "").trim()] || (row.platform || "").trim()],
      Synopsis: ["string", row.synopsis || ""],
      "Preview URL": ["link", (row.preview_url || "").trim() || null],
      "TVING URL": ["link", (row.tving_url || "").trim() || null],
      "Wavve URL": ["link", (row.wavve_url || "").trim() || null],
      "Is Wavve Original": ["boolean", asBool(row.is_wavve_original)],
      "Is Wavve Only": ["boolean", asBool(row.is_wavve_only)],
    },
  };
}

const hashOf = (rec) => crypto.createHash("sha1").update(JSON.stringify(rec.fields)).digest("hex").slice(0, 16);

// ── 상태 ──
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; } }
function saveState(s) {
  fs.mkdirSync(new URL("../state/", import.meta.url).pathname, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

// ── Framer ──
async function conn() {
  for (let a = 1; a <= 5; a++) {
    try { return await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY); }
    catch (e) { log(`연결 재시도 ${a}/5: ${e.code || e.message}`); if (a === 5) throw e; await new Promise((r) => setTimeout(r, 3000)); }
  }
}

// 스키마 보장: 구필드 제거 + 신필드 생성. 반환: name→field 맵(케이스 포함)
async function ensureSchema(collection) {
  let fields = await collection.getFields();
  const names = new Set(fields.map((f) => f.name));

  const removeIds = fields.filter((f) => FIELDS_TO_REMOVE.includes(f.name)).map((f) => f.id);
  if (removeIds.length) {
    log(`구필드 ${removeIds.length}개 제거: ${fields.filter((f) => removeIds.includes(f.id)).map((f) => f.name).join(", ")}`);
    await collection.removeFields(removeIds);
  }

  const toAdd = FIELDS_TO_ADD.filter((f) => !names.has(f.name));
  if (toAdd.length) {
    log(`신필드 ${toAdd.length}개 생성: ${toAdd.map((f) => f.name).join(", ")}`);
    try {
      await collection.addFields(toAdd);
    } catch (e) {
      // enum 생성이 실패하는 환경 대비: enum 만 string 으로 폴백
      log(`addFields 실패(${e.message}) — enum 을 string 으로 폴백 재시도`);
      await collection.addFields(toAdd.map((f) => (f.type === "enum" ? { type: "string", name: f.name } : f)));
    }
  }

  fields = await collection.getFields();
  return new Map(fields.map((f) => [f.name, f]));
}

function toEntry(field, [type, value]) {
  if (value == null) {
    // date/link/image 는 null 로 명시적 클리어 가능
    if (["date", "link", "image"].includes(type)) return { type, value: null };
    return undefined; // number 등은 생략
  }
  if (type === "enum") {
    if (field.type === "enum") {
      const kase = (field.cases || []).find((c) => c.name?.toLowerCase() === String(value).toLowerCase());
      // 케이스 미발견 시 silent drop 금지 (예: status 에 예상 밖 값) — 에러로 표면화
      if (!kase) throw new Error(`enum 케이스 없음: 필드 "${field.name}" 값 "${value}" (가능: ${(field.cases || []).map((c) => c.name).join(", ")})`);
      return { type: "enum", value: kase.id };
    }
    return { type: "string", value: String(value) }; // enum 폴백(string 필드)
  }
  return { type, value };
}

async function main() {
  // 1) 소스
  log(`소스: ${SOURCE_BASE}`);
  const lineup = await fetchCsv("lineup.csv", ["status", "title", "genre", "poster_url"]);
  // meta.csv 는 선택사항(소스에서 제거될 수 있음) — 없으면 Updated At 만 빈 값
  let meta = {};
  try {
    const metaRows = await fetchCsv("meta.csv", ["key", "value"]);
    meta = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
  } catch (e) {
    log(`meta.csv 없음/읽기 실패 — Updated At 생략 (${e.message})`);
  }
  if (!lineup.length) throw new Error("lineup.csv 가 비었습니다 — 동기화 중단(소스 이상 추정)");
  log(`lineup ${lineup.length}편 (기준일 ${meta.updated_at || "?"})`);

  // 2) 레코드 + diff
  const records = lineup.filter((r) => (r.title || "").trim()).map((r, i) => buildRecord(r, i, meta.updated_at));
  const dupCheck = new Set(records.map((r) => r.slug));
  if (dupCheck.size !== records.length) throw new Error("슬러그 중복 감지 — lineup.csv 의 poster_url 코드 확인 필요");

  const state = loadState();
  const prevHashes = state.schemaVersion === SCHEMA_VERSION ? state.hashes || {} : {};
  const changed = FORCE ? records : records.filter((r) => prevHashes[r.slug] !== hashOf(r));
  const desired = new Set(records.map((r) => r.slug));
  const knownRemoved = Object.keys(prevHashes).filter((s) => !desired.has(s));
  log(`전체 ${records.length} / 변경·신규 ${changed.length} / 상태기준 삭제예상 ${knownRemoved.length}`);

  if (!changed.length && !knownRemoved.length && state.schemaVersion === SCHEMA_VERSION) {
    log("변경 없음 — Framer 연결 생략");
    state.lastSync = new Date().toISOString();
    saveState(state);
    return;
  }

  // 3) Framer 적용
  const framer = await conn();
  let didChange = false;
  try {
    const collection = (await framer.getCollections()).find((c) => c.name === COLLECTION_NAME);
    if (!collection) throw new Error(`"${COLLECTION_NAME}" 컬렉션을 찾지 못함`);

    const fieldByName = await ensureSchema(collection);

    const existing = await collection.getItems();
    const slugToId = new Map(existing.map((it) => [it.slug, it.id]));

    // upsert (스키마가 갱신됐을 수 있으므로 schemaVersion 불일치 시 전체)
    const upsertList = state.schemaVersion === SCHEMA_VERSION && !FORCE ? changed : records;
    const items = upsertList.map((rec) => {
      const fieldData = {};
      for (const [name, cell] of Object.entries(rec.fields)) {
        if (!cell) continue;
        const field = fieldByName.get(name);
        if (!field) continue;
        const entry = toEntry(field, cell);
        if (entry !== undefined) fieldData[field.id] = entry;
      }
      return { id: slugToId.get(rec.slug), slug: rec.slug, fieldData };
    });
    if (items.length) {
      log(`upsert ${items.length}건 (신규 ${items.filter((i) => !i.id).length} / 갱신 ${items.filter((i) => i.id).length})`);
      await collection.addItems(items);
      didChange = true;
    }

    // 전체 조정: 소스에 없는 기존 항목은 모두 삭제 (이 컬렉션은 sync 전용)
    const stale = existing.filter((it) => !desired.has(it.slug));
    if (stale.length) {
      log(`소스에 없는 항목 ${stale.length}건 삭제: ${stale.map((s) => s.slug).join(", ")}`);
      await collection.removeItems(stale.map((s) => s.id));
      didChange = true;
    }

    // 4) publish — CMS 변경은 publish 해야 프로젝트에 영속화됨
    if (PUBLISH && (didChange || state.schemaVersion !== SCHEMA_VERSION)) {
      const { deployment } = await framer.publish();
      const hosts = await framer.deploy(deployment.id);
      log(`게시 완료 (deployment ${deployment.id}) → ${hosts.map((h) => h.hostname).join(", ") || "기본 호스트"}`);
    } else if (!PUBLISH) {
      log("⚠️ --no-publish: 이번 변경은 영속화되지 않습니다.");
    }
  } finally {
    try { await framer.disconnect(); } catch {}
  }

  // 5) 상태 저장
  const hashes = {};
  for (const r of records) hashes[r.slug] = hashOf(r);
  saveState({ schemaVersion: SCHEMA_VERSION, hashes, updatedAt: meta.updated_at, lastSync: new Date().toISOString() });
  log("완료 — state 저장.");
}

main().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1); });
