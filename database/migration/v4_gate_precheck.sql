-- SmartGuard-NetGuard Gate v4 mixed-schema migration precheck
--
-- This file is strictly read-only: every executable statement is SELECT.
-- Run it with a utf8mb4 client after selecting either:
--   net_guard                       (formal migration window), or
--   net_guard_gate_migration_test   (disposable rehearsal clone).
--
-- Any FAIL result means that migration must stop. The upgrade script repeats
-- the critical checks and raises SQLSTATE 45000 before its first DDL, so this
-- report cannot be bypassed by accidentally continuing after a failed check.

-- 0. Target and server capabilities.
SELECT
    DATABASE() AS `selected_database`,
    VERSION() AS `mysql_version`,
    @@SESSION.sql_mode AS `session_sql_mode`,
    @@character_set_connection AS `connection_character_set`,
    CASE
        WHEN LOWER(COALESCE(DATABASE(), '')) IN (
            'net_guard',
            'net_guard_gate_migration_test'
        ) THEN 'PASS'
        ELSE 'FAIL'
    END AS `target_status`,
    CASE
        WHEN SUBSTRING_INDEX(VERSION(), '-', 1) = '5.7.26'
          OR (
              CAST(SUBSTRING_INDEX(VERSION(), '.', 1) AS UNSIGNED) = 5
              AND CAST(SUBSTRING_INDEX(
                      SUBSTRING_INDEX(VERSION(), '.', 2), '.', -1
                  ) AS UNSIGNED) = 7
              AND CAST(SUBSTRING_INDEX(
                      SUBSTRING_INDEX(VERSION(), '-', 1), '.', -1
                  ) AS UNSIGNED) >= 8
          ) THEN 'PASS'
        ELSE 'FAIL'
    END AS `mysql_57_status`,
    CASE
        WHEN FIND_IN_SET(
            'NO_ENGINE_SUBSTITUTION',
            UPPER(COALESCE(@@SESSION.sql_mode, ''))
        ) > 0 THEN 'PASS'
        ELSE 'FAIL'
    END AS `sql_mode_status`;

