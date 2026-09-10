import json
import tempfile
import unittest
from pathlib import Path
from rabispeech.config import LocalTtsSettings, LocalTtsModelSettings
from rabispeech.worker_supervisor import WorkerLaunch
from rabispeech.providers.local_tts import LocalTtsProvider

class FixedVoiceCatalogTests(unittest.TestCase):
    def test_names_are_read_without_loading_worker_and_aliases_share_one_option(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'voices.json'
            config.write_text(json.dumps({'speakers': {'Voice A': 0, 'Alias A': 0, 'Voice B': 7, 'Invalid': -1}}))
            model = LocalTtsModelSettings('onnx-vits', 'VITS', 'VITS', '', True, (), ('fixed_speakers',), WorkerLaunch(command=('--config', str(config))))
            provider = LocalTtsProvider(LocalTtsSettings(True, '', 'default', 30, (), 'onnx-vits', (model,)))
            voices = provider.capabilities()['models'][0]['parameters']['voice']
            self.assertEqual(voices['oneOf'], [{'const': 'speaker:0', 'title': 'Voice A / Alias A'}, {'const': 'speaker:7', 'title': 'Voice B'}])
            config.write_text('invalid json')
            self.assertEqual(provider._model_parameters('onnx-vits')['voice']['x-catalog-status'], 'unavailable')

if __name__ == '__main__':
    unittest.main()
