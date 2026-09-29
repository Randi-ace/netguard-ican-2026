-- SmartGuard-NetGuard Gate v4 post-migration verification
--
-- Strictly read-only: every executable statement is SELECT. Run it after
-- selecting net_guard, or against the disposable rehearsal clone named
-- net_guard_gate_migration_test. Save the complete output as Gate evidence.

-- 0. Target, version and database defaults.
SELECT
    DATABASE() AS `selected_database`,
    VERSION() AS `mysql_version`,
    `schema`.`default_character_set_name`,
    `schema`.`default_collation_name`,
    CASE
        WHEN LOWER(COALESCE(DATABASE(), '')) IN (
            'net_guard',
            'net_guard_gate_migration_test'
        )
         AND `schema`.`default_character_set_name` = 'utf8mb4'
         AND `schema`.`default_collation_name` = 'utf8mb4_unicode_ci'
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `information_schema`.`schemata` AS `schema`
WHERE `schema`.`schema_name` = DATABASE();

-- 1. Formal, compatibility and preserved archive tables.
SELECT
    'formal_and_compatibility_tables' AS `check_name`,
    COUNT(*) AS `actual_count`,
    8 AS `expected_count`,
    CASE WHEN COUNT(*) = 8 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
      'security_logs', 'detection_records', 'url_blacklist'
  )
UNION ALL
SELECT
    'preserved_gate_archives',
    COUNT(*),
    5,
    CASE WHEN COUNT(*) = 5 THEN 'PASS' ELSE 'FAIL' END
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users_legacy_gate_20260831',
      'user_settings_legacy_gate_20260831',
      'risk_events_pre_gate_20260831',
      'ad_events_pre_gate_20260831',
      'settings_pre_gate_20260831'
  )
UNION ALL
SELECT
    'gate_staging_tables_removed_by_rename',
    COUNT(*),
    0,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'risk_events_gate_new', 'ad_events_gate_new', 'settings_gate_new'
  );

-- 2. All current ORM tables must be InnoDB/utf8mb4. The dated archives keep
-- their original engines and collations by design and are not included here.
SELECT
    `table_name`,
    `engine`,
    `table_collation`,
    CASE
        WHEN UPPER(`engine`) = 'INNODB'
         AND `table_collation` = 'utf8mb4_unicode_ci' THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
      'security_logs', 'detection_records', 'url_blacklist'
  )
ORDER BY `table_name`;

