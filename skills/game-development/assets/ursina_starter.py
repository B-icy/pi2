"""Known-working Ursina 7 vertical slice. Extend it; this is NOT a complete game.
Run: python ursina_starter.py --smoke --screenshot artifacts/starter.png
"""
import argparse
from pathlib import Path


def assert_nonblank(image_path, min_colors=3):
    """A saved PNG's existence is NOT render evidence: verify pixel variety.

    Smoke paths that only assert the file exists pass while the framebuffer is
    blank (flat window color, empty UI). Sample a grid and require distinct colors.
    """
    from PIL import Image
    with Image.open(image_path) as frame:
        rgb = frame.convert('RGB')
        width, height = rgb.size
        colors = {rgb.getpixel((x, y))
                  for x in range(0, width, max(1, width // 32))
                  for y in range(0, height, max(1, height // 32))}
    if len(colors) < min_colors:
        raise AssertionError(
            f'Framebuffer looks blank: {len(colors)} sampled colors in {image_path} '
            f'(need {min_colors}). The render is defective; do not blame the probe or environment.')
    return len(colors)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--smoke', action='store_true')
    parser.add_argument('--screenshot', default='artifacts/starter.png')
    args = parser.parse_args()
    # All graphical imports and construction are behind the main guard.
    from panda3d.core import Filename, loadPrcFileData
    from ursina import Ursina, Entity, Text, camera, window, color, mouse
    if args.smoke:
        loadPrcFileData('', 'audio-library-name null\nsync-video false')
    app = Ursina(window_type='offscreen' if args.smoke else 'onscreen',
                 size=(960, 600), development_mode=False, editor_ui_enabled=False)
    # Offscreen GraphicsBuffer has no requestProperties(): do not set mouse.locked.
    if not args.smoke:
        window.fullscreen = False
        mouse.locked = False
    aspect = app.win.getXSize() / app.win.getYSize()
    camera.ui_lens.set_film_size(camera.ui_size * .5 * aspect, camera.ui_size * .5)
    camera.perspective_lens.set_aspect_ratio(aspect)
    window.color = color.rgb32(174, 207, 220)
    camera.position = (5, 5, -8)
    camera.look_at((0, 0, 0))
    Entity(model='cube', scale=(12, 1, 12), y=-1, color=color.rgb32(93, 141, 73))

    class Slice(Entity):
        def __init__(self):
            super().__init__(model='cube', color=color.rgb32(178, 124, 76))
            self.actions = 0
            Text(parent=camera.ui, text='A RUNNABLE SLICE / press 1', x=-.7, y=.43, scale=1)

        def input(self, key):
            if key == '1':
                self.actions += 1
                self.color = color.rgb32(100, 160, 210)

    game = Slice()
    if not args.smoke:
        app.run()
        return
    game.input('1')
    assert game.actions == 1
    for _ in range(4):
        app.taskMgr.step()
        app.graphicsEngine.renderFrame()
    screenshot = Path(args.screenshot).resolve()
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    assert app.win.saveScreenshot(Filename.fromOsSpecific(str(screenshot)))
    # Verify the actual pixels, not just that a file was written.
    colors = assert_nonblank(screenshot)
    print(f'NONBLANK_OK {colors} sampled colors in {screenshot}')
    app.destroy()


if __name__ == '__main__':
    main()
