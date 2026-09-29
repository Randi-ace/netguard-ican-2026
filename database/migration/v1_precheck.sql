-- 净网护航 v1.0-alpha 数据库迁移前检查
-- 适用数据库：MySQL 5.7.8 及以上的 5.7 版本
--
-- 必须在 net_guard 或 net_guard_migration_test 数据库会话中先执行
-- 本文件，再在同一会话中执行 v1_migration.sql。任何检查失败都会
-- 抛出 SQLSTATE 45000，并保持 @v1_precheck_passed = 0；
-- 迁移脚本会拒绝继续。
--
-- 本文件只读取业务表和数据。仅创建并删除临时检查存储过程，
-- 不修改业务表结构或业务数据。

SET NAMES utf8mb4;
SET @v1_precheck_passed = 0;
SET @v1_precheck_database = NULL;
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

DROP PROCEDURE IF EXISTS `run_v1_precheck`;

DELIMITER $$

CREATE PROCEDURE `run_v1_precheck`()
BEGIN
    DECLARE `v_count` BIGINT DEFAULT 0;
    DECLARE `v_version_text` VARCHAR(64);
    DECLARE `v_major` INT DEFAULT 0;
    DECLARE `v_minor` INT DEFAULT 0;
    DECLARE `v_patch` INT DEFAULT 0;
    DECLARE `v_users_fk_count` INT DEFAULT 0;
    DECLARE `v_fk_done` TINYINT DEFAULT 0;
    DECLARE `v_fk_table` VARCHAR(64);
    DECLARE `v_fk_column` VARCHAR(64);
    DECLARE `v_fk_constraint` VARCHAR(64);

    DECLARE `users_fk_cursor` CURSOR FOR
        SELECT
            `table_name`,
            `column_name`,
            `constraint_name`
        FROM `information_schema`.`key_column_usage`
        WHERE `constraint_schema` = DATABASE()
          AND `referenced_table_schema` = DATABASE()
          AND `referenced_table_name` = 'users'
        ORDER BY `table_name`, `constraint_name`, `ordinal_position`;

    DECLARE CONTINUE HANDLER FOR NOT FOUND SET `v_fk_done` = 1;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        SET @v1_precheck_passed = 0;
        SET @v1_precheck_database = NULL;
        SET @v1_users_fk_count = NULL;
        RESIGNAL;
    END;

    -- 1. 数据库名称检查
    IF DATABASE() IS NULL
       OR LOWER(DATABASE()) NOT IN (
           'net_guard',
           'net_guard_migration_test'
       ) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: database must be net_guard or net_guard_migration_test';
    END IF;

    -- 2. MySQL 版本及目标 DDL 能力检查
    -- JSON 从 MySQL 5.7.8 开始可用；DATETIME(6)、utf8mb4 和 InnoDB
    -- 均为本次正式表 DDL 的必要条件。
    SET `v_version_text` = SUBSTRING_INDEX(VERSION(), '-', 1);
    SET `v_major` = CAST(
        SUBSTRING_INDEX(`v_version_text`, '.', 1) AS UNSIGNED
    );
    SET `v_minor` = CAST(
        SUBSTRING_INDEX(
            SUBSTRING_INDEX(`v_version_text`, '.', 2),
            '.',
            -1
        ) AS UNSIGNED
    );
    SET `v_patch` = CAST(
        SUBSTRING_INDEX(
            SUBSTRING_INDEX(`v_version_text`, '.', 3),
            '.',
            -1
        ) AS UNSIGNED
    );

    IF `v_major` <> 5
       OR `v_minor` <> 7
       OR `v_patch` < 8 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: MySQL 5.7.8 or newer 5.7 is required';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`engines`
    WHERE UPPER(`engine`) = 'INNODB'
      AND UPPER(`support`) IN ('YES', 'DEFAULT');

    IF `v_count` <> 1 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: InnoDB storage engine is unavailable';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`character_sets`
    WHERE LOWER(`character_set_name`) = 'utf8mb4';

    IF `v_count` <> 1 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: utf8mb4 character set is unavailable';
    END IF;

    IF FIND_IN_SET(
        'NO_ENGINE_SUBSTITUTION',
        UPPER(COALESCE(@@SESSION.sql_mode, ''))
    ) = 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: NO_ENGINE_SUBSTITUTION SQL mode is required';
    END IF;

    -- 3. 四张旧表必须全部存在，并且只能使用可迁移的持久化引擎。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_type` = 'BASE TABLE'
      AND `table_name` IN (
          'users',
          'security_logs',
          'detection_records',
          'user_settings'
      );

    IF `v_count` <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: required legacy tables are incomplete';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_name` IN (
          'users',
          'security_logs',
          'detection_records',
          'user_settings'
      )
      AND UPPER(COALESCE(`engine`, '')) NOT IN ('INNODB', 'MYISAM');

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy tables must use InnoDB or MyISAM';
    END IF;

    -- 4. 新表及固定归档表名不能提前存在，避免覆盖或混入半迁移状态。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_name` IN (
          'risk_events',
          'ad_events',
          'settings',
          'users_legacy_v22',
          'user_settings_legacy_v22'
      );

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: new or archived table names already exist';
    END IF;

    -- 5. users 旧表字段及关键类型检查
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'users'
      AND `column_name` IN (
          'id',
          'username',
          'email',
          'password_hash',
          'created_at',
          'updated_at',
          'role',
          'mode'
      );

    IF `v_count` <> 8 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy users columns do not match';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'users'
      AND (
          (
              `column_name` = 'id'
              AND `data_type` IN ('int', 'bigint')
              AND `column_key` = 'PRI'
              AND LOWER(`extra`) LIKE '%auto_increment%'
          )
          OR (
              `column_name` = 'username'
              AND `data_type` IN ('char', 'varchar')
          )
          OR (
              `column_name` IN ('created_at', 'updated_at')
              AND `data_type` IN ('datetime', 'timestamp')
          )
      );

    IF `v_count` <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy users key column types do not match';
    END IF;

    -- 6. security_logs 旧表字段及关键类型检查
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'security_logs'
      AND `column_name` IN (
          'id',
          'type',
          'risk_level',
          'url',
          'reason',
          'created_at'
      );

    IF `v_count` <> 6 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy security_logs columns do not match';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'security_logs'
      AND (
          (
              `column_name` = 'id'
              AND `data_type` IN ('int', 'bigint')
              AND `column_key` = 'PRI'
          )
          OR (
              `column_name` IN ('type', 'risk_level')
              AND `data_type` IN ('enum', 'char', 'varchar')
          )
          OR (
              `column_name` = 'url'
              AND `data_type` IN ('char', 'varchar', 'text')
          )
          OR (
              `column_name` = 'created_at'
              AND `data_type` IN ('datetime', 'timestamp')
          )
      );

    IF `v_count` <> 5 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy security_logs key column types do not match';
    END IF;

    -- 7. detection_records 旧表字段及关键类型检查
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'detection_records'
      AND `column_name` IN (
          'id',
          'check_type',
          'url',
          'risk_level',
          'risk_score',
          'user_id',
          'created_at'
      );

    IF `v_count` <> 7 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy detection_records columns do not match';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'detection_records'
      AND (
          (
              `column_name` = 'id'
              AND `data_type` IN ('int', 'bigint')
              AND `column_key` = 'PRI'
          )
          OR (
              `column_name` = 'user_id'
              AND `data_type` = 'int'
          )
          OR (
              `column_name` IN ('check_type', 'risk_level')
              AND `data_type` IN ('char', 'varchar', 'enum')
          )
          OR (
              `column_name` = 'created_at'
              AND `data_type` IN ('datetime', 'timestamp')
          )
      );

    IF `v_count` <> 5 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy detection_records key column types do not match';
    END IF;

    -- 本次迁移会新增这三个兼容字段；提前存在表示数据库已部分迁移。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'detection_records'
      AND `column_name` IN (
          'is_high_risk',
          'is_phishing',
          'reason'
      );

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: detection_records is already partially migrated';
    END IF;

    -- 8. user_settings 旧表字段及关键类型检查
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'user_settings'
      AND `column_name` IN (
          'id',
          'user_id',
          'mode',
          'updated_at'
      );

    IF `v_count` <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy user_settings columns do not match';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`columns`
    WHERE `table_schema` = DATABASE()
      AND `table_name` = 'user_settings'
      AND (
          (
              `column_name` = 'id'
              AND `data_type` IN ('int', 'bigint')
              AND `column_key` = 'PRI'
          )
          OR (
              `column_name` = 'user_id'
              AND `data_type` IN ('int', 'bigint')
          )
          OR (
              `column_name` = 'mode'
              AND `data_type` IN ('char', 'varchar', 'enum')
          )
          OR (
              `column_name` = 'updated_at'
              AND `data_type` IN ('datetime', 'timestamp')
          )
      );

    IF `v_count` <> 4 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: legacy user_settings key column types do not match';
    END IF;

    -- 9. 用户数据必须能无损映射到 BIGINT UNSIGNED 和目标唯一索引。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `users`
    WHERE `id` <= 0
       OR `created_at` IS NULL
       OR `updated_at` IS NULL;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: users contain invalid id or timestamp values';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `users`
    WHERE `username` IS NOT NULL
      AND CHAR_LENGTH(`username`) > 64;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: username longer than 64 characters exists';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM (
        SELECT
            CONVERT(
                LEFT(`username`, 64) USING utf8mb4
            ) COLLATE utf8mb4_unicode_ci AS `new_username`
        FROM `users`
        WHERE `username` IS NOT NULL
        GROUP BY `new_username`
        HAVING COUNT(*) > 1
    ) AS `duplicate_usernames`;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: duplicate username under target collation';
    END IF;

    -- 10. 设置和检测记录不允许静默丢失用户关联。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `user_settings` AS `us`
    LEFT JOIN `users` AS `u`
        ON `u`.`id` = `us`.`user_id`
    WHERE `us`.`user_id` IS NULL
       OR `u`.`id` IS NULL;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: orphan or NULL user_settings.user_id exists';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `user_settings`
    WHERE `mode` IS NULL
       OR `mode` NOT IN ('normal', 'strict', 'elder', 'child');

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: unsupported user setting mode exists';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `detection_records` AS `d`
    LEFT JOIN `users` AS `u`
        ON `u`.`id` = `d`.`user_id`
    WHERE `d`.`user_id` IS NOT NULL
      AND `u`.`id` IS NULL;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: orphan detection_records.user_id exists';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `detection_records`
    WHERE `risk_level` IS NULL
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high');

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: unsupported detection risk level exists';
    END IF;

    -- 当前仓库能明确识别的旧检测类型只有 AI、URL 和规则检测。
    -- 未知值不得在迁移时被静默归类为 rule，应先由执行人确认来源。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `detection_records`
    WHERE `check_type` IS NULL
       OR `check_type` NOT IN ('ai', 'text', 'url', 'rule');

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: unsupported detection check type exists';
    END IF;

    SELECT COUNT(*)
    INTO `v_count`
    FROM `security_logs`
    WHERE `type` IS NULL
       OR `type` NOT IN (
           'ai_check',
           'url_check',
           'ad_block',
           'child_mode',
           'elder_mode',
           'strict_mode',
           'entertainment_block',
           'game_block',
           'dangerous_block'
       )
       OR `risk_level` IS NULL
       OR `risk_level` NOT IN ('safe', 'low', 'medium', 'high');

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: unsupported security_logs enum value exists';
    END IF;

    -- 11. 扫描当前数据库及其他 schema 对 users 的所有真实外键。
    -- 跨数据库外键不允许自动迁移，必须先由维护者人工解除。
    SELECT COUNT(*)
    INTO `v_count`
    FROM `information_schema`.`key_column_usage`
    WHERE `referenced_table_schema` = DATABASE()
      AND `referenced_table_name` = 'users'
      AND `constraint_schema` <> DATABASE();

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: cross-database foreign key references users';
    END IF;

    -- 本迁移只接受指向 users.id 的单列外键。覆盖 ai_checks、
    -- detection_records、logs、statistics、url_checks 及其他可能的表。
    SELECT COUNT(*)
    INTO `v_count`
    FROM (
        SELECT
            `constraint_schema`,
            `table_name`,
            `constraint_name`
        FROM `information_schema`.`key_column_usage`
        WHERE `constraint_schema` = DATABASE()
          AND `referenced_table_schema` = DATABASE()
          AND `referenced_table_name` = 'users'
        GROUP BY
            `constraint_schema`,
            `table_name`,
            `constraint_name`
        HAVING COUNT(*) <> 1
            OR MIN(`referenced_column_name`) <> 'id'
            OR MAX(`referenced_column_name`) <> 'id'
    ) AS `unsupported_users_foreign_keys`;

    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'Precheck failed: users has unsupported composite or target foreign key';
    END IF;

    SELECT COUNT(*)
    INTO `v_users_fk_count`
    FROM `information_schema`.`key_column_usage`
    WHERE `constraint_schema` = DATABASE()
      AND `referenced_table_schema` = DATABASE()
      AND `referenced_table_name` = 'users';

    -- 对所有已发现的外键逐一做孤儿数据检查，不能只检查固定表名。
    SET `v_fk_done` = 0;
    OPEN `users_fk_cursor`;

    `users_fk_loop`: LOOP
        FETCH `users_fk_cursor`
        INTO `v_fk_table`, `v_fk_column`, `v_fk_constraint`;

        IF `v_fk_done` = 1 THEN
            LEAVE `users_fk_loop`;
        END IF;

        SET @v1_fk_orphan_count = 0;
        SET @v1_fk_orphan_sql = CONCAT(
            'SELECT COUNT(*) INTO @v1_fk_orphan_count ',
            'FROM `',
            REPLACE(`v_fk_table`, '`', '``'),
            '` AS `child_row` ',
            'LEFT JOIN `users` AS `parent_row` ON `parent_row`.`id` = ',
            '`child_row`.`',
            REPLACE(`v_fk_column`, '`', '``'),
            '` ',
            'WHERE `child_row`.`',
            REPLACE(`v_fk_column`, '`', '``'),
            '` IS NOT NULL AND `parent_row`.`id` IS NULL'
        );

        PREPARE v1_fk_orphan_statement FROM @v1_fk_orphan_sql;
        EXECUTE v1_fk_orphan_statement;
        DEALLOCATE PREPARE v1_fk_orphan_statement;

        IF COALESCE(@v1_fk_orphan_count, 0) <> 0 THEN
            SIGNAL SQLSTATE '45000'
                SET MESSAGE_TEXT = 'Precheck failed: orphan value exists in a users foreign key';
        END IF;
    END LOOP;

    CLOSE `users_fk_cursor`;

    -- 12. 固化源数据计数。迁移脚本会在执行前后再次核对，
    -- 从而发现预检查后仍有业务写入的情况。
    SELECT COUNT(*) INTO @v1_source_users_count
    FROM `users`;

    SELECT COUNT(*) INTO @v1_source_user_settings_count
    FROM `user_settings`;

    SELECT COUNT(*) INTO @v1_source_security_logs_count
    FROM `security_logs`;

    SELECT COUNT(*) INTO @v1_source_detection_records_count
    FROM `detection_records`;

    SELECT
        @v1_source_users_count
        + IF(
            EXISTS (
                SELECT 1
                FROM `users`
                WHERE CONVERT(
                    `username` USING utf8mb4
                ) COLLATE utf8mb4_unicode_ci = 'demo'
            ),
            0,
            1
        )
    INTO @v1_expected_users_count;

    SET @v1_expected_settings_count = @v1_expected_users_count;

    SELECT COUNT(*)
    INTO @v1_expected_security_risk_count
    FROM `security_logs`
    WHERE `type` <> 'ad_block';

    SELECT COUNT(*)
    INTO @v1_expected_ad_count
    FROM `security_logs`
    WHERE `type` = 'ad_block';

    -- detection_records 与 security_logs 的旧 AI 双写无法仅凭现有字段
    -- 可靠判定为同一事件。本轮不再静默排除疑似重复记录。
    SELECT COUNT(*)
    INTO @v1_expected_detection_risk_count
    FROM `detection_records`;

    SET @v1_users_fk_count = `v_users_fk_count`;
    SET @v1_precheck_database = DATABASE();
    SET @v1_precheck_passed = 1;
