-- SmartGuard-NetGuard Gate v4 mixed-schema upgrade
-- MySQL 5.7.26 only
--
-- Preconditions:
--   1. Stop every writer (Flask, extension integration, UI jobs).
--   2. Take a full locked backup. Several source tables are MyISAM, so a
--      transaction-only dump is not a consistent backup.
--   3. Run v4_gate_precheck.sql and review every result.
--   4. Select only net_guard or the disposable rehearsal clone named
--      net_guard_gate_migration_test.
--
-- This migration intentionally does not import security_logs or
-- detection_records into risk_events. It preserves those legacy tables and
-- only brings their schemas to the minimum compatibility required by the
-- current ORM.
--
-- DDL in MySQL 5.7 implicitly commits. The migration therefore preserves all
-- replaced tables under dated names and must not be treated as transactional.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

DROP PROCEDURE IF EXISTS `run_v4_gate_upgrade_mixed_net_guard`;

DELIMITER $$

CREATE PROCEDURE `run_v4_gate_upgrade_mixed_net_guard`()
BEGIN
    DECLARE `v_count` BIGINT DEFAULT 0;
    DECLARE `v_risk_before` BIGINT DEFAULT 0;
    DECLARE `v_ad_before` BIGINT DEFAULT 0;
    DECLARE `v_settings_before` BIGINT DEFAULT 0;
    DECLARE `v_security_before` BIGINT DEFAULT 0;
    DECLARE `v_detection_before` BIGINT DEFAULT 0;
    DECLARE `v_user_settings_before` BIGINT DEFAULT 0;
    DECLARE `v_url_blacklist_before` BIGINT DEFAULT 0;
    DECLARE `v_demo_user_id` BIGINT UNSIGNED DEFAULT NULL;
    DECLARE `v_version_text` VARCHAR(64);
    DECLARE `v_major` INT DEFAULT 0;
    DECLARE `v_minor` INT DEFAULT 0;
    DECLARE `v_patch` INT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- DDL already completed before an error is not rolled back. Stop here,
        -- keep writers disabled, inspect the dated tables and use the rollback
        -- design at the end of this file or restore the locked backup.
        RESIGNAL;
    END;

    -- ================================================================
    -- 1. Fail-fast target and capability guard. No DDL occurs above this
    -- section except creation of this temporary migration procedure itself.
    -- ================================================================
    IF LOWER(COALESCE(DATABASE(), '')) NOT IN (
        'net_guard',
        'net_guard_gate_migration_test'
    ) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: select net_guard or net_guard_gate_migration_test';
    END IF;

    SET `v_version_text` = SUBSTRING_INDEX(VERSION(), '-', 1);
    SET `v_major` = CAST(SUBSTRING_INDEX(`v_version_text`, '.', 1)
        AS UNSIGNED);
    SET `v_minor` = CAST(SUBSTRING_INDEX(
        SUBSTRING_INDEX(`v_version_text`, '.', 2), '.', -1
    ) AS UNSIGNED);
    SET `v_patch` = CAST(SUBSTRING_INDEX(
        SUBSTRING_INDEX(`v_version_text`, '.', 3), '.', -1
    ) AS UNSIGNED);

    IF `v_major` <> 5 OR `v_minor` <> 7 OR `v_patch` < 8 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: MySQL 5.7.8 or newer 5.7 is required';
    END IF;

    IF FIND_IN_SET(
        'NO_ENGINE_SUBSTITUTION',
        UPPER(COALESCE(@@SESSION.sql_mode, ''))
    ) = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: NO_ENGINE_SUBSTITUTION is required';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_type` = 'BASE TABLE'
      AND `table_name` IN (
          'users', 'user_settings', 'risk_events', 'ad_events', 'settings',
          'security_logs', 'detection_records', 'url_blacklist'
      );

    IF `v_count` <> 8 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: required mixed-state tables are incomplete';
    END IF;

    SELECT COUNT(*) INTO `v_count`
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

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: previous v4 work or archive table exists';
    END IF;

    -- Exact audited input column sets. Equal counts plus membership prevent an
    -- unknown table with coincidentally the same number of columns from passing.
    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'users'
      AND `column_name` IN (
          'id', 'username', 'email', 'password_hash',
          'created_at', 'updated_at', 'role', 'mode'
      );
    IF `v_count` <> 8 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE() AND `table_name` = 'users'
    ) <> 8 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: legacy users signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'user_settings'
      AND `column_name` IN ('id', 'user_id', 'mode', 'updated_at');
    IF `v_count` <> 4 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'user_settings'
    ) <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: legacy user_settings signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'risk_events'
      AND `column_name` IN (
          'id', 'event_uuid', 'user_id', 'event_type', 'check_type',
          'risk_level', 'risk_score', 'url', 'url_hash', 'reason', 'source',
          'details', 'occurred_at', 'created_at'
      );
    IF `v_count` <> 14 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'risk_events'
    ) <> 14 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: risk_events signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'ad_events'
      AND `column_name` IN (
          'id', 'event_uuid', 'user_id', 'action', 'mode', 'page_url',
          'url_hash', 'resource_type', 'rule_id', 'blocked_count', 'reason',
          'source', 'details', 'occurred_at', 'created_at'
      );
    IF `v_count` <> 15 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'ad_events'
    ) <> 15 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: ad_events signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'settings'
      AND `column_name` IN (
          'id', 'user_id', 'mode', 'preferences', 'version',
          'created_at', 'updated_at'
      );
    IF `v_count` <> 7 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'settings'
    ) <> 7 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: settings signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'security_logs'
      AND `column_name` IN (
          'id', 'type', 'risk_level', 'url', 'reason', 'created_at'
      );
    IF `v_count` <> 6 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'security_logs'
    ) <> 6 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: security_logs signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'detection_records'
      AND `column_name` IN (
          'id', 'check_type', 'url', 'risk_level',
          'risk_score', 'user_id', 'created_at'
      );
    IF `v_count` <> 7 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'detection_records'
    ) <> 7 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: detection_records signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'url_blacklist'
      AND `column_name` IN (
          'id', 'domain', 'match_type', 'risk_level', 'score', 'reason',
          'enabled', 'source', 'created_at', 'updated_at'
      );
    IF `v_count` <> 10 OR (
        SELECT COUNT(*) FROM `information_schema`.`columns`
        WHERE `table_schema` = DATABASE()
          AND `table_name` = 'url_blacklist'
    ) <> 10 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: url_blacklist signature changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`statistics`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'security_logs'
      AND `index_name` IN (
          'ix_security_logs_type_created_at',
          'ix_security_logs_risk_created_at'
      );
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: legacy target index name already exists';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_name` IN (
          'risk_events', 'ad_events', 'settings', 'security_logs'
      )
      AND UPPER(`engine`) = 'MYISAM'
      AND `table_collation` = 'utf8_unicode_ci';
    IF `v_count` <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: audited MyISAM/utf8 mixed state changed';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `users`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: legacy users gained rows; mapping needs review';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `settings`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: old settings gained rows; mapping needs review';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `user_settings` AS `us`
    LEFT JOIN `users` AS `u` ON `u`.`id` = `us`.`user_id`
    WHERE `u`.`id` IS NOT NULL
       OR `us`.`mode` IS NULL
       OR `us`.`mode` NOT IN ('normal', 'strict', 'elder', 'child');
    IF `v_count` <> 0 OR (
        SELECT COUNT(*) FROM `user_settings`
    ) > 1 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: legacy user_settings differs from audited orphan';
    END IF;

    -- UUID, required field, supported legacy-contract and length guards.
    SELECT COUNT(*) INTO `v_count`
    FROM (
        SELECT `event_uuid`
        FROM `risk_events`
        GROUP BY `event_uuid`
        HAVING COUNT(*) > 1
    ) AS `duplicates`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: duplicate risk event_uuid exists';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM (
        SELECT `event_uuid`
        FROM `ad_events`
        GROUP BY `event_uuid`
        HAVING COUNT(*) > 1
    ) AS `duplicates`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: duplicate ad event_uuid exists';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `risk_events`
    WHERE `event_uuid` IS NULL
       OR `event_uuid` NOT REGEXP
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR `event_type` IS NULL
       OR `check_type` IS NULL
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
       OR `risk_score` IS NULL OR `risk_score` < 0 OR `risk_score` > 1
       OR `source` IS NULL OR CHAR_LENGTH(`source`) > 20
       OR CHAR_LENGTH(`url`) > 4096
       OR CHAR_LENGTH(`reason`) > 1000
       OR `occurred_at` IS NULL OR `created_at` IS NULL
       OR (`details` IS NOT NULL AND JSON_VALID(`details`) = 0)
       OR NOT (
           (`event_type` = 'extension_risk'
            AND `check_type` IN ('ai', 'url', 'rule'))
           OR (`event_type` = 'ai_check' AND `check_type` = 'text')
           OR (`event_type` = 'url_check' AND `check_type` = 'url')
       )
       OR (
           (`event_type` = 'ai_check' AND `check_type` = 'text')
           OR (`event_type` = 'url_check' AND `check_type` = 'url')
       ) AND JSON_CONTAINS_PATH(
           COALESCE(`details`, JSON_OBJECT()),
           'one',
           '$.gate_v4_original_event_type',
           '$.gate_v4_original_check_type'
       ) = 1;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: unsupported or unsafe risk event row exists';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `ad_events`
    WHERE `event_uuid` IS NULL
       OR `event_uuid` NOT REGEXP
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR `action` NOT IN ('blocked', 'hidden', 'allowed')
       OR `mode` NOT IN ('normal', 'strict', 'elder', 'child')
       OR `blocked_count` IS NULL
       OR CHAR_LENGTH(`page_url`) > 4096
       OR CHAR_LENGTH(`resource_type`) > 32
       OR CHAR_LENGTH(`rule_id`) > 100
       OR CHAR_LENGTH(`reason`) > 500
       OR `source` IS NULL OR CHAR_LENGTH(`source`) > 20
       OR (`details` IS NOT NULL AND JSON_VALID(`details`) = 0)
       OR `occurred_at` IS NULL OR `created_at` IS NULL;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: unsupported or unsafe ad event row exists';
    END IF;

    -- No formal user mapping is fabricated. The audited source has no users,
    -- so all existing event user_id values must be NULL.
    SELECT
        (SELECT COUNT(*) FROM `risk_events` WHERE `user_id` IS NOT NULL)
        + (SELECT COUNT(*) FROM `ad_events` WHERE `user_id` IS NOT NULL)
    INTO `v_count`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: event user mapping requires manual review';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `security_logs`
    WHERE `type` IS NULL
       OR `type` NOT IN (
           'ai_check', 'url_check', 'ad_block', 'child_mode', 'elder_mode'
       )
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
       OR `url` IS NULL OR CHAR_LENGTH(`url`) > 500
       OR CHAR_LENGTH(`reason`) > 1000
       OR `created_at` IS NULL;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: security_logs contains unsupported data';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `detection_records`
    WHERE `check_type` IS NULL
       OR `check_type` NOT IN ('ai', 'text', 'url', 'rule')
       OR `url` IS NULL OR CHAR_LENGTH(`url`) > 500
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
       OR `risk_score` IS NULL
       OR `created_at` IS NULL;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: detection_records contains unsupported data';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM (
        SELECT CONVERT(`domain` USING utf8mb4)
            COLLATE utf8mb4_unicode_ci AS `new_domain`
        FROM `url_blacklist`
        GROUP BY `new_domain`
        HAVING COUNT(*) > 1
    ) AS `collisions`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 blocked: url_blacklist utf8mb4 collision exists';
    END IF;

    SELECT COUNT(*) INTO `v_risk_before` FROM `risk_events`;
    SELECT COUNT(*) INTO `v_ad_before` FROM `ad_events`;
    SELECT COUNT(*) INTO `v_settings_before` FROM `settings`;
    SELECT COUNT(*) INTO `v_security_before` FROM `security_logs`;
    SELECT COUNT(*) INTO `v_detection_before` FROM `detection_records`;
    SELECT COUNT(*) INTO `v_user_settings_before` FROM `user_settings`;
    SELECT COUNT(*) INTO `v_url_blacklist_before` FROM `url_blacklist`;

    -- ================================================================
    -- 2. Archive the conflicting legacy identity/settings tables. RENAME is
    -- atomic and causes existing legacy foreign keys to follow the archived
    -- users table. No old user row is copied or fabricated.
    -- ================================================================
    RENAME TABLE
        `users` TO `users_legacy_gate_20260831`,
        `user_settings` TO `user_settings_legacy_gate_20260831`;

    CREATE TABLE `users` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `public_id` CHAR(36) NOT NULL,
        `username` VARCHAR(64) NULL,
        `display_name` VARCHAR(100) NOT NULL DEFAULT '智盾用户',
        `role` VARCHAR(32) NOT NULL DEFAULT 'user',
        `status` VARCHAR(16) NOT NULL DEFAULT 'active',
        `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (`id`),
        UNIQUE KEY `uq_users_public_id` (`public_id`),
        UNIQUE KEY `uq_users_username` (`username`),
        KEY `ix_users_status_created_at` (`status`, `created_at`)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE `user_settings` (
        `id` INT NOT NULL AUTO_INCREMENT,
        `setting_key` VARCHAR(100) NOT NULL,
        `setting_value` VARCHAR(500) NULL,
        `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME NULL,
        PRIMARY KEY (`id`),
        UNIQUE KEY `uq_user_settings_setting_key` (`setting_key`)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;

    INSERT INTO `users` (
        `public_id`, `username`, `display_name`, `role`, `status`
    ) VALUES (
        UUID(), 'demo', '智盾演示用户', 'demo', 'active'
    );
    SET `v_demo_user_id` = LAST_INSERT_ID();

    -- The audited orphan user_settings row is preserved only in the archive.
    -- It is not linked to this Demo identity.

    -- ================================================================
    -- 3. Build formal staging tables from the current ORM schema. Foreign keys
    -- are intentionally added only after copy and validation.
    -- ================================================================
    CREATE TABLE `risk_events_gate_new` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `event_uuid` CHAR(36) NOT NULL,
        `user_id` BIGINT UNSIGNED NULL,
        `event_type` VARCHAR(32) NOT NULL,
        `check_type` VARCHAR(20) NOT NULL,
        `risk_level` VARCHAR(16) NOT NULL,
        `risk_score` DECIMAL(5,4) NOT NULL DEFAULT 0.0000,
        `url` TEXT NULL,
        `url_hash` CHAR(64) NULL,
        `reason` VARCHAR(1000) NULL,
        `source` VARCHAR(20) NOT NULL DEFAULT 'backend',
        `details` JSON NULL,
        `occurred_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (`id`),
        UNIQUE KEY `uq_risk_events_event_uuid` (`event_uuid`),
        KEY `ix_risk_events_user_occurred` (`user_id`, `occurred_at`),
        KEY `ix_risk_events_level_occurred` (`risk_level`, `occurred_at`),
        KEY `ix_risk_events_type_occurred` (`event_type`, `occurred_at`),
        KEY `ix_risk_events_url_hash` (`url_hash`)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE `ad_events_gate_new` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `event_uuid` CHAR(36) NOT NULL,
        `user_id` BIGINT UNSIGNED NULL,
        `action` VARCHAR(16) NOT NULL,
        `mode` VARCHAR(16) NOT NULL DEFAULT 'normal',
        `page_url` TEXT NULL,
        `url_hash` CHAR(64) NULL,
        `resource_type` VARCHAR(32) NULL,
        `rule_id` VARCHAR(100) NULL,
        `blocked_count` INT UNSIGNED NOT NULL DEFAULT 1,
        `reason` VARCHAR(500) NULL,
        `source` VARCHAR(20) NOT NULL DEFAULT 'extension',
        `details` JSON NULL,
        `occurred_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (`id`),
        UNIQUE KEY `uq_ad_events_event_uuid` (`event_uuid`),
        KEY `ix_ad_events_user_occurred` (`user_id`, `occurred_at`),
        KEY `ix_ad_events_action_occurred` (`action`, `occurred_at`),
        KEY `ix_ad_events_mode_occurred` (`mode`, `occurred_at`),
        KEY `ix_ad_events_url_hash` (`url_hash`)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE `settings_gate_new` (
        `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        `user_id` BIGINT UNSIGNED NOT NULL,
        `mode` VARCHAR(16) NOT NULL DEFAULT 'normal',
        `preferences` JSON NOT NULL,
        `version` INT UNSIGNED NOT NULL DEFAULT 1,
        `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (`id`),
        UNIQUE KEY `uq_settings_user_id` (`user_id`),
        KEY `ix_settings_mode_updated_at` (`mode`, `updated_at`)
    ) ENGINE=InnoDB
      DEFAULT CHARSET=utf8mb4
      COLLATE=utf8mb4_unicode_ci;

    -- Preserve every ID, UUID, timestamp and payload. Only the two audited old
    -- contracts are normalized. Their original values are stored in details.
    INSERT INTO `risk_events_gate_new` (
        `id`, `event_uuid`, `user_id`, `event_type`, `check_type`,
        `risk_level`, `risk_score`, `url`, `url_hash`, `reason`, `source`,
        `details`, `occurred_at`, `created_at`
    )
    SELECT
        `id`,
        `event_uuid`,
        `user_id`,
        CASE
            WHEN `event_type` = 'ai_check' AND `check_type` = 'text'
                THEN 'extension_risk'
            WHEN `event_type` = 'url_check' AND `check_type` = 'url'
                THEN 'extension_risk'
            ELSE `event_type`
        END,
        CASE
            WHEN `event_type` = 'ai_check' AND `check_type` = 'text'
                THEN 'ai'
            WHEN `event_type` = 'url_check' AND `check_type` = 'url'
                THEN 'url'
            ELSE `check_type`
        END,
        `risk_level`,
        `risk_score`,
        `url`,
        `url_hash`,
        `reason`,
        `source`,
        CASE
            WHEN (`event_type` = 'ai_check' AND `check_type` = 'text')
              OR (`event_type` = 'url_check' AND `check_type` = 'url')
            THEN JSON_SET(
                COALESCE(`details`, JSON_OBJECT()),
                '$.gate_v4_original_event_type', `event_type`,
                '$.gate_v4_original_check_type', `check_type`,
                '$.gate_v4_migration', 'mixed_net_guard_20260831'
            )
            ELSE `details`
        END,
        `occurred_at`,
        `created_at`
    FROM `risk_events`;

    INSERT INTO `ad_events_gate_new` (
        `id`, `event_uuid`, `user_id`, `action`, `mode`, `page_url`,
        `url_hash`, `resource_type`, `rule_id`, `blocked_count`, `reason`,
        `source`, `details`, `occurred_at`, `created_at`
    )
    SELECT
        `id`, `event_uuid`, `user_id`, `action`, `mode`, `page_url`,
        `url_hash`, `resource_type`, `rule_id`, `blocked_count`, `reason`,
        `source`, `details`, `occurred_at`, `created_at`
    FROM `ad_events`;

    -- The audited old settings table is empty. The SELECT remains explicit so
    -- a future non-empty state cannot be silently discarded; the guard above
    -- rejects that state before this point.
    INSERT INTO `settings_gate_new` (
        `id`, `user_id`, `mode`, `preferences`, `version`,
        `created_at`, `updated_at`
    )
    SELECT
        `id`, `user_id`, `mode`, `preferences`, `version`,
        `created_at`, `updated_at`
    FROM `settings`;

    INSERT INTO `settings_gate_new` (
        `user_id`, `mode`, `preferences`, `version`
    ) VALUES (
        `v_demo_user_id`,
        'normal',
        JSON_OBJECT(
            'elder_mode', 0,
            'child_mode', 0,
            'paused', 0
        ),
        1
    );

    -- ================================================================
    -- 4. Validate staging data before any formal table switch.
    -- ================================================================
    SELECT COUNT(*) INTO `v_count` FROM `risk_events_gate_new`;
    IF `v_count` <> `v_risk_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: risk row count changed';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `ad_events_gate_new`;
    IF `v_count` <> `v_ad_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: ad row count changed';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `settings_gate_new`;
    IF `v_count` <> `v_settings_before` + 1 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: Demo settings count mismatch';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `risk_events` AS `old_row`
    LEFT JOIN `risk_events_gate_new` AS `new_row`
        ON `new_row`.`id` = `old_row`.`id`
       AND `new_row`.`event_uuid` = `old_row`.`event_uuid`
    WHERE `new_row`.`id` IS NULL
       OR NOT (`new_row`.`user_id` <=> `old_row`.`user_id`)
       OR NOT (`new_row`.`risk_level` <=> `old_row`.`risk_level`)
       OR NOT (`new_row`.`risk_score` <=> `old_row`.`risk_score`)
       OR NOT (`new_row`.`url` <=> `old_row`.`url`)
       OR NOT (`new_row`.`url_hash` <=> `old_row`.`url_hash`)
       OR NOT (`new_row`.`reason` <=> `old_row`.`reason`)
       OR NOT (`new_row`.`source` <=> `old_row`.`source`)
       OR NOT (`new_row`.`occurred_at` <=> `old_row`.`occurred_at`)
       OR NOT (`new_row`.`created_at` <=> `old_row`.`created_at`)
       OR `new_row`.`event_type` <> CASE
           WHEN `old_row`.`event_type` IN ('ai_check', 'url_check')
               THEN 'extension_risk'
           ELSE `old_row`.`event_type`
       END
       OR `new_row`.`check_type` <> CASE
           WHEN `old_row`.`event_type` = 'ai_check'
            AND `old_row`.`check_type` = 'text' THEN 'ai'
           WHEN `old_row`.`event_type` = 'url_check'
            AND `old_row`.`check_type` = 'url' THEN 'url'
           ELSE `old_row`.`check_type`
       END
       OR (
           (`old_row`.`event_type` = 'ai_check'
            AND `old_row`.`check_type` = 'text')
           OR (`old_row`.`event_type` = 'url_check'
               AND `old_row`.`check_type` = 'url')
       ) AND (
           NOT (JSON_UNQUOTE(JSON_EXTRACT(
               `new_row`.`details`, '$.gate_v4_original_event_type'
           )) <=> `old_row`.`event_type`)
           OR NOT (JSON_UNQUOTE(JSON_EXTRACT(
               `new_row`.`details`, '$.gate_v4_original_check_type'
           )) <=> `old_row`.`check_type`)
       );
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: risk row copy mismatch';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `ad_events` AS `old_row`
    LEFT JOIN `ad_events_gate_new` AS `new_row`
        ON `new_row`.`id` = `old_row`.`id`
       AND `new_row`.`event_uuid` = `old_row`.`event_uuid`
    WHERE `new_row`.`id` IS NULL
       OR NOT (`new_row`.`user_id` <=> `old_row`.`user_id`)
       OR NOT (`new_row`.`action` <=> `old_row`.`action`)
       OR NOT (`new_row`.`mode` <=> `old_row`.`mode`)
       OR NOT (`new_row`.`page_url` <=> `old_row`.`page_url`)
       OR NOT (`new_row`.`url_hash` <=> `old_row`.`url_hash`)
       OR NOT (`new_row`.`resource_type` <=> `old_row`.`resource_type`)
       OR NOT (`new_row`.`rule_id` <=> `old_row`.`rule_id`)
       OR NOT (`new_row`.`blocked_count` <=> `old_row`.`blocked_count`)
       OR NOT (`new_row`.`reason` <=> `old_row`.`reason`)
       OR NOT (`new_row`.`source` <=> `old_row`.`source`)
       OR NOT (`new_row`.`details` <=> `old_row`.`details`)
       OR NOT (`new_row`.`occurred_at` <=> `old_row`.`occurred_at`)
       OR NOT (`new_row`.`created_at` <=> `old_row`.`created_at`);
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: ad row copy mismatch';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `risk_events_gate_new`
    WHERE `event_type` <> 'extension_risk'
       OR `check_type` NOT IN ('ai', 'url', 'rule')
       OR `event_uuid` IS NULL
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high')
       OR `risk_score` IS NULL OR `risk_score` < 0 OR `risk_score` > 1
       OR `source` IS NULL
       OR `occurred_at` IS NULL OR `created_at` IS NULL;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: noncanonical risk row remains';
    END IF;

    -- ================================================================
    -- 5. Minimum legacy ORM compatibility. Historical rows stay in place;
    -- detection risk_score values, including 3.9824, are not modified.
    -- ================================================================
    ALTER TABLE `security_logs`
        ENGINE=InnoDB,
        CONVERT TO CHARACTER SET utf8mb4
            COLLATE utf8mb4_unicode_ci,
        MODIFY COLUMN `type` ENUM(
            'ai_check',
            'url_check',
            'ad_block',
            'child_mode',
            'elder_mode',
            'strict_mode',
            'entertainment_block',
            'game_block',
            'dangerous_block'
        ) NOT NULL,
        MODIFY COLUMN `risk_level`
            ENUM('safe', 'low', 'medium', 'high') NOT NULL,
        MODIFY COLUMN `url` VARCHAR(500) NOT NULL,
        MODIFY COLUMN `reason` VARCHAR(1000) NULL,
        MODIFY COLUMN `created_at` DATETIME NOT NULL
            DEFAULT CURRENT_TIMESTAMP,
        ADD KEY `ix_security_logs_type_created_at` (`type`, `created_at`),
        ADD KEY `ix_security_logs_risk_created_at`
            (`risk_level`, `created_at`);

    ALTER TABLE `detection_records`
        ENGINE=InnoDB,
        CONVERT TO CHARACTER SET utf8mb4
            COLLATE utf8mb4_unicode_ci,
        MODIFY COLUMN `url` VARCHAR(500) NOT NULL AFTER `id`,
        ADD COLUMN `is_high_risk` TINYINT(1) NOT NULL DEFAULT 0
            AFTER `url`,
        ADD COLUMN `is_phishing` TINYINT(1) NOT NULL DEFAULT 0
            AFTER `is_high_risk`,
        MODIFY COLUMN `risk_level` VARCHAR(20) NOT NULL DEFAULT 'safe'
            AFTER `is_phishing`,
        MODIFY COLUMN `risk_score` FLOAT NOT NULL DEFAULT 0
            AFTER `risk_level`,
        MODIFY COLUMN `check_type` VARCHAR(20) NOT NULL DEFAULT 'unknown'
            AFTER `risk_score`,
        MODIFY COLUMN `user_id` INT NULL AFTER `check_type`,
        ADD COLUMN `reason` VARCHAR(500) NULL AFTER `user_id`,
        MODIFY COLUMN `created_at` DATETIME NOT NULL
            DEFAULT CURRENT_TIMESTAMP AFTER `reason`;

    SELECT COUNT(*) INTO `v_count` FROM `security_logs`;
    IF `v_count` <> `v_security_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: security_logs count changed';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `detection_records`;
    IF `v_count` <> `v_detection_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: detection_records count changed';
    END IF;

    -- ================================================================
    -- 6. Add formal foreign keys last, after copy and orphan validation.
    -- ================================================================
    SELECT
        (SELECT COUNT(*)
         FROM `risk_events_gate_new` AS `r`
         LEFT JOIN `users` AS `u` ON `u`.`id` = `r`.`user_id`
         WHERE `r`.`user_id` IS NOT NULL AND `u`.`id` IS NULL)
        + (SELECT COUNT(*)
           FROM `ad_events_gate_new` AS `a`
           LEFT JOIN `users` AS `u` ON `u`.`id` = `a`.`user_id`
           WHERE `a`.`user_id` IS NOT NULL AND `u`.`id` IS NULL)
        + (SELECT COUNT(*)
           FROM `settings_gate_new` AS `s`
           LEFT JOIN `users` AS `u` ON `u`.`id` = `s`.`user_id`
           WHERE `u`.`id` IS NULL)
    INTO `v_count`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 validation failed: formal FK orphan exists';
    END IF;

    ALTER TABLE `risk_events_gate_new`
        ADD CONSTRAINT `fk_risk_events_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE SET NULL;

    ALTER TABLE `ad_events_gate_new`
        ADD CONSTRAINT `fk_ad_events_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE SET NULL;

    ALTER TABLE `settings_gate_new`
        ADD CONSTRAINT `fk_settings_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE CASCADE;

    -- ================================================================
    -- 7. Atomic formal table switch. Every previous formal table remains under
    -- its dated pre-Gate name; nothing is dropped.
    -- ================================================================
    RENAME TABLE
        `risk_events` TO `risk_events_pre_gate_20260831`,
        `risk_events_gate_new` TO `risk_events`,
        `ad_events` TO `ad_events_pre_gate_20260831`,
        `ad_events_gate_new` TO `ad_events`,
        `settings` TO `settings_pre_gate_20260831`,
        `settings_gate_new` TO `settings`;

    -- Set the database default only after the complete table switch. MySQL
    -- 5.7 cannot PREPARE ALTER DATABASE, so use two static statements behind
    -- the exact target-name guard at the start of this procedure.
    IF LOWER(DATABASE()) = 'net_guard' THEN
        ALTER DATABASE `net_guard`
            CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    ELSEIF LOWER(DATABASE()) = 'net_guard_gate_migration_test' THEN
        ALTER DATABASE `net_guard_gate_migration_test`
            CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    END IF;

    -- ================================================================
    -- 8. Immediate post-switch checks. The standalone verify file performs a
    -- fuller read-only review and must be saved with the migration evidence.
    -- ================================================================
    SELECT COUNT(*) INTO `v_count` FROM `risk_events`;
    IF `v_count` <> `v_risk_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 final check failed: risk count mismatch';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `ad_events`;
    IF `v_count` <> `v_ad_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 final check failed: ad count mismatch';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `url_blacklist`;
    IF `v_count` <> `v_url_blacklist_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 final check failed: url_blacklist changed';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `user_settings_legacy_gate_20260831`;
    IF `v_count` <> `v_user_settings_before` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 final check failed: legacy settings changed';
    END IF;

    SELECT
        'PASS' AS `migration_status`,
        DATABASE() AS `database_name`,
        `v_risk_before` AS `risk_events_preserved`,
        `v_ad_before` AS `ad_events_preserved`,
        `v_security_before` AS `security_logs_preserved`,
        `v_detection_before` AS `detection_records_preserved`,
        `v_url_blacklist_before` AS `url_blacklist_preserved`;
