"""Verify the distributed ZIP and saved scene in a fresh Blender process."""

import json
from pathlib import Path
import sys
import bpy
import numpy as np

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'astra_press.zip'))
import astra_press

assert '.zip' in astra_press.__file__, astra_press.__file__
astra_press.register()
bpy.ops.wm.open_mainfile(filepath=str(root / 'output' / 'quiet_objects.blend'))
scene = bpy.context.scene
assert scene.render.engine == 'ASTRA_PRESS'
assert scene.camera.data.type == 'ORTHO'
assert scene.astra_press.bands == 4
assert bpy.data.images['Astra Press / Finished Print'].packed_file is not None
scene.render.resolution_x, scene.render.resolution_y = 320, 240
scene.astra_press.supersampling = '1'
scene.astra_press.shadow_size = '512'
scene.render.filepath = str(root / 'output' / 'checks' / 'reopened_scene.png')
bpy.ops.render.render(write_still=True)
assert scene.get('_astra_render_ok', False)
assert scene['_astra_triangles'] > 19000
image = bpy.data.images.load(scene.render.filepath)
pixels = np.empty(len(image.pixels), dtype=np.float32)
image.pixels.foreach_get(pixels)
assert tuple(image.size) == (320, 240)
assert np.isfinite(pixels).all()
assert float(pixels.reshape(-1, 4)[:, :3].std()) > 0.08

# Verify that the two completed high-resolution images differ materially.
arrays = []
for name in ('astra_press.png', 'cycles_reference.png'):
    item = bpy.data.images.load(str(root / 'output' / name), check_existing=False)
    assert tuple(item.size) == (1440, 1080)
    data = np.empty(len(item.pixels), dtype=np.float32)
    item.pixels.foreach_get(data)
    arrays.append(data.reshape(1080, 1440, 4)[..., :3])
    bpy.data.images.remove(item)
# Measure the central object region, excluding the page's printed labels.
a, b = (array[220:880, 250:1200] for array in arrays)
difference = float(np.mean(np.abs(a - b)))
assert difference > 0.025, difference
report = {'zip_import': True, 'saved_scene_reopened': True, 'rerender': True,
          'packed_print': True, 'reference_difference_mae': round(difference, 5),
          'blender': bpy.app.version_string}
(root / 'output' / 'checks' / 'package_report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print('ASTRA_PACKAGE_OK ' + json.dumps(report), flush=True)
