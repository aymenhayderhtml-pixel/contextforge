extends Control

func restart() -> void:
	GameManager.add_score(0)
	AudioManager.play_sfx("restart")
