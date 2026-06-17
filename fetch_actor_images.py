"""
TMDB에서 onair 콘텐츠 출연자 이미지를 가져와 actor_images.json 생성
Usage: python fetch_actor_images.py
"""
import csv, json, time, sys, ssl
import urllib.request
import urllib.parse

# 회사 네트워크 SSL 프록시 우회
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE

def _load_env():
    try:
        with open(".env") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    if k.strip() == "TMDB_API_KEY":
                        return v.strip()
    except FileNotFoundError:
        pass
    return None

TMDB_API_KEY = _load_env()
if not TMDB_API_KEY:
    raise SystemExit("❌ .env 파일에 TMDB_API_KEY가 없습니다.")
IMG_BASE = "https://image.tmdb.org/t/p/w185"
SEARCH_URL = "https://api.themoviedb.org/3/search/person"
DATA_DIR = "data"
OUT_FILE = "data/actor_images.json"

def tmdb_search(name):
    params = urllib.parse.urlencode({"api_key": TMDB_API_KEY, "query": name, "language": "ko-KR", "page": 1})
    url = f"{SEARCH_URL}?{params}"
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10, context=_CTX) as resp:
            data = json.loads(resp.read().decode())
            results = data.get("results", [])
            if results and results[0].get("profile_path"):
                return IMG_BASE + results[0]["profile_path"]
    except Exception as e:
        print(f"  ERROR: {e}")
    return None

def get_onair_cast():
    onair_titles = set()
    with open(f"{DATA_DIR}/lineup.csv", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("status", "").lower() == "onair":
                onair_titles.add(row["title"].strip())

    names = set()
    with open(f"{DATA_DIR}/target.csv", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row["title"].strip() in onair_titles:
                for name in row.get("cast_info", "").split("|"):
                    n = name.strip()
                    if n:
                        names.add(n)
    return sorted(names)

def main():
    # 기존 결과 로드 (재실행 시 이미 조회된 항목 스킵)
    try:
        with open(OUT_FILE, encoding="utf-8") as f:
            results = json.load(f)
        print(f"기존 캐시 {len(results)}명 로드")
    except FileNotFoundError:
        results = {}

    cast_names = get_onair_cast()
    todo = [n for n in cast_names if not results.get(n)]
    print(f"총 {len(cast_names)}명 중 {len(todo)}명 조회 필요\n")

    for i, name in enumerate(todo, 1):
        print(f"[{i}/{len(todo)}] {name} ... ", end="", flush=True)
        url = tmdb_search(name)
        results[name] = url
        if url:
            print(f"OK ({url.split('/')[-1]})")
        else:
            print("이미지 없음")
        # TMDB rate limit: 40 req/10s
        if i % 35 == 0:
            print("  (rate limit 대기 1초)")
            time.sleep(1)

    with open(OUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)

    found = sum(1 for v in results.values() if v)
    print(f"\n완료: {found}/{len(results)}명 이미지 확보 → {OUT_FILE}")

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
