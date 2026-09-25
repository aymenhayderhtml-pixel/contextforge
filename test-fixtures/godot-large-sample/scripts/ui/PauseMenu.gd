extends Control

func toggle_pause() -> void:
	GameManager.pause_game()

func on_resume_pressed() -> void:
	GameManager.resume_game()