-- 3. Exact ORM column membership and critical types/nullability/defaults.
SELECT
    `expected`.`table_name`,
    COUNT(`actual`.`column_name`) AS `matched_columns`,
    MAX(`expected`.`expected_count`) AS `expected_columns`,
    CASE
        WHEN COUNT(`actual`.`column_name`)
             = MAX(`expected`.`expected_count`)
         AND (
             SELECT COUNT(*)
             FROM `information_schema`.`columns` AS `all_columns`
             WHERE `all_columns`.`table_schema` = DATABASE()
               AND `all_columns`.`table_name` = `expected`.`table_name`
         ) = MAX(`expected`.`expected_count`)
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM (
    SELECT 'users' AS `table_name`, 'id' AS `column_name`, 8 AS `expected_count`
    UNION ALL SELECT 'users', 'public_id', 8
    UNION ALL SELECT 'users', 'username', 8
    UNION ALL SELECT 'users', 'display_name', 8
    UNION ALL SELECT 'users', 'role', 8
    UNION ALL SELECT 'users', 'status', 8
    UNION ALL SELECT 'users', 'created_at', 8
    UNION ALL SELECT 'users', 'updated_at', 8
    UNION ALL SELECT 'user_settings', 'id', 5
    UNION ALL SELECT 'user_settings', 'setting_key', 5
    UNION ALL SELECT 'user_settings', 'setting_value', 5
    UNION ALL SELECT 'user_settings', 'created_at', 5
    UNION ALL SELECT 'user_settings', 'updated_at', 5
    UNION ALL SELECT 'risk_events', 'id', 14
    UNION ALL SELECT 'risk_events', 'event_uuid', 14
    UNION ALL SELECT 'risk_events', 'user_id', 14
    UNION ALL SELECT 'risk_events', 'event_type', 14
    UNION ALL SELECT 'risk_events', 'check_type', 14
    UNION ALL SELECT 'risk_events', 'risk_level', 14
    UNION ALL SELECT 'risk_events', 'risk_score', 14
    UNION ALL SELECT 'risk_events', 'url', 14
    UNION ALL SELECT 'risk_events', 'url_hash', 14
    UNION ALL SELECT 'risk_events', 'reason', 14
    UNION ALL SELECT 'risk_events', 'source', 14
    UNION ALL SELECT 'risk_events', 'details', 14
    UNION ALL SELECT 'risk_events', 'occurred_at', 14
    UNION ALL SELECT 'risk_events', 'created_at', 14
    UNION ALL SELECT 'ad_events', 'id', 15
    UNION ALL SELECT 'ad_events', 'event_uuid', 15
    UNION ALL SELECT 'ad_events', 'user_id', 15
    UNION ALL SELECT 'ad_events', 'action', 15
    UNION ALL SELECT 'ad_events', 'mode', 15
    UNION ALL SELECT 'ad_events', 'page_url', 15
    UNION ALL SELECT 'ad_events', 'url_hash', 15
    UNION ALL SELECT 'ad_events', 'resource_type', 15
    UNION ALL SELECT 'ad_events', 'rule_id', 15
    UNION ALL SELECT 'ad_events', 'blocked_count', 15
    UNION ALL SELECT 'ad_events', 'reason', 15
    UNION ALL SELECT 'ad_events', 'source', 15
    UNION ALL SELECT 'ad_events', 'details', 15
    UNION ALL SELECT 'ad_events', 'occurred_at', 15
    UNION ALL SELECT 'ad_events', 'created_at', 15
    UNION ALL SELECT 'settings', 'id', 7
    UNION ALL SELECT 'settings', 'user_id', 7
    UNION ALL SELECT 'settings', 'mode', 7
    UNION ALL SELECT 'settings', 'preferences', 7
    UNION ALL SELECT 'settings', 'version', 7
    UNION ALL SELECT 'settings', 'created_at', 7
    UNION ALL SELECT 'settings', 'updated_at', 7
    UNION ALL SELECT 'url_blacklist', 'id', 10
    UNION ALL SELECT 'url_blacklist', 'domain', 10
    UNION ALL SELECT 'url_blacklist', 'match_type', 10
    UNION ALL SELECT 'url_blacklist', 'risk_level', 10
    UNION ALL SELECT 'url_blacklist', 'score', 10
    UNION ALL SELECT 'url_blacklist', 'reason', 10
    UNION ALL SELECT 'url_blacklist', 'enabled', 10
    UNION ALL SELECT 'url_blacklist', 'source', 10
    UNION ALL SELECT 'url_blacklist', 'created_at', 10
    UNION ALL SELECT 'url_blacklist', 'updated_at', 10
    UNION ALL SELECT 'security_logs', 'id', 6
    UNION ALL SELECT 'security_logs', 'type', 6
    UNION ALL SELECT 'security_logs', 'risk_level', 6
    UNION ALL SELECT 'security_logs', 'url', 6
    UNION ALL SELECT 'security_logs', 'reason', 6
    UNION ALL SELECT 'security_logs', 'created_at', 6
    UNION ALL SELECT 'detection_records', 'id', 10
    UNION ALL SELECT 'detection_records', 'url', 10
    UNION ALL SELECT 'detection_records', 'is_high_risk', 10
    UNION ALL SELECT 'detection_records', 'is_phishing', 10
    UNION ALL SELECT 'detection_records', 'risk_level', 10
    UNION ALL SELECT 'detection_records', 'risk_score', 10
    UNION ALL SELECT 'detection_records', 'check_type', 10
    UNION ALL SELECT 'detection_records', 'user_id', 10
    UNION ALL SELECT 'detection_records', 'reason', 10
    UNION ALL SELECT 'detection_records', 'created_at', 10
) AS `expected`
LEFT JOIN `information_schema`.`columns` AS `actual`
    ON `actual`.`table_schema` = DATABASE()
   AND `actual`.`table_name` = `expected`.`table_name`
   AND `actual`.`column_name` = `expected`.`column_name`
GROUP BY `expected`.`table_name`
ORDER BY `expected`.`table_name`;

SELECT
    `table_name`, `column_name`, `column_type`, `is_nullable`,
    `column_default`, `extra`, `character_set_name`, `collation_name`
FROM `information_schema`.`columns`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
      'security_logs', 'detection_records', 'url_blacklist'
  )
ORDER BY `table_name`, `ordinal_position`;

