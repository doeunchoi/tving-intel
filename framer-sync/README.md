# framer-sync

이 레포의 **`data/*.csv` 를 Framer CMS 컬렉션에 매일 자동 동기화하고 사이트까지 게시**하는 파이프라인입니다.

```
data/*.csv  (이 레포)
   │  ① data/ 푸시 시 즉시   ② 매일 KST 05:00 cron (안전망)
   ▼
framer-sync/scripts/  (GitHub Actions)
   ├─ content-sync.js : lineup.csv + meta.csv → "Content" 컬렉션 (Hot & New, 15편, 18필드)
   └─ ranking-sync.js : rank.csv          → "Ranking" 컬렉션 (성·연령별 TOP50, 1,050행)
        · 스키마 자동 보장(멱등), 해시 diff 증분 upsert, 빠진 항목 삭제
        · 변경이 있을 때만 publish + deploy
   ▼
Framer CMS → 게시된 사이트
```

> **Ranking 컬렉션** — `성별`·`연령`을 Option 필드로 두어 Framer 네이티브 Dynamic Filters(드롭다운)로
> 거를 수 있습니다. 디자이너는 Collection List 를 `순위` 오름차순 정렬 + 성별·연령 드롭다운 필터로 구성하면
> "성·연령별 TOP 50" 섹션이 완성됩니다. (필터 기본값을 `남녀 전체`+`전체 연령`으로 두면 원본과 동일하게 시작)

## 활성화 (1회 설정)

레포 **Settings → Secrets and variables → Actions** 에 등록:

| Secret | 값 |
|---|---|
| `FRAMER_PROJECT_URL` | Framer 에디터 주소 (`https://framer.com/projects/<이름>--<ID>`) |
| `FRAMER_API_KEY` | Framer **사이트 설정 → API** 에서 발급 |
| `FRAMER_COLLECTION_NAME` | `Content` |

등록하면 끝 — `data/` 가 main 에 푸시될 때마다 + 매일 새벽 자동 동기화됩니다.
수동 실행: **Actions 탭 → framer-sync → Run workflow**.

## 동작 원리 (운영 참고)

| 항목 | 내용 |
|---|---|
| **고유 키** | `poster_url` 속 프로그램 코드(`P001785205` → 슬러그 `p001785205`). 제목이 바뀌어도 같은 항목으로 추적 |
| **증분** | 항목별 해시를 `state/content-state.json` 에 저장, 바뀐 항목만 upsert. 변경 없으면 Framer 연결 생략 |
| **전체 조정** | lineup.csv 에서 빠진 항목은 CMS 에서 삭제 → ⚠️ **Content 컬렉션에 수동으로 항목을 추가하지 마세요** |
| **publish** | Server API 의 CMS 쓰기는 publish 해야 영속화됨 → 변경 시 자동 게시 |
| **안전장치** | lineup 0건이면 중단(CMS 비워짐 방지) · 연결 5회 재시도 · state 커밋으로 60일 비활성 중단 방지 |

## CMS 필드 (자동 관리, 이름 변경 금지 — 디자인 바인딩 키)

`Title` · `Status`(enum onair/soon) · `Genre` · `Sub Genres` · `Rating` · `Cast` · `Premiere`(date) · `Premiere Month`("6월" — Coming Soon 월별 그룹 필터용) · `Days` · `Episodes` · `Is Original` / `Is TVING Only` / `Is Special`(3종 뱃지) · `Special Link` · `Poster`(공식 포스터 자동 수록) · `Sort Order` · `Updated At`(데이터 기준일)

## data/ 작성 가이드 (데이터 관리자용)

- `lineup.csv` 의 **`poster_url` 은 필수** — 항목 식별 키(프로그램 코드)가 여기서 나옵니다.
- 컬럼명을 바꾸면 동기화가 중단되고 Actions 가 실패로 알려줍니다(필수 컬럼 검증 내장).
- 종영작은 행을 지우면 CMS 에서도 자동 제거됩니다.
- 스키마(컬럼)를 바꿔야 하면 `scripts/content-sync.js` 의 필드 정의와 `SCHEMA_VERSION` 을 함께 수정하세요.

## 로컬 실행 (디버그)

```bash
cd framer-sync
npm install
cp .env.example .env   # 값 채우기
npm run sync           # 증분 동기화 + 게시
npm run sync:force     # 해시 무시 전체 재동기화
```

## Framer 프로젝트 인수인계 시

API 키는 **발급자 계정 + 프로젝트에 묶입니다.** 프로젝트를 다른 워크스페이스로 Transfer 하면:
1. 인수한 워크스페이스에서 키 **새로 발급**
2. `FRAMER_PROJECT_URL` 재확인(에디터 주소 다시 복사)
3. 레포 Secrets 갱신, 기존 키 폐기
