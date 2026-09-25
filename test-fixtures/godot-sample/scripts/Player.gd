extends CharacterBody2D

## Player script — attached to Player.tscn root node.

signal died()
signal health_changed(new_value: int)

@export var speed: float = 200.0
@export var jump_force: float = 400.0

var health: int = 100

func take_damage(amount: int) -> void:
	health -= amount
	health_changed.emit(health)
	if health <= 0:
		died.emit()
		GameManager.add_score(-100)

func get_health() -> int:
	return health

func _process(delta: float) -> void:
	# private — should NOT appear in contract
	pass

func _physics_process(delta: float) -> void:
	# private — should NOT appear in contract
	pass
