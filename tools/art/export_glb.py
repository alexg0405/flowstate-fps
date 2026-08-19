"""Deterministic Blender 4.5 GLB export for Flowstate assets.

Usage:
  blender --background art-src/blender/characters/hunter-ranged.blend \
    --python tools/art/export_glb.py -- \
    --output build/art/raw/characters/hunter-ranged.glb

This produces an uncompressed interchange GLB. Meshopt/KTX2 post-processing is
performed after Blender export and verified by validate-assets.mjs.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

import bpy


def arguments_after_double_dash() -> list[str]:
    if "--" not in sys.argv:
        return []
    return sys.argv[sys.argv.index("--") + 1 :]


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a Flowstate Blender asset to GLB.")
    parser.add_argument("--output", required=True, help="Destination .glb path.")
    parser.add_argument("--collection", default="EXPORT", help="Collection exported from the source file.")
    parser.add_argument("--allow-nonunit-scale", action="store_true")
    return parser.parse_args(arguments_after_double_dash())


def fail(message: str) -> None:
    raise RuntimeError(f"Flowstate export validation failed: {message}")


def validate_blender_version() -> None:
    major, minor, _patch = bpy.app.version
    if (major, minor) != (4, 5):
        fail(f"expected Blender 4.5.x, running {bpy.app.version_string}")


def export_objects(collection_name: str) -> list[bpy.types.Object]:
    collection = bpy.data.collections.get(collection_name)
    if collection is None:
        fail(f"missing collection named {collection_name!r}")
    objects = [obj for obj in collection.all_objects if not obj.hide_render and not obj.get("no_export", False)]
    if not objects:
        fail(f"collection {collection_name!r} has no exportable objects")
    return objects


def validate_scene(objects: list[bpy.types.Object], allow_nonunit_scale: bool) -> None:
    if bpy.context.scene.unit_settings.system != "METRIC":
        fail("scene unit system must be METRIC")
    if abs(bpy.context.scene.unit_settings.scale_length - 1.0) > 1e-6:
        fail("scene unit scale_length must be 1.0 (one Blender unit equals one meter)")

    names: set[str] = set()
    for obj in objects:
        if obj.name in names:
            fail(f"duplicate object name {obj.name!r}")
        names.add(obj.name)
        if min(obj.scale) <= 0:
            fail(f"{obj.name!r} has a zero or negative scale")
        if not allow_nonunit_scale and obj.type in {"MESH", "ARMATURE"}:
            if any(abs(component - 1.0) > 1e-5 for component in obj.scale):
                fail(f"{obj.name!r} has unapplied scale {tuple(round(v, 5) for v in obj.scale)}")
        if obj.type == "MESH":
            if len(obj.data.polygons) == 0:
                fail(f"mesh {obj.name!r} is empty")
            for material in obj.data.materials:
                if material and not material.use_nodes:
                    fail(f"material {material.name!r} must use nodes")
        if obj.name.startswith("socket_") and obj.type != "EMPTY":
            fail(f"socket {obj.name!r} must be an Empty")


def select_only(objects: list[bpy.types.Object]) -> None:
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def export_glb(output: Path, objects: list[bpy.types.Object]) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    select_only(objects)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output),
        check_existing=False,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_animations=True,
        export_skins=True,
        export_morph=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_extras=True,
        export_cameras=False,
        export_lights=False,
    )
    if "FINISHED" not in result:
        fail(f"Blender exporter returned {result}")
    print(f"Exported {len(objects)} objects to {output}")


def main() -> None:
    arguments = parse_arguments()
    validate_blender_version()
    objects = export_objects(arguments.collection)
    validate_scene(objects, arguments.allow_nonunit_scale)
    export_glb(Path(arguments.output).expanduser().resolve(), objects)


if __name__ == "__main__":
    main()
