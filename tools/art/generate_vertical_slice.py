"""Generate the original Flow State vertical-slice source models in Blender 4.5.

This is intentionally deterministic and code-authored: it creates editable .blend
sources for the VX-09, both shared-rig hunters, and the modular rooftop kit. Artists
can open and refine the generated sources without changing runtime IDs or sockets.

Run from the repository root:
  .tooling/blender-4.5.10/Blender.app/Contents/MacOS/Blender --background \
    --python tools/art/generate_vertical_slice.py
"""

from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "art-src" / "blender"


def reset_scene() -> bpy.types.Collection:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    collection = bpy.data.collections.new("EXPORT")
    scene.collection.children.link(collection)
    return collection


def move_to(obj: bpy.types.Object, collection: bpy.types.Collection) -> bpy.types.Object:
    for current in list(obj.users_collection):
        current.objects.unlink(obj)
    collection.objects.link(obj)
    return obj


def material(name: str, color: tuple[float, float, float, float], metallic: float, roughness: float, emissive: tuple[float, float, float, float] | None = None, emission_strength: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    metallic_input = shader.inputs.get("Metallic IOR Level") or shader.inputs.get("Metallic")
    metallic_input.default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    if emissive:
        shader.inputs["Emission Color"].default_value = emissive
        shader.inputs["Emission Strength"].default_value = emission_strength
    return mat


def assign(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    if obj.type == "MESH":
        obj.data.materials.append(mat)


def box(collection: bpy.types.Collection, name: str, size: tuple[float, float, float], location=(0.0, 0.0, 0.0), mat=None, bevel=0.03, rotation=(0.0, 0.0, 0.0)) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(location=location, rotation=rotation)
    obj = move_to(bpy.context.object, collection)
    obj.name = name
    obj.dimensions = size
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel > 0:
        modifier = obj.modifiers.new("edge_bevel", "BEVEL")
        modifier.width = min(bevel, min(size) * 0.28)
        modifier.segments = 3
        modifier.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    if mat:
        assign(obj, mat)
    return obj


def cylinder(collection: bpy.types.Collection, name: str, radius: float, depth: float, location=(0.0, 0.0, 0.0), mat=None, rotation=(0.0, 0.0, 0.0), vertices=20) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = move_to(bpy.context.object, collection)
    obj.name = name
    if mat:
        assign(obj, mat)
    bevel = obj.modifiers.new("edge_bevel", "BEVEL")
    bevel.width = min(0.018, radius * 0.18)
    bevel.segments = 2
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    return obj


def sphere(collection: bpy.types.Collection, name: str, radius: float, location=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0), mat=None) -> bpy.types.Object:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=14, radius=radius, location=location)
    obj = move_to(bpy.context.object, collection)
    obj.name = name
    obj.scale = scale
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if mat:
        assign(obj, mat)
    return obj


def torus(collection: bpy.types.Collection, name: str, major: float, minor: float, location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), mat=None) -> bpy.types.Object:
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=28, minor_segments=8, location=location, rotation=rotation)
    obj = move_to(bpy.context.object, collection)
    obj.name = name
    if mat:
        assign(obj, mat)
    return obj


def socket(collection: bpy.types.Collection, name: str, location: tuple[float, float, float]) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.06
    obj.location = location
    obj["socket"] = True
    collection.objects.link(obj)
    return obj


def create_armature(collection: bpy.types.Collection, name: str, bones: list[tuple[str, tuple[float, float, float], tuple[float, float, float], str | None]]) -> bpy.types.Object:
    armature = bpy.data.armatures.new(f"{name}_data")
    rig = bpy.data.objects.new(name, armature)
    collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    made: dict[str, bpy.types.EditBone] = {}
    for bone_name, head, tail, parent in bones:
        bone = armature.edit_bones.new(bone_name)
        bone.head = head
        bone.tail = tail
        bone.use_deform = True
        if parent:
            bone.parent = made[parent]
        made[bone_name] = bone
    bpy.ops.object.mode_set(mode="OBJECT")
    rig.select_set(False)
    return rig


