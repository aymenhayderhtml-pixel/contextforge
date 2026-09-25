/**
 * create-godot-large.js — Generates the ~30-node medium-scale Godot fixture (T032).
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const fixtureDir = join(__dirname, 'godot-large-sample');

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

ensureDir(fixtureDir);
ensureDir(join(fixtureDir, 'scenes', 'ui'));
ensureDir(join(fixtureDir, 'scenes', 'entities'));
ensureDir(join(fixtureDir, 'scenes', 'levels'));
ensureDir(join(fixtureDir, 'scripts', 'core'));
ensureDir(join(fixtureDir, 'scripts', 'ui'));
ensureDir(join(fixtureDir, 'scripts', 'entities'));
ensureDir(join(fixtureDir, 'scripts', 'utils'));
ensureDir(join(fixtureDir, 'scripts', 'tests'));
ensureDir(join(fixtureDir, 'assets', 'sprites'));

// 1. project.godot
writeFileSync(join(fixtureDir, 'project.godot'), `; Engine configuration file for godot-large-sample (T032)
config_version=5

[application]
config/name="GodotLargeSample"
config/features=PackedStringArray("4.2")
run/main_scene="res://scenes/levels/Level1.tscn"

[autoload]
GameManager="*res://scripts/core/GameManager.gd"
AudioManager="*res://scripts/core/AudioManager.gd"
`);

// 2. scripts/core
writeFileSync(join(fixtureDir, 'scripts', 'core', 'GameManager.gd'), `extends Node

signal game_paused(is_paused: bool)
signal score_updated(new_score: int)

@export var current_score: int = 0
@export var high_score: int = 1000

func add_score(amount: int) -> void:
\tcurrent_score += amount
\tscore_updated.emit(current_score)

func pause_game() -> void:
\tgame_paused.emit(true)

func resume_game() -> void:
\tgame_paused.emit(false)
`);

writeFileSync(join(fixtureDir, 'scripts', 'core', 'AudioManager.gd'), `extends Node

@export var master_volume: float = 1.0
@export var music_volume: float = 0.8
@export var sfx_volume: float = 0.9

func play_sfx(sound_name: String) -> void:
\tpass

func play_music(track_name: String) -> void:
\tpass

func stop_music() -> void:
\tpass
`);

writeFileSync(join(fixtureDir, 'scripts', 'core', 'SaveSystem.gd'), `extends Node

@export var save_slot: int = 1

func save_game(data: Dictionary) -> bool:
\treturn true

func load_game() -> Dictionary:
\treturn {}
`);

writeFileSync(join(fixtureDir, 'scripts', 'core', 'EventBus.gd'), `extends Node

signal custom_event(name: String, payload: Dictionary)

func emit_event(event_name: String, data: Dictionary) -> void:
\tcustom_event.emit(event_name, data)
`);

// 3. scripts/ui
writeFileSync(join(fixtureDir, 'scripts', 'ui', 'MainMenu.gd'), `extends Control

func _ready() -> void:
\tAudioManager.play_music("title_theme")

func start_game() -> void:
\tGameManager.add_score(0)

func quit_game() -> void:
\tpass
`);

writeFileSync(join(fixtureDir, 'scripts', 'ui', 'HUD.gd'), `extends CanvasLayer

@export var show_fps: bool = true

func _ready() -> void:
\tGameManager.score_updated.connect(_on_score_updated)

func _on_score_updated(new_score: int) -> void:
\tupdate_display(new_score)

func update_display(score: int) -> void:
\tpass
`);

writeFileSync(join(fixtureDir, 'scripts', 'ui', 'PauseMenu.gd'), `extends Control

func toggle_pause() -> void:
\tGameManager.pause_game()

func on_resume_pressed() -> void:
\tGameManager.resume_game()
`);

writeFileSync(join(fixtureDir, 'scripts', 'ui', 'GameOver.gd'), `extends Control

func restart() -> void:
\tGameManager.add_score(0)
\tAudioManager.play_sfx("restart")
`);

// 4. scripts/entities
writeFileSync(join(fixtureDir, 'scripts', 'entities', 'Player.gd'), `extends CharacterBody2D

signal health_changed(new_hp: int)
signal died()

@export var move_speed: float = 200.0
@export var max_health: int = 100

func take_damage(amount: int) -> void:
\tAudioManager.play_sfx("hit")
\thealth_changed.emit(max_health - amount)

func die() -> void:
\tAudioManager.play_sfx("player_death")
\tGameManager.add_score(0)
\tdied.emit()
`);

writeFileSync(join(fixtureDir, 'scripts', 'entities', 'Enemy.gd'), `extends CharacterBody2D

signal defeated(points: int)

@export var patrol_speed: float = 80.0
@export var attack_damage: int = 15

func take_hit(amount: int) -> void:
\tAudioManager.play_sfx("enemy_hit")
\tdefeated.emit(100)
`);

writeFileSync(join(fixtureDir, 'scripts', 'entities', 'Boss.gd'), `extends CharacterBody2D

signal boss_defeated()

@export var boss_name: String = "Dragon"
@export var phase: int = 1

func rage_mode() -> void:
\tAudioManager.play_music("boss_phase2")

func defeat_boss() -> void:
\tGameManager.add_score(5000)
\tboss_defeated.emit()
`);

writeFileSync(join(fixtureDir, 'scripts', 'entities', 'NPC.gd'), `extends Area2D

@export var npc_name: String = "Elder"

func interact() -> void:
\tpass
`);

// 5. scripts/utils (Orphaned utility files)
writeFileSync(join(fixtureDir, 'scripts', 'utils', 'MathHelpers.gd'), `class_name MathHelpers

static func clamp_wrap(value: float, min_val: float, max_val: float) -> float:
\treturn value

static func smooth_step(from_val: float, to_val: float, weight: float) -> float:
\treturn from_val
`);

writeFileSync(join(fixtureDir, 'scripts', 'utils', 'ColorUtils.gd'), `class_name ColorUtils

static func hex_to_rgb(hex: String) -> Color:
\treturn Color.WHITE

static func invert_color(col: Color) -> Color:
\treturn Color.BLACK
`);

writeFileSync(join(fixtureDir, 'scripts', 'utils', 'DebugLogger.gd'), `class_name DebugLogger

static func log_info(msg: String) -> void:
\tprint("[INFO] " + msg)

static func log_error(msg: String) -> void:
\tprinterr("[ERROR] " + msg)
`);

writeFileSync(join(fixtureDir, 'scripts', 'utils', 'PathfindingHelpers.gd'), `class_name PathfindingHelpers

static func find_nearest_node(from_pos: Vector2, candidate_nodes: Array) -> Node2D:
\treturn null
`);

writeFileSync(join(fixtureDir, 'scripts', 'utils', 'Formatters.gd'), `class_name Formatters

static func format_currency(amount: int) -> String:
\treturn "$" + str(amount)

static func format_time(seconds: float) -> String:
\treturn "00:00"
`);

writeFileSync(join(fixtureDir, 'scripts', 'utils', 'RandomGen.gd'), `class_name RandomGen

static func roll_dice(sides: int) -> int:
\treturn 1

static func pick_random(items: Array) -> Variant:
\treturn null
`);

// 6. scripts/tests (Orphaned test files)
writeFileSync(join(fixtureDir, 'scripts', 'tests', 'TestCombat.gd'), `class_name TestCombat

static func run_tests() -> bool:
\treturn true
`);

writeFileSync(join(fixtureDir, 'scripts', 'tests', 'TestMovement.gd'), `class_name TestMovement

static func run_tests() -> bool:
\treturn true
`);

writeFileSync(join(fixtureDir, 'scripts', 'tests', 'TestInventory.gd'), `class_name TestInventory

static func run_tests() -> bool:
\treturn true
`);

// 7. Dummy PNG icon
// Minimal 1x1 PNG
const pngBuffer = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
writeFileSync(join(fixtureDir, 'assets', 'sprites', 'icon.png'), pngBuffer);

// 8. scenes/ui
writeFileSync(join(fixtureDir, 'scenes', 'ui', 'MainMenu.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/ui/MainMenu.gd" id="1_menu"]

[node name="MainMenu" type="Control"]
script = ExtResource("1_menu")
`);

writeFileSync(join(fixtureDir, 'scenes', 'ui', 'HUD.tscn'), `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/ui/HUD.gd" id="1_hud"]
[ext_resource type="Texture2D" path="res://assets/sprites/icon.png" id="2_icon"]

[node name="HUD" type="CanvasLayer"]
script = ExtResource("1_hud")
`);

writeFileSync(join(fixtureDir, 'scenes', 'ui', 'PauseMenu.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/ui/PauseMenu.gd" id="1_pause"]

[node name="PauseMenu" type="Control"]
script = ExtResource("1_pause")
`);

writeFileSync(join(fixtureDir, 'scenes', 'ui', 'GameOver.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/ui/GameOver.gd" id="1_gameover"]

[node name="GameOver" type="Control"]
script = ExtResource("1_gameover")
`);

// 9. scenes/entities
writeFileSync(join(fixtureDir, 'scenes', 'entities', 'Player.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/entities/Player.gd" id="1_player"]

[node name="Player" type="CharacterBody2D"]
script = ExtResource("1_player")
`);

writeFileSync(join(fixtureDir, 'scenes', 'entities', 'Enemy.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/entities/Enemy.gd" id="1_enemy"]

[node name="Enemy" type="CharacterBody2D"]
script = ExtResource("1_enemy")
`);

writeFileSync(join(fixtureDir, 'scenes', 'entities', 'Boss.tscn'), `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/entities/Boss.gd" id="1_boss"]
[ext_resource type="PackedScene" path="res://scenes/entities/Enemy.tscn" id="2_minion"]

[node name="Boss" type="CharacterBody2D"]
script = ExtResource("1_boss")

[node name="Minion" parent="." instance=ExtResource("2_minion")]
`);

writeFileSync(join(fixtureDir, 'scenes', 'entities', 'NPC.tscn'), `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/entities/NPC.gd" id="1_npc"]

[node name="NPC" type="Area2D"]
script = ExtResource("1_npc")
`);

// 10. scenes/levels
writeFileSync(join(fixtureDir, 'scenes', 'levels', 'Level1.tscn'), `[gd_scene load_steps=4 format=3]

[ext_resource type="PackedScene" path="res://scenes/entities/Player.tscn" id="1_player"]
[ext_resource type="PackedScene" path="res://scenes/entities/Enemy.tscn" id="2_enemy"]
[ext_resource type="PackedScene" path="res://scenes/ui/HUD.tscn" id="3_hud"]

[node name="Level1" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1_player")]
[node name="Enemy" parent="." instance=ExtResource("2_enemy")]
[node name="HUD" parent="." instance=ExtResource("3_hud")]

[connection signal="died" from="Player" to="." method="_on_player_died"]
[connection signal="defeated" from="Enemy" to="." method="_on_enemy_defeated"]
`);

writeFileSync(join(fixtureDir, 'scenes', 'levels', 'Level2.tscn'), `[gd_scene load_steps=4 format=3]

[ext_resource type="PackedScene" path="res://scenes/entities/Player.tscn" id="1_player"]
[ext_resource type="PackedScene" path="res://scenes/entities/Boss.tscn" id="2_boss"]
[ext_resource type="PackedScene" path="res://scenes/ui/HUD.tscn" id="3_hud"]

[node name="Level2" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1_player")]
[node name="Boss" parent="." instance=ExtResource("2_boss")]
[node name="HUD" parent="." instance=ExtResource("3_hud")]

[connection signal="died" from="Player" to="." method="_on_player_died"]
[connection signal="boss_defeated" from="Boss" to="." method="_on_boss_defeated"]
`);

writeFileSync(join(fixtureDir, 'scenes', 'levels', 'Arena.tscn'), `[gd_scene load_steps=3 format=3]

[ext_resource type="PackedScene" path="res://scenes/entities/Player.tscn" id="1_player"]
[ext_resource type="PackedScene" path="res://scenes/entities/Enemy.tscn" id="2_enemy"]

[node name="Arena" type="Node2D"]

[node name="Player" parent="." instance=ExtResource("1_player")]
[node name="Enemy" parent="." instance=ExtResource("2_enemy")]
`);

console.log('✓ Successfully created godot-large-sample fixture at:', fixtureDir);