END$$

DELIMITER ;

CALL `run_v1_precheck`();
DROP PROCEDURE IF EXISTS `run_v1_precheck`;

SELECT
    @v1_precheck_passed AS `precheck_passed`,
    @v1_precheck_database AS `checked_database`,
    VERSION() AS `mysql_version`,
    @v1_users_fk_count AS `legacy_users_foreign_key_count`,
    @v1_source_users_count AS `legacy_users_count`,
    @v1_source_user_settings_count AS `legacy_user_settings_count`,
    @v1_source_security_logs_count AS `legacy_security_logs_count`,
    @v1_source_detection_records_count AS `legacy_detection_records_count`;

SELECT
    `table_name` AS `child_table`,
    `column_name` AS `child_column`,
    `constraint_name`,
    `referenced_table_name`,
    `referenced_column_name`
FROM `information_schema`.`key_column_usage`
WHERE `constraint_schema` = DATABASE()
  AND `referenced_table_schema` = DATABASE()
  AND `referenced_table_name` = 'users'
ORDER BY `table_name`, `constraint_name`, `ordinal_position`;

-- 旧检测类型分布。执行人必须确认除 ai、text、url、rule 外的值
-- 是否确实属于规则检测；迁移会在 details 中保留原值。
SELECT
    `check_type` AS `legacy_check_type`,
    COUNT(*) AS `row_count`
