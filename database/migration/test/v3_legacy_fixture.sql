-- 净网护航 v3 补偿迁移：真实 MySQL 5.7 最小测试数据
--
-- 使用前提：
-- 1. 仅可在一次性数据库 net_guard_migration_v3_test 中执行。
-- 2. 执行前由人工创建并 USE 该空数据库。
-- 3. 本脚本不会创建、删除或切换数据库，也不会清理已有业务表。
-- 4. 任何数据库名不匹配或测试库非空的情况都会 SIGNAL 中止。

SET NAMES utf8mb4;
SET time_zone = '+00:00';
SET @v3_fixture_selected_database = DATABASE();

-- 如果专用测试库不存在，这里即中止；不会自动创建任何数据库。
DROP PROCEDURE IF EXISTS
    `net_guard_migration_v3_test`.`assert_v3_fixture_target`;

DELIMITER $$

CREATE PROCEDURE `net_guard_migration_v3_test`.`assert_v3_fixture_target`()
BEGIN
    DECLARE `v_table_count` BIGINT DEFAULT 0;

    IF @v3_fixture_selected_database IS NULL
       OR LOWER(@v3_fixture_selected_database)
          <> 'net_guard_migration_v3_test' THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Fixture blocked: select net_guard_migration_v3_test first';
    END IF;

    SELECT COUNT(*)
    INTO `v_table_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = 'net_guard_migration_v3_test'
      AND `table_type` = 'BASE TABLE';

    IF `v_table_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Fixture blocked: net_guard_migration_v3_test must be empty';
    END IF;

