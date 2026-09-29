import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
MIGRATION_ROOT = PROJECT_ROOT / 'database' / 'migration'
V4_PRECHECK = MIGRATION_ROOT / 'v4_gate_precheck.sql'
V4_UPGRADE = MIGRATION_ROOT / 'v4_gate_upgrade_mixed_net_guard.sql'
V4_VERIFY = MIGRATION_ROOT / 'v4_gate_verify.sql'
V4_ROLLBACK = MIGRATION_ROOT / 'v4_gate_rollback.sql'


def _without_line_comments(sql):
    return re.sub(r'--[^\n]*(?:\n|$)', '\n', sql)


def _without_string_literals(sql):
    return re.sub(r"'(?:''|[^'])*'", "''", sql)


def _compact(sql):
    return re.sub(r'\s+', ' ', sql).strip()


def _extract_insert(sql, table):
    match = re.search(
        rf"INSERT\s+INTO\s+`{table}`\s*\(.*?;",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if match is None:
        raise AssertionError(f'未找到写入 {table} 的语句')
    return _compact(match.group(0))


class V4GateMigrationStaticTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.precheck = V4_PRECHECK.read_text(encoding='utf-8')
        cls.upgrade = V4_UPGRADE.read_text(encoding='utf-8')
        cls.verify = V4_VERIFY.read_text(encoding='utf-8')
        cls.rollback = V4_ROLLBACK.read_text(encoding='utf-8')
        cls.precheck_executable = _without_line_comments(cls.precheck)
        cls.verify_executable = _without_line_comments(cls.verify)
        cls.risk_copy = _extract_insert(cls.upgrade, 'risk_events_gate_new')
        cls.ad_copy = _extract_insert(cls.upgrade, 'ad_events_gate_new')

    def test_precheck_and_verify_are_strictly_read_only(self):
        forbidden = (
            r'(?i)\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|'
            r'TRUNCATE|RENAME|CALL|SET|USE|LOCK|UNLOCK|PREPARE|EXECUTE)\b'
        )
        self.assertNotRegex(
            _without_string_literals(self.precheck_executable),
            forbidden,
        )
        self.assertNotRegex(
            _without_string_literals(self.verify_executable),
            forbidden,
        )
        self.assertRegex(self.precheck_executable, r'(?i)\bSELECT\b')
        self.assertRegex(self.verify_executable, r'(?i)\bSELECT\b')

    def test_target_guard_excludes_integration_database(self):
        for sql in (
            self.precheck,
            self.upgrade,
            self.verify,
            self.rollback,
        ):
            self.assertIn("'net_guard'", sql)
            self.assertIn("'net_guard_gate_migration_test'", sql)
            self.assertNotIn('net_guard_integration', sql)
        self.assertIn('SIGNAL SQLSTATE', self.upgrade)
        self.assertLess(
            self.upgrade.index('v4 blocked: select net_guard'),
            self.upgrade.index('RENAME TABLE'),
        )

    def test_precheck_covers_required_data_risks(self):
        for expected in (
            'required_mixed_tables',
            'legacy_users_signature',
            'risk_event_uuid_duplicates',
            'ad_event_uuid_duplicates',
            'risk_event_uuid_invalid',
            'ad_event_uuid_invalid',
            'settings_user_id_duplicates',
            'invalid_json_payloads',
            'url_or_text_length_overflow',
            'utf8mb4_unique_collision_candidates',
            'legacy_target_index_names_must_be_absent',
            'orphan_count',
            'over_one_report_only',
        ):
            self.assertIn(expected, self.precheck)
        self.assertNotRegex(
            self.precheck_executable,
            r'(?i)`risk_score`\s*/\s*100|LEAST\s*\([^;]*`risk_score`',
        )

    def test_upgrade_has_partial_run_and_repeat_execution_guards(self):
        for table in (
            'users_legacy_gate_20260831',
            'user_settings_legacy_gate_20260831',
            'risk_events_gate_new',
            'ad_events_gate_new',
            'settings_gate_new',
            'risk_events_pre_gate_20260831',
            'ad_events_pre_gate_20260831',
            'settings_pre_gate_20260831',
        ):
            self.assertIn(f"'{table}'", self.upgrade)
        self.assertIn(
            'v4 blocked: previous v4 work or archive table exists',
            self.upgrade,
        )
        self.assertIn(
            'v4 blocked: legacy target index name already exists',
            self.upgrade,
        )
        self.assertIn(
            'v4 blocked: url_blacklist signature changed',
            self.upgrade,
        )

    def test_formal_table_ddl_matches_current_model_contract(self):
        for expected in (
            '`id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT',
            '`public_id` CHAR(36) NOT NULL',
            'UNIQUE KEY `uq_users_public_id` (`public_id`)',
            'UNIQUE KEY `uq_users_username` (`username`)',
            'KEY `ix_users_status_created_at` (`status`, `created_at`)',
            'UNIQUE KEY `uq_risk_events_event_uuid` (`event_uuid`)',
            'UNIQUE KEY `uq_ad_events_event_uuid` (`event_uuid`)',
            'UNIQUE KEY `uq_settings_user_id` (`user_id`)',
            '`preferences` JSON NOT NULL',
            'ENGINE=InnoDB',
            'DEFAULT CHARSET=utf8mb4',
            'COLLATE=utf8mb4_unicode_ci',
        ):
            self.assertIn(expected, self.upgrade)

    def test_old_users_and_user_settings_are_archived_not_dropped(self):
        compact = _compact(self.upgrade)
        self.assertIn(
            'RENAME TABLE `users` TO `users_legacy_gate_20260831`, '
            '`user_settings` TO `user_settings_legacy_gate_20260831`',
            compact,
        )
        self.assertNotRegex(
            _without_line_comments(self.upgrade),
            r'(?i)\bDROP\s+TABLE\b',
        )
        users_insert = _extract_insert(self.upgrade, 'users')
        self.assertIn("UUID(), 'demo'", users_insert)
        self.assertNotIn('users_legacy_gate_20260831', users_insert)

    def test_risk_copy_preserves_identity_and_normalizes_only_two_contracts(self):
        for column in (
            '`id`',
            '`event_uuid`',
            '`occurred_at`',
            '`created_at`',
        ):
            self.assertIn(column, self.risk_copy)
        self.assertRegex(
            self.risk_copy,
            r"WHEN `event_type` = 'ai_check' AND `check_type` = 'text' "
            r"THEN 'extension_risk'",
        )
        self.assertRegex(
            self.risk_copy,
            r"WHEN `event_type` = 'ai_check' AND `check_type` = 'text' "
            r"THEN 'ai'",
        )
        self.assertRegex(
            self.risk_copy,
            r"WHEN `event_type` = 'url_check' AND `check_type` = 'url' "
            r"THEN 'extension_risk'",
        )
        self.assertIn('$.gate_v4_original_event_type', self.risk_copy)
        self.assertIn('$.gate_v4_original_check_type', self.risk_copy)
        self.assertIn('FROM `risk_events`', self.risk_copy)
        self.assertIn(')) <=> `old_row`.`event_type`)', self.upgrade)
        self.assertIn(')) <=> `old_row`.`check_type`)', self.upgrade)

    def test_ad_copy_is_field_for_field_and_preserves_uuid(self):
        for column in (
            '`id`',
            '`event_uuid`',
            '`user_id`',
            '`action`',
            '`mode`',
            '`page_url`',
            '`blocked_count`',
            '`details`',
            '`occurred_at`',
            '`created_at`',
        ):
            self.assertGreaterEqual(self.ad_copy.count(column), 2)
        self.assertIn('FROM `ad_events`', self.ad_copy)

    def test_legacy_history_is_not_imported_into_formal_events(self):
        self.assertNotIn('security_logs', self.risk_copy)
        self.assertNotIn('detection_records', self.risk_copy)
        self.assertNotIn('security_logs', self.ad_copy)
        self.assertNotIn('detection_records', self.ad_copy)
        executable = _without_line_comments(self.upgrade)
        self.assertNotRegex(
            executable,
            r'(?is)UPDATE\s+`detection_records`.*?`risk_score`',
        )

    def test_copy_validation_and_foreign_keys_precede_atomic_switch(self):
        risk_copy_at = self.upgrade.index(
            'INSERT INTO `risk_events_gate_new`'
        )
        validation_at = self.upgrade.index(
            'v4 validation failed: risk row copy mismatch'
        )
        fk_at = self.upgrade.index(
            'ADD CONSTRAINT `fk_risk_events_user`'
        )
        switch_at = self.upgrade.index(
            '`risk_events` TO `risk_events_pre_gate_20260831`'
        )
        self.assertLess(risk_copy_at, validation_at)
        self.assertLess(validation_at, fk_at)
        self.assertLess(fk_at, switch_at)
        for expected in (
            'ON DELETE SET NULL',
            'ON DELETE CASCADE',
            'formal FK orphan exists',
        ):
            self.assertIn(expected, self.upgrade)

    def test_security_and_detection_receive_only_compatibility_upgrade(self):
        self.assertIn('ALTER TABLE `security_logs`', self.upgrade)
        self.assertIn('ix_security_logs_type_created_at', self.upgrade)
        self.assertIn('ix_security_logs_risk_created_at', self.upgrade)
        self.assertIn('ALTER TABLE `detection_records`', self.upgrade)
        for column in ('is_high_risk', 'is_phishing', 'reason'):
            self.assertIn(f'ADD COLUMN `{column}`', self.upgrade)
        self.assertIn('detection_records count changed', self.upgrade)
        self.assertIn('security_logs count changed', self.upgrade)

    def test_url_blacklist_has_no_v4_write_statement(self):
        executable = _without_line_comments(self.upgrade)
        self.assertNotRegex(
            executable,
            r'(?is)\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|'
            r'RENAME\s+TABLE)[^;]*`url_blacklist`',
        )
        self.assertIn('url_blacklist changed', self.upgrade)

    def test_verify_covers_gate_acceptance_contract(self):
        for expected in (
            'preserved_gate_archives',
            'uq_risk_events_event_uuid',
            'uq_ad_events_event_uuid',
            'uq_settings_user_id',
            'fk_risk_events_user',
            'fk_ad_events_user',
            'fk_settings_user',
            'risk_before_count',
            'ad_before_count',
            'risk_uuid_set_difference',
            'ad_uuid_set_difference',
            'noncanonical_risk_rows',
            'traceable_converted_rows',
            'url_blacklist_count',
            'maximum_historical_detection_score',
            'auto_increment',
        ):
            self.assertIn(expected, self.verify)

    def test_rollback_is_recoverable_and_never_drops_old_tables(self):
        for expected in (
            'users_failed_gate_20260831',
            'risk_events_failed_gate_20260831',
            'ad_events_failed_gate_20260831',
            'settings_failed_gate_20260831',
            'Use one RENAME TABLE statement',
            'Do not drop either side',
            'locked full backup',
        ):
            self.assertIn(expected, self.upgrade)

        rollback_executable = _without_line_comments(self.rollback)
        self.assertNotRegex(
            rollback_executable,
            r'(?i)\bDROP\s+TABLE\b',
        )
        compact = _compact(self.rollback)
        for expected in (
            '`users` TO `users_failed_gate_20260831`',
            '`users_legacy_gate_20260831` TO `users`',
            '`user_settings` TO `user_settings_failed_gate_20260831`',
            '`user_settings_legacy_gate_20260831` TO `user_settings`',
            '`risk_events` TO `risk_events_failed_gate_20260831`',
            '`risk_events_pre_gate_20260831` TO `risk_events`',
            '`ad_events` TO `ad_events_failed_gate_20260831`',
            '`ad_events_pre_gate_20260831` TO `ad_events`',
            '`settings` TO `settings_failed_gate_20260831`',
            '`settings_pre_gate_20260831` TO `settings`',
            'security_logs and detection_records were compatibility-upgraded '
            'in place',
            'requires the locked full backup',
        ):
            self.assertIn(expected, compact)
        self.assertIn('preserved UUID missing', self.rollback)
        self.assertIn('risk_rows_isolated', self.rollback)

    def test_v4_uses_only_mysql_57_features(self):
        combined = f'{self.precheck}\n{self.upgrade}\n{self.verify}'
        for unsupported in (
            r'(?i)\bJSON_TABLE\s*\(',
            r'(?i)\bREGEXP_REPLACE\s*\(',
            r'(?i)\bROW_NUMBER\s*\(',
            r'(?i)\bWITH\s+RECURSIVE\b',
            r'(?i)\bRETURNING\b',
            r'(?i)\bRENAME\s+COLUMN\b',
            r'(?i)\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b',
        ):
            self.assertNotRegex(combined, unsupported)
        for required in (
            'JSON_VALID',
            'JSON_EXTRACT',
            'JSON_UNQUOTE',
            'JSON_SET',
            'JSON_OBJECT',
            'SIGNAL SQLSTATE',
            'CREATE PROCEDURE',
            'DATETIME(6)',
        ):
            self.assertIn(required, combined)


if __name__ == '__main__':
    unittest.main()
