# DAE (COLLADA)

|                     |                                                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Status              | Low priority. Export to GLB for now; our own reader if demand appears                                                        |
| Extensions          | `.dae`                                                                                                                       |
| Magic               | XML with a `<COLLADA` root element (namespace `http://www.collada.org/2005/11/COLLADASchema` for 1.4, `…/2008/03/…` for 1.5) |
| Behaviour on upload | Refused with export instructions until a reader exists                                                                       |

## The format, briefly

Khronos COLLADA 1.4/1.5: an XML scene with `library_geometries` (`<mesh>` with `<source>` float arrays, `<vertices>`, `<triangles>`/`<polylist>`/`<polygons>`), `library_materials` and `library_effects` (colours, textures), `library_nodes` and `library_visual_scenes` (node tree with `<matrix>` or TRS, `<instance_geometry>`, `<instance_node>`), and `<asset><unit meter="0.0254"/><up_axis>Z_UP</up_axis>`. SketchUp versions before 2025 and older pipelines export it.

## If we build it

Our own TypeScript, about 1,000 to 2,000 lines for the static-mesh subset, 2 to 3 weeks, with no dependency (reusing the streaming XML tokenizer from [3MF](3mf.md)):

1. Units from `<unit meter>`, axis from `<up_axis>`, both `basis: 'file'`.
2. Resolve `#id` references across the libraries.
3. Read polygons with their `<input semantic offset>` interleaving: `VERTEX` (positions, via `<vertices>`), `NORMAL`, `TEXCOORD` ignored. Fan-triangulate `polylist` using `vcount`.
4. Walk the visual scene: compose node matrices, expand `instance_node` and `instance_geometry` (baked), and bind materials through `<bind_material>`.
5. Colour: `<effect>` → `<diffuse><color>` (or `<texture>`, which gives `material_approximated`).
6. Identity: node `id` or `sid` path (`file-local`), `name` = node `name`.
7. Skip controllers (skins), animations, cameras and lights.

No licence obligation.

## Instructions for users

Open the `.dae` in Blender (File → Import → Collada) and export GLB ([blend.md](blend.md) settings). From SketchUp, see [skp.md](skp.md).