-- 1. Required mixed-state tables must exist, while all v4 work/archive names
-- must still be absent. Their presence indicates a previous partial attempt.
SELECT
    'required_mixed_tables' AS `check_name`,
    COUNT(*) AS `actual_count`,
    8 AS `expected_count`,
    CASE WHEN COUNT(*) = 8 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_type` = 'BASE TABLE'
  AND `table_name` IN (
      'users',
      'user_settings',
      'risk_events',
      'ad_events',
      'settings',
      'security_logs',
      'detection_records',
      'url_blacklist'
  )
UNION ALL
SELECT
    'v4_names_must_be_absent',
    COUNT(*),
    0,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users_legacy_gate_20260831',
      'user_settings_legacy_gate_20260831',
      'risk_events_gate_new',
      'ad_events_gate_new',
      'settings_gate_new',
      'risk_events_pre_gate_20260831',
      'ad_events_pre_gate_20260831',
      'settings_pre_gate_20260831'
  );

-- 2. Inventory is deliberately reported before detailed checks so an operator
-- can compare row counts and AUTO_INCREMENT values with the backup manifest.
SELECT
    `table_name`,
    `engine`,
    `table_collation`,
    `auto_increment`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
ORDER BY `table_name`;

-- The compatibility ALTER statements add these two indexes. Their names must
-- be absent in the audited source, otherwise a later ALTER could fail only
-- after identity tables and staging data have already been created.
SELECT
    'legacy_target_index_names_must_be_absent' AS `check_name`,
    COUNT(*) AS `failure_count`,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `information_schema`.`statistics`
WHERE `table_schema` = DATABASE()
  AND `table_name` = 'security_logs'
  AND `index_name` IN (
      'ix_security_logs_type_created_at',
      'ix_security_logs_risk_created_at'
  );

SELECT 'users' AS `table_name`, COUNT(*) AS `row_count` FROM `users`
UNION ALL SELECT 'user_settings', COUNT(*) FROM `user_settings`
UNION ALL SELECT 'risk_events', COUNT(*) FROM `risk_events`
UNION ALL SELECT 'ad_events', COUNT(*) FROM `ad_events`
UNION ALL SELECT 'settings', COUNT(*) FROM `settings`
UNION ALL SELECT 'security_logs', COUNT(*) FROM `security_logs`
UNION ALL SELECT 'detection_records', COUNT(*) FROM `detection_records`
UNION ALL SELECT 'url_blacklist', COUNT(*) FROM `url_blacklist`;

-- 3. The input must be the audited mixed schema, not a clean v1 schema and not
-- an unknown partial migration. Exact column names are checked here; the
-- upgrade repeats the critical signatures before changing anything.
SELECT
    `expected`.`table_name`,
    `expected`.`expected_columns`,
    COUNT(`actual`.`column_name`) AS `actual_columns`,
    CASE
        WHEN COUNT(`actual`.`column_name`) = `expected`.`expected_columns`
         AND SUM(`actual`.`column_name` IS NULL) = 0 THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM (
    SELECT 'users' AS `table_name`, 8 AS `expected_columns`
    UNION ALL SELECT 'user_settings', 4
    UNION ALL SELECT 'risk_events', 14
    UNION ALL SELECT 'ad_events', 15
    UNION ALL SELECT 'settings', 7
    UNION ALL SELECT 'security_logs', 6
    UNION ALL SELECT 'detection_records', 7
    UNION ALL SELECT 'url_blacklist', 10
) AS `expected`
LEFT JOIN `information_schema`.`columns` AS `actual`
    ON `actual`.`table_schema` = DATABASE()
   AND `actual`.`table_name` = `expected`.`table_name`
GROUP BY `expected`.`table_name`, `expected`.`expected_columns`
ORDER BY `expected`.`table_name`;

SELECT
    `expected`.`table_name`,
    `expected`.`expected_signature`,
    `actual`.`actual_signature`,
    CASE
        WHEN `actual`.`actual_signature` = `expected`.`expected_signature`
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM (
    SELECT
        'users' AS `table_name`,
        'id,username,email,password_hash,created_at,updated_at,role,mode'
            AS `expected_signature`
    UNION ALL SELECT
        'user_settings', 'id,user_id,mode,updated_at'
    UNION ALL SELECT
        'risk_events',
        'id,event_uuid,user_id,event_type,check_type,risk_level,risk_score,url,url_hash,reason,source,details,occurred_at,created_at'
    UNION ALL SELECT
        'ad_events',
        'id,event_uuid,user_id,action,mode,page_url,url_hash,resource_type,rule_id,blocked_count,reason,source,details,occurred_at,created_at'
    UNION ALL SELECT
        'settings',
        'id,user_id,mode,preferences,version,created_at,updated_at'
    UNION ALL SELECT
        'security_logs', 'id,type,risk_level,url,reason,created_at'
    UNION ALL SELECT
        'detection_records',
        'id,check_type,url,risk_level,risk_score,user_id,created_at'
    UNION ALL SELECT
        'url_blacklist',
        'id,domain,match_type,risk_level,score,reason,enabled,source,created_at,updated_at'
) AS `expected`
LEFT JOIN (
    SELECT
        `table_name`,
        GROUP_CONCAT(
            `column_name` ORDER BY `ordinal_position` SEPARATOR ','
        ) AS `actual_signature`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` IN (
          'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
          'security_logs', 'detection_records', 'url_blacklist'
      )
    GROUP BY `table_name`
) AS `actual` ON `actual`.`table_name` = `expected`.`table_name`
ORDER BY `expected`.`table_name`;

SELECT
    'legacy_users_signature' AS `check_name`,
    COUNT(*) AS `matching_columns`,
    8 AS `expected_columns`,
    CASE WHEN COUNT(*) = 8 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `information_schema`.`columns`
