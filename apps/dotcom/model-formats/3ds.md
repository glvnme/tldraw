# 3DS (3D Studio)

|                     |                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------- |
| Status              | Low priority. Export to GLB for now; our own reader if demand appears               |
| Extensions          | `.3ds`                                                                              |
| Magic               | Chunk id `0x4D4D` (MAIN3DS) as the first uint16, followed by the uint32 file length |
| Behaviour on upload | Refused with export instructions until a reader exists                              |

## The format, briefly

The legacy 3D Studio DOS chunk format, reverse-engineered and widely documented. Chunks are `uint16 id`, `uint32 length` (including the 6-byte header), then data or sub-chunks. Relevant chunks: `0x3D3D` editor, `0x4000` named object (null-terminated name), `0x4100` triangle mesh, `0x4110` vertex list (`uint16 count`, float32 xyz), `0x4120` face list (`uint16 count`, then `uint16 a b c flags`), `0x4130` face material group, `0x4160` local matrix, `0xAFFF` material, `0xA000` material name, `0xA020` diffuse colour. Limits: 65,535 vertices per object, 10-character names, no units (scene units live in the `.max`).

## If we build it

Our own TypeScript, about 400 to 800 lines, 2 to 4 days, with no dependency:

1. Walk chunks recursively. Skip unknown ids by length, and bound-check every length against its parent.
2. Each named object with a triangle mesh is one feature (`sourceId` = `file-local` name, de-duplicated).
3. Vertices are already in world space in most exporters. The `0x4160` local matrix describes the pivot and should not be applied again (a known 3DS trap). Verify on fixtures.
4. Material groups (`0x4130`) split faces into `Rgba` materials from `0xA020` colours.
5. Units unknown: assume metres with `units_assumed` and allow an override. Z-up.

No licence obligation.

## Instructions for users

Re-export from the source tool as GLB or FBX. If only the `.3ds` exists, import it into Blender and export GLB ([blend.md](blend.md)).
