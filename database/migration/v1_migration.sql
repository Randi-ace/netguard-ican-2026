-- 净网护航 v1.0-alpha 旧数据库升级脚本
-- 适用数据库：MySQL 5.7.26
-- 适用来源：已有 users、security_logs、detection_records、user_settings
-- 目标结构：users、risk_events、ad_events、settings
--
-- 重要：
-- 1. 本脚本只允许执行一次。
-- 2. 执行前必须停止 backend，避免迁移期间继续写入旧表。
-- 3. 正式迁移前必须完成 net_guard 全库备份。
-- 4. 必须先在同一 MySQL 会话执行 v1_precheck.sql。
-- 5. 未取得预检查通过凭证时，本脚本只返回错误，不操作业务表。
-- 6. 本脚本不删除旧表或旧数据；冲突旧表通过重命名保留。
-- 7. MySQL 5.7 的 DDL 会隐式提交，无法整体回滚；预检查、停写、
--    全库备份和测试库演练是正式执行的必要条件。
-- 8. 旧表原有的 users 入站外键将随 RENAME 自动指向
--    users_legacy_v22；新正式表只引用新 users。

SET NAMES utf8mb4;
SET time_zone = '+00:00';

DROP PROCEDURE IF EXISTS `run_v1_migration`;

DELIMITER $$

CREATE PROCEDURE `run_v1_migration`()
BEGIN
    DECLARE `v_count` BIGINT DEFAULT 0;

    -- DML 复制阶段发生错误时回滚尚未提交的新表数据。
    -- 已完成的 RENAME/CREATE/ALTER 属于 MySQL 5.7 DDL，不能由此回滚。
    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        SET @v1_precheck_passed = 0;
        RESIGNAL;
    END;

    -- 双重守卫：预检查必须通过，且必须在同一数据库会话执行。
    IF COALESCE(@v1_precheck_passed, 0) <> 1
       OR LOWER(COALESCE(@v1_precheck_database, '')) NOT IN (
           'net_guard',
           'net_guard_migration_test'
       )
       OR LOWER(COALESCE(DATABASE(), ''))
          <> LOWER(COALESCE(@v1_precheck_database, ''))
       OR @v1_users_fk_count IS NULL
       OR @v1_source_users_count IS NULL
       OR @v1_source_user_settings_count IS NULL
       OR @v1_source_security_logs_count IS NULL
       OR @v1_source_detection_records_count IS NULL
       OR @v1_expected_users_count IS NULL
       OR @v1_expected_settings_count IS NULL
       OR @v1_expected_security_risk_count IS NULL
       OR @v1_expected_ad_count IS NULL
       OR @v1_expected_detection_risk_count IS NULL THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: precheck database and current database must match';
    END IF;

    -- 预检查后源表行数必须保持不变，避免停写要求未落实。
    SELECT COUNT(*) INTO `v_count` FROM `users`;
    IF `v_count` <> @v1_source_users_count THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: users changed after precheck';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `user_settings`;
    IF `v_count` <> @v1_source_user_settings_count THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: user_settings changed after precheck';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `security_logs`;
    IF `v_count` <> @v1_source_security_logs_count THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: security_logs changed after precheck';
    END IF;

    SELECT COUNT(*) INTO `v_count` FROM `detection_records`;
    IF `v_count` <> @v1_source_detection_records_count THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: detection_records changed after precheck';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`key_column_usage`
    WHERE `constraint_schema` = DATABASE()
      AND `referenced_table_schema` = DATABASE()
      AND `referenced_table_name` = 'users';

    IF `v_count` <> @v1_users_fk_count THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Migration blocked: users foreign keys changed after precheck';
    END IF;

    -- 凭证一次性消费。迁移失败后不能在同一会话直接重试。
    SET @v1_precheck_passed = 0;

-- ============================================================
-- 第二部分：保留冲突旧表
-- RENAME 会完整保留旧表和数据，不会删除。
-- MySQL 会把所有原本指向 users 的真实外键同步更新为指向
-- users_legacy_v22，旧业务表继续关联旧用户快照。
-- ============================================================

RENAME TABLE
    `users` TO `users_legacy_v22`,
    `user_settings` TO `user_settings_legacy_v22`;

SELECT COUNT(*)
INTO `v_count`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users_legacy_v22';