def rigid_bone_parent(obj: bpy.types.Object, rig: bpy.types.Object, bone: str) -> None:
    world = obj.matrix_world.copy()
    obj.parent = rig
    obj.parent_type = "BONE"
    obj.parent_bone = bone
    obj.matrix_world = world


def add_actions(rig: bpy.types.Object, names: list[str]) -> None:
    rig.animation_data_create()
    for index, name in enumerate(names):
        action = bpy.data.actions.new(name)
        rig.animation_data.action = action
        for pose in rig.pose.bones:
            pose.rotation_mode = "XYZ"
            pose.rotation_euler = (0.0, 0.0, 0.0)
            pose.location = (0.0, 0.0, 0.0)
            pose.scale = (1.0, 1.0, 1.0)
            pose.keyframe_insert("rotation_euler", frame=1, group=pose.name)
            pose.keyframe_insert("location", frame=1, group=pose.name)

        root = rig.pose.bones.get("root")
        # Each clip has a distinct silhouette and motion signature. These remain
        # presentation-only: simulation never reads animation or root motion.
        if name in {"vm_fire_01", "vm_fire_02", "hunter_fire"}:
            root.rotation_euler.x = -0.09 if name != "vm_fire_02" else -0.12
            root.location.y = 0.055
        elif "reload" in name:
            root.rotation_euler.z = 0.22 if name.endswith("tactical") else 0.32
            rig.pose.bones.get("hand_l").rotation_euler.x = -0.72
        elif name == "vm_melee" or name == "hunter_melee":
            root.rotation_euler.y = -0.34
            root.rotation_euler.z = 0.16
        elif name == "vm_sprint" or name == "hunter_run":
            root.rotation_euler.x = 0.13
            root.location.z = 0.045
            for bone_name, direction in (("leg_l", 1), ("leg_r", -1), ("arm_l", -1), ("arm_r", 1)):
                bone = rig.pose.bones.get(bone_name)
                if bone:
                    bone.rotation_euler.x = direction * 0.42
        elif "strafe_l" in name:
            root.rotation_euler.z = 0.12
        elif "strafe_r" in name:
            root.rotation_euler.z = -0.12
        elif "death" in name:
            root.rotation_euler.z = 1.05
            root.location.y = -0.18
        elif "hit" in name:
            root.rotation_euler.x = 0.2
        elif "jump" in name or "vault" in name:
            root.location.z = 0.18
            root.rotation_euler.x = -0.16 if "vault" in name else 0.06
        elif "drop" in name:
            root.location.z = -0.12
        elif "land" in name:
            root.location.z = -0.08
        elif name == "vm_equip":
            root.location.z = -0.25
            root.rotation_euler.z = 0.24
        elif name == "vm_grapple_cast":
            root.rotation_euler.y = -0.2
        elif name == "vm_grapple_hold":
            root.rotation_euler.y = -0.08
        elif name == "vm_grapple_release":
            root.rotation_euler.y = 0.14
        else:
            root.rotation_euler.z = 0.018 + (index % 3) * 0.006

        for pose in rig.pose.bones:
            pose.keyframe_insert("rotation_euler", frame=8, group=pose.name)
            pose.keyframe_insert("location", frame=8, group=pose.name)
            pose.rotation_euler = (0.0, 0.0, 0.0)
            pose.location = (0.0, 0.0, 0.0)
            pose.keyframe_insert("rotation_euler", frame=16, group=pose.name)
            pose.keyframe_insert("location", frame=16, group=pose.name)
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, action)
        strip.action_frame_start = 1
        strip.action_frame_end = 16
    rig.animation_data.action = None


def collapse_by_material(collection: bpy.types.Collection, rig: bpy.types.Object | None, prefix: str) -> None:
    """Join only parts sharing both material and rigid bone binding.

    Joining across bones makes exported actions visually inert. Keeping the bone
    in the batching key preserves animation while still collapsing draw units.
    """
    groups: dict[tuple[str, str], list[bpy.types.Object]] = {}
    for obj in list(collection.objects):
        if obj.type != "MESH" or not obj.data.materials:
            continue
        bone_name = obj.parent_bone if rig and obj.parent == rig and obj.parent_type == "BONE" else ""
        groups.setdefault((obj.data.materials[0].name, bone_name), []).append(obj)
    for index, ((_, bone_name), objects) in enumerate(groups.items()):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            world = obj.matrix_world.copy()
            obj.parent = None
            obj.matrix_world = world
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        joined = bpy.context.object
        joined.name = f"{prefix}_surface_{index:02}"
        if rig:
            world = joined.matrix_world.copy()
            if bone_name:
                rigid_bone_parent(joined, rig, bone_name)
            else:
                joined.parent = rig
                joined.matrix_world = world
        joined.select_set(False)


