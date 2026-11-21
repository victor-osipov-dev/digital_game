class_name Session
extends RefCounted
const Lang := preload("res://scripts/core/lang.gd")

# Сохранённая сессия: токен, под которым сервер узнаёт нас без пароля.
#
# Отдельным файлом от настроек игры намеренно: настройки — это то, что
# игрок крутит в меню, а токен — секрет. Смешав их в одном файле, мы
# заставили бы игрока вручную вычищать секрет из бэкапа, который он шлёт
# при обращении в поддержку.
#
# Токен подписан общим секретом кластера, и его принимает ЛЮБОЙ сервер
# кластера, а не только тот, что его выдал. Именно это и нужно: аккаунт
# заводится на одном сервере, а играть можно на любом.

const PATH := "user://session.json"

var token: String = ""
var login: String = ""
var nick: String = ""

## Пароль в том же файле, что и токен, а не в настройках игры: иначе
## он уехал бы в бэкап, который игрок шлёт в поддержку. Держим его
## открытым текстом — файл и так уже лежит в приватном каталоге
## приложения, и отдельное шифрование ключом, лежащим рядом, ровно
## ничего бы не дало.
var password: String = ""

var _loaded := false


static func load_from_disk() -> Session:
	var out := Session.new()
	out._loaded = true
	if not FileAccess.file_exists(PATH):
		return out
	var text := FileAccess.get_file_as_string(PATH)
	if text.strip_edges().is_empty():
		return out
	var parsed = JSON.parse_string(text)
	if not (parsed is Dictionary):
		return out
	var d: Dictionary = parsed
	out.token = String(d.get("token", ""))
	out.login = String(d.get("login", ""))
	out.nick = String(d.get("nick", ""))
	out.password = String(d.get("password", ""))
	return out

func is_valid() -> bool:
	return not token.is_empty()

func clear() -> void:
	token = ""
	login = ""
	nick = ""
	password = ""
	save()

func save() -> void:
	# Пустую сессию стираем, а не храним: зачем держать на диске файл,
	# из которого ничего не прочитать. Вход не прошёл — токена нет, но
	# пароль и логин остаются: иначе игрок вводил бы их заново после
	# каждой неудачной попытки.
	if token.is_empty() and login.is_empty() and password.is_empty():
		if FileAccess.file_exists(PATH):
			DirAccess.remove_absolute(PATH)
		return
	var tmp := PATH + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		push_warning(Lang.t("не удалось записать сессию: %s") % error_string(FileAccess.get_open_error()))
		return
	f.store_string(JSON.stringify({
		"token": token,
		"login": login,
		"nick": nick,
		"password": password,
	}, "  "))
	f.close()
	var err := DirAccess.rename_absolute(tmp, PATH)
	if err != OK:
		DirAccess.remove_absolute(PATH)
		err = DirAccess.rename_absolute(tmp, PATH)
		if err != OK:
			push_warning(Lang.t("не удалось сохранить сессию: %s") % error_string(err))
