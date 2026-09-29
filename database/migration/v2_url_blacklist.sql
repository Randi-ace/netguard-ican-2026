-- 净网护航 url_blacklist 增量迁移
-- 适用数据库：已完成 v1alpha1 初始化或迁移的 MySQL 5.7.26 数据库
--
-- 本脚本只新增空的 url_blacklist 表，不写入或修改现有业务数据。
-- 执行前必须明确选中目标数据库；脚本不会 CREATE DATABASE 或 USE 固定库名。

SET NAMES utf8mb4;
SET time_zone = '+00:00';

CREATE TABLE IF NOT EXISTS `url_blacklist` (
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

SHOW CREATE TABLE `url_blacklist`;
