extends Node

signal game_paused(is_paused: bool)
signal score_updated(new_score: int)

@export var current_score: int = 0
@export var high_score: int = 1000

func add_score(amount: int) -> void:
	current_score += amount
	score_updated.emit(current_score)

func pause_game() -> void:
	game_paused.emit(true)

func resume_game() -> void:
	game_paused.emit(false)
