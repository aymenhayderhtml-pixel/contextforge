extends Node

@export var master_volume: float = 1.0
@export var music_volume: float = 0.8
@export var sfx_volume: float = 0.9

func play_sfx(sound_name: String) -> void:
	pass

func play_music(track_name: String) -> void:
	pass

func stop_music() -> void:
	pass
