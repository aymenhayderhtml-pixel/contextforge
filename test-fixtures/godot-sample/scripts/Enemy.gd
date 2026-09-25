extends CharacterBody2D

## Enemy script — attached to Enemy.tscn root node.

signal defeated()

@export var patrol_speed: float = 80.0

func take_hit() -> void:
	defeated.emit()
	queue_free()
