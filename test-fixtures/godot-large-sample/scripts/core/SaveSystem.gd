extends Node

@export var save_slot: int = 1

func save_game(data: Dictionary) -> bool:
	return true

func load_game() -> Dictionary:
	return {}
