#!/usr/bin/env python3
"""External acceptance grader for generated Minecraft-style Ursina games.

The renderer probe proves that a real framebuffer exists. This grader adds the
missing product-level contract: a smoke run must exercise the same game systems
the user asked for and leave machine-readable evidence behind.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

from PIL import Image, ImageChops


MARKER = "GAME_SMOKE_RESULT "


class Failure(Exception):
    pass


def run(argv, cwd, timeout=90):
    try:
        return subprocess.run(
            argv,
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as error:
        output = error.stdout or ""
        if isinstance(output, bytes):
            output = output.decode(errors="replace")
        return subprocess.CompletedProcess(argv, 124, f"{output}\nTimed out after {timeout} seconds")


def fail_if(condition, message, failures):
    if condition:
        failures.append(message)


def import_safely(entry):
    try:
        from direct.showbase.ShowBase import ShowBase
    except Exception:
        ShowBase = None
    opened = []
    original_init = ShowBase.__init__ if ShowBase is not None else None

    def blocked_init(self, *args, **kwargs):
        opened.append(True)
        raise RuntimeError("minecraft.py opened a graphics window during import")

    if ShowBase is not None:
        ShowBase.__init__ = blocked_init
    old_path = list(sys.path)
    try:
        sys.path.insert(0, str(entry.parent))
        spec = importlib.util.spec_from_file_location("candidate_minecraft", entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path = old_path
        if ShowBase is not None:
            ShowBase.__init__ = original_init
    if opened:
        raise Failure("Importing minecraft.py must not construct Ursina/ShowBase")


def sampled_colors_and_dark_ratio(path):
    with Image.open(path) as image:
        rgb = image.convert("RGB")
        pixels = [
            rgb.getpixel((x, y))
            for x in range(0, rgb.width, max(1, rgb.width // 48))
            for y in range(0, rgb.height, max(1, rgb.height // 48))
        ]
    colors = len(set(pixels))
    dark = sum(1 for r, g, b in pixels if r + g + b < 90) / max(1, len(pixels))
    return colors, dark


def changed_pixels(first, second):
    with Image.open(first) as before, Image.open(second) as after:
        difference = ImageChops.difference(before.convert("RGB"), after.convert("RGB"))
        return sum(1 for pixel in difference.getdata() if pixel != (0, 0, 0))


def xdotool(*argv, timeout=5):
    return subprocess.run(
        ["xdotool", *argv],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )


def wait_for_window(process, timeout=12):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = xdotool("search", "--onlyvisible", "--pid", str(process.pid))
        windows = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if windows:
            return windows[-1]
        if process.poll() is not None:
            break
        time.sleep(0.2)
    return None


def window_geometry(window_id):
    result = xdotool("getwindowgeometry", "--shell", window_id)
    values = {}
    for line in result.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = int(value)
    return values["X"], values["Y"], values["WIDTH"], values["HEIGHT"]


def capture_window(window_id, destination):
    x, y, width, height = window_geometry(window_id)
    result = subprocess.run(
        ["scrot", "-o", "-a", f"{x},{y},{width},{height}", str(destination)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=10,
    )
    if result.returncode != 0 or not destination.is_file():
        raise Failure(f"Could not capture game window: {result.stdout[-1000:]}")


def press(window_id, key, hold=0):
    xdotool("windowfocus", "--sync", window_id)
    if hold:
        xdotool("keydown", key)
        time.sleep(hold)
        xdotool("keyup", key)
    else:
        xdotool("key", key)
    time.sleep(0.35)


def check_interactive_window(candidate, entry, artifacts, failures):
    if not os.environ.get("DISPLAY") or not shutil.which("xdotool") or not shutil.which("scrot"):
        failures.append("Interactive probe needs DISPLAY, xdotool, and scrot")
        return

    log_path = artifacts / "grade-interactive.log"
    save_path = artifacts / "grade-interactive-save.json"
    save_path.unlink(missing_ok=True)
    with log_path.open("w") as log:
        process = subprocess.Popen(
            [sys.executable, str(entry), "--save", str(save_path)],
            cwd=candidate,
            stdout=log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            try:
                window_id = wait_for_window(process)
                if window_id is None:
                    failures.append(f"Game did not open an interactive window:\n{log_path.read_text(errors='replace')[-2000:]}")
                    return
                time.sleep(1)
                captures = {"initial": artifacts / "grade-interactive-initial.png"}
                capture_window(window_id, captures["initial"])

                press(window_id, "w", hold=0.7)
                captures["move"] = artifacts / "grade-interactive-move.png"
                capture_window(window_id, captures["move"])

                press(window_id, "2")
                captures["select"] = artifacts / "grade-interactive-select.png"
                capture_window(window_id, captures["select"])

                press(window_id, "p")
                captures["pause"] = artifacts / "grade-interactive-pause.png"
                capture_window(window_id, captures["pause"])
                press(window_id, "p")

                press(window_id, "s")
                fail_if(not save_path.is_file(), "Interactive S key did not write the requested save file", failures)

                fail_if(changed_pixels(captures["initial"], captures["move"]) < 100, "Interactive W key did not visibly move the player/camera", failures)
                fail_if(changed_pixels(captures["move"], captures["select"]) < 20, "Interactive number key did not visibly change block selection", failures)
                fail_if(changed_pixels(captures["select"], captures["pause"]) < 100, "Interactive P key did not show a paused state", failures)
            except Exception as error:
                failures.append(f"Interactive probe failed: {error}")
        finally:
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)


def world_size(data):
    if isinstance(data, dict):
        for key in ("world", "blocks", "tiles", "voxels"):
            value = data.get(key)
            if isinstance(value, dict):
                return len(value)
            if isinstance(value, list):
                return len(value)
    return 0


def selected_value(data):
    if isinstance(data, dict):
        for key in ("selected", "selected_block", "selected_block_index", "active_block"):
            if key in data:
                return data[key]
    return None


def parse_smoke_result(output):
    for line in output.splitlines():
        if line.startswith(MARKER):
            return json.loads(line[len(MARKER):])
    raise Failure(
        f"Missing {MARKER.strip()} JSON line. --smoke must report gameplay evidence, "
        "not just save a screenshot."
    )


def check_smoke_protocol(result, save_path, screenshot, failures):
    required_true = {
        "spawn_safe": "safe spawn",
        "moved": "WASD/player movement",
        "jumped": "jump or gravity response",
        "looked": "camera/mouselook change",
        "selected_block_changed": "number-key block selection",
        "break_changed_world": "breaking a targeted block",
        "place_changed_world": "placing a selected block",
        "pause_toggled": "pause/resume toggle",
        "save_roundtrip": "save/load round-trip",
    }
    for key, label in required_true.items():
        fail_if(result.get(key) is not True, f"Smoke did not prove {label} ({key}=true)", failures)

    block_types = result.get("block_type_count") or result.get("selectable_block_types") or 0
    fail_if(not isinstance(block_types, int) or block_types < 4, "Game needs at least four selectable block types", failures)

    before = result.get("world_blocks_before")
    after_break = result.get("world_blocks_after_break")
    after_place = result.get("world_blocks_after_place")
    fail_if(not isinstance(before, int) or before < 20, "Smoke world must contain a real block field (>=20 blocks)", failures)
    fail_if(not isinstance(after_break, int) or after_break >= before, "Breaking must reduce the world/block count", failures)
    fail_if(not isinstance(after_place, int) or after_place <= after_break, "Placing must add a block after breaking", failures)

    fail_if(not save_path.is_file(), "Smoke did not write the requested save file", failures)
    if save_path.is_file():
        try:
            data = json.loads(save_path.read_text())
        except Exception as error:
            failures.append(f"Save file is not valid JSON: {error}")
        else:
            fail_if(world_size(data) < 20, "Save file does not contain meaningful world progress", failures)
            fail_if(selected_value(data) in (None, 0, "0", "dirt"), "Save file did not preserve changed selected block", failures)

    fail_if(not screenshot.is_file(), "Smoke did not write the requested screenshot", failures)
    if screenshot.is_file():
        colors, dark = sampled_colors_and_dark_ratio(screenshot)
        fail_if(colors < 8, f"Smoke screenshot has too little visual variety ({colors} sampled colors)", failures)
        fail_if(dark > 0.70, "Smoke screenshot is mostly dark/pause overlay, not playable world evidence", failures)


def check_docs_and_tests(candidate, failures):
    readmes = [p for p in (candidate / "README.md", candidate / "readme.md") if p.is_file()]
    fail_if(not readmes, "Missing README with setup, run command, controls, and save/load notes", failures)
    if readmes:
        text = readmes[0].read_text(errors="replace").lower()
        for needle in ("python", "minecraft.py", "wasd", "pause", "save"):
            fail_if(needle not in text, f"README missing {needle!r} instruction", failures)
        fail_if("pytest" in text and not importlib.util.find_spec("pytest"), "README asks for pytest but pytest is not installed", failures)

    tests = candidate / "tests"
    fail_if(not any(tests.glob("test*.py")) if tests.is_dir() else True, "Missing Python tests under tests/", failures)
    if tests.is_dir() and any(tests.glob("test*.py")):
        result = run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], candidate, timeout=30)
        fail_if(result.returncode != 0, f"Candidate tests failed under unittest:\n{result.stdout[-2000:]}", failures)


def check_static(entry, failures):
    text = entry.read_text(errors="replace")
    lowered = text.lower()
    for token, label in [
        ("--smoke", "smoke CLI"),
        ("--screenshot", "screenshot CLI"),
        ("save", "save/load code"),
        ("pause", "pause code"),
    ]:
        fail_if(token not in lowered, f"minecraft.py missing {label}", failures)
    fail_if(not re.search(r"if\s+__name__\s*==\s*['\"]__main__['\"]", text), "minecraft.py must use a main guard", failures)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", help="Candidate work directory")
    parser.add_argument("--probe", required=True, help="Path to verify_ursina.py or compatible renderer probe")
    parser.add_argument("--artifacts", default="artifacts", help="Artifact directory relative to the candidate")
    parser.add_argument("--skip-interactive", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    candidate = Path(args.candidate).resolve()
    entry = candidate / "minecraft.py"
    artifacts = candidate / args.artifacts
    artifacts.mkdir(parents=True, exist_ok=True)
    failures = []

    fail_if(not entry.is_file(), "Missing minecraft.py launcher", failures)
    if failures:
        raise SystemExit("\n".join(failures))

    try:
        import_safely(entry)
    except SystemExit as error:
        failures.append(f"Importing minecraft.py exited the process: {error}")
    except Exception as error:
        failures.append(str(error))
    check_static(entry, failures)
    check_docs_and_tests(candidate, failures)

    probe_shot = artifacts / "grade-probe.png"
    probe = run([sys.executable, str(Path(args.probe).resolve()), "minecraft.py", "--screenshot", str(probe_shot)], candidate, timeout=30)
    fail_if(probe.returncode != 0 or "URSINA_PROBE_RESULT " not in probe.stdout, f"Renderer probe failed:\n{probe.stdout[-2000:]}", failures)

    smoke_shot = artifacts / "grade-smoke.png"
    smoke_save = artifacts / "grade-save.json"
    smoke = run(
        [sys.executable, "minecraft.py", "--smoke", "--screenshot", str(smoke_shot), "--save", str(smoke_save)],
        candidate,
        timeout=30,
    )
    fail_if(smoke.returncode != 0, f"Candidate smoke failed:\n{smoke.stdout[-2000:]}", failures)
    if smoke.returncode == 0:
        try:
            result = parse_smoke_result(smoke.stdout)
            check_smoke_protocol(result, smoke_save, smoke_shot, failures)
        except Exception as error:
            failures.append(str(error))
    if not args.skip_interactive:
        check_interactive_window(candidate, entry, artifacts, failures)

    if failures:
        print("GAME_GRADE_RESULT " + json.dumps({"status": "failed", "failures": failures}, indent=2))
        raise SystemExit(1)
    print("GAME_GRADE_RESULT " + json.dumps({"status": "passed", "candidate": str(candidate)}))


if __name__ == "__main__":
    main()
