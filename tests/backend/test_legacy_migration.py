import re
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
V1_MIGRATION = (
    PROJECT_ROOT / 'database' / 'migration' / 'v1_migration.sql'
)
V1_PRECHECK = (
    PROJECT_ROOT / 'database' / 'migration' / 'v1_precheck.sql'
)
V3_MIGRATION = (
    PROJECT_ROOT
    / 'database'
    / 'migration'
    / 'v3_normalize_legacy_risk_events.sql'
)
V3_FIXTURE = (
    PROJECT_ROOT
    / 'database'
    / 'migration'
    / 'test'
    / 'v3_legacy_fixture.sql'
)
V3_VERIFY = (
    PROJECT_ROOT
    / 'database'
    / 'migration'
    / 'test'
    / 'v3_verify.sql'
)


def _compact_sql(sql):
    return re.sub(r'\s+', ' ', sql).strip()


def _extract_insert(sql, target, source):
    statements = re.findall(
        rf"INSERT INTO `{target}`\s*\(.*?;",
        sql,
        flags=re.DOTALL,
    )
    for statement in statements:
        if f"FROM `{source}`" in statement:
            return _compact_sql(statement)
    raise AssertionError(f'未找到 {source} -> {target} 的迁移片段')


class LegacyMigrationStaticTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.v1 = V1_MIGRATION.read_text(encoding='utf-8')
        cls.precheck = V1_PRECHECK.read_text(encoding='utf-8')
        cls.v3 = V3_MIGRATION.read_text(encoding='utf-8')
        cls.v3_fixture = V3_FIXTURE.read_text(encoding='utf-8')
        cls.v3_verify = V3_VERIFY.read_text(encoding='utf-8')
        cls.security_insert = _extract_insert(
            cls.v1,
            'risk_events',
            'security_logs',
        )
        cls.detection_insert = _extract_insert(
            cls.v1,
            'risk_events',
            'detection_records',
        )

    def test_security_logs_ai_check_maps_to_formal_fields(self):
        self.assertIn("'extension_risk'", self.security_insert)
        self.assertRegex(
            self.security_insert,
            r"WHEN `x`\.`type` = 'ai_check' THEN 'ai'",
        )

    def test_security_logs_url_check_maps_to_formal_fields(self):
        self.assertRegex(
            self.security_insert,
            r"WHEN `x`\.`type` = 'url_check' THEN 'url'",
        )

    def test_security_logs_rule_and_mode_types_map_to_rule(self):
        self.assertRegex(
            self.security_insert,
            r"WHEN `x`\.`type` = 'url_check' THEN 'url' ELSE 'rule' END",
        )
        for legacy_type in (
            'child_mode',
            'elder_mode',
            'strict_mode',
            'entertainment_block',
            'game_block',
            'dangerous_block',
        ):
            self.assertIn(f"'{legacy_type}'", self.v1)

    def test_detection_ai_and_text_map_to_ai(self):
        self.assertRegex(
            self.detection_insert,
            r"IN \('ai', 'text'\) THEN 'ai'",
        )

    def test_detection_url_maps_to_url_and_other_values_to_rule(self):
        self.assertRegex(
            self.detection_insert,
            r"WHEN `x`\.`check_type` = 'url' THEN 'url' ELSE 'rule' END",
        )

    def test_v1_risk_inserts_do_not_generate_legacy_formal_values(self):
        for insert in (self.security_insert, self.detection_insert):
            for legacy_output in (
                'ai_check',
                'url_check',
                'child_block',
                'elder_warning',
                'strict_block',
                'entertainment_block',
                'game_block',
                'dangerous_block',
                'legacy_check',
                'text',
            ):
                self.assertNotRegex(
                    insert,
                    rf"(?:THEN|ELSE) '{legacy_output}'",
                )

    def test_v1_details_preserve_legacy_sources(self):
        self.assertRegex(
            self.security_insert,
            r"'legacy_table', 'security_logs'.*?'legacy_id'.*?"
            r"'legacy_type', `x`\.`type`",
        )
        self.assertRegex(
            self.detection_insert,
            r"'legacy_table', 'detection_records'.*?'legacy_id'.*?"
            r"'legacy_check_type', `x`\.`check_type`",
        )

    def test_v1_does_not_silently_drop_possible_ai_double_writes(self):
        self.assertNotIn('WHERE NOT EXISTS', self.detection_insert)
        self.assertIn(
            'suspected_ai_double_write_candidate_pairs',
            self.v1,
        )

    def test_precheck_reports_types_scores_times_and_optional_tables(self):
        for expected in (
            'legacy_check_type',
            'unsupported detection check type exists',
            'null_score_count',
            'negative_score_count',
            'zero_to_one_score_count',
            'possible_zero_to_hundred_score_count',
            'over_hundred_score_count',
            'minimum_created_at',
            'maximum_created_at',
            '@@GLOBAL.time_zone',
            '@@SESSION.time_zone',
            'ai_checks',
            'url_checks',
            'logs',
            'statistics',
        ):
            self.assertIn(expected, self.precheck)
        self.assertNotRegex(
            self.precheck,
            r"`risk_score`\s*/\s*100",
        )

    def test_v3_never_inserts_or_deletes_risk_events(self):
        self.assertNotRegex(
            self.v3,
            r"(?i)\b(?:INSERT\s+INTO|DELETE\s+FROM)\s+`?risk_events`?",
        )

    def test_v3_only_targets_marked_legacy_records(self):
        updates = re.findall(
            r"UPDATE `risk_events`.*?;",
            self.v3,
            flags=re.DOTALL,
        )
        self.assertGreaterEqual(len(updates), 4)
        for statement in updates:
            self.assertIn("'$.legacy_table'", statement)
            self.assertIn("'$.legacy_id'", statement)
            self.assertRegex(
                statement,
                r"(?:= 'security_logs'|= 'detection_records')",
            )

    def test_v3_recovers_legacy_types_from_preserved_source_tables(self):
        self.assertIn(
            "INNER JOIN `security_logs` AS `security_log`",
            self.v3,
        )
        self.assertIn(
            "'$.legacy_type',\n        `security_log`.`type`",
            self.v3,
        )
        self.assertIn(
            "INNER JOIN `detection_records` AS `detection_record`",
            self.v3,
        )
        self.assertIn(
            "'$.legacy_check_type',\n        `detection_record`.`check_type`",
            self.v3,
        )

    def test_v3_updates_have_idempotent_conditions(self):
        self.assertGreaterEqual(
            self.v3.count("'$.legacy_type'"),
            1,
        )
        self.assertGreaterEqual(
            self.v3.count("'$.legacy_check_type'"),
            1,
        )
        self.assertGreaterEqual(
            self.v3.count("`event_type` <> 'extension_risk'"),
            3,
        )
        self.assertIn(
            "`check_type` NOT IN ('ai', 'url', 'rule')",
            self.v3,
        )
        self.assertIn(
            'legacy source type is unavailable',
            self.v3,
        )
        self.assertIn(
            'unsupported legacy source type exists',
            self.v3,
        )

    def test_v3_reports_required_validation_counts(self):
        for expected in (
            'total_risk_events',
            'legacy_migrated_events',
            'non_extension_risk_legacy_events',
            'invalid_check_type_legacy_events',
            'ai_events',
            'url_events',
            'rule_events',
            'suspected_ai_double_write_candidate_pairs',
        ):
            self.assertIn(expected, self.v3)

    def test_v3_fixture_is_scoped_to_disposable_test_database(self):
        self.assertIn(
            "LOWER(@v3_fixture_selected_database)",
            self.v3_fixture,
        )
        self.assertIn(
            "<> 'net_guard_migration_v3_test'",
            self.v3_fixture,
        )
        self.assertIn('SIGNAL SQLSTATE', self.v3_fixture)
        self.assertIn('must be empty', self.v3_fixture)
        self.assertNotRegex(
            self.v3_fixture,
            r'(?i)\b(?:CREATE|DROP)\s+DATABASE\b',
        )
        for protected_database in (
            'net_guard_integration',
            'net_guard_migration_test',
        ):
            self.assertNotIn(protected_database, self.v3_fixture)

        guard_start = self.v3_fixture.index(
            'CREATE PROCEDURE '
            '`net_guard_migration_v3_test`.`assert_v3_fixture_target`()'
        )
        guard_end = self.v3_fixture.index('END$$', guard_start)
        guarded_body = self.v3_fixture[guard_start:guard_end]
        self.assertIn('CREATE TABLE `risk_events`', guarded_body)
        self.assertIn('INSERT INTO `risk_events`', guarded_body)
        self.assertLess(
            guarded_body.index("<> 'net_guard_migration_v3_test'"),
            guarded_body.index('CREATE TABLE `risk_events`'),
        )
        self.assertLess(
            guarded_body.index('must be empty'),
            guarded_body.index('CREATE TABLE `risk_events`'),
        )

    def test_v3_fixture_covers_all_legacy_mapping_sources(self):
        for expected in (
            "'ai_check'",
            "'url_check'",
            "'child_mode'",
            "'text'",
            "'url'",
            "'rule'",
            "'legacy_table', 'security_logs'",
            "'legacy_table', 'detection_records'",
            '00000000-0000-4000-8000-000000009001',
        ):
            self.assertIn(expected, self.v3_fixture)
        self.assertEqual(
            self.v3_fixture.count("JSON_OBJECT('legacy_table'"),
            6,
        )

    def test_v3_verify_is_read_only_and_checks_idempotent_result(self):
        without_comments = re.sub(
            r'--[^\n]*(?:\n|$)',
            '',
            self.v3_verify,
        )
        self.assertNotRegex(
            without_comments,
            r'(?i)\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|'
            r'TRUNCATE|CALL|SET|USE)\b',
        )
        for expected in (
            'actual_total',
            'actual_legacy',
            'noncanonical_event_type_count',
            'invalid_check_type_count',
            'actual_details_keys',
            'normal new event must remain unchanged',
            'expected_fixture_rows_found',
            'risk_events_fingerprint',
        ):
            self.assertIn(expected, self.v3_verify)

    def test_migrations_stay_within_mysql_57_sql_features(self):
        combined = (
            f'{self.v1}\n{self.precheck}\n{self.v3}\n'
            f'{self.v3_fixture}\n{self.v3_verify}'
        )
        for unsupported in (
            r'(?i)\bJSON_TABLE\s*\(',
            r'(?i)\bREGEXP_REPLACE\s*\(',
            r'(?i)\bROW_NUMBER\s*\(',
            r'(?i)\bWITH\s+RECURSIVE\b',
            r'(?i)\bRETURNING\b',
        ):
            self.assertNotRegex(combined, unsupported)
        for required in (
            'JSON_EXTRACT',
            'JSON_UNQUOTE',
            'JSON_SET',
            'JSON_OBJECT',
            'SIGNAL SQLSTATE',
            'CREATE PROCEDURE',
        ):
            self.assertIn(required, combined)


if __name__ == '__main__':
    unittest.main()
