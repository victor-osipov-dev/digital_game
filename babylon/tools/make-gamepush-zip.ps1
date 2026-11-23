# Архив GamePush для загрузки в панель проекта: index.html в корне.
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zipPath = 'C:\Users\victor\Desktop\Projects\games\digital_game\antiskleroz-gamepush.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
$dist = 'C:\Users\victor\Desktop\Projects\games\digital_game\babylon\dist-gamepush'
Get-ChildItem $dist -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($dist.Length + 1).Replace('\', '/')
  # Конфиг Playgama Bridge не нужен в GamePush-архиве (лежит в public/).
  if ($rel -eq 'playgama-bridge-config.json') { return }
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
}
$zip.Dispose()
Write-Output ('zip size: ' + (Get-Item $zipPath).Length)