IF `v_count` <> @v1_users_fk_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration failed: legacy users foreign keys were not preserved';
END IF;

-- ============================================================
-- 第三部分：创建四张正式表
-- ============================================================

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

CREATE TABLE `risk_events` (
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
    KEY `ix_risk_events_url_hash` (`url_hash`),

    CONSTRAINT `fk_risk_events_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `ad_events` (
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
    KEY `ix_ad_events_url_hash` (`url_hash`),

    CONSTRAINT `fk_ad_events_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE SET NULL
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `mode` VARCHAR(16) NOT NULL DEFAULT 'normal',
    `preferences` JSON NOT NULL,
    `version` INT UNSIGNED NOT NULL DEFAULT 1,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_settings_user_id` (`user_id`),
    KEY `ix_settings_mode_updated_at` (`mode`, `updated_at`),

    CONSTRAINT `fk_settings_user`
        FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
        ON DELETE CASCADE
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 第四部分：恢复兼容旧模型所需结构
-- ============================================================

-- 旧 user_settings 数据已保留在 user_settings_legacy_v22。
-- 重新创建与当前 SQLAlchemy 兼容的键值表。
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

-- 当前真实 detection_records 缺少下列三个旧模型字段。
-- 同一次 ALTER 将兼容表统一为 InnoDB/utf8mb4；旧记录不删除。
ALTER TABLE `detection_records`
    ENGINE=InnoDB,
    CONVERT TO CHARACTER SET utf8mb4
        COLLATE utf8mb4_unicode_ci,
    ADD COLUMN `is_high_risk` TINYINT(1) NOT NULL DEFAULT 0 AFTER `url`,
    ADD COLUMN `is_phishing` TINYINT(1) NOT NULL DEFAULT 0 AFTER `is_high_risk`,
    ADD COLUMN `reason` VARCHAR(500) NULL AFTER `user_id`;

-- 扩展旧日志类型为当前模型声明的完整集合，只增加允许值，
-- 并把仍被兼容接口使用的 security_logs 转换为 InnoDB/utf8mb4。
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
    ) NOT NULL;

-- ============================================================
-- 第五部分：迁移旧数据
-- 此处只包含 DML，使用事务保证数据复制阶段的一致性。
-- ============================================================

START TRANSACTION;

-- 5.1 迁移旧用户，保留原整数主键。
-- email 和 password_hash 仅保留在 users_legacy_v22，不进入新核心表。
INSERT INTO `users` (
    `id`,
    `public_id`,
    `username`,
    `display_name`,
    `role`,
    `status`,
    `created_at`,
    `updated_at`
)
SELECT
    `id`,
    UUID(),
    LEFT(`username`, 64),
    COALESCE(NULLIF(LEFT(`username`, 100), ''), '智盾用户'),
    CASE
        WHEN `role` IN ('user', 'admin', 'demo') THEN `role`
        ELSE 'user'
    END,
    'active',
    `created_at`,
    `updated_at`
FROM `users_legacy_v22`;

-- 5.2 确保存在固定 Demo 用户。
INSERT INTO `users` (
    `public_id`,
    `username`,
    `display_name`,
    `role`,
    `status`
)
SELECT
    UUID(),
    'demo',
    '智盾演示用户',
    'demo',
    'active'
FROM DUAL
WHERE NOT EXISTS (
    SELECT 1
    FROM `users`
    WHERE `username` = 'demo'
);

-- 5.3 优先迁移每个用户最新的一条旧设置。
INSERT INTO `settings` (
    `user_id`,
    `mode`,
    `preferences`,
    `version`,
    `created_at`,
    `updated_at`
)
SELECT
    `u`.`id`,
    CASE
        WHEN `us`.`mode` IN ('normal', 'strict', 'elder', 'child')
            THEN `us`.`mode`
        ELSE 'normal'
    END,
    JSON_OBJECT(
        'elder_mode', IF(`us`.`mode` = 'elder', 1, 0),
        'child_mode', IF(`us`.`mode` = 'child', 1, 0),
        'paused', 0
    ),
    1,
    COALESCE(`us`.`updated_at`, CURRENT_TIMESTAMP(6)),
    COALESCE(`us`.`updated_at`, CURRENT_TIMESTAMP(6))
FROM `user_settings_legacy_v22` AS `us`
INNER JOIN (
    SELECT
        `user_id`,
        MAX(`id`) AS `latest_id`
    FROM `user_settings_legacy_v22`
    GROUP BY `user_id`
) AS `latest`
    ON `latest`.`latest_id` = `us`.`id`
INNER JOIN `users` AS `u`
    ON `u`.`id` = `us`.`user_id`;

-- 5.4 没有 user_settings 的旧用户使用 users_legacy_v22.mode。
INSERT INTO `settings` (
    `user_id`,
    `mode`,
    `preferences`,
    `version`,
    `created_at`,
    `updated_at`
)
SELECT
    `u`.`id`,
    CASE
        WHEN `legacy`.`mode` IN ('normal', 'strict', 'elder', 'child')
            THEN `legacy`.`mode`
        ELSE 'normal'
    END,
    JSON_OBJECT(
        'elder_mode', IF(`legacy`.`mode` = 'elder', 1, 0),
        'child_mode', IF(`legacy`.`mode` = 'child', 1, 0),
        'paused', 0
    ),
    1,
    `u`.`created_at`,
    `u`.`updated_at`
FROM `users_legacy_v22` AS `legacy`
INNER JOIN `users` AS `u`
    ON `u`.`id` = `legacy`.`id`
WHERE NOT EXISTS (
    SELECT 1
    FROM `settings` AS `s`
    WHERE `s`.`user_id` = `u`.`id`
);

-- 5.5 确保 Demo 用户一定有设置。
-- 无法按 user_id 对应的旧设置只用于提供 Demo 模式初始值。
INSERT INTO `settings` (
    `user_id`,
    `mode`,
    `preferences`,
    `version`
)
SELECT
    `u`.`id`,
    COALESCE(
        (
            SELECT CASE
                WHEN `mode` IN ('normal', 'strict', 'elder', 'child')
                    THEN `mode`
                ELSE 'normal'
            END
            FROM `user_settings_legacy_v22`
            ORDER BY `updated_at` DESC, `id` DESC
            LIMIT 1
        ),
        'normal'
    ),
    JSON_OBJECT(
        'elder_mode', 0,
        'child_mode', 0,
        'paused', 0
    ),
    1
FROM `users` AS `u`
WHERE `u`.`username` = 'demo'
  AND NOT EXISTS (
      SELECT 1
      FROM `settings` AS `s`
      WHERE `s`.`user_id` = `u`.`id`
  );

-- 5.6 security_logs 中除广告外的事件迁入 risk_events。
INSERT INTO `risk_events` (
    `event_uuid`,
    `user_id`,
    `event_type`,
    `check_type`,
    `risk_level`,
    `risk_score`,
    `url`,
    `url_hash`,
    `reason`,
    `source`,
    `details`,
    `occurred_at`,
    `created_at`
)
SELECT
    CONCAT(
        SUBSTRING(`x`.`uuid_hex`, 1, 8), '-',
        SUBSTRING(`x`.`uuid_hex`, 9, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 13, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 17, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 21, 12)
    ),
    NULL,
    'extension_risk',
    CASE
        WHEN `x`.`type` = 'ai_check' THEN 'ai'
        WHEN `x`.`type` = 'url_check' THEN 'url'
        ELSE 'rule'
    END,
    CASE
        WHEN `x`.`risk_level` IN ('safe', 'low', 'medium', 'high')
            THEN `x`.`risk_level`
        ELSE 'safe'
    END,
    CASE `x`.`risk_level`
        WHEN 'high' THEN 0.9000
        WHEN 'medium' THEN 0.6000
        WHEN 'low' THEN 0.2500
        ELSE 0.0500
    END,
    `x`.`url`,
    SHA2(`x`.`url`, 256),
    `x`.`reason`,
    'backend',
    JSON_OBJECT(
        'legacy_table', 'security_logs',
        'legacy_id', `x`.`id`,
        'legacy_type', `x`.`type`
    ),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6)),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6))
FROM (
    SELECT
        `s`.*,
        MD5(CONCAT('security_logs:risk:', `s`.`id`)) AS `uuid_hex`
    FROM `security_logs` AS `s`
    WHERE `s`.`type` <> 'ad_block'
) AS `x`;

-- 5.7 security_logs 中的广告事件迁入 ad_events。
INSERT INTO `ad_events` (
    `event_uuid`,
    `user_id`,
    `action`,
    `mode`,
    `page_url`,
    `url_hash`,
    `resource_type`,
    `rule_id`,
    `blocked_count`,
    `reason`,
    `source`,
    `details`,
    `occurred_at`,
    `created_at`
)
SELECT
    CONCAT(
        SUBSTRING(`x`.`uuid_hex`, 1, 8), '-',
        SUBSTRING(`x`.`uuid_hex`, 9, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 13, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 17, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 21, 12)
    ),
    NULL,
    'blocked',
    'normal',
    `x`.`url`,
    SHA2(`x`.`url`, 256),
    NULL,
    NULL,
    1,
    `x`.`reason`,
    'extension',
    JSON_OBJECT(
        'legacy_table', 'security_logs',
        'legacy_id', `x`.`id`,
        'legacy_risk_level', `x`.`risk_level`
    ),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6)),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6))
FROM (
    SELECT
        `s`.*,
        MD5(CONCAT('security_logs:ad:', `s`.`id`)) AS `uuid_hex`
    FROM `security_logs` AS `s`
    WHERE `s`.`type` = 'ad_block'
) AS `x`;

-- 5.8 detection_records 全量迁入 risk_events。
-- security_logs 与 detection_records 可能来自旧 /ai/check 的同一次双写，
-- 但现有字段不足以可靠确认同一业务事件，因此这里只保留并报告候选，
-- 不根据 URL、风险等级或时间窗口自动丢弃记录。
INSERT INTO `risk_events` (
    `event_uuid`,
    `user_id`,
    `event_type`,
    `check_type`,
    `risk_level`,
    `risk_score`,
    `url`,
    `url_hash`,
    `reason`,
    `source`,
    `details`,
    `occurred_at`,
    `created_at`
)
SELECT
    CONCAT(
        SUBSTRING(`x`.`uuid_hex`, 1, 8), '-',
        SUBSTRING(`x`.`uuid_hex`, 9, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 13, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 17, 4), '-',
        SUBSTRING(`x`.`uuid_hex`, 21, 12)
    ),
    `u`.`id`,
    'extension_risk',
    CASE
        WHEN `x`.`check_type` IN ('ai', 'text') THEN 'ai'
        WHEN `x`.`check_type` = 'url' THEN 'url'
        ELSE 'rule'
    END,
    CASE
        WHEN `x`.`risk_level` IN ('safe', 'low', 'medium', 'high')
            THEN `x`.`risk_level`
        ELSE 'safe'
    END,
    CAST(
        LEAST(
            1.0000,
            GREATEST(
                0.0000,
                COALESCE(
                    `x`.`risk_score`,
                    CASE `x`.`risk_level`
                        WHEN 'high' THEN 0.9000
                        WHEN 'medium' THEN 0.6000
                        WHEN 'low' THEN 0.2500
                        ELSE 0.0500
                    END
                )
            )
        ) AS DECIMAL(5,4)
    ),
    `x`.`url`,
    SHA2(`x`.`url`, 256),
    COALESCE(`x`.`reason`, '由旧 detection_records 迁移'),
    'backend',
    JSON_OBJECT(
        'legacy_table', 'detection_records',
        'legacy_id', `x`.`id`,
        'legacy_check_type', `x`.`check_type`
    ),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6)),
    COALESCE(`x`.`created_at`, CURRENT_TIMESTAMP(6))
FROM (
    SELECT
        `d`.*,
        MD5(CONCAT('detection_records:', `d`.`id`)) AS `uuid_hex`
    FROM `detection_records` AS `d`
) AS `x`
LEFT JOIN `users` AS `u`
    ON `u`.`id` = `x`.`user_id`;

-- ============================================================
-- 第六部分：提交前强制校验
-- 任一检查失败均抛出 SQLSTATE 45000，并由异常处理器回滚本次 DML。
-- MySQL 5.7 已执行的 DDL 不能回滚，必须依赖执行前全库备份恢复。
-- ============================================================

-- 6.1 源表和归档表数量必须与预检查快照一致。
SELECT COUNT(*) INTO `v_count`
FROM `users_legacy_v22`;

IF `v_count` <> @v1_source_users_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: legacy users count changed';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `user_settings_legacy_v22`;

IF `v_count` <> @v1_source_user_settings_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: legacy user settings count changed';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `security_logs`;

IF `v_count` <> @v1_source_security_logs_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: security logs count changed';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `detection_records`;

IF `v_count` <> @v1_source_detection_records_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: detection records count changed';
END IF;

-- 6.2 正式表数据量必须符合预检查计算结果。
SELECT COUNT(*) INTO `v_count`
FROM `users`;

IF `v_count` <> @v1_expected_users_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: users count mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `settings`;

IF `v_count` <> @v1_expected_settings_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: settings count mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `risk_events`;

IF `v_count` <> (
    @v1_expected_security_risk_count
    + @v1_expected_detection_risk_count
) THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: risk events total mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `risk_events`
WHERE JSON_UNQUOTE(
    JSON_EXTRACT(`details`, '$.legacy_table')
) = 'security_logs';

IF `v_count` <> @v1_expected_security_risk_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: security risk count mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `risk_events`
WHERE JSON_UNQUOTE(
    JSON_EXTRACT(`details`, '$.legacy_table')
) = 'detection_records';

IF `v_count` <> @v1_expected_detection_risk_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: detection risk count mismatch';
END IF;

-- 6.3 迁入正式风险表的数据必须全部符合当前事件口径，并保留旧来源。
SELECT COUNT(*) INTO `v_count`
FROM `risk_events`
WHERE `event_type` <> 'extension_risk'
   OR `check_type` NOT IN ('ai', 'url', 'rule');

IF `v_count` <> 0 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: noncanonical risk event exists';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `risk_events`
WHERE JSON_UNQUOTE(
          JSON_EXTRACT(`details`, '$.legacy_table')
      ) = 'security_logs'
  AND JSON_EXTRACT(`details`, '$.legacy_type') IS NULL;

IF `v_count` <> 0 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: security legacy type is missing';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `risk_events`
WHERE JSON_UNQUOTE(
          JSON_EXTRACT(`details`, '$.legacy_table')
      ) = 'detection_records'
  AND JSON_EXTRACT(`details`, '$.legacy_check_type') IS NULL;

IF `v_count` <> 0 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: detection legacy type is missing';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `ad_events`;

IF `v_count` <> @v1_expected_ad_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: ad events count mismatch';
END IF;

-- 6.4 指定的正式及兼容写入表必须全部为 InnoDB/utf8mb4。
SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users',
      'risk_events',
      'ad_events',
      'settings',
      'security_logs'
  )
  AND UPPER(COALESCE(`engine`, '')) = 'INNODB'
  AND LOWER(COALESCE(`table_collation`, '')) = 'utf8mb4_unicode_ci';

IF `v_count` <> 5 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: core engine or collation mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'detection_records',
      'user_settings'
  )
  AND UPPER(COALESCE(`engine`, '')) = 'INNODB'
  AND LOWER(COALESCE(`table_collation`, '')) = 'utf8mb4_unicode_ci';

IF `v_count` <> 2 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: compatibility engine or collation mismatch';
END IF;

-- 6.5 新 users 只能由三张正式表引用，且删除规则必须符合模型。
SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users';

IF `v_count` <> 3 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: unexpected new users foreign key count';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users'
  AND (
      (
          `table_name` = 'risk_events'
          AND `column_name` = 'user_id'
          AND `constraint_name` = 'fk_risk_events_user'
      )
      OR (
          `table_name` = 'ad_events'
          AND `column_name` = 'user_id'
          AND `constraint_name` = 'fk_ad_events_user'
      )
      OR (
          `table_name` = 'settings'
          AND `column_name` = 'user_id'
          AND `constraint_name` = 'fk_settings_user'
      )
  );

IF `v_count` <> 3 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: formal users foreign key mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`referential_constraints`
WHERE `constraint_schema` = DATABASE()
  AND (
      (
          `table_name` = 'risk_events'
          AND `constraint_name` = 'fk_risk_events_user'
          AND `delete_rule` = 'SET NULL'
      )
      OR (
          `table_name` = 'ad_events'
          AND `constraint_name` = 'fk_ad_events_user'
          AND `delete_rule` = 'SET NULL'
      )
      OR (
          `table_name` = 'settings'
          AND `constraint_name` = 'fk_settings_user'
          AND `delete_rule` = 'CASCADE'
      )
  );

IF `v_count` <> 3 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: formal foreign key delete rule mismatch';
END IF;

-- 原有 ai_checks、detection_records、logs、statistics、url_checks
-- 以及其他旧表外键必须完整跟随 users_legacy_v22。
SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users_legacy_v22';

IF `v_count` <> @v1_users_fk_count THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: legacy users foreign key count mismatch';
END IF;

SELECT COUNT(*) INTO `v_count`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users_legacy_v22'
  AND `table_name` IN (
      'risk_events',
      'ad_events',
      'settings'
  );

IF `v_count` <> 0 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: formal table references legacy users';
END IF;

-- 6.6 新旧用户关联均不得出现孤儿值。
SELECT SUM(`orphan_count`) INTO `v_count`
FROM (
    SELECT COUNT(*) AS `orphan_count`
    FROM `risk_events` AS `r`
    LEFT JOIN `users` AS `u`
        ON `u`.`id` = `r`.`user_id`
    WHERE `r`.`user_id` IS NOT NULL
      AND `u`.`id` IS NULL

    UNION ALL

    SELECT COUNT(*)
    FROM `ad_events` AS `a`
    LEFT JOIN `users` AS `u`
        ON `u`.`id` = `a`.`user_id`
    WHERE `a`.`user_id` IS NOT NULL
      AND `u`.`id` IS NULL

    UNION ALL

    SELECT COUNT(*)
    FROM `settings` AS `s`
    LEFT JOIN `users` AS `u`
        ON `u`.`id` = `s`.`user_id`
    WHERE `u`.`id` IS NULL

    UNION ALL

    SELECT COUNT(*)
    FROM `detection_records` AS `d`
    LEFT JOIN `users_legacy_v22` AS `u`
        ON `u`.`id` = `d`.`user_id`
    WHERE `d`.`user_id` IS NOT NULL
      AND `u`.`id` IS NULL

    UNION ALL

    SELECT COUNT(*)
    FROM `user_settings_legacy_v22` AS `us`
    LEFT JOIN `users_legacy_v22` AS `u`
        ON `u`.`id` = `us`.`user_id`
    WHERE `us`.`user_id` IS NULL
       OR `u`.`id` IS NULL
) AS `all_orphans`;

IF COALESCE(`v_count`, 0) <> 0 THEN
    SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'Migration validation failed: orphan user reference exists';
END IF;

COMMIT;

-- ============================================================
-- 第七部分：迁移后只读报告
-- 下列语句只读取数据，不修改数据库。
-- ============================================================

SELECT 'users' AS `table_name`, COUNT(*) AS `row_count` FROM `users`
UNION ALL
SELECT 'risk_events', COUNT(*) FROM `risk_events`
UNION ALL
SELECT 'ad_events', COUNT(*) FROM `ad_events`
UNION ALL
SELECT 'settings', COUNT(*) FROM `settings`
UNION ALL
SELECT 'users_legacy_v22', COUNT(*) FROM `users_legacy_v22`
UNION ALL
SELECT 'security_logs', COUNT(*) FROM `security_logs`
UNION ALL
SELECT 'detection_records', COUNT(*) FROM `detection_records`
UNION ALL
SELECT 'user_settings_legacy_v22', COUNT(*) FROM `user_settings_legacy_v22`;

-- 对照 security_logs 风险事件数量。
SELECT
    (
        SELECT COUNT(*)
        FROM `security_logs`
        WHERE `type` <> 'ad_block'
    ) AS `legacy_security_risk_rows`,
    (
        SELECT COUNT(*)
        FROM `risk_events`
        WHERE JSON_UNQUOTE(
            JSON_EXTRACT(`details`, '$.legacy_table')
        ) = 'security_logs'
    ) AS `migrated_security_risk_rows`;

-- 对照广告事件数量。
SELECT
    (
        SELECT COUNT(*)
        FROM `security_logs`
        WHERE `type` = 'ad_block'
    ) AS `legacy_ad_rows`,
    (
        SELECT COUNT(*)
        FROM `ad_events`
        WHERE JSON_UNQUOTE(
            JSON_EXTRACT(`details`, '$.legacy_table')
        ) = 'security_logs'
    ) AS `migrated_ad_rows`;

-- 疑似旧 /ai/check 双写候选。只输出数量供人工复核，不删除、不合并。
-- 旧路由可能分别把页面 URL 和内容摘要写入两张表，因此不使用 URL
-- 相等作为自动去重依据；时间和风险等级也只能用于提示候选。
SELECT COUNT(*) AS `suspected_ai_double_write_candidate_pairs`
FROM `security_logs` AS `security_log`
INNER JOIN `detection_records` AS `detection_record`
    ON `security_log`.`risk_level` = `detection_record`.`risk_level`
   AND ABS(TIMESTAMPDIFF(
           SECOND,
           `security_log`.`created_at`,
           `detection_record`.`created_at`
       )) <= 60
WHERE `security_log`.`type` = 'ai_check'
  AND `detection_record`.`check_type` IN ('ai', 'text');

-- 检查 event_uuid 重复；预期无结果。
SELECT
    `event_uuid`,
    COUNT(*) AS `duplicate_count`
FROM `risk_events`
GROUP BY `event_uuid`
HAVING COUNT(*) > 1;

SELECT
    `event_uuid`,
    COUNT(*) AS `duplicate_count`
FROM `ad_events`
GROUP BY `event_uuid`
HAVING COUNT(*) > 1;

-- 检查每用户多条设置；预期无结果。
SELECT
    `user_id`,
    COUNT(*) AS `duplicate_count`
FROM `settings`
GROUP BY `user_id`
HAVING COUNT(*) > 1;

-- 检查悬空用户引用；两个结果均应为 0。
SELECT COUNT(*) AS `orphan_risk_event_count`
FROM `risk_events` AS `r`
LEFT JOIN `users` AS `u`
    ON `u`.`id` = `r`.`user_id`
WHERE `r`.`user_id` IS NOT NULL
  AND `u`.`id` IS NULL;

SELECT COUNT(*) AS `orphan_ad_event_count`
FROM `ad_events` AS `a`
LEFT JOIN `users` AS `u`
    ON `u`.`id` = `a`.`user_id`
WHERE `a`.`user_id` IS NOT NULL
  AND `u`.`id` IS NULL;

-- 检查 JSON 列没有服务端 DEFAULT。
SELECT
    `table_name`,
    `column_name`,
    `column_default`
FROM `information_schema`.`columns`
WHERE `table_schema` = DATABASE()
  AND `data_type` = 'json'
  AND `table_name` IN (
      'risk_events',
      'ad_events',
      'settings'
  )
ORDER BY `table_name`, `column_name`;

-- 检查 DATETIME(6) 默认值。
SELECT
    `table_name`,
    `column_name`,
    `column_default`,
    `datetime_precision`
FROM `information_schema`.`columns`
WHERE `table_schema` = DATABASE()
  AND `data_type` = 'datetime'
  AND `datetime_precision` = 6
  AND `table_name` IN (
      'users',
      'risk_events',
      'ad_events',
      'settings'
  )
ORDER BY `table_name`, `column_name`;

-- 检查正式表和旧表归档均存在。
SELECT
    `table_name`,
    `engine`,
    `table_collation`
FROM `information_schema`.`tables`
WHERE `table_schema` = DATABASE()
  AND `table_name` IN (
      'users',
      'risk_events',
      'ad_events',
      'settings',
      'security_logs',
      'detection_records',
      'user_settings',
      'users_legacy_v22',
      'user_settings_legacy_v22'
  )
ORDER BY `table_name`;

-- 输出新 users 与归档 users 的全部入站外键，便于留档核对。
SELECT
    `table_name` AS `child_table`,
    `column_name` AS `child_column`,
    `constraint_name`,
    `referenced_table_name`,
    `referenced_column_name`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` IN (
      'users',
      'users_legacy_v22'
  )
ORDER BY
    `referenced_table_name`,
    `table_name`,
    `constraint_name`,
    `ordinal_position`;

    SET @v1_users_fk_count = NULL;
    SET @v1_source_users_count = NULL;
    SET @v1_source_user_settings_count = NULL;
    SET @v1_source_security_logs_count = NULL;
    SET @v1_source_detection_records_count = NULL;
    SET @v1_expected_users_count = NULL;
    SET @v1_expected_settings_count = NULL;
    SET @v1_expected_security_risk_count = NULL;
    SET @v1_expected_ad_count = NULL;
    SET @v1_expected_detection_risk_count = NULL;
    SET @v1_precheck_database = NULL;
END$$

DELIMITER ;

CALL `run_v1_migration`();
DROP PROCEDURE IF EXISTS `run_v1_migration`;
