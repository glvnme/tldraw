# STEP and IGES

|                  |                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Planned (order 6)                                                                                                                |
| Extensions       | `.step`, `.stp` (ISO 10303-21, AP203/AP214/AP242), `.iges`, `.igs`                                                               |
| Magic            | STEP: `ISO-10303-21;` with a `FILE_SCHEMA` that isn't IFC. IGES: 80-column fixed records with `S` in column 73 of the first line |
| Reader           | occt-import-js 0.0.23 (WASM build of Open CASCADE 7.6.1)                                                                         |
| Runtime          | Converter child process. Browser later, if wanted                                                                                |
| Source format id | `'step'`, `'iges'`                                                                                                               |

## The format, briefly

Neutral CAD exchange formats from mechanical CAD, used in architecture for fabrication parts, facade systems and furniture. Geometry is exact B-rep (NURBS surfaces, trims, topology), so it needs a CAD kernel to tessellate. STEP AP214 and AP242 carry assembly structure, names and colours. IGES is older, mostly surfaces with weaker topology.

STEP and IFC share the `ISO-10303-21` container. Tell them apart by `FILE_SCHEMA` (`IFC*` goes to the [IFC](ifc.md) reader).

## Dependency and licence

| Code                                    | Licence                                                | Obligation                                                                                                                                                                                                                                  | Size                         |
| --------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `occt-import-js` 0.0.23, pinned exactly | LGPL-2.1 (wrapper) plus OCCT's LGPL-2.1 with exception | Notice and licence text in `THIRD_PARTY_NOTICES.md`, plus a link to the exact source. Used unmodified as a separate module. Shipping it to the browser would also require letting users swap the WASM file, which a separate file satisfies | 7.6 MB WASM, 11.6 MB package |

Its last release is from 2024-12-03 (OCCT 7.6.1). If it shows bugs, the fallback is to build OCCT 7.9 natively in the converter image, with the same licence.

Writing our own STEP B-rep tessellator isn't realistic. It's a kernel-scale project.

## Conversion steps

1. `const occt = await occtimportjs()`. Then `ReadStepFile(bytes, params)` or `ReadIgesFile(bytes, params)`.
2. Params: `linearUnit: 'millimeter'` (output units), `linearDeflectionType: 'absolute_value'`, `linearDeflection: 0.5` (mm, so 0.5 mm chord error), `angularDeflection: 0.5` (radians). Record them in `settingsHash`. Allow per-upload overrides later.
3. The result is `{ success, root: { name, meshes: [indices], children }, meshes: [{ name, color, brep_faces, attributes: { position, normal }, index }] }`. On `success: false`, throw `conversion_failed`.
4. Walk `root` and its children. The node path gives `instancePath`, and node names give `name`. Each mesh becomes one feature. With `brep_faces`, a per-face colour can split it into materials.
5. Colour: the mesh `color` or the face colour, default grey.
6. Identity: STEP has no persistent IDs. Use `sourceId` = node path plus mesh name (`file-local`), and say in the UI that comments may not carry over to revisions.
7. Units: output is millimetres (from `linearUnit`), so the scale is 0.001. STEP is usually Z-up; record `basis: 'file'`.
8. Limits: abort when the summed index count passes `maxTriangles`. OCCT runs synchronously, so the child process timeout is the real guard.

The ghost reference takes `formatVersion` = the schema (`AUTOMOTIVE_DESIGN` = AP214, `AP242_...`) and `authoring` = the header `FILE_NAME` originating system.

## Tests

- Fixtures: a NIST or OCCT sample assembly (AP214 with colours and names), an IGES surface model, and a malformed file.
- Check the triangle count is within ±20% of a reference at the chosen deflection, names survive, and colours map correctly.
- Time and memory on a 50 MB STEP file before enabling it.

## Instructions for users

Export STEP AP214 or AP242 from the CAD tool, with colours and names on. For very large assemblies, export only the parts that need review, or a simplified (defeatured) model.
