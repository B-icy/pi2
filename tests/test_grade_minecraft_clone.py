import json
import subprocess
import sys
import textwrap
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from grade_minecraft_clone import nested_ursina_callbacks, playable_frame, run


ROOT = Path(__file__).resolve().parents[1]
GRADER = ROOT / "tests" / "grade_minecraft_clone.py"


def write_file(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(body).lstrip())


def write_common_files(work):
    write_file(work / "README.md", """
        # Minecraft demo

        Run with `python minecraft.py`. Use W/A/S/D to move, mouse to look,
        number keys to select blocks, click to break/place, P to pause, and S to save.
    """)
    write_file(work / "tests" / "test_game.py", """
        import unittest

        class GameTests(unittest.TestCase):
            def test_world_math(self):
                self.assertEqual(2 + 2, 4)

        if __name__ == "__main__":
            unittest.main()
    """)


def write_probe(path):
    write_file(path, """
        import json
        import sys
        from pathlib import Path
        from PIL import Image

        shot = Path(sys.argv[sys.argv.index('--screenshot') + 1])
        shot.parent.mkdir(parents=True, exist_ok=True)
        image = Image.new('RGB', (96, 64), (120, 180, 220))
        for i in range(16):
            for x in range(i * 6, i * 6 + 6):
                for y in range(0, 64):
                    image.putpixel((x, y), ((i * 30) % 255, (50 + i * 20) % 255, (100 + i * 10) % 255))
        image.save(shot)
        print('URSINA_PROBE_RESULT ' + json.dumps({'status': 'passed', 'captures': [{'sampled_colors': 16}]}))
    """)


def write_candidate(path, marker=True, dark=False, save_world=True):
    marker_line = """
    print('GAME_SMOKE_RESULT ' + json.dumps({
        'spawn_safe': True,
        'moved': True,
        'jumped': True,
        'looked': True,
        'selected_block_changed': True,
        'break_changed_world': True,
        'place_changed_world': True,
        'pause_toggled': True,
        'save_roundtrip': True,
        'block_type_count': 8,
        'world_blocks_before': 40,
        'world_blocks_after_break': 39,
        'world_blocks_after_place': 40,
    }))
    """ if marker else ""
    image_body = """
    image = Image.new('RGB', (96, 64), (0, 0, 0))
    """ if dark else """
    image = Image.new('RGB', (96, 64), (120, 180, 220))
    for i in range(16):
        for x in range(i * 6, i * 6 + 6):
            for y in range(0, 64):
                image.putpixel((x, y), ((i * 30) % 255, (50 + i * 20) % 255, (100 + i * 10) % 255))
    """
    world = "{str((i, 0, 0)): 'stone' for i in range(40)}" if save_world else "{}"
    body = f"""import argparse
import json
from pathlib import Path
from PIL import Image

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--screenshot', default='artifacts/smoke.png')
    parser.add_argument('--save', default='saves/world.json')
    args = parser.parse_args()
    paused = False
    if not args.smoke:
        print('launch minecraft game')
        return
    shot = Path(args.screenshot)
    shot.parent.mkdir(parents=True, exist_ok=True)
{textwrap.indent(textwrap.dedent(image_body).strip(), '    ')}
    image.save(shot)
    save = Path(args.save)
    save.parent.mkdir(parents=True, exist_ok=True)
    save.write_text(json.dumps({{'world': {world}, 'selected_block': 1}}))
{textwrap.indent(textwrap.dedent(marker_line).strip(), '    ')}

if __name__ == '__main__':
    main()
"""
    write_file(path, body)


class GradeMinecraftCloneTests(unittest.TestCase):
    def run_grade(self, work):
        probe = work / "probe.py"
        write_probe(probe)
        return subprocess.run(
            [sys.executable, str(GRADER), str(work), "--probe", str(probe), "--skip-interactive"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=15,
        )

    def test_accepts_gameplay_smoke_protocol(self):
        with TemporaryDirectory() as tmp:
            work = Path(tmp)
            write_common_files(work)
            write_candidate(work / "minecraft.py")
            result = self.run_grade(work)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertIn("GAME_GRADE_RESULT", result.stdout)

    def test_rejects_renderer_only_smoke(self):
        with TemporaryDirectory() as tmp:
            work = Path(tmp)
            write_common_files(work)
            write_candidate(work / "minecraft.py", marker=False)
            result = self.run_grade(work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Missing GAME_SMOKE_RESULT", result.stdout)

    def test_rejects_pause_overlay_as_smoke_evidence(self):
        with TemporaryDirectory() as tmp:
            work = Path(tmp)
            write_common_files(work)
            write_candidate(work / "minecraft.py", dark=True)
            result = self.run_grade(work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("mostly dark", result.stdout)

    def test_rejects_empty_saved_world(self):
        with TemporaryDirectory() as tmp:
            work = Path(tmp)
            write_common_files(work)
            write_candidate(work / "minecraft.py", save_world=False)
            result = self.run_grade(work)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("meaningful world progress", result.stdout)

    def test_command_timeout_is_reported_as_a_failed_result(self):
        with TemporaryDirectory() as tmp:
            result = run(
                [sys.executable, "-c", "import time; time.sleep(1)"],
                Path(tmp),
                timeout=0.01,
            )
            self.assertEqual(result.returncode, 124)
            self.assertIn("Timed out", result.stdout)

    def test_playable_frame_rejects_empty_sky(self):
        with TemporaryDirectory() as tmp:
            shot = Path(tmp) / "sky.png"
            from PIL import Image
            Image.new("RGB", (96, 64), (120, 190, 220)).save(shot)
            self.assertFalse(playable_frame(shot))

    def test_reports_nested_ursina_callbacks(self):
        with TemporaryDirectory() as tmp:
            entry = Path(tmp) / "minecraft.py"
            write_file(entry, """
                def main():
                    def input(key):
                        return key
                    def update():
                        return None

                def module_helper():
                    return None
            """)
            self.assertEqual(nested_ursina_callbacks(entry), ["input", "update"])


if __name__ == "__main__":
    unittest.main()
