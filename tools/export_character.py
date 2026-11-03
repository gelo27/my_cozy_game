"""Exports the Roblox-style character from roblox_animation.blend to a game GLB.
Drops the parkour scene (city, cameras, PK_Rig, PK_Parkour action) and the tool preview meshes.
The source .blend is never saved."""
import bpy, sys

out_path = sys.argv[sys.argv.index('--') + 1]
CHARACTER = 'Armature.003'
DROP_OBJECTS = {'Axe_preview', 'Bat_preview', 'Pickaxe_preview', 'Tree_preview'}

# 1. Remove the parkour scene with everything only it uses
main = bpy.data.scenes['Scene']
parkour = bpy.data.scenes.get('Parkour')
if parkour:
    for obj in list(parkour.objects):
        if obj.name not in main.objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.data.scenes.remove(parkour)
for name in DROP_OBJECTS:
    if name in bpy.data.objects:
        bpy.data.objects.remove(bpy.data.objects[name], do_unlink=True)

# 2. Remove parkour / camera / empty actions; keep only character clips
for act in list(bpy.data.actions):
    if act.name.startswith('PK_') or act.name == 'Pass' or len(act.fcurves) == 0:
        bpy.data.actions.remove(act)

arm = bpy.data.objects[CHARACTER]
if arm.animation_data:
    for track in list(arm.animation_data.nla_tracks):
        arm.animation_data.nla_tracks.remove(track)
    arm.animation_data.action = bpy.data.actions['IDLE']

print('KEEP ACTIONS', sorted(a.name for a in bpy.data.actions))

# 3. Shrink the 2048px texture; the character is small on screen
for img in bpy.data.images:
    if img.source == 'FILE' and img.size[0] > 1024:
        img.scale(1024, 1024)

# 4. Select the character hierarchy only, in the main scene's view layer
view_layer = main.view_layers[0]
for o in main.objects:
    o.select_set(False, view_layer=view_layer)
def select_tree(o):
    # The armature is hidden (eye icon) in the source file, and hidden objects cannot be selected
    o.hide_set(False, view_layer=view_layer)
    o.select_set(True, view_layer=view_layer)
    for c in o.children:
        select_tree(c)
select_tree(arm)
print('SELECTED', sorted(o.name for o in main.objects if o.select_get(view_layer=view_layer)))

with bpy.context.temp_override(window=bpy.context.window, scene=main, view_layer=view_layer):
  bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format='GLB',
    use_selection=True,
    export_yup=True,
    export_apply=True,
    export_animations=True,
    export_animation_mode='ACTIONS',
    export_anim_slide_to_zero=True,
    export_force_sampling=True,
    export_optimize_animation_size=True,
    export_cameras=False,
    export_lights=False,
    export_image_format='JPEG',
  )
print('EXPORTED', out_path)
