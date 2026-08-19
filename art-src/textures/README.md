# Cyber-dusk surface atlas

`cyber-dusk-surface-atlas.png` is the original source sheet for the runtime ceramic, graphite, gunmetal, and signal-circuit materials. It was generated with the built-in OpenAI image-generation tool, then split, resized, mipmapped, and encoded to ETC1S/KTX2 by `tools/art/build-surface-textures.mjs`.

Generation prompt:

> A perfectly tileable cyber-industrial rooftop material sheet with four equal quadrants: pale ceramic composite, dark graphite deck, brushed gunmetal trim, and restrained cyan/crimson emissive circuit inlay. Production game texture; realistic surface detail with crisp anime-editorial design, subtle panel seams, micro-scratches, restrained wear. Orthographic top-down and edge-to-edge. Flat neutral albedo capture with no directional lighting, shadows, perspective, depth of field, text, logos, recognizable symbols, watermark, objects, or outer frame. Original generic design only.

Runtime outputs are deliberately not hand-edited. Rebuild them with:

```sh
npm run art:textures
```
