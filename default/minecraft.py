#!/usr/bin/env python3
"""
3D Minecraft Clone using Ursina Engine
A self-contained, feature-rich Minecraft-style game.
"""

from ursina import *
from ursina.prefabs.first_person_controller import FirstPersonController
import random
import math

# Initialize the game app
app = Ursina()

# Game constants
WORLD_SIZE = 32  # Size of the world
CHUNK_SIZE = 16  # Not used in this simple version but kept for structure
BLOCK_TYPES = ['dirt', 'stone', 'grass', 'wood', 'leaves', 'plank', 'brick', 'glass']
TEXTURE_PATHS = {
    'dirt': 'assets/textures/dirt.png',
    'stone': 'assets/textures/stone.png',
    'grass': 'assets/textures/grass.png',
    'wood': 'assets/textures/wood.png',
    'leaves': 'assets/textures/leaves.png',
    'plank': 'assets/textures/plank.png',
    'brick': 'assets/textures/brick.png',
    'glass': 'assets/textures/glass.png'
}
# Fall back to default ursina textures if custom ones don't exist
FALLBACK_TEXTURES = {
    'dirt': 'dirt',
    'stone': 'stone',
    'grass': 'grass',
    'wood': 'wood',
    'leaves': 'leaves',
    'plank': 'plank',
    'brick': 'brick',
    'glass': 'glass'
}

# Store all blocks for collision detection
blocks = []
# Selected block type (starting with dirt)
selected_block = 'dirt'

# Create skybox
sky = Sky()

# Create ground
ground = Entity(
    parent=camera.ui,
    model='plane',
    texture='grass',
    scale=(100, 100, 1),
    position=(0, -1, 0),
    collider='box'
)

# Generate terrain
print("Generating terrain...")
for x in range(-WORLD_SIZE // 2, WORLD_SIZE // 2):
    for z in range(-WORLD_SIZE // 2, WORLD_SIZE // 2):
        # Simple terrain generation
        height = math.sin(x * 0.1) * 2 + math.cos(z * 0.1) * 2
        height = int(height) + 2
        
        for y in range(1, height):
            block_type = 'stone' if y < height - 2 else 'grass' if y == height - 1 else 'dirt'
            block = Entity(
                model='cube',
                texture=FALLBACK_TEXTURES[block_type],
                color=color.white,
                position=(x, y, z),
                collider='box'
            )
            blocks.append(block)

# Create player
player = FirstPersonController(
    speed=10,
    jump_height=5,
    gravity=10
)
player.position = (0, 10, 0)
player.cursor.visible = False

# Create crosshair
crosshair = Entity(
    parent=camera.ui,
    model='quad',
    color=color.white,
    scale=0.01,
    position=(0, 0)
)
crosshair_line_h = Entity(
    parent=camera.ui,
    model='quad',
    color=color.white,
    scale=(0.02, 0.001),
    position=(0, 0)
)
crosshair_line_v = Entity(
    parent=camera.ui,
    model='quad',
    color=color.white,
    scale=(0.001, 0.02),
    position=(0, 0)
)

# Hotbar UI
hotbar = Entity(parent=camera.ui)
hotbar_items = []
hotbar_size = 8
for i in range(hotbar_size):
    item = Entity(
        parent=hotbar,
        model='quad',
        texture=FALLBACK_TEXTURES[BLOCK_TYPES[i]],
        scale=0.1,
        position=(-0.35 + i * 0.1, -0.4)
    )
    hotbar_items.append(item)

# Selected item indicator
selected_indicator = Entity(
    parent=hotbar,
    model='quad',
    color=color.yellow,
    scale=0.11,
    position=(-0.35, -0.4)
)

# Update hotbar selection
def update_hotbar_selection(index):
    selected_indicator.position = (-0.35 + index * 0.1, -0.4)
    global selected_block
    selected_block = BLOCK_TYPES[index]

# UI text
ui_text = Text(
    text='WASD to move | Click to place/break | 1-8 to select block | ESC to release cursor',
    position=(-0.9, 0.45),
    origin=(0, 1),
    scale=0.8
)
block_info = Text(
    text='Selected: dirt',
    position=(0.7, 0.45),
    origin=(1, 1),
    scale=0.8
)

def update():
    # Update player position
    if player.y < -10:
        player.position = (0, 10, 0)
    
    # Update block info text
    block_info.text = f'Selected: {selected_block}'

def input(key):
    # Block selection
    if key in ('1', '2', '3', '4', '5', '6', '7', '8'):
        index = int(key) - 1
        if index < hotbar_size:
            update_hotbar_selection(index)
    
    # Block placement and destruction
    if key == 'left mouse down':
        if held_keys['left mouse']:
            hit = player.camera_raycast()
            if hit and hit.entity in blocks:
                # Destroy block
                blocks.remove(hit.entity)
                destroy(hit.entity)
    
    if key == 'right mouse down':
        if held_keys['right mouse']:
            hit = player.camera_raycast()
            if hit and hit.entity in blocks and hasattr(hit, 'normal'):
                # Place new block
                new_block = Entity(
                    model='cube',
                    texture=FALLBACK_TEXTURES[selected_block],
                    color=color.white,
                    position=hit.entity.position + hit.normal,
                    collider='box'
                )
                blocks.append(new_block)

# Run the game
print("Starting game...")
app.run()
