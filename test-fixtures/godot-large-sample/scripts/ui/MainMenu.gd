extends Control

func _ready() -> void:
	AudioManager.play_music("title_theme")

func start_game() -> void:
	GameManager.add_score(0)

func quit_game() -> void:
	pass
