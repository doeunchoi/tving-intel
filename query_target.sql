-- =============================================================
-- TVING Contents Intelligence — target.csv 추출 쿼리 v2
-- 출력: title, genre, band, reach, branded(0고정), f10~m60(비중%), cast_info, hour_dist, dow_dist
-- 변경: f10~m60 = 전체 시청자 대비 순수 비중(%), 인덱스 아님
--       hour_dist = 시간대별 시청 비중(%) 24값 파이프 구분 (0시~23시)
--       dow_dist  = 요일별 시청 비중(%) 7값 파이프 구분 (월~일 순, DAY_OF_WEEK 1=월…7=일)
-- 사용법: Redash에서 실행 → Download as CSV → data/target.csv 교체
-- ※ branded 컬럼은 0으로 출력됨 — CSV 받은 후 수기로 1/0 입력
-- ※ cast_info는 이름만 콤마 구분 (역할/설명은 콜론 구분으로 수기 보완 가능)
-- ※ 콤마가 포함되므로 CSV에서 따옴표로 감싸짐 — 정상 (프론트 파서가 따옴표 처리)
-- =============================================================
WITH watch AS (
    SELECT
        DATE((DATE_PARSE(a.utc_time, '%Y-%m-%d-%H') + INTERVAL '9' HOUR)) AS kst_date,
        HOUR(DATE_PARSE(a.utc_time, '%Y-%m-%d-%H') + INTERVAL '9' HOUR)   AS kst_hour,
        user_no,
        COALESCE(b.media_code_to,
            CASE WHEN media_type IN ('EPISODE', 'CHANNEL') THEN a.related_media_code ELSE a.media_code END
        ) AS media_code
    FROM prod_de_neat.watchlog_agg_v1 a
    LEFT JOIN prod_ds.media_code_redirect_v1_merged__latest b
        ON a.media_code = b.media_code_from
    WHERE media_type IN ('EPISODE', 'MOVIE', 'CHANNEL')
      AND DATE((DATE_PARSE(a.utc_time, '%Y-%m-%d-%H') + INTERVAL '9' HOUR))
          BETWEEN (current_date - INTERVAL '28' DAY) AND current_date
      AND log_type_cnt['01'] > 0
),
user_info AS (
    SELECT user_no, birth, COALESCE(gender, '알 수 없음') AS gender
    FROM prod_de_neat.user_meta_v1__latest
),
content AS (
    SELECT DISTINCT
        media_code,
        COALESCE(program_title_kr, title_kr) AS program_title_kr
    FROM prod_de_neat.content_meta_v2
    WHERE media_type IN ('PROGRAM','MOVIE')
),
-- 데모 세그먼트: 성별·연령 분류 (성별/나이 미확인은 기타/알 수 없음으로 유지)
base_segment AS (
    SELECT
        c.program_title_kr,
        u.gender,
        CASE
            WHEN DATE_DIFF('year', u.birth, w.kst_date) BETWEEN 0  AND 19 THEN '10대'
            WHEN DATE_DIFF('year', u.birth, w.kst_date) BETWEEN 20 AND 29 THEN '20대'
            WHEN DATE_DIFF('year', u.birth, w.kst_date) BETWEEN 30 AND 39 THEN '30대'
            WHEN DATE_DIFF('year', u.birth, w.kst_date) BETWEEN 40 AND 49 THEN '40대'
            WHEN DATE_DIFF('year', u.birth, w.kst_date) BETWEEN 50 AND 59 THEN '50대'
            WHEN DATE_DIFF('year', u.birth, w.kst_date) >= 60             THEN '60대 이상'
            ELSE '기타'
        END AS age_group,
        w.user_no
    FROM watch w
    INNER JOIN content c ON w.media_code = c.media_code
    LEFT JOIN user_info u ON w.user_no = u.user_no
),
content_demo AS (
    SELECT program_title_kr, gender, age_group, COUNT(DISTINCT user_no) AS uv
    FROM base_segment
    GROUP BY 1, 2, 3
),
-- 분모: 성별/나이 미확인 포함한 전체 시청자 수
content_total AS (
    SELECT program_title_kr, COUNT(DISTINCT user_no) AS total_uv
    FROM base_segment
    GROUP BY 1
),
-- 비중(%) 피벗: uv / 전체시청자 * 100, 소수점 1자리
-- 분모에 성별/나이 미확인 포함 → 12개 세그먼트 합계 < 100% (정상)
pivoted AS (
    SELECT
        cd.program_title_kr                                                                                                           AS title,
        MAX(ct.total_uv)                                                                                                             AS total_uv,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='10대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f10,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='20대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f20,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='30대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f30,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='40대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f40,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='50대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f50,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='F' AND cd.age_group='60대 이상' THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS f60,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='10대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m10,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='20대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m20,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='30대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m30,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='40대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m40,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='50대'      THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m50,
        ROUND(100.0 * MAX(CASE WHEN cd.gender='M' AND cd.age_group='60대 이상' THEN cd.uv END) / NULLIF(MAX(ct.total_uv), 0), 1)     AS m60
    FROM content_demo cd
    JOIN content_total ct ON cd.program_title_kr = ct.program_title_kr
    WHERE cd.gender <> '알 수 없음'
      AND cd.age_group <> '기타'
      AND ct.total_uv >= 30
    GROUP BY cd.program_title_kr
),
-- 절대 UV 기준 band(4구간) + reach(0~100 게이지), 10,000 UV 미만 제외
content_band AS (
    SELECT
        title,
        total_uv,
        CAST(ROUND(PERCENT_RANK() OVER (ORDER BY total_uv) * 100) AS INTEGER) AS reach,
        CASE
            WHEN total_uv >= 1000000 THEN '초대형'
            WHEN total_uv >=  400000 THEN '대형'
            WHEN total_uv >=  100000 THEN '중형'
            ELSE '소형'
        END AS band
    FROM pivoted
    WHERE total_uv >= 10000
),
-- 시간대별 시청 비중: 콘텐츠별 시간당 UV, 파이프 구분 24값 (0시~23시 순)
-- 분모 = 해당 콘텐츠의 시간별 UV 합계 (한 유저가 여러 시간대에 시청하면 복수 카운트)
hour_segment AS (
    SELECT
        c.program_title_kr,
        w.kst_hour,
        COUNT(DISTINCT w.user_no) AS hour_uv
    FROM watch w
    INNER JOIN content c ON w.media_code = c.media_code
    GROUP BY 1, 2
),
hour_agg AS (
    SELECT
        program_title_kr AS title,
        ARRAY_JOIN(ARRAY[
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=0  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=1  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=2  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=3  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=4  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=5  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=6  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=7  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=8  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=9  THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=10 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=11 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=12 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=13 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=14 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=15 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=16 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=17 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=18 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=19 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=20 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=21 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=22 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN kst_hour=23 THEN hour_uv END), 0) / NULLIF(SUM(hour_uv), 0), 1) AS VARCHAR)
        ], '|') AS hour_dist
    FROM hour_segment
    GROUP BY program_title_kr
),
-- 요일별 시청 비중: 콘텐츠별 요일당 UV, 파이프 구분 7값 (월~일 순)
-- DAY_OF_WEEK: 1=월요일 … 7=일요일 (ISO). 분모 = 요일별 UV 합계
dow_segment AS (
    SELECT
        c.program_title_kr,
        DAY_OF_WEEK(w.kst_date) AS dow,
        COUNT(DISTINCT w.user_no) AS dow_uv
    FROM watch w
    INNER JOIN content c ON w.media_code = c.media_code
    GROUP BY 1, 2
),
dow_agg AS (
    SELECT
        program_title_kr AS title,
        ARRAY_JOIN(ARRAY[
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=1 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=2 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=3 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=4 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=5 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=6 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR),
            CAST(ROUND(100.0 * COALESCE(MAX(CASE WHEN dow=7 THEN dow_uv END), 0) / NULLIF(SUM(dow_uv), 0), 1) AS VARCHAR)
        ], '|') AS dow_dist
    FROM dow_segment
    GROUP BY program_title_kr
),
meta AS (
    SELECT DISTINCT
        COALESCE(program_title_kr, title_kr) AS title_kr,
        main_genre_name AS genre,
        ARRAY_JOIN(COALESCE(casting_kr, ARRAY[]), ', ') AS cast_info
    FROM prod_de_neat.content_meta_v2
    WHERE media_type IN ('PROGRAM', 'MOVIE')
)
-- 최종 출력: target.csv 스키마 (hour_dist 컬럼 추가)
SELECT
    p.title,
    COALESCE(m.genre, '')      AS genre,
    b.band,
    b.reach,
    0                          AS branded,
    COALESCE(p.f10, 0)         AS f10,
    COALESCE(p.f20, 0)         AS f20,
    COALESCE(p.f30, 0)         AS f30,
    COALESCE(p.f40, 0)         AS f40,
    COALESCE(p.f50, 0)         AS f50,
    COALESCE(p.f60, 0)         AS f60,
    COALESCE(p.m10, 0)         AS m10,
    COALESCE(p.m20, 0)         AS m20,
    COALESCE(p.m30, 0)         AS m30,
    COALESCE(p.m40, 0)         AS m40,
    COALESCE(p.m50, 0)         AS m50,
    COALESCE(p.m60, 0)         AS m60,
    COALESCE(m.cast_info, '')  AS cast_info,
    COALESCE(h.hour_dist, '')  AS hour_dist,
    COALESCE(d.dow_dist, '')   AS dow_dist
FROM pivoted p
JOIN content_band b  ON p.title = b.title
LEFT JOIN meta m     ON p.title = m.title_kr
LEFT JOIN hour_agg h ON p.title = h.title
LEFT JOIN dow_agg d  ON p.title = d.title
ORDER BY b.total_uv DESC