-- 4. Primary/unique indexes required by the current model.
SELECT
    `expected`.`table_name`,
    `expected`.`index_name`,
    `expected`.`expected_columns`,
    GROUP_CONCAT(
        `actual`.`column_name`
        ORDER BY `actual`.`seq_in_index`
        SEPARATOR ','
    ) AS `actual_columns`,
    MIN(`actual`.`non_unique`) AS `non_unique`,
    CASE
        WHEN GROUP_CONCAT(
            `actual`.`column_name`
            ORDER BY `actual`.`seq_in_index`
            SEPARATOR ','
        ) = `expected`.`expected_columns`
         AND MIN(`actual`.`non_unique`) = `expected`.`expected_non_unique`
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM (
    SELECT 'users' AS `table_name`, 'PRIMARY' AS `index_name`,
           'id' AS `expected_columns`, 0 AS `expected_non_unique`
    UNION ALL SELECT 'users', 'uq_users_public_id', 'public_id', 0
    UNION ALL SELECT 'users', 'uq_users_username', 'username', 0
    UNION ALL SELECT 'users', 'ix_users_status_created_at',
                     'status,created_at', 1
    UNION ALL SELECT 'risk_events', 'uq_risk_events_event_uuid',
                     'event_uuid', 0
    UNION ALL SELECT 'ad_events', 'uq_ad_events_event_uuid',
                     'event_uuid', 0
    UNION ALL SELECT 'settings', 'uq_settings_user_id', 'user_id', 0
    UNION ALL SELECT 'url_blacklist', 'uq_url_blacklist_domain',
                     'domain', 0
    UNION ALL SELECT 'user_settings', 'uq_user_settings_setting_key',
                     'setting_key', 0
) AS `expected`
LEFT JOIN `information_schema`.`statistics` AS `actual`
    ON `actual`.`table_schema` = DATABASE()
   AND `actual`.`table_name` = `expected`.`table_name`
   AND `actual`.`index_name` = `expected`.`index_name`
GROUP BY
    `expected`.`table_name`,
    `expected`.`index_name`,
    `expected`.`expected_columns`,
    `expected`.`expected_non_unique`
ORDER BY `expected`.`table_name`, `expected`.`index_name`;

-- 5. Formal foreign keys and delete rules.
SELECT
    `expected`.`constraint_name`,
    `expected`.`table_name`,
    `expected`.`column_name`,
    `actual`.`referenced_table_name`,
    `actual`.`referenced_column_name`,
    `rule`.`delete_rule`,
    CASE
        WHEN `actual`.`referenced_table_name` = 'users'
         AND `actual`.`referenced_column_name` = 'id'
         AND `rule`.`delete_rule` = `expected`.`delete_rule`
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM (
    SELECT 'fk_risk_events_user' AS `constraint_name`,
           'risk_events' AS `table_name`, 'user_id' AS `column_name`,
           'SET NULL' AS `delete_rule`
    UNION ALL SELECT 'fk_ad_events_user', 'ad_events', 'user_id', 'SET NULL'
    UNION ALL SELECT 'fk_settings_user', 'settings', 'user_id', 'CASCADE'
) AS `expected`
LEFT JOIN `information_schema`.`key_column_usage` AS `actual`
    ON `actual`.`constraint_schema` = DATABASE()
   AND `actual`.`constraint_name` = `expected`.`constraint_name`
   AND `actual`.`table_name` = `expected`.`table_name`
   AND `actual`.`column_name` = `expected`.`column_name`
LEFT JOIN `information_schema`.`referential_constraints` AS `rule`
    ON `rule`.`constraint_schema` = `actual`.`constraint_schema`
   AND `rule`.`constraint_name` = `actual`.`constraint_name`
   AND `rule`.`table_name` = `actual`.`table_name`
ORDER BY `expected`.`table_name`;

-- 6. No formal orphan may remain.
SELECT
    'risk_events_user_orphans' AS `check_name`,
    COUNT(*) AS `orphan_count`,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `risk_events` AS `r`
LEFT JOIN `users` AS `u` ON `u`.`id` = `r`.`user_id`
WHERE `r`.`user_id` IS NOT NULL AND `u`.`id` IS NULL
UNION ALL
SELECT
    'ad_events_user_orphans',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `ad_events` AS `a`
LEFT JOIN `users` AS `u` ON `u`.`id` = `a`.`user_id`
WHERE `a`.`user_id` IS NOT NULL AND `u`.`id` IS NULL
UNION ALL
SELECT
    'settings_user_orphans',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM `settings` AS `s`
LEFT JOIN `users` AS `u` ON `u`.`id` = `s`.`user_id`
WHERE `u`.`id` IS NULL;

