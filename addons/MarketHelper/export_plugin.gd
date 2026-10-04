@tool
extends EditorPlugin

## Упаковка MarketHelper в Android-экспорт: отдаём AAR-библиотеки
## (собираются Gradle из addons/MarketHelper/plugin в bin/).

var export_plugin: AndroidExportPlugin


func _enter_tree() -> void:
	export_plugin = AndroidExportPlugin.new()
	add_export_plugin(export_plugin)


func _exit_tree() -> void:
	remove_export_plugin(export_plugin)
	export_plugin = null


class AndroidExportPlugin extends EditorExportPlugin:
	var _plugin_name := "MarketHelper"

	func _supports_platform(_platform) -> bool:
		if _platform is EditorExportPlatformAndroid:
			return true
		return false

	func _get_android_libraries(_platform: Object, debug: bool) -> PackedStringArray:
		if debug:
			return PackedStringArray(["MarketHelper/bin/markethelper-debug.aar"])
		return PackedStringArray(["MarketHelper/bin/markethelper-release.aar"])

	func _get_name() -> String:
		return _plugin_name
