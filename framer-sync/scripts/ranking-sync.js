// ranking-sync.js — data/rank.csv → Framer "Ranking" 컬렉션 (성·연령별 TOP50, 21세그×50=1050행)
//   성별·연령을 Option(enum) 필드로 만들어 Framer 네이티브 Dynamic Filters(드롭다운) 사용 가능.
//   해시 diff 증분 upsert + 변경 시 publish (CMS 쓰기는 publish 해야 영속화).
//
//   node --env-file=.env scripts/ranking-sync.js          # 증분 동기화 + 게시
//   node --env-file=.env scripts/ranking-sync.js --force  # 전체 재동기화
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import Papa from "papaparse"
import { connect } from "framer-api"

const SOURCE_BASE =
    process.env.SOURCE_BASE ||
    "https://raw.githubusercontent.com/doeunchoi/tving-intel/main/data"
const COLLECTION_NAME = "Ranking"
const STATE_PATH = new URL("../state/ranking-state.json", import.meta.url).pathname
const SCHEMA_VERSION = "ranking-v2" // v2: 필드명 영어화(성별→Gender 등, 다른 컬렉션과 일관)
const BATCH = 200

const args = process.argv.slice(2)
const FORCE = args.includes("--force")
const PUBLISH = !args.includes("--no-publish")

// ── 코드 → 라벨/슬러그 매핑 ──────────────────────────────────────────────
const GENDER_LABEL = { MF: "남녀 전체", M: "남성", F: "여성" }
const GENDER_CODE = { MF: "mf", M: "m", F: "f" }
const AGE_LABEL = { "": "전체 연령", "10": "10대", "20": "20대", "30": "30대", "40": "40대", "50": "50대", "60": "60대+" }
const AGE_CODE = { "": "all", "10": "10", "20": "20", "30": "30", "40": "40", "50": "50", "60": "60" }

// Option(enum) 필드 케이스 — 드롭다운 옵션 순서대로
const GENDER_CASES = ["남녀 전체", "여성", "남성"]
const AGE_CASES = ["전체 연령", "10대", "20대", "30대", "40대", "50대", "60대+"]

// 불필요한 기본 필드 제거 (컬렉션 생성 시 딸려온 formattedText)
// 기본 Content 필드 + 구(한글) 필드 제거 → 영어 필드로 재생성 (값은 rank.csv 에서 재적재)
const FIELDS_TO_REMOVE = ["Content", "성별", "연령", "순위", "장르"]

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)
const pad2 = (n) => String(n).padStart(2, "0")
const chunk = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o }

async function fetchCsv(file, required) {
    let text
    if (/^https?:\/\//.test(SOURCE_BASE)) {
        const res = await fetch(`${SOURCE_BASE}/${file}`, { redirect: "follow" })
        if (!res.ok) throw new Error(`${file} HTTP ${res.status}`)
        text = await res.text()
    } else {
        const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", SOURCE_BASE, file)
        text = fs.readFileSync(p, "utf8")
    }
    text = text.replace(/^﻿/, "")
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase() })
    const headers = parsed.meta?.fields || []
    const missing = required.filter((c) => !headers.includes(c))
    if (missing.length) throw new Error(`${file}: 필수 컬럼 누락 [${missing.join(", ")}] — 실제: [${headers.join(", ")}]`)
    return parsed.data
}

// rank.csv 행 → 논리 레코드
function buildRecord(r) {
    const gender = r.gender || "MF"
    const age = r.age || ""
    const rank = parseInt(r.rank, 10) || 0
    const slug = `${GENDER_CODE[gender] || "x"}-${AGE_CODE[age] || age}-${pad2(rank)}`
    const genre = [r.main_genre, r.sub_genre].filter(Boolean).join(" · ")
    return {
        slug,
        fields: {
            Title: ["string", r.title],
            Gender: ["enum", GENDER_LABEL[gender] || gender], // 표시값(케이스)은 한글 유지, 라벨→케이스ID 변환은 upsert 시
            Age: ["enum", AGE_LABEL[age] || age],
            Rank: ["number", rank],
            Genre: ["string", genre],
        },
    }
}

const hashOf = (rec) => crypto.createHash("sha1").update(JSON.stringify(rec.fields)).digest("hex").slice(0, 16)

function loadState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) } catch { return {} } }
function saveState(s) {
    fs.mkdirSync(new URL("../state/", import.meta.url).pathname, { recursive: true })
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2))
}

async function conn() {
    for (let a = 1; a <= 5; a++) {
        try { return await connect(process.env.FRAMER_PROJECT_URL, process.env.FRAMER_API_KEY) }
        catch (e) { log(`연결 재시도 ${a}/5: ${e.code || e.message}`); if (a === 5) throw e; await new Promise((r) => setTimeout(r, 3000)) }
    }
}