-- v3 直接读取并更新 risk_events。这里保留旧 v1 创建的完整列集合，
-- 但不创建 users 外键，从而证明 v3 本身不依赖 users 表。
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
    `occurred_at` DATETIME(6) NOT NULL,
    `created_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_risk_events_event_uuid` (`event_uuid`),
    KEY `ix_risk_events_type_occurred` (`event_type`, `occurred_at`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- 旧 v1 会保留 security_logs；v3 用 id 恢复 legacy_type，
-- 并在执行前用 type、risk_level、created_at 盘点疑似双写。
CREATE TABLE `security_logs` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `type` ENUM(
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
    `risk_level` ENUM('safe', 'low', 'medium', 'high') NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `created_at` DATETIME NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- 结构模拟旧 v1 执行后仍保留的兼容表。v3 用 id 恢复
-- legacy_check_type，并读取 check_type、risk_level、created_at。
CREATE TABLE `detection_records` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `url` VARCHAR(500) NOT NULL,
    `is_high_risk` TINYINT(1) NOT NULL DEFAULT 0,
    `is_phishing` TINYINT(1) NOT NULL DEFAULT 0,
    `risk_level` VARCHAR(20) NOT NULL DEFAULT 'safe',
    `risk_score` FLOAT NOT NULL DEFAULT 0,
    `check_type` VARCHAR(20) NOT NULL,
    `user_id` INT NULL,
    `reason` VARCHAR(500) NULL,
    `created_at` DATETIME NOT NULL,

    PRIMARY KEY (`id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

INSERT INTO `security_logs` (
    `id`, `type`, `risk_level`, `url`, `reason`, `created_at`
) VALUES
    (
        101,
        'ai_check',
        'high',
        'https://v3-fixture.invalid/security/ai',
        '[V3 FIXTURE] security_logs ai_check source',
        '2026-01-15 01:00:00'
    ),
    (
        102,
        'url_check',
        'medium',
        'https://v3-fixture.invalid/security/url',
        '[V3 FIXTURE] security_logs url_check source',
        '2026-01-15 01:10:00'
    ),
    (
        103,
        'child_mode',
        'low',
        'https://v3-fixture.invalid/security/child-mode',
        '[V3 FIXTURE] security_logs child_mode source',
        '2026-01-15 01:20:00'
    );

INSERT INTO `detection_records` (
    `id`,
    `url`,
    `is_high_risk`,
    `is_phishing`,
    `risk_level`,
    `risk_score`,
    `check_type`,
    `user_id`,
    `reason`,
    `created_at`
) VALUES
    (
        201,
        'https://v3-fixture.invalid/detection/text',
        1,
        0,
        'high',
        0.9500,
        'text',
        NULL,
        '[V3 FIXTURE] detection_records text source',
        '2026-01-15 01:00:30'
    ),
    (
        202,
        'https://v3-fixture.invalid/detection/url',
        0,
        1,
        'medium',
        0.7000,
        'url',
        NULL,
        '[V3 FIXTURE] detection_records url source',
        '2026-01-15 01:30:00'
    ),
    (
        203,
        'https://v3-fixture.invalid/detection/rule',
        1,
        0,
        'low',
        0.3000,
        'rule',
        NULL,
        '[V3 FIXTURE] detection_records rule source',
        '2026-01-15 01:40:00'
    );

-- 六条历史记录只携带旧 v1 当时写入的 legacy_table/legacy_id。
-- v3 应从上述源表补回 legacy_type 或 legacy_check_type。
INSERT INTO `risk_events` (
    `id`,
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
) VALUES
    (
        1001,
        '00000000-0000-4000-8000-000000000101',
        NULL,
        'ai_check',
        'text',
        'high',
        0.9000,
        'https://v3-fixture.invalid/security/ai',
        SHA2('https://v3-fixture.invalid/security/ai', 256),
        '[V3 FIXTURE] legacy security ai event',
        'backend',
        JSON_OBJECT('legacy_table', 'security_logs', 'legacy_id', 101),
        '2026-01-15 01:00:00.000000',
        '2026-01-15 01:00:00.000000'
    ),
    (
        1002,
        '00000000-0000-4000-8000-000000000102',
        NULL,
        'url_check',
        'url',
        'medium',
        0.6000,
        'https://v3-fixture.invalid/security/url',
        SHA2('https://v3-fixture.invalid/security/url', 256),
        '[V3 FIXTURE] legacy security url event',
        'backend',
        JSON_OBJECT('legacy_table', 'security_logs', 'legacy_id', 102),
        '2026-01-15 01:10:00.000000',
        '2026-01-15 01:10:00.000000'
    ),
    (
        1003,
        '00000000-0000-4000-8000-000000000103',
        NULL,
        'child_block',
        'rule',
        'low',
        0.2500,
        'https://v3-fixture.invalid/security/child-mode',
        SHA2('https://v3-fixture.invalid/security/child-mode', 256),
        '[V3 FIXTURE] legacy security child mode event',
        'backend',
        JSON_OBJECT('legacy_table', 'security_logs', 'legacy_id', 103),
        '2026-01-15 01:20:00.000000',
        '2026-01-15 01:20:00.000000'
    ),
    (
        1004,
        '00000000-0000-4000-8000-000000000201',
        NULL,
        'ai_check',
        'text',
        'high',
        0.9500,
        'https://v3-fixture.invalid/detection/text',
        SHA2('https://v3-fixture.invalid/detection/text', 256),
        '[V3 FIXTURE] legacy detection text event',
        'backend',
        JSON_OBJECT('legacy_table', 'detection_records', 'legacy_id', 201),
        '2026-01-15 01:00:30.000000',
        '2026-01-15 01:00:30.000000'
    ),
    (
        1005,
        '00000000-0000-4000-8000-000000000202',
        NULL,
        'url_check',
        'url',
        'medium',
        0.7000,
        'https://v3-fixture.invalid/detection/url',
        SHA2('https://v3-fixture.invalid/detection/url', 256),
        '[V3 FIXTURE] legacy detection url event',
        'backend',
        JSON_OBJECT('legacy_table', 'detection_records', 'legacy_id', 202),
        '2026-01-15 01:30:00.000000',
        '2026-01-15 01:30:00.000000'
    ),
    (
        1006,
        '00000000-0000-4000-8000-000000000203',
        NULL,
        'legacy_check',
        'rule',
        'low',
        0.3000,
        'https://v3-fixture.invalid/detection/rule',
        SHA2('https://v3-fixture.invalid/detection/rule', 256),
        '[V3 FIXTURE] legacy detection rule event',
        'backend',
        JSON_OBJECT('legacy_table', 'detection_records', 'legacy_id', 203),
        '2026-01-15 01:40:00.000000',
        '2026-01-15 01:40:00.000000'
    ),
    (
        1007,
        '00000000-0000-4000-8000-000000009001',
        NULL,
        'extension_risk',
        'ai',
        'medium',
        0.5500,
        'https://v3-fixture.invalid/new/untouched',
        SHA2('https://v3-fixture.invalid/new/untouched', 256),
        '[V3 FIXTURE] normal new event must remain unchanged',
        'extension',
        JSON_OBJECT(
            'fixture_case', 'normal-new-event',
            'immutable_marker', 'v3-must-not-change'
        ),
        '2026-01-15 02:00:00.123456',
        '2026-01-15 02:00:01.654321'
    );

-- 迁移前基线。预期：总量 7、历史标记 6、正常新事件 1。
SELECT
    VERSION() AS `mysql_version`,
    DATABASE() AS `fixture_database`,
    COUNT(*) AS `total_risk_events`,
    COALESCE(SUM(
        JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
            IN ('security_logs', 'detection_records')
        AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
    ), 0) AS `legacy_marked_events`,
    COALESCE(SUM(
        `event_uuid` = '00000000-0000-4000-8000-000000009001'
    ), 0) AS `normal_new_events`
FROM `risk_events`;

SELECT
    `event_type`,
    `check_type`,
    COUNT(*) AS `row_count`
FROM `risk_events`
GROUP BY `event_type`, `check_type`
ORDER BY `event_type`, `check_type`;

END$$

DELIMITER ;

-- 所有 DDL、DML 和迁移前基线输出都封装在守卫过程内部。
-- 即使 mysql SOURCE 在语句报错后继续读取文件，也不会越过数据库名检查
-- 创建测试表或写入 fixture 数据。
CALL `net_guard_migration_v3_test`.`assert_v3_fixture_target`();
DROP PROCEDURE IF EXISTS
    `net_guard_migration_v3_test`.`assert_v3_fixture_target`;