def save(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(path), check_existing=False)
    print(f"Generated {path.relative_to(ROOT)}")


def build_viewmodel() -> None:
    collection = reset_scene()
    ceramic = material("vm_ceramic", (0.55, 0.62, 0.65, 1), 0.58, 0.22)
    metal = material("vm_gunmetal", (0.035, 0.055, 0.075, 1), 0.92, 0.18)
    carbon = material("vm_carbon", (0.012, 0.018, 0.026, 1), 0.35, 0.36)
    red = material("vm_signal_red", (0.4, 0.012, 0.035, 1), 0.46, 0.24, (1.0, 0.01, 0.08, 1), 4.0)
    cyan = material("vm_optic_cyan", (0.01, 0.2, 0.28, 1), 0.2, 0.08, (0.02, 0.8, 1.0, 1), 3.0)
    fabric = material("vm_glove", (0.02, 0.026, 0.035, 1), 0.05, 0.86)
    skin = material("vm_skin", (0.42, 0.23, 0.18, 1), 0.0, 0.64)

    rig = create_armature(collection, "vx09_rig", [
        ("root", (0, 0, 0), (0, 0, 0.2), None),
        ("weapon", (0, 0, 0.2), (0, -0.45, 0.2), "root"),
        ("hand_l", (-0.18, -0.3, -0.08), (-0.18, -0.7, -0.08), "root"),
        ("hand_r", (0.17, 0.0, -0.12), (0.17, -0.35, -0.12), "root"),
    ])

    parts: list[tuple[bpy.types.Object, str]] = []
    parts.append((box(collection, "receiver_upper", (0.25, 0.82, 0.22), (0, -0.2, 0.02), ceramic, 0.045), "weapon"))
    parts.append((box(collection, "receiver_lower", (0.21, 0.56, 0.2), (0, 0.22, -0.08), metal, 0.035), "weapon"))
    parts.append((box(collection, "stock_beam", (0.12, 0.6, 0.11), (0, 0.72, 0.02), metal, 0.028), "weapon"))
    parts.append((box(collection, "stock_pad", (0.28, 0.16, 0.42), (0, 1.08, -0.06), carbon, 0.06), "weapon"))
    parts.append((cylinder(collection, "handguard", 0.17, 0.76, (0, -0.94, 0.02), ceramic, (math.pi / 2, 0, 0), 12), "weapon"))
    parts.append((cylinder(collection, "barrel", 0.032, 0.82, (0, -1.65, 0.02), metal, (math.pi / 2, 0, 0)), "weapon"))
    parts.append((cylinder(collection, "muzzle_brake", 0.058, 0.2, (0, -2.15, 0.02), metal, (math.pi / 2, 0, 0), 12), "weapon"))
    parts.append((box(collection, "top_rail", (0.14, 1.35, 0.04), (0, -0.4, 0.2), metal, 0.012), "weapon"))
    for index in range(12):
        parts.append((box(collection, f"rail_tooth_{index:02}", (0.19, 0.042, 0.055), (0, 0.16 - index * 0.105, 0.23), metal, 0.008), "weapon"))
    for index in range(6):
        angle = index / 6 * math.tau
        parts.append((box(collection, f"handguard_slot_{index:02}", (0.028, 0.28, 0.035), (math.cos(angle) * 0.17, -0.95, 0.02 + math.sin(angle) * 0.17), red, 0.008, (0, angle, 0)), "weapon"))
    parts.append((box(collection, "optic_body", (0.25, 0.33, 0.23), (0, -0.05, 0.36), carbon, 0.065), "weapon"))
    parts.append((cylinder(collection, "optic_lens_front", 0.09, 0.018, (0, -0.22, 0.37), cyan, (math.pi / 2, 0, 0), 28), "weapon"))
    parts.append((cylinder(collection, "optic_lens_rear", 0.09, 0.018, (0, 0.12, 0.37), cyan, (math.pi / 2, 0, 0), 28), "weapon"))
    magazine = box(collection, "magazine", (0.19, 0.24, 0.5), (0, 0.19, -0.37), metal, 0.045, (0.14, 0, 0))
    parts.append((magazine, "weapon"))
    parts.append((box(collection, "pistol_grip", (0.15, 0.19, 0.39), (0, 0.54, -0.36), carbon, 0.045, (-0.18, 0, 0)), "weapon"))
    parts.append((box(collection, "charge_handle", (0.35, 0.055, 0.055), (0.1, 0.15, 0.11), ceramic, 0.014), "weapon"))

    for side, bone, x in [(-1, "hand_l", -0.28), (1, "hand_r", 0.3)]:
        forearm = cylinder(collection, f"forearm_{bone}", 0.105, 0.7, (x, 0.35 if side > 0 else -0.55, -0.48), fabric, (math.pi / 2.65, 0, 0), 16)
        palm = box(collection, f"palm_{bone}", (0.2, 0.25, 0.12), (x, 0.0 if side > 0 else -0.9, -0.3), fabric, 0.055)
        plate = box(collection, f"hand_plate_{bone}", (0.17, 0.14, 0.04), (x, -0.02 if side > 0 else -0.92, -0.23), red if side > 0 else ceramic, 0.025)
        parts.extend([(forearm, bone), (palm, bone), (plate, bone)])
        for finger in range(4):
            finger_obj = cylinder(collection, f"finger_{bone}_{finger}", 0.022, 0.15 + finger * 0.008, (x + side * (-0.065 + finger * 0.043), -0.14 if side > 0 else -1.03, -0.31), fabric, (math.pi / 2, 0, 0), 10)
            parts.append((finger_obj, bone))
        skin_patch = box(collection, f"skin_patch_{bone}", (0.12, 0.11, 0.025), (x, -0.025 if side > 0 else -0.925, -0.365), skin, 0.014)
        parts.append((skin_patch, bone))

    for obj, bone in parts:
        rigid_bone_parent(obj, rig, bone)
    rigid_bone_parent(socket(collection, "socket_muzzle", (0, -2.28, 0.02)), rig, "weapon")
    rigid_bone_parent(socket(collection, "socket_eject", (0.15, -0.18, 0.08)), rig, "weapon")
    rigid_bone_parent(socket(collection, "socket_hand_l", (-0.28, -0.9, -0.3)), rig, "hand_l")
    rigid_bone_parent(socket(collection, "socket_hand_r", (0.3, 0.0, -0.3)), rig, "hand_r")
    rigid_bone_parent(socket(collection, "socket_grapple_emitter", (-0.13, -1.18, 0.02)), rig, "weapon")
    add_actions(rig, [
        "vm_equip",
        "vm_idle",
        "vm_sprint",
        "vm_fire_01",
        "vm_fire_02",
        "vm_ads_in",
        "vm_ads_out",
        "vm_reload_tactical",
        "vm_reload_empty",
        "vm_melee",
        "vm_grapple_cast",
        "vm_grapple_hold",
        "vm_grapple_release",
    ])
    collapse_by_material(collection, rig, "vx09")
    save(SOURCE / "viewmodels" / "runner-rifle.blend")