FROM `detection_records`
GROUP BY `check_type`
ORDER BY `check_type`;

-- 风险等级分布。非法或 NULL 值已由强制预检查阻止迁移。
SELECT
    'security_logs' AS `legacy_table`,
    `risk_level`,
    COUNT(*) AS `row_count`
FROM `security_logs`
GROUP BY `risk_level`
UNION ALL
SELECT
    'detection_records',
    `risk_level`,
    COUNT(*)
FROM `detection_records`
GROUP BY `risk_level`
ORDER BY `legacy_table`, `risk_level`;

-- 只盘点分数量纲，不自动把大于 1 的值除以 100。
SELECT
    SUM(`risk_score` IS NULL) AS `null_score_count`,
    SUM(`risk_score` < 0) AS `negative_score_count`,
    SUM(`risk_score` BETWEEN 0 AND 1) AS `zero_to_one_score_count`,
    SUM(`risk_score` > 1 AND `risk_score` <= 100)
        AS `possible_zero_to_hundred_score_count`,
    SUM(`risk_score` > 100) AS `over_hundred_score_count`,
    CASE
        WHEN SUM(`risk_score` > 1 AND `risk_score` <= 100) > 0 THEN
            'WARNING: confirm whether legacy scores use a 0-100 scale before migration'
        ELSE 'No 0-100 score candidates found'
    END AS `score_scale_warning`
