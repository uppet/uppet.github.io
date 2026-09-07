"""Small NumPy software renderer. No bpy, GPU, or other renderer dependency.

Coordinates use OpenGL homogeneous clipping and bottom-up image rows, matching
Blender's RenderResult. All color buffers crossing the Blender boundary are linear.
"""

from dataclasses import dataclass
import numpy as np


class RenderCancelled(Exception):
    pass


def normalized(v):
    return v / np.maximum(np.linalg.norm(v, axis=-1, keepdims=True), 1e-12)


def linear_to_srgb(c):
    c = np.maximum(c, 0.0)
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * c ** (1.0 / 2.4) - 0.055)


def srgb_to_linear(c):
    c = np.maximum(np.asarray(c, dtype=np.float32), 0.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


@dataclass
class Geometry:
    positions: np.ndarray  # (triangles, 3, 3), world space
    normals: np.ndarray    # (triangles, 3, 3), split corner normals
    colors: np.ndarray     # (triangles, 3), linear RGB
    object_ids: np.ndarray
    unlit: np.ndarray
    outlined: np.ndarray
    casts_shadow: np.ndarray


@dataclass
class Style:
    paper: tuple = (0.898, 0.855, 0.768)
    ink: tuple = (0.018, 0.045, 0.039)
    bands: int = 4
    outline_width: float = 0.85
    hatch_amount: float = 0.23
    grain: float = 0.025
    registration: float = 0.85
    shadow_size: int = 1024
    seed: int = 19


_PLANES = np.array(((1, 0, 0, 1), (-1, 0, 0, 1),
                    (0, 1, 0, 1), (0, -1, 0, 1),
                    (0, 0, 1, 1), (0, 0, -1, 1)), dtype=np.float32)


def clip_triangle(clip, attributes):
    """Clip against all six frustum planes, carrying interpolated attributes."""
    distances = clip @ _PLANES.T
    if np.any(np.all(distances < 0, axis=0)):
        return []
    if np.all(distances >= 0):
        return [(clip, attributes)]
    polygon = list(np.concatenate((clip, attributes), axis=1))
    for plane in _PLANES:
        if not polygon:
            break
        output = []
        previous = polygon[-1]
        dp = float(previous[:4] @ plane)
        for current in polygon:
            dc = float(current[:4] @ plane)
            if (dp >= 0) != (dc >= 0):
                output.append(previous + (current - previous) * (dp / (dp - dc)))
            if dc >= 0:
                output.append(current)
            previous, dp = current, dc
        polygon = output
    result = []
    for i in range(1, len(polygon) - 1):
        triangle = np.asarray((polygon[0], polygon[i], polygon[i + 1]))
        if np.all(triangle[:, 3] > 1e-8):
            result.append((triangle[:, :4], triangle[:, 4:]))
    return result


def fragments(clip, width, height):
    """Yield bounded strips of covered pixels and perspective-correct weights."""
    reciprocal_w = 1.0 / clip[:, 3]
    ndc = clip[:, :3] * reciprocal_w[:, None]
    xy = (ndc[:, :2] * 0.5 + 0.5) * (width, height)
    low = np.maximum(np.ceil(xy.min(axis=0) - 0.5).astype(int), 0)
    high = np.minimum(np.floor(xy.max(axis=0) - 0.5).astype(int), (width - 1, height - 1))
    if np.any(low > high):
        return
    a, b, c = xy
    denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(denominator) < 1e-10:
        return
    x = np.arange(low[0], high[0] + 1, dtype=np.float32)[None, :] + 0.5
    # Strip size limits temporary memory for large ground-plane triangles.
    for row in range(low[1], high[1] + 1, 48):
        end = min(row + 48, high[1] + 1)
        y = np.arange(row, end, dtype=np.float32)[:, None] + 0.5
        wa = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / denominator
        wb = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / denominator
        wc = 1.0 - wa - wb
        inside = (wa >= -1e-6) & (wb >= -1e-6) & (wc >= -1e-6)
        iy, ix = np.nonzero(inside)
        if not len(ix):
            continue
        barycentric = np.column_stack((wa[iy, ix], wb[iy, ix], wc[iy, ix]))
        depth = barycentric @ ndc[:, 2]
        weights = barycentric * reciprocal_w
        weights /= weights.sum(axis=1, keepdims=True)
        yield iy + row, ix + low[0], depth, weights


def rasterize(geometry, matrix, width, height, cancel=lambda: False,
              progress=lambda p: None, depth_only=False):
    depth = np.full((height, width), np.inf, dtype=np.float32)
    if not depth_only:
        position = np.zeros((height, width, 3), dtype=np.float32)
        normal = np.zeros_like(position)
        color = np.zeros_like(position)
        ids = np.full((height, width), -1, dtype=np.int32)
        unlit = np.zeros((height, width), dtype=bool)
        outlined = np.zeros_like(unlit)
    homogeneous = np.concatenate((geometry.positions, np.ones((*geometry.positions.shape[:2], 1), dtype=np.float32)), axis=2)
    clips = homogeneous @ np.asarray(matrix, dtype=np.float32).T
    attributes = np.concatenate((geometry.positions, geometry.normals), axis=2)
    for i in range(len(clips)):
        if i % 128 == 0:
            if cancel():
                raise RenderCancelled()
            progress(i / max(len(clips), 1))
        if depth_only and not geometry.casts_shadow[i]:
            continue
        for clip, attr in clip_triangle(clips[i], attributes[i]):
            for y, x, z, weights in fragments(clip, width, height):
                nearer = z < depth[y, x]
                if not np.any(nearer):
                    continue
                y, x, z, weights = y[nearer], x[nearer], z[nearer], weights[nearer]
                depth[y, x] = z
                if not depth_only:
                    interpolated = weights @ attr
                    position[y, x] = interpolated[:, :3]
                    normal[y, x] = interpolated[:, 3:]
                    color[y, x] = geometry.colors[i]
                    ids[y, x] = geometry.object_ids[i]
                    unlit[y, x] = geometry.unlit[i]
                    outlined[y, x] = geometry.outlined[i]
    if depth_only:
        return depth
    return dict(depth=depth, position=position, normal=normalized(normal), color=color,
                ids=ids, unlit=unlit, outlined=outlined)


def shadow_matrix(geometry, light_direction):
    points = geometry.positions[geometry.casts_shadow].reshape(-1, 3)
    if not len(points):
        return None
    toward_light = normalized(np.asarray(light_direction, dtype=np.float32))
    helper = np.array((0, 0, 1) if abs(toward_light[2]) < 0.98 else (0, 1, 0), dtype=np.float32)
    right = normalized(np.cross(helper, toward_light))
    up = np.cross(toward_light, right)
    basis = np.asarray((right, up, -toward_light))
    projected = points @ basis.T
    low, high = projected.min(axis=0), projected.max(axis=0)
    padding = max(float(np.max(high - low)) * 0.05, 0.1)
    low -= padding
    high += padding
    matrix = np.eye(4, dtype=np.float32)
    matrix[:3, :3] = basis * (2.0 / (high - low))[:, None]
    matrix[:3, 3] = -(high + low) / (high - low)
    return matrix


def visibility(position, normal, light, matrix, shadow):
    if matrix is None:
        return np.ones(position.shape[:2], dtype=np.float32)
    projected = position @ matrix[:3, :3].T + matrix[:3, 3]
    size = shadow.shape[0]
    uv = (projected[..., :2] * 0.5 + 0.5) * size - 0.5
    x, y = np.rint(uv[..., 0]).astype(int), np.rint(uv[..., 1]).astype(int)
    bias = 0.0012 + 0.002 * (1.0 - np.maximum(normal @ light, 0))
    result = np.zeros(position.shape[:2], dtype=np.float32)
    for dx, dy in ((0, 0), (-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (1, 1), (-1, 1), (1, -1)):
        sx, sy = x + dx, y + dy
        outside = (sx < 0) | (sx >= size) | (sy < 0) | (sy >= size)
        closest = shadow[np.clip(sy, 0, size - 1), np.clip(sx, 0, size - 1)]
        result += outside | (projected[..., 2] <= closest + bias)
    return result / 9.0


def shifted(array, dx, dy, fill=0):
    result = np.full_like(array, fill)
    height, width = array.shape[:2]
    if abs(dx) >= width or abs(dy) >= height:
        return result
    xs, xe = max(0, -dx), min(width, width - dx)
    ys, ye = max(0, -dy), min(height, height - dy)
    result[ys + dy:ye + dy, xs + dx:xe + dx] = array[ys:ye, xs:xe]
    return result


def contours(buffers, radius):
    ids, n = buffers['ids'], buffers['normal']
    eligible = buffers['outlined'] & ~buffers['unlit'] & (ids >= 0)
    edge = np.zeros_like(eligible)
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        neighbor_id = shifted(ids, dx, dy, -1)
        neighbor_n = shifted(n, dx, dy)
        different = neighbor_id != ids
        crease = (np.sum(n * neighbor_n, axis=2) < 0.60) & (neighbor_id >= 0)
        edge |= eligible & (different | crease)
    expanded = edge.copy()
    radius = max(0, int(round(radius)) - 1)
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            if dx * dx + dy * dy <= radius * radius:
                expanded |= shifted(edge, dx, dy)
    return expanded


def shade(buffers, light_direction, light_strength, light_color, light_matrix,
          shadow, style, scale, cancel=lambda: False):
    """Pigment shading: discrete tones, crosshatching, grain and displaced ink."""
    height, width = buffers['ids'].shape
    paper = linear_to_srgb(np.asarray(style.paper, dtype=np.float32))
    ink = linear_to_srgb(np.asarray(style.ink, dtype=np.float32))
    light = normalized(np.asarray(light_direction, dtype=np.float32))
    rgb = np.empty((height, width, 3), dtype=np.float32)
    for row in range(0, height, 64):
        if cancel():
            raise RenderCancelled()
        sl = slice(row, min(row + 64, height))
        normal, position = buffers['normal'][sl], buffers['position'][sl]
        lit = np.clip(normal @ light, 0, 1)
        visible = visibility(position, normal, light, light_matrix, shadow)
        illumination = np.clip(lit * visible * light_strength, 0, 1)
        steps = np.floor(illumination * (style.bands - 0.001)) / max(style.bands - 1, 1)
        pigment = np.clip(linear_to_srgb(buffers['color'][sl]), 0, 1)
        shadow_tone = pigment * 0.48 + ink * 0.52
        light_tone = pigment * 0.88 + paper * 0.12
        shaded = shadow_tone + (light_tone - shadow_tone) * (0.23 + 0.77 * steps[..., None])
        tint = np.clip(linear_to_srgb(np.asarray(light_color)), 0, 1)
        shaded *= 0.82 + 0.18 * tint
        y, x = np.mgrid[row:sl.stop, 0:width].astype(np.float32) / scale
        # Fixed print-space coordinates keep the texture stable between frames.
        wave = np.sin(x * 0.041 + y * 0.019) * 0.35
        hatch = np.abs(np.mod(x * 0.78 + y * 0.63 + wave, 7.2) - 3.6) < 0.48
        cross = (np.abs(np.mod(x * 0.71 - y * 0.70, 8.6) - 4.3) < 0.40) & (illumination < 0.16)
        mask = (hatch | cross) * np.clip((0.58 - illumination) * 2.2, 0, 1) * style.hatch_amount
        shaded = shaded * (1 - mask[..., None]) + ink * mask[..., None]
        active = buffers['ids'][sl] >= 0
        shaded = np.where(active[..., None], shaded, paper)
        shaded = np.where(buffers['unlit'][sl, :, None], pigment, shaded)
        # Stateless noise also makes renders independent of object iteration order.
        noise = np.mod(np.sin(x * 127.1 + y * 311.7 + style.seed * 19.19) * 43758.5453, 1.0) - 0.5
        fiber = np.sin(y * 2.4 + np.sin(x * 0.045) * 0.6) * 0.12
        shaded += (noise + fiber)[..., None] * style.grain
        rgb[sl] = shaded
    if style.outline_width > 0:
        edge = contours(buffers, style.outline_width * scale)
        if style.registration > 0:
            offset = max(1, round(style.registration * scale))
            displaced = shifted(edge, offset, -offset) & ~edge & ~buffers['unlit']
            rgb[displaced] = rgb[displaced] * 0.65 + np.array((0.80, 0.33, 0.22)) * 0.35
        rgb[edge] = rgb[edge] * 0.12 + ink * 0.88
    return srgb_to_linear(np.clip(rgb, 0, 1))


def render(geometry, camera_matrix, width, height, style, light_direction=(-3, -4, 7),
           light_strength=1.0, light_color=(1, 1, 1), supersampling=2,
           cancel=lambda: False, progress=lambda value, message: None):
    scale = supersampling
    progress(0.02, 'Rasterizing geometry')
    buffers = rasterize(geometry, camera_matrix, width * scale, height * scale,
                        cancel, lambda p: progress(0.02 + 0.45 * p, 'Rasterizing geometry'))
    progress(0.48, 'Building sun shadow map')
    matrix = shadow_matrix(geometry, light_direction)
    shadow = None
    if matrix is not None:
        shadow = rasterize(geometry, matrix, style.shadow_size, style.shadow_size, cancel,
                           lambda p: progress(0.48 + 0.20 * p, 'Building sun shadow map'), True)
    progress(0.70, 'Mixing pigments and drawing ink')
    rgb = shade(buffers, light_direction, light_strength, light_color, matrix, shadow, style, scale, cancel)
    if scale > 1:
        rgb = rgb.reshape(height, scale, width, scale, 3).mean(axis=(1, 3))
    rgba = np.ones((height, width, 4), dtype=np.float32)
    rgba[..., :3] = rgb
    progress(0.98, 'Sending image to Blender')
    return rgba
