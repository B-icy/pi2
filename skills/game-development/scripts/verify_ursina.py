"""External smoke credibility check: require a real renderer and nonblank framebuffer.

Usage: python verify_ursina.py minecraft.py --screenshot artifacts/probe.png
Runs the candidate's --smoke path. This is NOT a sandbox or a gameplay/UX oracle.
"""
import argparse
import json
from pathlib import Path
import runpy
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('entry')
    parser.add_argument('--screenshot', default='artifacts/probe.png')
    options = parser.parse_args()
    entry = Path(options.entry).resolve()
    screenshot = Path(options.screenshot).resolve()
    from direct.showbase.ShowBase import ShowBase
    from panda3d.core import PNMImage, Filename
    original_init, original_destroy = ShowBase.__init__, ShowBase.destroy
    instances, captures = [], []

    def capture(app):
        if getattr(app, 'win', None) is None:
            return
        app.graphicsEngine.renderFrame()
        app.graphicsEngine.renderFrame()
        image = PNMImage()
        if not app.win.getScreenshot(image):
            return
        colors = set()
        for x in range(0, image.getXSize(), max(1, image.getXSize() // 32)):
            for y in range(0, image.getYSize(), max(1, image.getYSize() // 32)):
                pixel = image.getXel(x, y)
                colors.add(tuple(round(float(c) * 255) for c in pixel))
        proof = screenshot.with_name(screenshot.stem + '-framebuffer.png')
        proof.parent.mkdir(parents=True, exist_ok=True)
        image.write(Filename.fromOsSpecific(str(proof)))
        captures.append({'width': image.getXSize(), 'height': image.getYSize(), 'sampled_colors': len(colors), 'framebuffer': str(proof)})

    def tracked_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        instances.append(self)

    def tracked_destroy(self, *args, **kwargs):
        capture(self)
        return original_destroy(self, *args, **kwargs)

    ShowBase.__init__, ShowBase.destroy = tracked_init, tracked_destroy
    sys.path.insert(0, str(entry.parent))
    old_argv = sys.argv
    sys.argv = [str(entry), '--smoke', '--screenshot', str(screenshot)]
    try:
        try:
            runpy.run_path(str(entry), run_name='__main__')
        except SystemExit as error:
            if error.code not in (None, 0):
                raise RuntimeError(f'Candidate smoke failed: {error.code}') from error
        for app in instances:
            capture(app)
        if not instances:
            raise AssertionError('Smoke never instantiated Panda3D ShowBase: fake/headless-only smoke is not renderer evidence')
        if not captures or not any(c['width'] >= 320 and c['height'] >= 200 and c['sampled_colors'] >= 3 for c in captures):
            raise AssertionError(f'No sufficiently sized, nonblank real framebuffer captured. Renderers={len(instances)}, captures={captures}. Step/render frames before destroying the app; smoke must draw the actual game, not an empty window.')
        if not screenshot.is_file():
            raise AssertionError('Candidate did not save the requested screenshot')
        print('URSINA_PROBE_RESULT ' + json.dumps({'status': 'passed', 'renderers': len(instances), 'captures': captures}))
    finally:
        ShowBase.__init__, ShowBase.destroy = original_init, original_destroy
        sys.argv = old_argv
        sys.path.pop(0)
        for app in instances:
            if getattr(app, 'win', None):
                original_destroy(app)


if __name__ == '__main__':
    main()