WHERE `table_schema` = DATABASE()
  AND `table_name` = 'users'
  AND (
      (`column_name` = 'id' AND `data_type` IN ('int', 'bigint')
       AND `column_key` = 'PRI'
       AND LOWER(`extra`) LIKE '%auto_increment%')
      OR (`column_name` = 'username' AND `data_type` = 'varchar')
      OR (`column_name` = 'email' AND `data_type` = 'varchar')
      OR (`column_name` = 'password_hash' AND `data_type` = 'varchar')
      OR (`column_name` = 'created_at'
          AND `data_type` IN ('datetime', 'timestamp'))
      OR (`column_name` = 'updated_at'
          AND `data_type` IN ('datetime', 'timestamp'))
      OR (`column_name` = 'role' AND `data_type` = 'varchar')
      OR (`column_name` = 'mode' AND `data_type` = 'varchar')
  )
UNION ALL
SELECT
    'formal_users_columns_must_be_absent',
    COUNT(*),
    0,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `information_schema`.`columns`
WHERE `table_schema` = DATABASE()
  AND `table_name` = 'users'
  AND `column_name` IN ('public_id', 'display_name', 'status');

SELECT
    `table_name`,
    `engine`,
    `table_collation`,
    CASE
        WHEN `table_name` IN (
            'risk_events', 'ad_events', 'settings', 'security_logs'
        ) AND UPPER(`engine`) = 'MYISAM'
         AND `table_collation` = 'utf8_unicode_ci' THEN 'PASS'
        WHEN `table_name` IN ('users', 'detection_records', 'url_blacklist')
         AND UPPER(`engine`) = 'INNODB'
         AND `table_collation` = 'utf8mb4_unicode_ci' THEN 'PASS'
        WHEN `table_name` = 'user_settings'
         AND UPPER(`engine`) IN ('MYISAM', 'INNODB') THEN 'PASS'
        ELSE 'FAIL'
    END AS `mixed_engine_status`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
      'security_logs', 'detection_records', 'url_blacklist'
  )
ORDER BY `table_name`;

-- 4. Hard data failures. Every row below must report zero failures.
SELECT
    'legacy_users_must_be_empty' AS `check_name`,
    COUNT(*) AS `failure_count`,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `users`
UNION ALL
SELECT
    'existing_settings_must_be_empty',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `settings`
UNION ALL
SELECT
    'risk_event_uuid_duplicates',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT `event_uuid`
    FROM `risk_events`
    GROUP BY `event_uuid`
    HAVING COUNT(*) > 1
) AS `risk_uuid_duplicates`
UNION ALL
SELECT
    'ad_event_uuid_duplicates',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT `event_uuid`
    FROM `ad_events`
    GROUP BY `event_uuid`
    HAVING COUNT(*) > 1
) AS `ad_uuid_duplicates`
UNION ALL
SELECT
    'risk_event_uuid_invalid',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `risk_events`
WHERE `event_uuid` IS NULL
   OR `event_uuid` NOT REGEXP
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
UNION ALL
SELECT
    'ad_event_uuid_invalid',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `ad_events`
WHERE `event_uuid` IS NULL
   OR `event_uuid` NOT REGEXP
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
UNION ALL
SELECT
    'settings_user_id_duplicates',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT `user_id`
    FROM `settings`
    GROUP BY `user_id`
    HAVING COUNT(*) > 1
) AS `setting_duplicates`
UNION ALL
SELECT
    'risk_user_candidates_without_legacy_user',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `risk_events` AS `r`
LEFT JOIN `users` AS `u` ON `u`.`id` = `r`.`user_id`
WHERE `r`.`user_id` IS NOT NULL
  AND `u`.`id` IS NULL
UNION ALL
SELECT
    'ad_user_candidates_without_legacy_user',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `ad_events` AS `a`
LEFT JOIN `users` AS `u` ON `u`.`id` = `a`.`user_id`
WHERE `a`.`user_id` IS NOT NULL
  AND `u`.`id` IS NULL
UNION ALL
SELECT
    'settings_user_candidates_without_legacy_user',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `settings` AS `s`
LEFT JOIN `users` AS `u` ON `u`.`id` = `s`.`user_id`
WHERE `s`.`user_id` IS NULL
   OR `u`.`id` IS NULL
UNION ALL
SELECT
    'risk_required_or_contract_invalid',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `risk_events`
