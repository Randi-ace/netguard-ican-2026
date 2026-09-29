-- 净网护航历史风险事件口径补偿迁移
-- 适用数据库：已经运行旧版 v1_migration.sql 的 MySQL 5.7.26 数据库
--
-- 目标：只规范化由旧 v1 迁入 risk_events 的历史记录。
-- 识别条件：details.legacy_table 为 security_logs 或 detection_records，
-- 且 details.legacy_id 存在。正常新事件没有这些标记，不会被修改。
--
-- 本脚本只执行 UPDATE 和只读验证，不插入或删除 risk_events。
-- UPDATE 均带非规范值条件，重复执行不会继续改变已完成的记录。
-- 执行前仍必须完成全库备份，并明确选中目标数据库。

SET NAMES utf8mb4;
SET time_zone = '+00:00';

DROP PROCEDURE IF EXISTS `run_v3_normalize_legacy_risk_events`;

DELIMITER $$

CREATE PROCEDURE `run_v3_normalize_legacy_risk_events`()
BEGIN
    DECLARE `v_invalid_count` BIGINT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        ROLLBACK;
        RESIGNAL;
    END;

    -- 执行前报告：总量、历史迁移量、非规范值和当前分类。
    SELECT
        'before' AS `phase`,
        COUNT(*) AS `total_risk_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
        ), 0) AS `legacy_migrated_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `event_type` <> 'extension_risk'
        ), 0) AS `non_extension_risk_legacy_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` NOT IN ('ai', 'url', 'rule')
        ), 0) AS `invalid_check_type_legacy_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'ai'
        ), 0) AS `ai_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'url'
        ), 0) AS `url_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'rule'
        ), 0) AS `rule_events`
    FROM `risk_events`;

    SELECT
        'before' AS `phase`,
        COUNT(*) AS `suspected_ai_double_write_candidate_pairs`
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

    START TRANSACTION;

    -- 旧 v1 没有保存 legacy_type。先根据其确定性 event_type 映射补回，
    -- 以便规范化后仍可追溯 security_logs 的原始类型。
    UPDATE `risk_events` AS `risk_event`
    INNER JOIN `security_logs` AS `security_log`
        ON `security_log`.`id` = CAST(
            JSON_UNQUOTE(
                JSON_EXTRACT(`risk_event`.`details`, '$.legacy_id')
            ) AS UNSIGNED
        )
    SET `risk_event`.`details` = JSON_SET(
        `risk_event`.`details`,
        '$.legacy_type',
        `security_log`.`type`
    )
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`risk_event`.`details`, '$.legacy_table')
          ) = 'security_logs'
      AND JSON_EXTRACT(
              `risk_event`.`details`, '$.legacy_id'
          ) IS NOT NULL
      AND JSON_EXTRACT(
              `risk_event`.`details`, '$.legacy_type'
          ) IS NULL;

    -- 同样保留 detection_records 的旧 check_type；旧 v1 的值仍在
    -- check_type 中，先存入 details 再规范化。
    UPDATE `risk_events` AS `risk_event`
    INNER JOIN `detection_records` AS `detection_record`
        ON `detection_record`.`id` = CAST(
            JSON_UNQUOTE(
                JSON_EXTRACT(`risk_event`.`details`, '$.legacy_id')
            ) AS UNSIGNED
        )
    SET `risk_event`.`details` = JSON_SET(
        `risk_event`.`details`,
        '$.legacy_check_type',
        `detection_record`.`check_type`
    )
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`risk_event`.`details`, '$.legacy_table')
          ) = 'detection_records'
      AND JSON_EXTRACT(
              `risk_event`.`details`, '$.legacy_id'
          ) IS NOT NULL
      AND JSON_EXTRACT(
              `risk_event`.`details`, '$.legacy_check_type'
          ) IS NULL;

    -- 旧 v1 明确保留上述两张源表。若无法按 legacy_id 找回原始类型，
    -- 立即回滚，避免把无法确认的历史记录静默归入 rule。
    SELECT COUNT(*) INTO `v_invalid_count`
    FROM `risk_events`
    WHERE (
            JSON_UNQUOTE(
                JSON_EXTRACT(`details`, '$.legacy_table')
            ) = 'security_logs'
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND JSON_EXTRACT(`details`, '$.legacy_type') IS NULL
          )
       OR (
            JSON_UNQUOTE(
                JSON_EXTRACT(`details`, '$.legacy_table')
            ) = 'detection_records'
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND JSON_EXTRACT(
                    `details`, '$.legacy_check_type'
                ) IS NULL
          );

    IF `v_invalid_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v3 validation failed: legacy source type is unavailable';
    END IF;

    SELECT COUNT(*) INTO `v_invalid_count`
    FROM `risk_events`
    WHERE (
            JSON_UNQUOTE(
                JSON_EXTRACT(`details`, '$.legacy_table')
            ) = 'security_logs'
            AND JSON_UNQUOTE(
                    JSON_EXTRACT(`details`, '$.legacy_type')
                ) NOT IN (
                    'ai_check',
                    'url_check',
                    'child_mode',
                    'elder_mode',
                    'strict_mode',
                    'entertainment_block',
                    'game_block',
                    'dangerous_block'
                )
          )
       OR (
            JSON_UNQUOTE(
                JSON_EXTRACT(`details`, '$.legacy_table')
            ) = 'detection_records'
            AND JSON_UNQUOTE(
                    JSON_EXTRACT(`details`, '$.legacy_check_type')
                ) NOT IN ('ai', 'text', 'url', 'rule')
          );

    IF `v_invalid_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v3 validation failed: unsupported legacy source type exists';
    END IF;

    -- security_logs 历史风险记录：正式口径用于业务统计，旧类型留在 details。
    UPDATE `risk_events`
    SET
        `event_type` = 'extension_risk',
        `check_type` = CASE
            WHEN JSON_UNQUOTE(
                     JSON_EXTRACT(`details`, '$.legacy_type')
                 ) = 'ai_check' THEN 'ai'
            WHEN JSON_UNQUOTE(
                     JSON_EXTRACT(`details`, '$.legacy_type')
                 ) = 'url_check' THEN 'url'
            ELSE 'rule'
        END
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`details`, '$.legacy_table')
          ) = 'security_logs'
      AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
      AND (
          `event_type` <> 'extension_risk'
          OR `check_type` NOT IN ('ai', 'url', 'rule')
          OR `check_type` <> CASE
              WHEN JSON_UNQUOTE(
                       JSON_EXTRACT(`details`, '$.legacy_type')
                   ) = 'ai_check' THEN 'ai'
              WHEN JSON_UNQUOTE(
                       JSON_EXTRACT(`details`, '$.legacy_type')
                   ) = 'url_check' THEN 'url'
              ELSE 'rule'
          END
      );

    -- detection_records 历史记录：ai/text 统一为 ai，url 保持 url，
    -- 其余旧检测类型归入 rule，原值由 legacy_check_type 保留。
    UPDATE `risk_events`
    SET
        `event_type` = 'extension_risk',
        `check_type` = CASE
            WHEN JSON_UNQUOTE(
                     JSON_EXTRACT(`details`, '$.legacy_check_type')
                 ) IN ('ai', 'text') THEN 'ai'
            WHEN JSON_UNQUOTE(
                     JSON_EXTRACT(`details`, '$.legacy_check_type')
                 ) = 'url' THEN 'url'
            WHEN JSON_UNQUOTE(
                     JSON_EXTRACT(`details`, '$.legacy_check_type')
                 ) = 'rule' THEN 'rule'
            ELSE `check_type`
        END
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`details`, '$.legacy_table')
          ) = 'detection_records'
      AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
      AND (
          `event_type` <> 'extension_risk'
          OR `check_type` NOT IN ('ai', 'url', 'rule')
          OR `check_type` <> CASE
              WHEN JSON_UNQUOTE(
                       JSON_EXTRACT(`details`, '$.legacy_check_type')
                   ) IN ('ai', 'text') THEN 'ai'
              WHEN JSON_UNQUOTE(
                       JSON_EXTRACT(`details`, '$.legacy_check_type')
                   ) = 'url' THEN 'url'
              WHEN JSON_UNQUOTE(
                       JSON_EXTRACT(`details`, '$.legacy_check_type')
                   ) = 'rule' THEN 'rule'
              ELSE `check_type`
          END
      );

    -- 提交前强制确认所有明确标记的历史迁移记录已符合正式口径。
    SELECT COUNT(*) INTO `v_invalid_count`
    FROM `risk_events`
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`details`, '$.legacy_table')
          ) IN ('security_logs', 'detection_records')
      AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
      AND (
          `event_type` <> 'extension_risk'
          OR `check_type` NOT IN ('ai', 'url', 'rule')
      );

    IF `v_invalid_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v3 validation failed: noncanonical legacy risk event remains';
    END IF;

    COMMIT;

    -- 执行后报告。总 risk_events 数量应与执行前完全相同。
    SELECT
        'after' AS `phase`,
        COUNT(*) AS `total_risk_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
        ), 0) AS `legacy_migrated_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `event_type` <> 'extension_risk'
        ), 0) AS `non_extension_risk_legacy_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` NOT IN ('ai', 'url', 'rule')
        ), 0) AS `invalid_check_type_legacy_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'ai'
        ), 0) AS `ai_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'url'
        ), 0) AS `url_events`,
        COALESCE(SUM(
            JSON_UNQUOTE(JSON_EXTRACT(`details`, '$.legacy_table'))
                IN ('security_logs', 'detection_records')
            AND JSON_EXTRACT(`details`, '$.legacy_id') IS NOT NULL
            AND `check_type` = 'rule'
        ), 0) AS `rule_events`
    FROM `risk_events`;

    -- 疑似旧 /ai/check 双写候选。只报告配对数量，不删除、不合并。
    -- 时间和风险等级只能提示人工复核，不能证明是同一业务事件。
    SELECT
        'after' AS `phase`,
        COUNT(*) AS `suspected_ai_double_write_candidate_pairs`
    FROM `risk_events` AS `security_event`
    INNER JOIN `risk_events` AS `detection_event`
        ON `security_event`.`risk_level` = `detection_event`.`risk_level`
       AND ABS(TIMESTAMPDIFF(
               SECOND,
               `security_event`.`occurred_at`,
               `detection_event`.`occurred_at`
           )) <= 60
    WHERE JSON_UNQUOTE(
              JSON_EXTRACT(`security_event`.`details`, '$.legacy_table')
          ) = 'security_logs'
      AND JSON_EXTRACT(
              `security_event`.`details`, '$.legacy_id'
          ) IS NOT NULL
      AND JSON_UNQUOTE(
              JSON_EXTRACT(`security_event`.`details`, '$.legacy_type')
          ) = 'ai_check'
      AND JSON_UNQUOTE(
              JSON_EXTRACT(`detection_event`.`details`, '$.legacy_table')
          ) = 'detection_records'
      AND JSON_EXTRACT(
              `detection_event`.`details`, '$.legacy_id'
          ) IS NOT NULL
      AND JSON_UNQUOTE(
              JSON_EXTRACT(
                  `detection_event`.`details`, '$.legacy_check_type'
              )
          ) IN ('ai', 'text');
END$$

DELIMITER ;

CALL `run_v3_normalize_legacy_risk_events`();
DROP PROCEDURE IF EXISTS `run_v3_normalize_legacy_risk_events`;
