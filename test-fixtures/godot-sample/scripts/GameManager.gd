extends Node

## Singleton autoload — manages game state.

var score: int = 0
var is_game_over: bool = false

func add_score(points: int) -> void:
	score += points

func reset() -> void:
	score = 0
	is_game_over = false
