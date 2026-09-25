extends CanvasLayer

@export var show_fps: bool = true

func _ready() -> void:
	GameManager.score_updated.connect(_on_score_updated)

func _on_score_updated(new_score: int) -> void:
	update_display(new_score)

func update_display(score: int) -> void:
	pass
