extends CharacterBody2D

signal defeated(points: int)

@export var patrol_speed: float = 80.0
@export var attack_damage: int = 15

func take_hit(amount: int) -> void:
	AudioManager.play_sfx("enemy_hit")
	defeated.emit(100)
