-- SmartGuard-NetGuard Gate v4 formal-table rollback
-- MySQL 5.7.26 only
--
-- This script reverses the v4 atomic name switch without deleting either
-- side. Run it only while every writer is stopped and only after a failed
-- application acceptance on net_guard, or during the disposable clone drill
-- on net_guard_gate_migration_test.
--
-- Important limitation:
--   security_logs and detection_records were compatibility-upgraded in place.
--   The database default charset was also changed in place. This name switch
--   does not restore those three changes. An exact pre-v4 rollback therefore
--   requires the locked full backup. Do not claim that this script alone is a
--   complete physical rollback.

SET NAMES utf8mb4;
SET time_zone = '+00:00';

DROP PROCEDURE IF EXISTS `run_v4_gate_rollback`;

DELIMITER $$

CREATE PROCEDURE `run_v4_gate_rollback`()
BEGIN
    DECLARE `v_count` BIGINT DEFAULT 0;
    DECLARE `v_risk_restore` BIGINT DEFAULT 0;
    DECLARE `v_ad_restore` BIGINT DEFAULT 0;
    DECLARE `v_settings_restore` BIGINT DEFAULT 0;
    DECLARE `v_users_restore` BIGINT DEFAULT 0;
    DECLARE `v_user_settings_restore` BIGINT DEFAULT 0;
    DECLARE `v_risk_failed` BIGINT DEFAULT 0;
    DECLARE `v_ad_failed` BIGINT DEFAULT 0;
    DECLARE `v_settings_failed` BIGINT DEFAULT 0;

    DECLARE EXIT HANDLER FOR SQLEXCEPTION
    BEGIN
        -- RENAME TABLE is atomic. If it fails, no table in that statement is
        -- renamed. Keep writers stopped and inspect all names before retrying.
        RESIGNAL;
    END;

    IF LOWER(COALESCE(DATABASE(), '')) NOT IN (
        'net_guard',
        'net_guard_gate_migration_test'
    ) THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: unexpected database';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_type` = 'BASE TABLE'
      AND `table_name` IN (
          'users',
          'user_settings',
          'risk_events',
          'ad_events',
          'settings',
          'users_legacy_gate_20260831',
          'user_settings_legacy_gate_20260831',
          'risk_events_pre_gate_20260831',
          'ad_events_pre_gate_20260831',
          'settings_pre_gate_20260831'
      );
    IF `v_count` <> 10 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: required table set is incomplete';
    END IF;

    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND `table_name` IN (
          'users_failed_gate_20260831',
          'user_settings_failed_gate_20260831',
          'risk_events_failed_gate_20260831',
          'ad_events_failed_gate_20260831',
          'settings_failed_gate_20260831'
      );
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: failed-side name already exists';
    END IF;

    -- The restore candidates must still be the preserved pre-Gate tables.
    SELECT COUNT(*) INTO `v_count`
    FROM `information_schema`.`tables`
    WHERE `table_schema` = DATABASE()
      AND (
          (`table_name` IN (
              'risk_events_pre_gate_20260831',
              'ad_events_pre_gate_20260831',
              'settings_pre_gate_20260831'
          ) AND UPPER(`engine`) <> 'MYISAM')
          OR (`table_name` = 'users_legacy_gate_20260831'
              AND UPPER(`engine`) <> 'INNODB')
      );
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: restore candidate engine changed';
    END IF;

    SELECT COUNT(*) INTO `v_risk_restore`
    FROM `risk_events_pre_gate_20260831`;
    SELECT COUNT(*) INTO `v_ad_restore`
    FROM `ad_events_pre_gate_20260831`;
    SELECT COUNT(*) INTO `v_settings_restore`
    FROM `settings_pre_gate_20260831`;
    SELECT COUNT(*) INTO `v_users_restore`
    FROM `users_legacy_gate_20260831`;
    SELECT COUNT(*) INTO `v_user_settings_restore`
    FROM `user_settings_legacy_gate_20260831`;

    SELECT COUNT(*) INTO `v_risk_failed` FROM `risk_events`;
    SELECT COUNT(*) INTO `v_ad_failed` FROM `ad_events`;
    SELECT COUNT(*) INTO `v_settings_failed` FROM `settings`;

    IF `v_risk_failed` < `v_risk_restore`
       OR `v_ad_failed` < `v_ad_restore`
       OR `v_settings_failed` < `v_settings_restore` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: current formal count is smaller';
    END IF;

    -- Every preserved UUID must still exist on the failed side. New Gate test
    -- UUIDs are allowed there and remain isolated after the name switch.
    SELECT
        (SELECT COUNT(*)
         FROM `risk_events_pre_gate_20260831` AS `old_row`
         LEFT JOIN `risk_events` AS `new_row`
             ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
         WHERE `new_row`.`event_uuid` IS NULL)
        + (SELECT COUNT(*)
           FROM `ad_events_pre_gate_20260831` AS `old_row`
           LEFT JOIN `ad_events` AS `new_row`
               ON `new_row`.`event_uuid` = `old_row`.`event_uuid`
           WHERE `new_row`.`event_uuid` IS NULL)
    INTO `v_count`;
    IF `v_count` <> 0 THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback blocked: preserved UUID missing';
    END IF;

    -- One atomic switch. No source, archive or failed-side table is dropped.
    RENAME TABLE
        `users` TO `users_failed_gate_20260831`,
        `users_legacy_gate_20260831` TO `users`,
        `user_settings` TO `user_settings_failed_gate_20260831`,
        `user_settings_legacy_gate_20260831` TO `user_settings`,
        `risk_events` TO `risk_events_failed_gate_20260831`,
        `risk_events_pre_gate_20260831` TO `risk_events`,
        `ad_events` TO `ad_events_failed_gate_20260831`,
        `ad_events_pre_gate_20260831` TO `ad_events`,
        `settings` TO `settings_failed_gate_20260831`,
        `settings_pre_gate_20260831` TO `settings`;

    IF (SELECT COUNT(*) FROM `risk_events`) <> `v_risk_restore`
       OR (SELECT COUNT(*) FROM `ad_events`) <> `v_ad_restore`
       OR (SELECT COUNT(*) FROM `settings`) <> `v_settings_restore`
       OR (SELECT COUNT(*) FROM `users`) <> `v_users_restore`
       OR (SELECT COUNT(*) FROM `user_settings`)
          <> `v_user_settings_restore` THEN
        SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'v4 rollback check failed: restored count mismatch';
    END IF;

    SELECT
        'PASS' AS `rollback_status`,
        DATABASE() AS `database_name`,
        `v_risk_restore` AS `risk_events_restored`,
        `v_ad_restore` AS `ad_events_restored`,
        `v_settings_restore` AS `settings_restored`,
        `v_users_restore` AS `legacy_users_restored`,
        `v_user_settings_restore` AS `legacy_user_settings_restored`,
        `v_risk_failed` - `v_risk_restore` AS `risk_rows_isolated`,
        `v_ad_failed` - `v_ad_restore` AS `ad_rows_isolated`,
        `v_settings_failed` - `v_settings_restore`
            AS `settings_rows_isolated`;
END$$

DELIMITER ;

CALL `run_v4_gate_rollback`();
DROP PROCEDURE IF EXISTS `run_v4_gate_rollback`;
