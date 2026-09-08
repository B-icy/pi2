"""Import-safe tests for the verified starter's nonblank framebuffer assertion.

Runs without any graphics context: assert_nonblank works on plain image files.
"""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

STARTER = Path(__file__).resolve().parents[1] / 'skills' / 'game-development' / 'assets' / 'ursina_starter.py'


def load_starter():
    spec = importlib.util.spec_from_file_location('ursina_starter_under_test', STARTER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def image_file(colors):
    """Write a small PNG whose top rows hold the given distinct colors."""
    width, height = 64, 64
    band = max(1, height // len(colors))
    image = Image.new('RGB', (width, height))
    for y in range(height):
        image.paste(Image.new('RGB', (width, 1), colors[min(y // band, len(colors) - 1)]), (0, y))
    handle = tempfile.NamedTemporaryFile(prefix='nonblank-', suffix='.png', delete=False)
    image.save(handle, format='PNG')
    handle.close()
    return Path(handle.name)


class NonblankAssertionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.starter = load_starter()

    def track(self, path):
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        return path

    def test_importing_starter_never_opens_a_window(self):
        self.assertTrue(hasattr(self.starter, 'assert_nonblank'))
        self.assertNotIn('Ursina', sys.modules, 'starter import must not load the graphics stack')

    def test_color_varied_image_passes_and_reports_color_count(self):
        path = self.track(image_file([(10, 40, 90), (200, 180, 60), (255, 255, 255), (0, 0, 0)]))
        colors = self.starter.assert_nonblank(path, min_colors=3)
        self.assertGreaterEqual(colors, 3)

    def test_flat_single_color_image_is_rejected_as_blank(self):
        path = self.track(image_file([(120, 120, 120)]))
        with self.assertRaises(AssertionError) as caught:
            self.starter.assert_nonblank(path)
        self.assertIn('sampled colors', str(caught.exception))

    def test_pure_black_image_is_rejected(self):
        path = self.track(image_file([(0, 0, 0)]))
        with self.assertRaises(AssertionError):
            self.starter.assert_nonblank(path)

    def test_two_colors_fail_the_default_three_color_bar(self):
        path = self.track(image_file([(20, 20, 20), (240, 240, 240)]))
        with self.assertRaises(AssertionError):
            self.starter.assert_nonblank(path)
        # The threshold is an argument, matching the external probe's coarse bar.
        self.assertGreaterEqual(self.starter.assert_nonblank(path, min_colors=2), 2)

    def test_missing_image_file_raises(self):
        with self.assertRaises(Exception):
            self.starter.assert_nonblank(Path(tempfile.gettempdir()) / 'definitely-not-rendered-9x7.png')


if __name__ == '__main__':
    unittest.main()
