-- 净网护航 v1.0-alpha 全新数据库初始化脚本
-- 适用数据库：MySQL 5.7.26
-- 使用场景：全新环境、空数据库
--
-- 注意：
-- 1. 本脚本不会删除数据库或数据表。
-- 2. 本脚本不用于已有旧版 net_guard 数据库。
-- 3. MySQL 5.7 的 JSON 列不能使用对象字面量 DEFAULT，
--    因此 settings.preferences 不设置服务端默认值，由后端显式写入。
-- 4. DATETIME(6) 统一使用 CURRENT_TIMESTAMP(6)。
-- 5. 本脚本只创建空表，不写入用户、设置、检测记录或测试数据。

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE DATABASE IF NOT EXISTS `net_guard`
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

USE `net_guard`;

-- ============================================================
-- 正式表：users
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

-- ============================================================
-- 正式表：risk_events
-- ============================================================

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

-- ============================================================
-- 正式表：url_blacklist
-- ============================================================

CREATE TABLE `url_blacklist` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `domain` VARCHAR(253) NOT NULL,
    `match_type` VARCHAR(16) NOT NULL DEFAULT 'domain',
    `risk_level` VARCHAR(16) NOT NULL DEFAULT 'high',
    `score` DECIMAL(5,4) NOT NULL DEFAULT 0.9500,
    `reason` VARCHAR(500) NOT NULL,
    `enabled` TINYINT(1) NOT NULL DEFAULT 1,
    `source` VARCHAR(32) NOT NULL DEFAULT 'manual',
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`id`),
    UNIQUE KEY `uq_url_blacklist_domain` (`domain`),
    KEY `ix_url_blacklist_enabled_domain` (`enabled`, `domain`),
    CONSTRAINT `ck_url_blacklist_score_range`
        CHECK (`score` >= 0 AND `score` <= 1)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 正式表：ad_events
-- ============================================================

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

-- ============================================================
-- 正式表：settings
-- ============================================================

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
-- 兼容旧接口表：security_logs
-- DEPRECATED：新功能应写入 risk_events 或 ad_events。
-- ============================================================

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
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (`id`),
    KEY `ix_security_logs_type_created_at` (`type`, `created_at`),
    KEY `ix_security_logs_risk_created_at` (`risk_level`, `created_at`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 兼容旧接口表：detection_records
-- DEPRECATED：新功能应写入 risk_events。
-- ============================================================

CREATE TABLE `detection_records` (
    `id` INT NOT NULL AUTO_INCREMENT,
    `url` VARCHAR(500) NOT NULL,
    `is_high_risk` TINYINT(1) NOT NULL DEFAULT 0,
    `is_phishing` TINYINT(1) NOT NULL DEFAULT 0,
    `risk_level` VARCHAR(20) NOT NULL DEFAULT 'safe',
    `risk_score` FLOAT NOT NULL DEFAULT 0,
    `check_type` VARCHAR(20) NOT NULL DEFAULT 'unknown',
    `user_id` INT NULL,
    `reason` VARCHAR(500) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (`id`),
    KEY `ix_detection_records_check_type` (`check_type`),
    KEY `ix_detection_records_created_at` (`created_at`),
    KEY `ix_detection_records_user_id` (`user_id`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8mb4
  COLLATE=utf8mb4_unicode_ci;

-- ============================================================
-- 兼容旧模型表：user_settings
-- DEPRECATED：正式设置使用 settings。
-- ============================================================

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

-- 初始化完成后输出表清单。默认 Demo 用户及设置由后端首次访问设置接口时创建。
SHOW TABLES;