HUNTER_BONES = [
    ("root", (0, 0, 0), (0, 0, 0.2), None),
    ("pelvis", (0, 0, 0.85), (0, 0, 1.08), "root"),
    ("spine", (0, 0, 1.08), (0, 0, 1.62), "pelvis"),
    ("neck", (0, 0, 1.62), (0, 0, 1.88), "spine"),
    ("head", (0, 0, 1.88), (0, 0, 2.15), "neck"),
    ("arm_l", (0, 0, 1.56), (-0.72, 0, 1.32), "spine"),
    ("arm_r", (0, 0, 1.56), (0.72, 0, 1.32), "spine"),
    ("leg_l", (-0.18, 0, 0.9), (-0.18, 0, 0.08), "pelvis"),
    ("leg_r", (0.18, 0, 0.9), (0.18, 0, 0.08), "pelvis"),
]


def build_hunter(aggressive: bool) -> None:
    collection = reset_scene()
    armor = material("hunter_armor_red" if aggressive else "hunter_armor_blue", (0.32, 0.025, 0.07, 1) if aggressive else (0.03, 0.12, 0.18, 1), 0.68, 0.27)
    secondary = material("hunter_secondary", (0.055, 0.075, 0.1, 1), 0.55, 0.38)
    fabric = material("hunter_fabric", (0.012, 0.018, 0.025, 1), 0.05, 0.88)
    metal = material("hunter_metal", (0.18, 0.22, 0.26, 1), 0.88, 0.22)
    signal = material("hunter_signal", (0.45, 0.01, 0.04, 1) if aggressive else (0.01, 0.26, 0.36, 1), 0.35, 0.16, (1, 0.01, 0.08, 1) if aggressive else (0.02, 0.9, 1, 1), 5.0)
    glass = material("hunter_glass", (0.03, 0.22, 0.28, 1), 0.18, 0.07, (0.02, 0.7, 1, 1), 2.8)
    rig = create_armature(collection, "hunter_shared_rig", HUNTER_BONES)

    pieces: list[tuple[bpy.types.Object, str]] = []
    pieces.append((box(collection, "pelvis_armor", (0.5, 0.32, 0.3), (0, 0, 0.9), fabric, 0.09), "pelvis"))
    pieces.append((sphere(collection, "torso_underlayer", 0.35, (0, 0, 1.36), (1.0, 0.7, 1.25), fabric), "spine"))
    pieces.append((box(collection, "chest_plate", (0.72 if aggressive else 0.65, 0.25, 0.5), (0, -0.18, 1.43), armor, 0.1, (-0.06, 0, 0)), "spine"))
    pieces.append((box(collection, "sternum_light", (0.14, 0.055, 0.36), (0, -0.32, 1.43), signal, 0.025), "spine"))
    for side in (-1, 1):
        pieces.append((box(collection, f"collar_{side}", (0.28, 0.28, 0.13), (side * 0.25, -0.05, 1.62), armor, 0.06, (0, side * 0.12, side * 0.17)), "spine"))
        pieces.append((box(collection, f"hip_plate_{side}", (0.19, 0.12, 0.35), (side * 0.29, 0, 0.86), armor, 0.05, (0, 0, side * 0.14)), "pelvis"))
    pieces.append((sphere(collection, "helmet", 0.3, (0, 0, 1.99), (0.92, 0.98, 1.08), armor), "head"))
    pieces.append((box(collection, "faceplate", (0.43, 0.13, 0.22), (0, -0.255, 1.98), metal, 0.065), "head"))
    pieces.append((box(collection, "visor", (0.34, 0.035, 0.058), (0, -0.33, 2.04), signal, 0.018), "head"))
    if not aggressive:
        pieces.append((cylinder(collection, "helmet_optic", 0.075, 0.18, (0.2, -0.31, 2.08), glass, (math.pi / 2, 0, 0), 20), "head"))
    else:
        for side in (-1, 1):
            pieces.append((cylinder(collection, f"helmet_fin_{side}", 0.05, 0.3, (side * 0.2, 0, 2.28), armor, (0, side * 0.45, 0), 8), "head"))

    for side, bone in [(-1, "arm_l"), (1, "arm_r")]:
        pieces.append((cylinder(collection, f"upper_{bone}", 0.11, 0.48, (side * 0.43, 0, 1.42), fabric, (0, side * 0.2, side * 0.18), 16), bone))
        pieces.append((box(collection, f"shoulder_{bone}", (0.27, 0.29, 0.26), (side * 0.43, 0, 1.58), armor, 0.07), bone))
        pieces.append((cylinder(collection, f"forearm_{bone}", 0.095, 0.42, (side * 0.56, -0.03, 1.14), fabric, (0, side * 0.25, side * 0.15), 16), bone))
        pieces.append((box(collection, f"gauntlet_{bone}", (0.21, 0.25, 0.32), (side * 0.6, -0.05, 1.08), metal, 0.055), bone))
    for side, bone in [(-1, "leg_l"), (1, "leg_r")]:
        pieces.append((cylinder(collection, f"thigh_{bone}", 0.135, 0.58, (side * 0.18, 0, 0.65), fabric, (0, 0, 0), 16), bone))
        pieces.append((box(collection, f"thigh_plate_{bone}", (0.25, 0.18, 0.48), (side * 0.18, -0.11, 0.67), armor, 0.06), bone))
        pieces.append((cylinder(collection, f"shin_{bone}", 0.115, 0.55, (side * 0.18, 0, 0.28), fabric, (0, 0, 0), 16), bone))
        pieces.append((box(collection, f"shin_plate_{bone}", (0.22, 0.16, 0.42), (side * 0.18, -0.105, 0.28), metal, 0.05), bone))
        pieces.append((box(collection, f"boot_{bone}", (0.25, 0.38, 0.16), (side * 0.18, -0.09, 0.08), metal, 0.055), bone))
    for side in (-1, 1):
        coat = box(collection, f"coat_tail_{side}", (0.28, 0.06, 0.78 if not aggressive else 0.58), (side * 0.18, 0.15, 0.93), armor, 0.045, (side * 0.07, 0, side * 0.08))
        pieces.append((coat, "pelvis"))

    if aggressive:
        weapon = cylinder(collection, "pressure_blade", 0.065, 1.35, (0.57, -0.08, 0.93), signal, (0, 0.2, -0.12), 8)
    else:
        weapon = box(collection, "marksman_rifle", (0.15, 1.22, 0.17), (0.5, -0.18, 1.2), metal, 0.04, (0.14, 0, -0.08))
        optic = box(collection, "marksman_optic", (0.2, 0.3, 0.2), (0.5, -0.18, 1.38), glass, 0.05)
        pieces.append((optic, "arm_r"))
    pieces.append((weapon, "arm_r"))

    for obj, bone in pieces:
        rigid_bone_parent(obj, rig, bone)
    rigid_bone_parent(socket(collection, "socket_weapon", (0.52, -0.18, 1.2)), rig, "arm_r")
    rigid_bone_parent(socket(collection, "socket_head", (0, 0, 2.02)), rig, "head")
    if not aggressive:
        rigid_bone_parent(socket(collection, "socket_muzzle", (0.5, -0.88, 1.2)), rig, "arm_r")
    clips = ["hunter_idle", "hunter_run", "hunter_strafe_l", "hunter_strafe_r", "hunter_melee" if aggressive else "hunter_fire", "hunter_hit", "hunter_death", "hunter_jump", "hunter_vault", "hunter_drop", "hunter_land"]
    add_actions(rig, clips)
    collapse_by_material(collection, rig, "hunter")
    save(SOURCE / "characters" / ("hunter-aggressive.blend" if aggressive else "hunter-ranged.blend"))


