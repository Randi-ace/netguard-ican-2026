import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = PROJECT_ROOT / 'backend'
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from config import (  # noqa: E402
    Config,
    PROJECT_ROOT as CONFIG_PROJECT_ROOT,
    _env_project_path,
)
from services.text_risk_model import TextRiskModel  # noqa: E402


UNAVAILABLE = {'ai_available': False}
VALID_CLASSES = [
    'adult',
    'gambling',
    'malicious',
    'normal',
    'phishing',
    'scam',
]
FORMAL_MODEL_CASES = (
    (
        'tfidf-logreg-v1',
        PROJECT_ROOT / 'models' / 'ai' / 'tfidf-logreg-v1.joblib',
        '807aa18183c1a80ffebcedf35338be2817098ab66a19451f2e4d84011a66fb55',
    ),
    (
        'tfidf-logreg-v2-char',
        PROJECT_ROOT / 'models' / 'ai' / 'tfidf-logreg-v2-char.joblib',
        'fd305f1c81c5b7a689cf212107a7ff6547a85d8abcd8db23e37d45585a9c0fde',
    ),
)


class FakePipeline:
    def __init__(self, classes=None, probabilities=None):
        self.classes_ = classes or list(VALID_CLASSES)
        self.probabilities = probabilities or [
            [0.05, 0.10, 0.15, 0.20, 0.25, 0.25]
        ]
        self.received_inputs = []

    def predict_proba(self, inputs):
        self.received_inputs.append(inputs)
        return self.probabilities


class FailingPipeline(FakePipeline):
    def predict_proba(self, inputs):
        raise RuntimeError('simulated prediction failure')


class TextRiskModelTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.model_path = Path(self.temp_dir.name) / 'model.joblib'
        self.manifest_path = self.model_path.with_suffix('.manifest.json')

    def tearDown(self):
        self.temp_dir.cleanup()

    def _write_artifact_and_manifest(
        self,
        classes=None,
        version='test-v1',
        artifact_bytes=b'model placeholder',
        artifact_hash=None,
    ):
        self.model_path.write_bytes(artifact_bytes)
        digest = artifact_hash or hashlib.sha256(artifact_bytes).hexdigest()
        self.manifest_path.write_text(
            json.dumps({
                'model_version': version,
                'classes': classes or list(VALID_CLASSES),
                'artifact': {'sha256': digest},
            }),
            encoding='utf-8',
        )

    def _model(self, loader, classes=None, version='test-v1'):
        self._write_artifact_and_manifest(
            classes=classes,
            version=version,
        )
        return TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version=version,
            loader=loader,
        )

    def test_ai_disabled_does_not_load(self):
        loader_calls = []
        model = TextRiskModel(
            enabled=False,
            model_path=self.model_path,
            loader=lambda path: loader_calls.append(path),
        )

        self.assertEqual(model.predict('url', 'title', 'text'), UNAVAILABLE)
        self.assertEqual(loader_calls, [])

    def test_missing_model_does_not_call_loader(self):
        loader_calls = []
        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            loader=lambda path: loader_calls.append(path),
        )

        self.assertEqual(model.predict('url', 'title', 'text'), UNAVAILABLE)
        self.assertEqual(loader_calls, [])

    def test_corrupted_joblib_model_is_unavailable(self):
        self._write_artifact_and_manifest(
            artifact_bytes=b'not a valid joblib model',
        )
        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version='test-v1',
        )

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_unexpected_loading_exception_is_unavailable(self):
        self._write_artifact_and_manifest()
        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version='test-v1',
            loader=lambda _path: FakePipeline(),
        )

        with patch.object(
            model,
            '_load_model',
            side_effect=RuntimeError('unexpected load failure'),
        ), self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_failed_load_is_cached_across_repeated_predictions(self):
        self._write_artifact_and_manifest()
        loader_calls = []

        def failing_loader(path):
            loader_calls.append(path)
            raise RuntimeError('simulated load failure')

        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version='test-v1',
            loader=failing_loader,
        )

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            first = model.predict('url-1', 'title-1', 'text-1')
        second = model.predict('url-2', 'title-2', 'text-2')

        self.assertEqual(first, UNAVAILABLE)
        self.assertEqual(second, UNAVAILABLE)
        self.assertEqual(loader_calls, [self.model_path])

    def test_prediction_exception_is_unavailable(self):
        model = self._model(lambda _path: FailingPipeline())

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'sensitive text')

        self.assertEqual(result, UNAVAILABLE)

    def test_repeated_calls_load_only_once(self):
        loader_calls = []
        pipeline = FakePipeline()

        def loader(path):
            loader_calls.append(path)
            return pipeline

        model = self._model(loader)

        first = model.predict('url-1', 'title-1', 'text-1')
        second = model.predict('url-2', 'title-2', 'text-2')

        self.assertTrue(first['ai_available'])
        self.assertEqual(second, first)
        self.assertEqual(loader_calls, [self.model_path])
        self.assertEqual(
            pipeline.received_inputs,
            [['text-1'], ['text-2']],
        )

    def test_import_and_construction_do_not_load_model(self):
        self.model_path.write_bytes(b'model placeholder')
        loader_calls = []

        TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            loader=lambda path: loader_calls.append(path),
        )

        self.assertEqual(loader_calls, [])

    def test_default_model_path_is_stable_across_working_directories(self):
        expected_path = (
            PROJECT_ROOT / 'models' / 'ai' / 'tfidf-logreg-v2-char.joblib'
        ).resolve()
        original_cwd = Path.cwd()
        working_directories = (
            PROJECT_ROOT,
            BACKEND_DIR,
            Path(self.temp_dir.name),
        )

        with patch.dict(os.environ, {}, clear=True):
            try:
                for working_directory in working_directories:
                    with self.subTest(cwd=working_directory):
                        os.chdir(working_directory)
                        configured_path = _env_project_path(
                            'AI_TEXT_MODEL_PATH',
                            'models/ai/tfidf-logreg-v2-char.joblib',
                        )
                        self.assertEqual(configured_path, expected_path)
                        self.assertTrue(configured_path.is_file())
            finally:
                os.chdir(original_cwd)

        self.assertEqual(CONFIG_PROJECT_ROOT, PROJECT_ROOT)
        self.assertEqual(Path(Config.AI_TEXT_MODEL_PATH), expected_path)
        self.assertEqual(Config.AI_MODEL_VERSION, 'tfidf-logreg-v2-char')

    def test_absolute_model_path_environment_value_is_not_rebased(self):
        absolute_path = self.model_path.resolve()
        with patch.dict(
            os.environ,
            {'AI_TEXT_MODEL_PATH': str(absolute_path)},
        ):
            configured_path = _env_project_path(
                'AI_TEXT_MODEL_PATH',
                'models/ai/tfidf-logreg-v1.joblib',
            )

        self.assertEqual(configured_path, absolute_path)

    def test_probability_mapping_uses_real_class_order(self):
        classes = [
            'scam',
            'normal',
            'adult',
            'malicious',
            'phishing',
            'gambling',
        ]
        probabilities = [[0.05, 0.10, 0.15, 0.40, 0.20, 0.10]]
        pipeline = FakePipeline(classes, probabilities)
        model = self._model(lambda _path: pipeline, classes=classes)

        result = model.predict(
            'https://ignored.example',
            'ignored title',
            'model text only',
        )

        self.assertEqual(result, {
            'ai_available': True,
            'ai_score': 0.9,
            'ai_category': 'malicious',
            'ai_confidence': 0.4,
            'ai_reasons': [],
            'model_version': 'test-v1',
        })
        self.assertEqual(pipeline.received_inputs, [['model text only']])

    def test_out_of_range_or_invalid_probability_falls_back(self):
        invalid_rows = (
            [[-0.1, 0.2, 0.2, 0.2, 0.2, 0.3]],
            [[0.2, 0.2, 0.2, 0.2, 0.2, 0.2]],
            [['0.1', 0.1, 0.2, 0.2, 0.2, 0.2]],
        )

        for probabilities in invalid_rows:
            with self.subTest(probabilities=probabilities):
                pipeline = FakePipeline(probabilities=probabilities)
                model = self._model(lambda _path: pipeline)
                with self.assertLogs(
                    'services.text_risk_model',
                    level='WARNING',
                ):
                    result = model.predict('url', 'title', 'text')
                self.assertEqual(result, UNAVAILABLE)

    def test_invalid_model_object_falls_back(self):
        model = self._model(lambda _path: object())

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_illegal_classes_fall_back(self):
        classes = [
            'adult',
            'gambling',
            'malicious',
            'normal',
            'phishing',
            'unknown',
        ]
        pipeline = FakePipeline(classes=classes)
        model = self._model(lambda _path: pipeline, classes=classes)

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_missing_normal_class_falls_back(self):
        classes = ['adult', 'gambling', 'malicious', 'phishing', 'scam']
        pipeline = FakePipeline(
            classes=classes,
            probabilities=[[0.1, 0.2, 0.2, 0.2, 0.3]],
        )
        model = self._model(lambda _path: pipeline, classes=classes)

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_manifest_classes_mismatch_falls_back(self):
        pipeline = FakePipeline()
        manifest_classes = list(VALID_CLASSES)
        manifest_classes.reverse()
        model = self._model(
            lambda _path: pipeline,
            classes=manifest_classes,
        )

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_manifest_version_mismatch_falls_back(self):
        self._write_artifact_and_manifest(version='manifest-v2')
        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version='configured-v1',
            loader=lambda _path: FakePipeline(),
        )

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_artifact_hash_mismatch_falls_back(self):
        self._write_artifact_and_manifest(artifact_hash='0' * 64)
        model = TextRiskModel(
            enabled=True,
            model_path=self.model_path,
            model_version='test-v1',
            loader=lambda _path: FakePipeline(),
        )

        with self.assertLogs(
            'services.text_risk_model',
            level='WARNING',
        ):
            result = model.predict('url', 'title', 'text')

        self.assertEqual(result, UNAVAILABLE)

    def test_formal_artifacts_match_frozen_metadata(self):
        for version, artifact_path, expected_hash in FORMAL_MODEL_CASES:
            with self.subTest(version=version):
                manifest_path = artifact_path.with_suffix('.manifest.json')

                self.assertTrue(artifact_path.is_file())
                self.assertTrue(manifest_path.is_file())
                self.assertEqual(
                    hashlib.sha256(artifact_path.read_bytes()).hexdigest(),
                    expected_hash,
                )

                manifest = json.loads(
                    manifest_path.read_text(encoding='utf-8')
                )
                self.assertEqual(manifest['model_version'], version)
                self.assertEqual(manifest['artifact']['sha256'], expected_hash)
                self.assertEqual(manifest['classes'], VALID_CLASSES)

    def test_formal_v1_and_v2_path_version_pairs_load_lazily_and_predict(self):
        try:
            import joblib
        except ImportError:
            self.skipTest('joblib is not installed in the current environment')

        text = '紧急转账领取奖金'
        for version, artifact_path, _expected_hash in FORMAL_MODEL_CASES:
            with self.subTest(version=version):
                loader_calls = []

                def loader(path):
                    loader_calls.append(Path(path))
                    return joblib.load(path)

                model = TextRiskModel(
                    enabled=True,
                    model_path=artifact_path,
                    model_version=version,
                    loader=loader,
                )
                self.assertEqual(loader_calls, [])

                result = model.predict(
                    'https://first.example',
                    '第一个标题不会进入模型',
                    text,
                )
                repeated = model.predict(
                    'https://second.example',
                    '第二个标题也不会进入模型',
                    text,
                )

                self.assertEqual(loader_calls, [artifact_path])
                self.assertEqual(repeated, result)

                pipeline = joblib.load(artifact_path)
                probabilities = pipeline.predict_proba([text])[0]
                classes = [str(category) for category in pipeline.classes_]
                normal_index = classes.index('normal')
                best_index = max(
                    range(len(classes)),
                    key=probabilities.__getitem__,
                )

                self.assertEqual(classes, VALID_CLASSES)
                self.assertEqual(result, {
                    'ai_available': True,
                    'ai_score': 1.0 - float(probabilities[normal_index]),
                    'ai_category': classes[best_index],
                    'ai_confidence': float(probabilities[best_index]),
                    'ai_reasons': [],
                    'model_version': version,
                })


if __name__ == '__main__':
    unittest.main()
