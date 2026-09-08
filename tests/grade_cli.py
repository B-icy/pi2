"""External, fixed behavioral grader. Candidate agents do not receive this file."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

CANDIDATE = Path(sys.argv.pop(1)).resolve() / 'tasks.py'


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='held-out-tasks-')
        self.addCleanup(self.directory.cleanup)
        self.file = Path(self.directory.name) / 'nested' / 'tasks.json'

    def call(self, *arguments, success=True):
        result = subprocess.run([sys.executable, str(CANDIDATE), '--file', str(self.file), *arguments], capture_output=True, text=True, encoding='utf-8', timeout=5)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(result.stderr.strip())
        return result

    def test_missing_list_does_not_write(self):
        self.assertEqual(self.call('list'), [])
        self.assertFalse(self.file.exists())

    def test_unicode_add_and_persistence(self):
        title = 'Build café 世界 / test "quotes"'
        self.assertEqual(self.call('add', title), {'id': 1, 'title': title, 'done': False})
        self.assertEqual(self.call('add', 'second')['id'], 2)
        self.assertEqual(self.call('list')[0]['title'], title)

    def test_done_persists_and_is_idempotent(self):
        self.call('add', 'ship')
        self.assertEqual(self.call('done', '1'), {'id': 1, 'title': 'ship', 'done': True})
        self.assertEqual(self.call('done', '1')['done'], True)
        self.assertTrue(self.call('list')[0]['done'])

    def test_invalid_id_preserves_bytes(self):
        self.call('add', 'first')
        before = self.file.read_bytes()
        for id_ in ('999', '-1', '0', 'abc'):
            self.call('done', id_, success=False)
            self.assertEqual(self.file.read_bytes(), before)

    def test_blank_title_rejected(self):
        self.call('add', '   ', success=False)
        self.assertFalse(self.file.exists())

    def test_corrupt_file_preserved(self):
        self.file.parent.mkdir(parents=True)
        self.file.write_text('{broken', encoding='utf-8')
        self.call('list', success=False)
        self.call('add', 'new', success=False)
        self.assertEqual(self.file.read_text(), '{broken')

    def test_import_safe(self):
        result = subprocess.run([sys.executable, '-c', 'import importlib.util; s=importlib.util.spec_from_file_location("candidate",' + repr(str(CANDIDATE)) + '); m=importlib.util.module_from_spec(s); s.loader.exec_module(m)'], capture_output=True, text=True, timeout=5, cwd=self.directory.name)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertEqual(list(Path(self.directory.name).iterdir()), [])


unittest.main(verbosity=2)