def new_export_collection(name: str) -> bpy.types.Collection:
    collection = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(collection)
    return collection


def build_environment() -> None:
    reset_scene()
    # Remove the default EXPORT: this source uses one named collection per prefab.
    export = bpy.data.collections.get("EXPORT")
    bpy.context.scene.collection.children.unlink(export)
    bpy.data.collections.remove(export)
    # The deck top was the brightest surface in the game at (0.28, 0.34, 0.38), which
    # put the play surface above everything the player actually needs to read. The
    # interface this look is drawn from is flat saturated colour over near-black, so the
    # architecture goes dark and the emissive trim carries the brightness.
    concrete = material("roof_ceramic", (0.09, 0.115, 0.135, 1), 0.28, 0.62)
    deck = material("roof_deck", (0.03, 0.045, 0.06, 1), 0.74, 0.32)
    metal = material("roof_gunmetal", (0.025, 0.04, 0.055, 1), 0.9, 0.22)
    # Emissives sit on the Cyber-Dusk palette: #08f7ff, #ff2d55, #f4ec18.
    cyan = material("roof_cyan", (0.01, 0.25, 0.32, 1), 0.34, 0.2, (0.03, 0.97, 1.0, 1), 5)
    magenta = material("roof_magenta", (0.42, 0.015, 0.08, 1), 0.4, 0.23, (1.0, 0.176, 0.333, 1), 4.5)
    amber = material("roof_amber", (0.45, 0.42, 0.02, 1), 0.35, 0.24, (0.957, 0.925, 0.094, 1), 4.4)

    platform = new_export_collection("ROOFTOP_PLATFORM")
    box(platform, "platform_core", (4, 4, 0.34), (0, 0, -0.17), deck, 0.1)
    box(platform, "platform_top", (3.92, 3.92, 0.07), (0, 0, 0.035), concrete, 0.025)
    for index in range(5):
        box(platform, f"platform_rib_{index}", (3.2, 0.1, 0.22), (0, -1.6 + index * 0.8, -0.38), metal, 0.025)
    for side in (-1, 1):
        box(platform, f"platform_signal_{side}", (2.7, 0.055, 0.055), (0, side * 2.02, -0.14), cyan if side > 0 else magenta, 0.015)

    wall = new_export_collection("WALLRUN_PANEL")
    box(wall, "wall_core", (4, 0.24, 2.8), (0, 0, 1.4), concrete, 0.1)
    for row in range(2):
        for column in range(4):
            box(wall, f"wall_panel_{row}_{column}", (0.78, 0.08, 1.02), (-1.5 + column, -0.17, 0.72 + row * 1.25), deck, 0.045)
    box(wall, "wallrun_signal", (3.35, 0.055, 0.09), (0, -0.24, 1.5), cyan, 0.025)

    barrier = new_export_collection("VAULT_BARRIER")
    box(barrier, "barrier_body", (2.4, 0.5, 1.05), (0, 0, 0.525), concrete, 0.11)
    for side in (-1, 1):
        box(barrier, f"barrier_frame_{side}", (0.12, 0.62, 0.95), (side * 1.06, 0, 0.5), metal, 0.035)
    box(barrier, "barrier_chevron_l", (0.72, 0.055, 0.09), (-0.31, -0.29, 0.57), magenta, 0.02, (0, -0.45, 0))
    box(barrier, "barrier_chevron_r", (0.72, 0.055, 0.09), (0.31, -0.29, 0.57), magenta, 0.02, (0, 0.45, 0))

    anchor = new_export_collection("GRAPPLE_ANCHOR")
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=0.38)
    core = move_to(bpy.context.object, anchor)
    core.name = "anchor_core"
    assign(core, metal)
    torus(anchor, "anchor_ring_xy", 0.58, 0.065, mat=cyan)
    torus(anchor, "anchor_ring_xz", 0.58, 0.065, rotation=(math.pi / 2, 0, 0), mat=magenta)
    socket(anchor, "socket_grapple", (0, 0, 0))

    sign = new_export_collection("ROUTE_SIGN")
    box(sign, "sign_housing", (2.8, 0.12, 0.82), (0, 0, 0.42), metal, 0.065)
    box(sign, "sign_display", (2.48, 0.04, 0.58), (0, -0.08, 0.43), deck, 0.035)
    box(sign, "sign_signal", (1.8, 0.025, 0.075), (-0.12, -0.11, 0.47), amber, 0.02)
    box(sign, "sign_arrow", (0.45, 0.025, 0.22), (0.87, -0.11, 0.42), cyan, 0.025, (0, -0.48, 0))
    for collection in [platform, wall, barrier, anchor, sign]:
        collapse_by_material(collection, None, collection.name.lower())
    save(SOURCE / "environment" / "rooftop-kit.blend")


def main() -> None:
    if bpy.app.version[:2] != (4, 5):
        raise RuntimeError(f"Expected Blender 4.5.x, got {bpy.app.version_string}")
    build_viewmodel()
    build_hunter(False)
    build_hunter(True)
    build_environment()
    print("Flow State vertical-slice sources generated successfully.")


if __name__ == "__main__":
    main()
