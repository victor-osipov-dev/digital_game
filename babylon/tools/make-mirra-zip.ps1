# Архив сборки для Mirra Games: index.html в корне dist-mirra.
# Внутри — MirraWeb SDK (mirra-sdk.js) и его настройки (mirra-config.js).
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zipPath = 'C:\Users\victor\Desktop\Projects\games\digital_game\antiskleroz-mirra.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
$dist = 'C:\Users\victor\Desktop\Projects\games\digital_game\babylon\dist-mirra'
Get-ChildItem $dist -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($dist.Length + 1).Replace('\', '/')
  # Конфиг Playgama Bridge не нужен Mirra-сборке (лежит в public/).
  if ($rel -eq 'playgama-bridge-config.json') { return }
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
}
$zip.Dispose()
Write-Output ('zip size: ' + (Get-Item $zipPath).Length)
