"""Run inside Blender: --background --factory-startup --python render_demo.py."""

import argparse
import json
import math
from pathlib import Path
import sys
import time
import zipfile
import bpy
import numpy as np
from mathutils import Vector

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import astra_press


def material(name, color, unlit=False, outline=True):
    mat = bpy.data.materials.new(name)
    rgb = astra_press.hex_linear(color)
    mat.diffuse_color = (*rgb, 1.0)
    mat.use_nodes = True
    principled = mat.node_tree.nodes.get('Principled BSDF')
    principled.inputs['Base Color'].default_value = (*rgb, 1)
    principled.inputs['Roughness'].default_value = 0.8
    mat.astra_press.unlit, mat.astra_press.outline = unlit, outline
    if unlit:
        principled.inputs['Emission Color'].default_value = (*rgb, 1)
        principled.inputs['Emission Strength'].default_value = 1.0
        principled.inputs['Base Color'].default_value = (0, 0, 0, 1)
        # Astra reads diffuse color for this emission-only annotation material.
        mat.node_tree.nodes.remove(principled)
        emission = mat.node_tree.nodes.new('ShaderNodeEmission')
        emission.inputs['Color'].default_value = (*rgb, 1)
        emission.inputs['Strength'].default_value = 1
        mat.node_tree.links.new(emission.outputs[0], mat.node_tree.nodes.get('Material Output').inputs['Surface'])
    return mat


def finish(obj, name, mat, bevel=0, smooth=False):
    obj.name = name
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Soft print edges', 'BEVEL')
        mod.width, mod.segments = bevel, 3
    if smooth:
        for face in obj.data.polygons:
            face.use_smooth = True
    return obj


def cube(name, location, dimensions, mat, bevel=0.035):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.scale = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, bevel)


def cylinder(name, location, radius, depth, mat):
    bpy.ops.mesh.primitive_cylinder_add(vertices=80, radius=radius, depth=depth, location=location)
    return finish(bpy.context.object, name, mat, 0.035)


def arch(mat):
    outer, inner, leg, depth = 1.28, 0.77, 1.22, 0.60
    profile = [(-outer, 0)]
    profile += [(outer * math.cos(t), leg + outer * math.sin(t)) for t in np.linspace(math.pi, 0, 41)]
    profile += [(outer, 0), (inner, 0)]
    profile += [(inner * math.cos(t), leg + inner * math.sin(t)) for t in np.linspace(0, math.pi, 41)]
    profile += [(-inner, 0)]
    count = len(profile)
    vertices = [(x, y, z) for y in (-depth / 2, depth / 2) for x, z in profile]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    faces += [(i, (i + 1) % count, (i + 1) % count + count, i + count) for i in range(count)]
    mesh = bpy.data.meshes.new('Arch solid')
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new('01 / Terracotta arch', mesh)
    bpy.context.collection.objects.link(obj)
    obj.location = (-1.10, 0.50, 0.10)
    return finish(obj, obj.name, mat, 0.045)


def face_camera(name, body, camera, xy, size, mat, align='LEFT'):
    text = bpy.data.curves.new(name, 'FONT')
    text.body, text.size, text.align_x = body, size, align
    text.space_character = 1.15
    obj = bpy.data.objects.new(name, text)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler = camera.rotation_euler
    obj.location = camera.location + camera.rotation_euler.to_quaternion() @ Vector((xy[0], xy[1], -4))
    obj.data.materials.append(mat)
    obj['astra_cast_shadow'] = False
    return obj


def camera_rule(name, camera, y, mat):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions, curve.bevel_depth, curve.bevel_resolution = '3D', 0.0045, 0
    spline = curve.splines.new('POLY')
    spline.points.add(1)
    spline.points[0].co, spline.points[1].co = (-5.1, y, 0, 1), (5.1, y, 0, 1)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.rotation_euler = camera.rotation_euler
    obj.location = camera.location + camera.rotation_euler.to_quaternion() @ Vector((0, 0, -4))
    obj.data.materials.append(mat)
    obj['astra_cast_shadow'] = False


