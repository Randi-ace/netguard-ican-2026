-- 净网护航 v3 补偿迁移：只读验收 SQL
--
-- 本文件只执行 SELECT，不创建例程、不修改会话变量、不写任何表。
-- 所有业务表均使用专用测试库全限定名，绝不读取其他数据库同名表。

-- 0. 目标数据库提示。执行 v3 前仍必须人工 USE 正确数据库；
-- v3 本身使用未限定表名，不包含数据库名保护。
SELECT
    DATABASE() AS `selected_database`,
    'net_guard_migration_v3_test' AS `expected_database`,
    CASE
        WHEN LOWER(COALESCE(DATABASE(), ''))
             = 'net_guard_migration_v3_test' THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`;

-- 1. 总量、历史标记、正式口径和分类汇总。
-- 第一次及第二次 v3 后都应完全相同。
SELECT
    COUNT(*) AS `actual_total`,
    7 AS `expected_total`,
    CASE WHEN COUNT(*) = 7 THEN 'PASS' ELSE 'FAIL' END AS `total_status`,
    COALESCE(SUM(
        JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
            IN ('security_logs', 'detection_records')
        AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
    ), 0) AS `actual_legacy`,
    6 AS `expected_legacy`,
    CASE
        WHEN COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
        ), 0) = 6 THEN 'PASS'
        ELSE 'FAIL'
    END AS `legacy_status`,
    COALESCE(SUM(
        JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
            IN ('security_logs', 'detection_records')
        AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
        AND `event_type` <> 'extension_risk'
    ), 0) AS `noncanonical_event_type_count`,
    COALESCE(SUM(
        JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
            IN ('security_logs', 'detection_records')
        AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
        AND `check_type` NOT IN ('ai', 'url', 'rule')
    ), 0) AS `invalid_check_type_count`
FROM `net_guard_migration_v3_test`.`risk_events`;

SELECT
    `check_type`,
    COUNT(*) AS `actual_count`,
    CASE `check_type`
        WHEN 'ai' THEN 2
        WHEN 'url' THEN 2
        WHEN 'rule' THEN 2
        ELSE 0
    END AS `expected_count`,
    CASE
        WHEN `check_type` = 'ai' AND COUNT(*) = 2 THEN 'PASS'
        WHEN `check_type` = 'url' AND COUNT(*) = 2 THEN 'PASS'
        WHEN `check_type` = 'rule' AND COUNT(*) = 2 THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `net_guard_migration_v3_test`.`risk_events`
WHERE JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
          IN ('security_logs', 'detection_records')
  AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
GROUP BY `check_type`
ORDER BY `check_type`;

-- 2. 六条历史 fixture 的正式字段及 details 来源逐条核验。
SELECT
    `expected`.`fixture_case`,
    `actual`.`event_uuid`,
    `actual`.`event_type` AS `actual_event_type`,
    `expected`.`expected_event_type`,
    `actual`.`check_type` AS `actual_check_type`,
    `expected`.`expected_check_type`,
    JSON_UNQUOTE(
        JSON_EXTRACT(`actual`.`details`, '$.legacy_table')
    ) AS `actual_legacy_table`,
    `expected`.`expected_legacy_table`,
    JSON_UNQUOTE(
        JSON_EXTRACT(`actual`.`details`, '$.legacy_id')
    ) AS `actual_legacy_id`,
    `expected`.`expected_legacy_id`,
    JSON_UNQUOTE(
        JSON_EXTRACT(`actual`.`details`, '$.legacy_type')
    ) AS `actual_legacy_type`,
    `expected`.`expected_legacy_type`,
    JSON_UNQUOTE(
        JSON_EXTRACT(`actual`.`details`, '$.legacy_check_type')
    ) AS `actual_legacy_check_type`,
    `expected`.`expected_legacy_check_type`,
    JSON_LENGTH(`actual`.`details`) AS `actual_details_keys`,
    3 AS `expected_details_keys`,
    CASE
        WHEN `actual`.`event_uuid` IS NULL THEN 'FAIL'
        WHEN `actual`.`event_type` <> `expected`.`expected_event_type`
            THEN 'FAIL'
        WHEN `actual`.`check_type` <> `expected`.`expected_check_type`
            THEN 'FAIL'
        WHEN JSON_UNQUOTE(
                 JSON_EXTRACT(`actual`.`details`, '$.legacy_table')
             ) <> `expected`.`expected_legacy_table` THEN 'FAIL'
        WHEN JSON_UNQUOTE(
                 JSON_EXTRACT(`actual`.`details`, '$.legacy_id')
             ) <> `expected`.`expected_legacy_id` THEN 'FAIL'
        WHEN `expected`.`expected_legacy_type` IS NOT NULL
             AND COALESCE(
                 JSON_UNQUOTE(
                     JSON_EXTRACT(`actual`.`details`, '$.legacy_type')
                 ),
                 ''
             ) <> `expected`.`expected_legacy_type` THEN 'FAIL'
        WHEN `expected`.`expected_legacy_type` IS NULL
             AND JSON_EXTRACT(
                 `actual`.`details`, '$.legacy_type'
             ) IS NOT NULL THEN 'FAIL'
        WHEN `expected`.`expected_legacy_check_type` IS NOT NULL
             AND COALESCE(
                 JSON_UNQUOTE(
                     JSON_EXTRACT(
                         `actual`.`details`, '$.legacy_check_type'
                     )
                 ),
                 ''
             ) <> `expected`.`expected_legacy_check_type` THEN 'FAIL'
        WHEN `expected`.`expected_legacy_check_type` IS NULL
             AND JSON_EXTRACT(
                 `actual`.`details`, '$.legacy_check_type'
             ) IS NOT NULL THEN 'FAIL'
        WHEN JSON_LENGTH(`actual`.`details`) <> 3 THEN 'FAIL'
        ELSE 'PASS'
    END AS `status`
FROM (
    SELECT
        'A-security-ai' AS `fixture_case`,
        '00000000-0000-4000-8000-000000000101' AS `event_uuid`,
        'extension_risk' AS `expected_event_type`,
        'ai' AS `expected_check_type`,
        'security_logs' AS `expected_legacy_table`,
        '101' AS `expected_legacy_id`,
        'ai_check' AS `expected_legacy_type`,
        CAST(NULL AS CHAR(20)) AS `expected_legacy_check_type`
    UNION ALL
    SELECT
        'B-security-url',
        '00000000-0000-4000-8000-000000000102',
        'extension_risk', 'url', 'security_logs', '102',
        'url_check', NULL
    UNION ALL
    SELECT
        'C-security-child-mode',
        '00000000-0000-4000-8000-000000000103',
        'extension_risk', 'rule', 'security_logs', '103',
        'child_mode', NULL
    UNION ALL
    SELECT
        'D-detection-text',
        '00000000-0000-4000-8000-000000000201',
        'extension_risk', 'ai', 'detection_records', '201',
        NULL, 'text'
    UNION ALL
    SELECT
        'E-detection-url',
        '00000000-0000-4000-8000-000000000202',
        'extension_risk', 'url', 'detection_records', '202',
        NULL, 'url'
    UNION ALL
    SELECT
        'F-detection-rule',
        '00000000-0000-4000-8000-000000000203',
        'extension_risk', 'rule', 'detection_records', '203',
        NULL, 'rule'
) AS `expected`
LEFT JOIN `net_guard_migration_v3_test`.`risk_events` AS `actual`
    ON `actual`.`event_uuid` = `expected`.`event_uuid`
ORDER BY `expected`.`fixture_case`;

-- 3. 正常新事件全字段保护。它没有 legacy_table/legacy_id，
-- 第一次和第二次 v3 均不得修改。
SELECT
    `id`,
    `event_uuid`,
    `event_type`,
    `check_type`,
    `risk_level`,
    `risk_score`,
    `url`,
    `reason`,
    `source`,
    `occurred_at`,
    `created_at`,
    CASE
        WHEN `id` <> 1007 THEN 'FAIL'
        WHEN `user_id` IS NOT NULL THEN 'FAIL'
        WHEN `event_type` <> 'extension_risk' THEN 'FAIL'
        WHEN `check_type` <> 'ai' THEN 'FAIL'
        WHEN `risk_level` <> 'medium' THEN 'FAIL'
        WHEN `risk_score` <> 0.5500 THEN 'FAIL'
        WHEN `url` <> 'https://v3-fixture.invalid/new/untouched'
            THEN 'FAIL'
        WHEN `url_hash` <> SHA2(
            'https://v3-fixture.invalid/new/untouched', 256
        ) THEN 'FAIL'
        WHEN `reason` <>
            '[V3 FIXTURE] normal new event must remain unchanged'
            THEN 'FAIL'
        WHEN `source` <> 'extension' THEN 'FAIL'
        WHEN `occurred_at` <> '2026-01-15 02:00:00.123456'
            THEN 'FAIL'
        WHEN `created_at` <> '2026-01-15 02:00:01.654321'
            THEN 'FAIL'
        WHEN JSON_LENGTH(`details`) <> 2 THEN 'FAIL'
        WHEN JSON_UNQUOTE(
            JSON_EXTRACT(`details`, '$.fixture_case')
        ) <> 'normal-new-event' THEN 'FAIL'
        WHEN JSON_UNQUOTE(
            JSON_EXTRACT(`details`, '$.immutable_marker')
        ) <> 'v3-must-not-change' THEN 'FAIL'
        WHEN JSON_CONTAINS_PATH(
            `details`,
            'one',
            '$.legacy_table',
            '$.legacy_id',
            '$.legacy_type',
            '$.legacy_check_type'
        ) <> 0 THEN 'FAIL'
        ELSE 'PASS'
    END AS `status`
FROM `net_guard_migration_v3_test`.`risk_events`
WHERE `event_uuid` = '00000000-0000-4000-8000-000000009001';

-- 4. 精确验证 fixture 集合和 event_uuid 唯一性，排除新增、删除或替换。
SELECT
    COUNT(*) AS `actual_total`,
    COUNT(DISTINCT `event_uuid`) AS `actual_unique_uuids`,
    COALESCE(SUM(`event_uuid` IN (
        '00000000-0000-4000-8000-000000000101',
        '00000000-0000-4000-8000-000000000102',
        '00000000-0000-4000-8000-000000000103',
        '00000000-0000-4000-8000-000000000201',
        '00000000-0000-4000-8000-000000000202',
        '00000000-0000-4000-8000-000000000203',
        '00000000-0000-4000-8000-000000009001'
    )), 0) AS `expected_fixture_rows_found`,
    CASE
        WHEN COUNT(*) = 7
         AND COUNT(DISTINCT `event_uuid`) = 7
         AND COALESCE(SUM(`event_uuid` IN (
             '00000000-0000-4000-8000-000000000101',
             '00000000-0000-4000-8000-000000000102',
             '00000000-0000-4000-8000-000000000103',
             '00000000-0000-4000-8000-000000000201',
             '00000000-0000-4000-8000-000000000202',
             '00000000-0000-4000-8000-000000000203',
             '00000000-0000-4000-8000-000000009001'
         )), 0) = 7 THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `net_guard_migration_v3_test`.`risk_events`;

-- 5. 迁移后最终分布；两次验证输出应逐项一致。
SELECT
    `event_type`,
    `check_type`,
    COUNT(*) AS `row_count`
FROM `net_guard_migration_v3_test`.`risk_events`
GROUP BY `event_type`, `check_type`
ORDER BY `event_type`, `check_type`;

-- 6. 稳定指纹。记录第一次输出，第二次执行 v3 后应逐字符相同；
-- 这同时覆盖正式字段、details 和正常新事件未被重复污染。
SELECT
    MD5(GROUP_CONCAT(
        MD5(CONCAT_WS(
                '|',
                `id`,
                `event_uuid`,
                COALESCE(`user_id`, 'NULL'),
                `event_type`,
                `check_type`,
                `risk_level`,
                `risk_score`,
                COALESCE(`url`, 'NULL'),
                COALESCE(`url_hash`, 'NULL'),
                COALESCE(`reason`, 'NULL'),
                `source`,
                COALESCE(CAST(`details` AS CHAR), 'NULL'),
                `occurred_at`,
                `created_at`
            ))
        ORDER BY `id`
        SEPARATOR ''
    )) AS `risk_events_fingerprint`,
    'Compare this value after the first and second v3 execution'
        AS `expected_result`
FROM `net_guard_migration_v3_test`.`risk_events`;
