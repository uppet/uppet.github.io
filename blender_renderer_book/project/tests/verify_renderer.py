"""Numerical and Blender integration checks; run with Blender's Python."""

from pathlib import Path
import sys
import unittest
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import astra_press
from astra_press import core


def geometry(triangles, colors=None):
    triangles = np.asarray(triangles, dtype=np.float32).reshape(-1, 3, 3)
    count = len(triangles)
    normals = np.tile((0, 0, 1), (count, 3, 1)).astype(np.float32)
    colors = np.ones((count, 3), dtype=np.float32) if colors is None else np.asarray(colors, dtype=np.float32)
    return core.Geometry(triangles, normals, colors, np.arange(count, dtype=np.int32),
                         np.zeros(count, dtype=bool), np.ones(count, dtype=bool), np.ones(count, dtype=bool))


class RasterTests(unittest.TestCase):
    def test_nearest_surface_wins_in_both_submission_orders(self):
        near = [(-0.8, -0.8, -0.5), (0.8, -0.8, -0.5), (0, 0.8, -0.5)]
        far = [(x, y, 0.5) for x, y, z in near]
        for triangles, colors in (([near, far], [(1, 0, 0), (0, 1, 0)]),
                                  ([far, near], [(0, 1, 0), (1, 0, 0)])):
            result = core.rasterize(geometry(triangles, colors), np.eye(4), 32, 32)
            np.testing.assert_allclose(result['color'][12, 16], (1, 0, 0))
            self.assertAlmostEqual(float(result['depth'][12, 16]), -0.5, places=5)

    def test_near_plane_clipping_preserves_visible_portion(self):
        triangle = np.array([(-0.8, -0.8, -2, 1), (0.8, -0.8, 0, 1), (0, 0.8, 0, 1)], dtype=np.float32)
        clipped = core.clip_triangle(triangle, triangle[:, :3])
        self.assertEqual(len(clipped), 2)
        for clip, attributes in clipped:
            self.assertTrue(np.all(clip @ core._PLANES.T >= -1e-6))
            np.testing.assert_allclose(attributes, clip[:, :3], atol=1e-6)
        result = core.rasterize(geometry([triangle[:, :3]]), np.eye(4), 32, 32)
        self.assertGreater(np.isfinite(result['depth']).sum(), 100)
        self.assertTrue(np.all(result['depth'][np.isfinite(result['depth'])] >= -1.00001))

    def test_triangles_behind_camera_are_rejected(self):
        clip = np.array([(-0.2, -0.2, 0, -1), (0.2, -0.2, 0, -1), (0, 0.2, 0, -1)])
        self.assertEqual(core.clip_triangle(clip, np.zeros((3, 6))), [])

    def test_perspective_interpolation_uses_reciprocal_w(self):
        # Projected screen vertices are (0,0), (8,0), (0,8).
        clip = np.array([(-1, -1, 0, 1), (2, -2, 0, 2), (-4, 4, 0, 4)], dtype=np.float32)
        for y, x, z, weights in core.fragments(clip, 8, 8):
            at_pixel = (x == 1) & (y == 1)
            if np.any(at_pixel):
                barycentric = np.array((0.625, 0.1875, 0.1875))
                expected = barycentric / (1, 2, 4)
                expected /= expected.sum()
                np.testing.assert_allclose(weights[at_pixel][0], expected, atol=1e-6)
                return
        self.fail('Expected covered pixel was missing')

    def test_shadow_occluder_and_unoccluded_receivers(self):
        g = geometry([[(-1, -1, 1), (1, -1, 1), (1, 1, 1)],
                      [(-1, -1, 1), (1, 1, 1), (-1, 1, 1)]])
        light = np.array((0, 0, 1), dtype=np.float32)
        matrix = core.shadow_matrix(g, light)
        depth = core.rasterize(g, matrix, 64, 64, depth_only=True)
        positions = np.array([[(0, 0, 0), (3, 0, 0), (0, 0, 2)]], dtype=np.float32)
        normals = np.tile((0, 0, 1), (1, 3, 1))
        result = core.visibility(positions, normals, light, matrix, depth)
        np.testing.assert_allclose(result, [[0, 1, 1]])

    def test_empty_scene_and_linear_color_roundtrip(self):
        style = core.Style(grain=0, outline_width=0)
        rgba = core.render(geometry([]), np.eye(4), 16, 12, style, supersampling=1)
        np.testing.assert_allclose(rgba[0, 0, :3], style.paper, atol=1e-6)
        self.assertTrue(np.all(rgba[..., 3] == 1))
        ramp = np.linspace(0, 1, 100, dtype=np.float32)
        np.testing.assert_allclose(core.srgb_to_linear(core.linear_to_srgb(ramp)), ramp, atol=3e-7)

    def test_render_cancellation(self):
        g = geometry([[(-1, -1, 0), (1, -1, 0), (0, 1, 0)]])
        with self.assertRaises(core.RenderCancelled):
            core.render(g, np.eye(4), 16, 16, core.Style(), cancel=lambda: True)


class BlenderTests(unittest.TestCase):
    def setUp(self):
        bpy.ops.wm.read_factory_settings(use_empty=True)

    def test_evaluated_modifiers_and_hidden_objects(self):
        bpy.ops.mesh.primitive_cube_add()
        obj = bpy.context.object
        array = obj.modifiers.new('Two copies', 'ARRAY')
        array.count = 2
        array.relative_offset_displace = (2, 0, 0)
        bpy.ops.mesh.primitive_cube_add(location=(100, 0, 0))
        bpy.context.object.hide_render = True
        depsgraph = bpy.context.evaluated_depsgraph_get()
        result = astra_press.export_geometry(depsgraph, lambda: False)
        self.assertEqual(len(result.positions), 24)
        self.assertAlmostEqual(float(result.positions[..., 0].max()), 5.0)
        np.testing.assert_allclose(np.linalg.norm(result.normals, axis=2), 1, atol=1e-6)

    def test_collection_instances_have_independent_transforms(self):
        bpy.ops.mesh.primitive_cube_add()
        cube = bpy.context.object
        source = bpy.data.collections.new('Instance source')
        source.objects.link(cube)
        for collection in list(cube.users_collection):
            if collection != source:
                collection.objects.unlink(cube)
        for x in (-5, 5):
            instance = bpy.data.objects.new('Collection instance', None)
            instance.instance_type = 'COLLECTION'
            instance.instance_collection = source
            instance.location.x = x
            bpy.context.scene.collection.objects.link(instance)
        result = astra_press.export_geometry(bpy.context.evaluated_depsgraph_get(), lambda: False)
        self.assertEqual(len(result.positions), 24)
        self.assertEqual(len(np.unique(result.object_ids)), 2)
        self.assertEqual(float(result.positions[..., 0].min()), -6)
        self.assertEqual(float(result.positions[..., 0].max()), 6)


if __name__ == '__main__':
    astra_press.register()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    astra_press.unregister()
    astra_press.register()
    astra_press.unregister()
    if not result.wasSuccessful():
        raise RuntimeError('Renderer verification failed')
    print(f'ASTRA_TESTS_OK {result.testsRun} tests; registration lifecycle passed', flush=True)