WHERE `event_uuid` IS NULL
   OR `event_type` IS NULL
   OR `check_type` IS NULL
   OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
   OR `risk_score` IS NULL
   OR `risk_score` < 0
   OR `risk_score` > 1
   OR `source` IS NULL
   OR `occurred_at` IS NULL
   OR `created_at` IS NULL
   OR NOT (
       (`event_type` = 'extension_risk'
        AND `check_type` IN ('ai', 'url', 'rule'))
       OR (`event_type` = 'ai_check' AND `check_type` = 'text')
       OR (`event_type` = 'url_check' AND `check_type` = 'url')
   )
UNION ALL
SELECT
    'ad_required_or_contract_invalid',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `ad_events`
WHERE `event_uuid` IS NULL
   OR `action` NOT IN ('blocked', 'hidden', 'allowed')
   OR `mode` NOT IN ('normal', 'strict', 'elder', 'child')
   OR `blocked_count` IS NULL
   OR `source` IS NULL
   OR `occurred_at` IS NULL
   OR `created_at` IS NULL
UNION ALL
SELECT
    'invalid_json_payloads',
    (
        SELECT COUNT(*) FROM `risk_events`
        WHERE `details` IS NOT NULL AND JSON_VALID(`details`) = 0
    ) + (
        SELECT COUNT(*) FROM `ad_events`
        WHERE `details` IS NOT NULL AND JSON_VALID(`details`) = 0
    ) + (
        SELECT COUNT(*) FROM `settings`
        WHERE JSON_VALID(`preferences`) = 0
    ),
    CASE WHEN (
        (SELECT COUNT(*) FROM `risk_events`
         WHERE `details` IS NOT NULL AND JSON_VALID(`details`) = 0)
        + (SELECT COUNT(*) FROM `ad_events`
           WHERE `details` IS NOT NULL AND JSON_VALID(`details`) = 0)
        + (SELECT COUNT(*) FROM `settings`
           WHERE JSON_VALID(`preferences`) = 0)
    ) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT
    'url_or_text_length_overflow',
    (
        SELECT COUNT(*) FROM `risk_events`
        WHERE CHAR_LENGTH(`url`) > 4096
           OR CHAR_LENGTH(`reason`) > 1000
           OR CHAR_LENGTH(`source`) > 20
    ) + (
        SELECT COUNT(*) FROM `ad_events`
        WHERE CHAR_LENGTH(`page_url`) > 4096
           OR CHAR_LENGTH(`resource_type`) > 32
           OR CHAR_LENGTH(`rule_id`) > 100
           OR CHAR_LENGTH(`reason`) > 500
           OR CHAR_LENGTH(`source`) > 20
    ) + (
        SELECT COUNT(*) FROM `detection_records`
        WHERE `url` IS NULL OR CHAR_LENGTH(`url`) > 500
    ) + (
        SELECT COUNT(*) FROM `security_logs`
        WHERE `url` IS NULL OR CHAR_LENGTH(`url`) > 500
           OR CHAR_LENGTH(`reason`) > 1000
    ),
    CASE WHEN (
        (SELECT COUNT(*) FROM `risk_events`
         WHERE CHAR_LENGTH(`url`) > 4096
            OR CHAR_LENGTH(`reason`) > 1000
            OR CHAR_LENGTH(`source`) > 20)
        + (SELECT COUNT(*) FROM `ad_events`
           WHERE CHAR_LENGTH(`page_url`) > 4096
              OR CHAR_LENGTH(`resource_type`) > 32
              OR CHAR_LENGTH(`rule_id`) > 100
              OR CHAR_LENGTH(`reason`) > 500
              OR CHAR_LENGTH(`source`) > 20)
        + (SELECT COUNT(*) FROM `detection_records`
           WHERE `url` IS NULL OR CHAR_LENGTH(`url`) > 500)
        + (SELECT COUNT(*) FROM `security_logs`
           WHERE `url` IS NULL OR CHAR_LENGTH(`url`) > 500
              OR CHAR_LENGTH(`reason`) > 1000)
    ) = 0 THEN 'PASS' ELSE 'FAIL' END