def build_scene(width):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    scene = bpy.context.scene
    scene.name = 'Astra Press / Quiet Objects'
    scene.render.resolution_x, scene.render.resolution_y = width, width * 3 // 4
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.film_transparent = False
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.view_settings.exposure, scene.view_settings.gamma = 0, 1
    scene.world.use_nodes = True
    scene.world.node_tree.nodes.get('Background').inputs['Color'].default_value = (0.72, 0.78, 0.85, 1)
    scene.world.node_tree.nodes.get('Background').inputs['Strength'].default_value = 0.45
    clay = material('01 / Fired terracotta', 'd86d4d')
    teal = material('02 / Petrol blue', '3d8580')
    ochre = material('03 / Marigold', 'edb54b')
    chalk = material('04 / Limestone', 'efe2c8')
    paper = material('05 / Warm paper', 'f4eddb', outline=False)
    ink = material('06 / Letterpress ink', '29433e', unlit=True, outline=False)
    red_ink = material('07 / Accent ink', 'c56347', unlit=True, outline=False)

    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, -0.22))
    ground = finish(bpy.context.object, 'Paper sweep', paper)
    ground['astra_cast_shadow'] = False
    cylinder('Stage / limestone disc', (0, 0, -0.07), 3.40, 0.28, chalk)
    arch(clay)
    cylinder('Sphere pedestal', (-2.0, -0.95, 0.25), 0.77, 0.36, teal)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=56, ring_count=28, radius=0.66, location=(-2.0, -0.95, 1.09))
    finish(bpy.context.object, '02 / Golden sphere', ochre, smooth=True)
    cube('Ring pedestal', (1.55, 0.58, 0.24), (1.65, 0.90, 0.34), clay)
    bpy.ops.mesh.primitive_torus_add(major_segments=80, minor_segments=24, location=(1.55, 0.58, 1.52),
                                   rotation=(math.pi / 2, 0.12, -0.15), major_radius=0.81, minor_radius=0.255)
    finish(bpy.context.object, '03 / Petrol ring', teal, smooth=True)
    for i in range(3):
        height = 0.30 * (i + 1)
        cube(f'04 / Stair {i + 1}', (0.12 + 0.54 * i, -1.15, 0.07 + height / 2), (0.56, 0.94, height), chalk, 0.022)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=36, ring_count=18, radius=0.27, location=(2.2, -1.15, 0.34))
    finish(bpy.context.object, '05 / Clay pebble', clay, smooth=True)

    bpy.ops.object.camera_add(location=(6.2, -10.5, 7.0))
    camera = bpy.context.object
    camera.name = 'Camera / Print composition'
    camera.rotation_euler = (Vector((0, 0, 1.00)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type, camera.data.ortho_scale = 'ORTHO', 11.8
    camera.data.clip_start, camera.data.clip_end = 0.1, 200
    scene.camera = camera
    bpy.ops.object.light_add(type='SUN', location=(-3, -4, 7))
    sun = bpy.context.object
    sun.name = 'Sun / Upper-left studio light'
    sun.rotation_euler = Vector((3, 4, -7)).to_track_quat('-Z', 'Y').to_euler()
    sun.data.energy, sun.data.angle = 1.05, math.radians(4)

    face_camera('Title', 'ASTRA / PRESS', camera, (-5.10, 3.55), 0.32, ink)
    face_camera('Edition', 'QUIET OBJECTS     /     001', camera, (5.10, 3.62), 0.115, ink, 'RIGHT')
    camera_rule('Top rule', camera, 3.32, ink)
    camera_rule('Bottom rule', camera, -3.35, ink)
    face_camera('Footer', 'PIGMENT, LIGHT & A LITTLE IMPERFECTION.', camera, (-5.1, -3.68), 0.12, ink)
    face_camera('Signature', 'SOFTWARE RENDERED', camera, (5.1, -3.68), 0.12, red_ink, 'RIGHT')
    scene.render.engine = astra_press.ENGINE_ID
    scene.astra_press.shadow_size = '2048'
    # Save a pleasant camera/material view for opening the blend interactively.
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == 'VIEW_3D':
                area.spaces.active.region_3d.view_perspective = 'CAMERA'
                area.spaces.active.shading.color_type = 'MATERIAL'
    return scene


def save_render(scene, path):
    scene.render.filepath = str(path)
    started = time.perf_counter()
    bpy.ops.render.render(write_still=True)
    if scene.render.engine == astra_press.ENGINE_ID and not scene.get('_astra_render_ok', False):
        raise RuntimeError('Astra did not complete its render callback.')
    if not path.is_file() or path.stat().st_size < 1000:
        raise RuntimeError(f'Missing or empty image: {path}')
    image = bpy.data.images.load(str(path), check_existing=False)
    data = np.empty(len(image.pixels), dtype=np.float32)
    image.pixels.foreach_get(data)
    pixels = data.reshape(-1, 4)
    assert tuple(image.size) == (scene.render.resolution_x, scene.render.resolution_y)
    assert np.isfinite(pixels).all() and float(pixels[:, :3].std()) > 0.08
    assert np.all(pixels[:, 3] > 0.99)
    report = {'path': str(path), 'seconds': round(time.perf_counter() - started, 3),
              'dimensions': list(image.size), 'rgb_stddev': round(float(pixels[:, :3].std()), 4)}
    bpy.data.images.remove(image)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--width', type=int, default=1440)
    parser.add_argument('--draft', action='store_true')
    parser.add_argument('--compare', action='store_true')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
    astra_press.register()
    scene = build_scene(args.width)
    output = ROOT / 'output'
    output.mkdir(exist_ok=True)
    stem = 'draft' if args.draft else 'astra_press'
    results = {'blender_version': bpy.app.version_string, 'engine': astra_press.ENGINE_ID}
    results['astra'] = save_render(scene, output / f'{stem}.png')
    results['triangles'] = int(scene['_astra_triangles'])
    results['core_seconds'] = round(float(scene['_astra_seconds']), 3)
    if args.compare:
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = 32
        scene.cycles.use_denoising = True
        results['cycles'] = save_render(scene, output / 'cycles_reference.png')
        scene.render.engine = astra_press.ENGINE_ID
        scene.render.filepath = str(output / 'astra_press.png')
    if not args.draft:
        finished_print = bpy.data.images.load(str(output / 'astra_press.png'), check_existing=False)
        finished_print.name = 'Astra Press / Finished Print'
        finished_print.use_fake_user = True
        finished_print.pack()
        instructions = bpy.data.texts.new('START HERE / Astra Press')
        instructions.use_fake_user = True
        instructions.write('ASTRA PRESS — QUIET OBJECTS\n\nInstall astra_press.zip via Preferences > Add-ons > Install from Disk.\nEnable Astra Press, select it in Render Engine, then press F12.\n\nSource and instructions: README.md next to this project.\nRender settings contain pigment, contour, hatch and paper controls.\nThis scene uses Standard color management.\n')
        bpy.ops.wm.save_as_mainfile(filepath=str(output / 'quiet_objects.blend'))
        with zipfile.ZipFile(ROOT / 'astra_press.zip', 'w', zipfile.ZIP_DEFLATED) as bundle:
            for path in sorted((ROOT / 'astra_press').glob('*.py')):
                bundle.write(path, str(path.relative_to(ROOT)))
            bundle.write(ROOT / 'README.md', 'astra_press/README.md')
    (output / f'{stem}_report.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    print('ASTRA_DEMO_SUCCESS ' + json.dumps(results), flush=True)


if __name__ == '__main__':
    main()