// 스키마 보장: 불필요 필드 제거 + Option/Number/Text 필드 생성. 반환: name→field(케이스 포함)
async function ensureSchema(collection) {
    let fields = await collection.getFields()
    const byName = new Map(fields.map((f) => [f.name, f]))

    const removeIds = fields.filter((f) => FIELDS_TO_REMOVE.includes(f.name)).map((f) => f.id)
    if (removeIds.length) { log(`기본 필드 제거: ${FIELDS_TO_REMOVE.join(", ")}`); await collection.removeFields(removeIds) }

    const toAdd = []
    if (!byName.has("Gender")) toAdd.push({ type: "enum", name: "Gender", cases: GENDER_CASES.map((name) => ({ name })) })
    if (!byName.has("Age")) toAdd.push({ type: "enum", name: "Age", cases: AGE_CASES.map((name) => ({ name })) })
    if (!byName.has("Rank")) toAdd.push({ type: "number", name: "Rank" })
    if (!byName.has("Genre")) toAdd.push({ type: "string", name: "Genre" })
    if (toAdd.length) { log(`필드 생성: ${toAdd.map((f) => f.name).join(", ")}`); await collection.addFields(toAdd) }

    fields = await collection.getFields()
    return new Map(fields.map((f) => [f.name, f]))
}

function toEntry(field, [type, value]) {
    if (value == null || value === "") return undefined
    if (type === "enum") {
        const kase = (field.cases || []).find((c) => c.name === value)
        // 케이스 미발견 시 silent drop 금지 — 라벨 드리프트로 성별/연령이 빈 채
        // 적재되고 해시가 라벨 기준이라 '변경 없음'으로 영구 고착되는 것을 방지.
        if (!kase) throw new Error(`enum 케이스 없음: 필드 "${field.name}" 값 "${value}" (가능: ${(field.cases || []).map((c) => c.name).join(", ")})`)
        return { type: "enum", value: kase.id }
    }
    return { type, value }
}

async function main() {
    log(`소스: ${SOURCE_BASE}`)
    const rows = await fetchCsv("rank.csv", ["gender", "age", "rank", "title", "main_genre"])
    const records = rows.filter((r) => (r.title || "").trim() && r.rank).map(buildRecord)
    if (!records.length) throw new Error("rank.csv 가 비었습니다 — 동기화 중단")
    const slugs = new Set(records.map((r) => r.slug))
    if (slugs.size !== records.length) throw new Error(`슬러그 중복 (${records.length - slugs.size}건) — 키 규칙 확인`)
    log(`rank.csv ${records.length}행 (세그먼트 ${new Set(rows.map((r) => (r.gender || "MF") + (r.age || ""))).size})`)

    const state = loadState()
    const prevHashes = state.schemaVersion === SCHEMA_VERSION ? state.hashes || {} : {}
    const changed = FORCE ? records : records.filter((r) => prevHashes[r.slug] !== hashOf(r))
    const removedSlugs = Object.keys(prevHashes).filter((s) => !slugs.has(s))
    log(`전체 ${records.length} / 변경·신규 ${changed.length} / 삭제예상 ${removedSlugs.length}`)

    if (!changed.length && !removedSlugs.length && state.schemaVersion === SCHEMA_VERSION) {
        log("변경 없음 — Framer 연결 생략")
        state.lastSync = new Date().toISOString(); saveState(state); return
    }

    const framer = await conn()
    let didChange = false
    try {
        const collection = (await framer.getCollections()).find((c) => c.name === COLLECTION_NAME)
        if (!collection) throw new Error(`"${COLLECTION_NAME}" 컬렉션을 찾지 못함`)

        const fieldByName = await ensureSchema(collection)
        const existing = await collection.getItems()
        const slugToId = new Map(existing.map((it) => [it.slug, it.id]))

        // 스키마가 새로 잡혔으면 전체 upsert (case id 가 이제 잡힘)
        const upsertList = state.schemaVersion === SCHEMA_VERSION && !FORCE ? changed : records
        const items = upsertList.map((rec) => {
            const fieldData = {}
            for (const [name, cell] of Object.entries(rec.fields)) {
                const field = fieldByName.get(name)
                if (!field) continue
                const entry = toEntry(field, cell)
                if (entry !== undefined) fieldData[field.id] = entry
            }
            return { id: slugToId.get(rec.slug), slug: rec.slug, fieldData }
        })

        if (items.length) {
            const batches = chunk(items, BATCH)
            log(`upsert ${items.length}건 (${batches.length} 배치, 신규 ${items.filter((i) => !i.id).length})`)
            for (let i = 0; i < batches.length; i++) {
                await collection.addItems(batches[i])
                log(`  배치 ${i + 1}/${batches.length} (${batches[i].length}건) 완료`)
            }
            didChange = true
        }

        const stale = existing.filter((it) => !slugs.has(it.slug))
        if (stale.length) {
            log(`stale ${stale.length}건 삭제`)
            for (const b of chunk(stale.map((s) => s.id), BATCH)) await collection.removeItems(b)
            didChange = true
        }

        if (PUBLISH && (didChange || state.schemaVersion !== SCHEMA_VERSION)) {
            const { deployment } = await framer.publish()
            await framer.deploy(deployment.id)
            log(`게시 완료 (${deployment.id})`)
        } else if (!PUBLISH) log("⚠️ --no-publish: 영속화 안 됨")
    } finally {
        try { await framer.disconnect() } catch {}
    }

    const hashes = {}
    for (const r of records) hashes[r.slug] = hashOf(r)
    saveState({ schemaVersion: SCHEMA_VERSION, hashes, lastSync: new Date().toISOString() })
    log("완료 — state 저장.")
}

main().catch((e) => { console.error("FAIL:", e?.message || e); process.exit(1) })
