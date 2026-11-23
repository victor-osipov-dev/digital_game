# Собирает antiskleroz-playgama.zip из dist-playgama (index.html в корне архива).
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$zipPath = 'C:\Users\victor\Desktop\Projects\games\digital_game\antiskleroz-playgama.zip'
if (Test-Path $zipPath) { Remove-Item $zipPath }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
$dist = 'C:\Users\victor\Desktop\Projects\games\digital_game\babylon\dist-playgama'
Get-ChildItem $dist -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($dist.Length + 1).Replace('\', '/')
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel) | Out-Null
}
$zip.Dispose()
Write-Output ('zip size: ' + (Get-Item $zipPath).Length)
