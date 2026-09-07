# Astra Press

为 Blender 4.5 编写的小型 CPU 渲染器。视觉是一张略有套色偏移的纸上版画：陶土红、孔雀绿、暖纸色、分层明暗、细墨线和阴影排线。

![Astra Press 示例](output/astra_press.png)

## 打开与使用

1. 在 Blender 的 **Edit → Preferences → Add-ons** 中，通过右上角菜单 **Install from Disk** 选择本目录的 `astra_press.zip`，启用 **Astra Press**。
2. 打开 `output/quiet_objects.blend`，确认 Render Engine 为 **Astra Press**，按 **F12**。
3. Render Properties 中的 **Astra Press / Print Studio** 面板可以调整色阶、墨线宽度、排线、颗粒、套色偏移和抗锯齿。

示例文件已经设置好相机、Sun 光源、材质以及 Standard 色彩管理，最终 PNG 也已打包进 blend 的 `Astra Press / Finished Print` 图像数据块。

实现和验证过程使用独立的 Blender 后台进程；没有修改现有 Blender 偏好或安装全局依赖。ZIP 是传统 Blender add-on 包，通过 Add-ons 安装。

## 文件

| 文件 | 用途 |
| --- | --- |
| `astra_press.zip` | 可安装的渲染器插件 |
| `astra_press/__init__.py` | RenderEngine 注册、Blender 场景转换、参数面板 |
| `astra_press/core.py` | 独立 NumPy 光栅化、阴影与版画着色 |
| `render_demo.py` | 创建完整示例场景、渲染、保存 blend 和打包插件 |
| `output/astra_press.png` | 1440 × 1080 的渲染结果 |
| `output/quiet_objects.blend` | 可编辑、可重新渲染的示例场景 |
| `output/cycles_reference.png` | 同场景、同相机、同色彩管理的 Cycles 对照 |
| `output/compare.html` | 可拖动分界线的渲染对比，直接用浏览器打开 |
| `output/astra_press_report.json` | 实际 Blender 版本、尺寸、耗时和三角形数量 |
| `tests/verify_renderer.py` | 数值与 Blender 场景转换验证 |

## 实现

完整的图像由 Astra 自己计算：

1. 从 Blender evaluated dependency graph 读取实例、应用修改器后的三角网格和分裂法线。
2. 使用 Blender 相机投影矩阵，执行六平面齐次裁剪。
3. CPU 深度缓冲光栅化，使用透视校正插值生成位置、法线和材质缓冲。
4. 为 Sun 构建阴影贴图并进行九点采样。
5. 以离散颜料色阶着色，叠加阴影交叉排线、轮廓、轻微墨版偏移及固定种子的纸纹。
6. 2× 超采样后在线性空间下采样，以浮点 RGBA 写回 Blender Render Result。

插件本身不调用 Cycles、EEVEE 或外部图像生成服务。`render_demo.py --compare` 单独调用 Cycles，生成参考图。

为了获得纸张和颜料的效果，着色中的颜料混合在 sRGB 编码的颜色上进行；输入和返回 Blender 的结果都是线性颜色，避免重复应用显示变换。自己的场景建议使用 **Standard** view transform。

## 当前范围

- 支持透视与正交相机、网格、可转换成网格的曲线和文字、修改器、集合实例。
- 材质读取直接连接 Material Output 的 Principled BSDF 的 Base Color 常量；其他着色结构使用 Material 的 diffuse color。`Flat ink / Unlit` 可用于文字。
- 使用场景中第一个可渲染 Sun 的方向、颜色与强度；没有 Sun 时使用默认工作室方向光。
- 当前只做最终图像渲染，提供 Combined 通道和不透明纸底。没有实时 Rendered 视口、贴图节点求值、反射折射、间接光、透明材质、运动模糊和全景相机支持。Render Region 需关闭。
- 阴影、套色和纸纹是风格化设计，适合小场景。它并不是物理准确的路径追踪器。
- 若某个对象不应投射阴影，可设置其自定义属性 `astra_cast_shadow = False`，示例中的纸面与排版文字使用了这个设置。

## 在 Windows 重新生成

在 Windows Git Bash 中执行：

```bash
cd /d/bld/astra_render
"/c/Program Files/Blender Foundation/Blender 4.5/blender.exe" \
  --background --factory-startup --python-exit-code 1 \
  --python render_demo.py -- --width 1440 --compare
```

这里的 factory-startup 只作用于本次后台进程。脚本会重新生成专用 `output` 目录中的示例成果。

运行验证：

```bash
"/c/Program Files/Blender Foundation/Blender 4.5/blender.exe" \
  --background --factory-startup --python-exit-code 1 \
  --python tests/verify_renderer.py
```

验证覆盖深度遮挡与绘制顺序、近平面裁剪、相机背后的三角形、透视插值、阴影遮挡、空场景、颜色往返、取消渲染、修改器、隐藏对象、集合实例以及插件注册/注销。出图脚本还会检查图片尺寸、有限像素值、非空画面与 Alpha。

API 参考：[Blender 4.5 RenderEngine](https://docs.blender.org/api/4.5/bpy.types.RenderEngine.html)。