UNION ALL
SELECT
    'utf8mb4_unique_collision_candidates',
    (
        SELECT COUNT(*) FROM (
            SELECT CONVERT(`event_uuid` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `risk_events`
            GROUP BY `new_value`
            HAVING COUNT(*) > 1
        ) AS `risk_collisions`
    ) + (
        SELECT COUNT(*) FROM (
            SELECT CONVERT(`event_uuid` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `ad_events`
            GROUP BY `new_value`
            HAVING COUNT(*) > 1
        ) AS `ad_collisions`
    ) + (
        SELECT COUNT(*) FROM (
            SELECT CONVERT(`domain` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `url_blacklist`
            GROUP BY `new_value`
            HAVING COUNT(*) > 1
        ) AS `blacklist_collisions`
    ),
    CASE WHEN (
        (SELECT COUNT(*) FROM (
            SELECT CONVERT(`event_uuid` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `risk_events` GROUP BY `new_value` HAVING COUNT(*) > 1
        ) AS `risk_collisions_again`)
        + (SELECT COUNT(*) FROM (
            SELECT CONVERT(`event_uuid` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `ad_events` GROUP BY `new_value` HAVING COUNT(*) > 1
        ) AS `ad_collisions_again`)
        + (SELECT COUNT(*) FROM (
            SELECT CONVERT(`domain` USING utf8mb4)
                COLLATE utf8mb4_unicode_ci AS `new_value`
            FROM `url_blacklist` GROUP BY `new_value` HAVING COUNT(*) > 1
        ) AS `blacklist_collisions_again`)
    ) = 0 THEN 'PASS' ELSE 'FAIL' END;

-- 5. The audited orphan is expected and is archived without being associated
-- with the new Demo user. Invalid modes are still a hard failure.
SELECT
    COUNT(*) AS `legacy_user_settings_total`,
    COALESCE(SUM(`u`.`id` IS NULL), 0) AS `orphan_count`,
    COALESCE(SUM(
        `us`.`mode` IS NULL
        OR `us`.`mode` NOT IN ('normal', 'strict', 'elder', 'child')
    ), 0) AS `invalid_mode_count`,
    CASE
        WHEN COUNT(*) <= 1
         AND COALESCE(SUM(`u`.`id` IS NULL), 0) = COUNT(*)
         AND COALESCE(SUM(
             `us`.`mode` IS NULL
             OR `us`.`mode` NOT IN ('normal', 'strict', 'elder', 'child')
         ), 0) = 0 THEN 'EXPECTED_ARCHIVE_ONLY'
        ELSE 'FAIL'
    END AS `status`
FROM `user_settings` AS `us`
LEFT JOIN `users` AS `u` ON `u`.`id` = `us`.`user_id`;

-- 6. Risk score anomalies are reported only. In particular, a historical
-- detection_records score such as 3.9824 must never be silently divided,
-- clamped or otherwise rewritten by this Gate migration.
SELECT
    'risk_events' AS `source_table`,
    SUM(`risk_score` IS NULL) AS `null_score_count`,
    SUM(`risk_score` < 0) AS `negative_score_count`,
    SUM(`risk_score` BETWEEN 0 AND 1) AS `zero_to_one_count`,
    SUM(`risk_score` > 1) AS `over_one_report_only`
FROM `risk_events`
UNION ALL
SELECT
    'detection_records',
    SUM(`risk_score` IS NULL),
    SUM(`risk_score` < 0),
    SUM(`risk_score` BETWEEN 0 AND 1),
    SUM(`risk_score` > 1)
FROM `detection_records`;

-- 7. Human-readable distributions used to approve the conversion scope.
SELECT `event_type`, `check_type`, COUNT(*) AS `row_count`
FROM `risk_events`
GROUP BY `event_type`, `check_type`
ORDER BY `event_type`, `check_type`;

SELECT `mode`, COUNT(*) AS `row_count`, SUM(`blocked_count`) AS `blocked_total`
FROM `ad_events`
GROUP BY `mode`
ORDER BY `mode`;

SELECT `type`, COUNT(*) AS `row_count`
FROM `security_logs`
GROUP BY `type`
ORDER BY `type`;

SELECT `check_type`, `risk_level`, COUNT(*) AS `row_count`,
       MIN(`risk_score`) AS `minimum_score`,
       MAX(`risk_score`) AS `maximum_score`
FROM `detection_records`
GROUP BY `check_type`, `risk_level`
ORDER BY `check_type`, `risk_level`;