END$$

DELIMITER ;

CALL `run_v4_gate_upgrade_mixed_net_guard`();
DROP PROCEDURE IF EXISTS `run_v4_gate_upgrade_mixed_net_guard`;

-- ====================================================================
-- ROLLBACK DESIGN (manual; never append automatic execution here)
-- ====================================================================
-- MySQL DDL cannot be transactionally rolled back. Keep all writers stopped.
-- If the formal switch completed but application acceptance failed, first
-- verify that these failed names are absent, then atomically rename:
--
--   users                         -> users_failed_gate_20260831
--   users_legacy_gate_20260831    -> users
--   user_settings                  -> user_settings_failed_gate_20260831
--   user_settings_legacy_gate_20260831 -> user_settings
--   risk_events                    -> risk_events_failed_gate_20260831
--   risk_events_pre_gate_20260831  -> risk_events
--   ad_events                      -> ad_events_failed_gate_20260831
--   ad_events_pre_gate_20260831    -> ad_events
--   settings                       -> settings_failed_gate_20260831
--   settings_pre_gate_20260831     -> settings
--
-- Use one RENAME TABLE statement for that switch. Do not drop either side.
-- security_logs and detection_records are compatibility-upgraded in place;
-- restoring their exact old schema requires the locked full backup. If any
-- post-migration writer ran, the full backup plus a reviewed forward replay is
-- the authoritative recovery path.