-- 7. Risk/ad preservation and normalization. Counts and UUID sets must be
-- identical to the dated source tables.
SELECT
    (SELECT COUNT(*) FROM `risk_events`) AS `risk_after_count`,
    (SELECT COUNT(*) FROM `risk_events_pre_gate_20260831`)
        AS `risk_before_count`,
    (SELECT COUNT(*) FROM `ad_events`) AS `ad_after_count`,
    (SELECT COUNT(*) FROM `ad_events_pre_gate_20260831`)
        AS `ad_before_count`,
    CASE
        WHEN (SELECT COUNT(*) FROM `risk_events`)
             = (SELECT COUNT(*) FROM `risk_events_pre_gate_20260831`)
         AND (SELECT COUNT(*) FROM `ad_events`)
             = (SELECT COUNT(*) FROM `ad_events_pre_gate_20260831`)
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`;

SELECT
    'risk_uuid_set_difference' AS `check_name`,
    (
        SELECT COUNT(*)
        FROM `risk_events_pre_gate_20260831` AS `old_row`
        LEFT JOIN `risk_events` AS `new_row`
            ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
        WHERE `new_row`.`event_uuid` IS NULL
    ) + (
        SELECT COUNT(*)
        FROM `risk_events` AS `new_row`
        LEFT JOIN `risk_events_pre_gate_20260831` AS `old_row`
            ON `old_row`.`event_uuid` = `new_row`.`event_uuid`
        WHERE `old_row`.`event_uuid` IS NULL
    ) AS `difference_count`,
    CASE WHEN (
        (SELECT COUNT(*)
         FROM `risk_events_pre_gate_20260831` AS `old_row`
         LEFT JOIN `risk_events` AS `new_row`
             ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
         WHERE `new_row`.`event_uuid` IS NULL)
        + (SELECT COUNT(*)
           FROM `risk_events` AS `new_row`
           LEFT JOIN `risk_events_pre_gate_20260831` AS `old_row`
               ON `old_row`.`event_uuid` = `new_row`.`event_uuid`
           WHERE `old_row`.`event_uuid` IS NULL)
    ) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
UNION ALL
SELECT
    'ad_uuid_set_difference',
    (
        SELECT COUNT(*)
        FROM `ad_events_pre_gate_20260831` AS `old_row`
        LEFT JOIN `ad_events` AS `new_row`
            ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
        WHERE `new_row`.`event_uuid` IS NULL
    ) + (
        SELECT COUNT(*)
        FROM `ad_events` AS `new_row`
        LEFT JOIN `ad_events_pre_gate_20260831` AS `old_row`
            ON `old_row`.`event_uuid` = `new_row`.`event_uuid`
        WHERE `old_row`.`event_uuid` IS NULL
    ),
    CASE WHEN (
        (SELECT COUNT(*)
         FROM `ad_events_pre_gate_20260831` AS `old_row`
         LEFT JOIN `ad_events` AS `new_row`
             ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
         WHERE `new_row`.`event_uuid` IS NULL)
        + (SELECT COUNT(*)
           FROM `ad_events` AS `new_row`
           LEFT JOIN `ad_events_pre_gate_20260831` AS `old_row`
               ON `old_row`.`event_uuid` = `new_row`.`event_uuid`
           WHERE `old_row`.`event_uuid` IS NULL)
    ) = 0 THEN 'PASS' ELSE 'FAIL' END;

SELECT
    COUNT(*) AS `noncanonical_risk_rows`,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM `risk_events`
WHERE `event_type` <> 'extension_risk'
   OR `check_type` NOT IN ('ai', 'url', 'rule')
   OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
   OR `risk_score` IS NULL OR `risk_score` < 0 OR `risk_score` > 1;

SELECT
    COUNT(*) AS `old_contract_source_rows`,
    COALESCE(SUM(
        JSON_UNQUOTE(JSON_EXTRACT(
            `new_row`.`details`, '$.gate_v4_original_event_type'
        )) = `old_row`.`event_type`
        AND JSON_UNQUOTE(JSON_EXTRACT(
            `new_row`.`details`, '$.gate_v4_original_check_type'
        )) = `old_row`.`check_type`
    ), 0) AS `traceable_converted_rows`,
    CASE
        WHEN COUNT(*) = COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(
                `new_row`.`details`, '$.gate_v4_original_event_type'
            )) = `old_row`.`event_type`
            AND JSON_UNQUOTE(JSON_EXTRACT(
                `new_row`.`details`, '$.gate_v4_original_check_type'
            )) = `old_row`.`check_type`
        ), 0) THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `risk_events_pre_gate_20260831` AS `old_row`
INNER JOIN `risk_events` AS `new_row`
    ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
WHERE (`old_row`.`event_type` = 'ai_check'
       AND `old_row`.`check_type` = 'text')
   OR (`old_row`.`event_type` = 'url_check'
       AND `old_row`.`check_type` = 'url');

-- 8. UUID/settings uniqueness and Demo settings readiness.
SELECT
    'risk_event_uuid_duplicates' AS `check_name`,
    COUNT(*) AS `failure_count`,
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS `status`
FROM (
    SELECT `event_uuid` FROM `risk_events`
    GROUP BY `event_uuid` HAVING COUNT(*) > 1
) AS `duplicates`
UNION ALL
SELECT
    'ad_event_uuid_duplicates',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT `event_uuid` FROM `ad_events`
    GROUP BY `event_uuid` HAVING COUNT(*) > 1
) AS `duplicates`
UNION ALL
SELECT
    'settings_user_id_duplicates',
    COUNT(*),
    CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END
FROM (
    SELECT `user_id` FROM `settings`
    GROUP BY `user_id` HAVING COUNT(*) > 1
) AS `duplicates`;

SELECT
    `u`.`public_id`,
    `u`.`username`,
    `u`.`display_name`,
    `u`.`role`,
    `u`.`status`,
    `s`.`mode`,
    JSON_VALID(`s`.`preferences`) AS `preferences_valid`,
    `s`.`version`,
    CASE
        WHEN `u`.`username` = 'demo'
         AND `u`.`role` = 'demo'
         AND `u`.`status` = 'active'
         AND `s`.`mode` = 'normal'
         AND JSON_VALID(`s`.`preferences`) = 1 THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `users` AS `u`
LEFT JOIN `settings` AS `s` ON `s`.`user_id` = `u`.`id`
WHERE `u`.`username` = 'demo';

-- 9. url_blacklist is not rebuilt or populated by v4. Record this output and
-- compare it with the precheck/backup manifest.
SELECT
    COUNT(*) AS `url_blacklist_count`,
    COUNT(DISTINCT `domain`) AS `unique_domain_count`,
    SUM(`domain` IS NULL OR `reason` IS NULL) AS `invalid_required_count`,
    CASE
        WHEN COUNT(*) = COUNT(DISTINCT `domain`)
         AND COALESCE(SUM(`domain` IS NULL OR `reason` IS NULL), 0) = 0
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `url_blacklist`;

-- 10. Legacy row preservation. The one old orphan setting remains in its
-- archive; security_logs/detection_records are not imported into risk_events.
SELECT
    'legacy_user_settings_archive' AS `table_name`,
    COUNT(*) AS `row_count`
FROM `user_settings_legacy_gate_20260831`
UNION ALL SELECT 'security_logs', COUNT(*) FROM `security_logs`
UNION ALL SELECT 'detection_records', COUNT(*) FROM `detection_records`
UNION ALL SELECT 'users_legacy_gate_20260831', COUNT(*)
    FROM `users_legacy_gate_20260831`;

SELECT
    COUNT(*) AS `historical_detection_scores_over_one`,
    MAX(`risk_score`) AS `maximum_historical_detection_score`,
    'REPORT_ONLY: v4 must not rewrite historical detection risk_score'
        AS `expected_action`
FROM `detection_records`
WHERE `risk_score` > 1;

-- 11. AUTO_INCREMENT must always be greater than the current maximum ID.
SELECT
    `inventory`.`table_name`,
    `inventory`.`auto_increment`,
    `maximums`.`maximum_id`,
    CASE
        WHEN `inventory`.`auto_increment` > `maximums`.`maximum_id`
        THEN 'PASS'
        ELSE 'FAIL'
    END AS `status`
FROM `information_schema`.`tables` AS `inventory`
INNER JOIN (
    SELECT 'users' AS `table_name`, COALESCE(MAX(`id`), 0) AS `maximum_id`
    FROM `users`
    UNION ALL SELECT 'user_settings', COALESCE(MAX(`id`), 0)
        FROM `user_settings`
    UNION ALL SELECT 'risk_events', COALESCE(MAX(`id`), 0)
        FROM `risk_events`
    UNION ALL SELECT 'ad_events', COALESCE(MAX(`id`), 0)
        FROM `ad_events`
    UNION ALL SELECT 'settings', COALESCE(MAX(`id`), 0)
        FROM `settings`
    UNION ALL SELECT 'security_logs', COALESCE(MAX(`id`), 0)
        FROM `security_logs`
    UNION ALL SELECT 'detection_records', COALESCE(MAX(`id`), 0)
        FROM `detection_records`
    UNION ALL SELECT 'url_blacklist', COALESCE(MAX(`id`), 0)
        FROM `url_blacklist`
) AS `maximums`
    ON `maximums`.`table_name` = `inventory`.`table_name`
WHERE `inventory`.`table_schema` = DATABASE()
ORDER BY `inventory`.`table_name`;
