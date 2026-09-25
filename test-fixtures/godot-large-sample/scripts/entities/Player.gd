extends CharacterBody2D

signal health_changed(new_hp: int)
signal died()

@export var move_speed: float = 200.0
@export var max_health: int = 100

func take_damage(amount: int) -> void:
	AudioManager.play_sfx("hit")
	health_changed.emit(max_health - amount)

func die() -> void:
	AudioManager.play_sfx("player_death")
	GameManager.add_score(0)
	died.emit()