FROM `detection_records`;

-- DATETIME 不携带时区。这里仅输出范围和 MySQL 时区供人工判断，
-- 不在迁移中统一加减 8 小时或调用 CONVERT_TZ。
SELECT
    'security_logs' AS `legacy_table`,
    MIN(`created_at`) AS `minimum_created_at`,
    MAX(`created_at`) AS `maximum_created_at`,
    @@GLOBAL.time_zone AS `global_time_zone`,
    @@SESSION.time_zone AS `session_time_zone`,
    @@system_time_zone AS `system_time_zone`
FROM `security_logs`
UNION ALL
SELECT
    'detection_records',
    MIN(`created_at`),
    MAX(`created_at`),
    @@GLOBAL.time_zone,
    @@SESSION.time_zone,
    @@system_time_zone
FROM `detection_records`;

-- 这些负责人本地旧表不是本轮迁移数据源，只输出存在性和估算行数，
-- 供执行人在迁移前确认是否存在未被正式数据源覆盖的历史数据。
SELECT
    `legacy_inventory`.`table_name`,
    IF(`tables`.`table_name` IS NULL, 0, 1) AS `table_exists`,
    `tables`.`table_rows` AS `estimated_row_count`
FROM (
    SELECT 'ai_checks' AS `table_name`
    UNION ALL SELECT 'url_checks'
    UNION ALL SELECT 'logs'
    UNION ALL SELECT 'statistics'
) AS `legacy_inventory`
LEFT JOIN `information_schema`.`tables` AS `tables`
    ON `tables`.`table_schema` = DATABASE()
   AND `tables`.`table_name` = `legacy_inventory`.`table_name`
ORDER BY `legacy_inventory`.`table_name`;
