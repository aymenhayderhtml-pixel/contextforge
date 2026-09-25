extends CharacterBody2D

signal boss_defeated()

@export var boss_name: String = "Dragon"
@export var phase: int = 1

func rage_mode() -> void:
	AudioManager.play_music("boss_phase2")

func defeat_boss() -> void:
	GameManager.add_score(5000)
	boss_defeated.emit()
