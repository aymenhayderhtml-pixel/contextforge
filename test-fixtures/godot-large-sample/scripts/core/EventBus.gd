extends Node

signal custom_event(name: String, payload: Dictionary)

func emit_event(event_name: String, data: Dictionary) -> void:
	custom_event.emit(event_name, data)
