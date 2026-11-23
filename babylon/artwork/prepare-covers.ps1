# Готовит три обложки Playgama из ассетов babylon/artwork:
#   square    800x800  <- icon.png (512x512, bicubic upscale)
#   landscape 1920x1080 <- cover-wide.png (800x470, scale-to-fill + crop)
#   portrait 1080x1920 <- cover-portrait.png (композит, скрипт портрета ниже)
Add-Type -AssemblyName System.Drawing
$root = 'C:\Users\victor\Desktop\Projects\games\digital_game\babylon\artwork'

function Save-JpegPng($bmp, $path) {
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Resize-Image($srcPath, $outPath, $outW, $outH) {
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $bmp = New-Object System.Drawing.Bitmap($outW, $outH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $outW, $outH)
  $g.Dispose()
  Save-JpegPng $bmp $outPath
  $bmp.Dispose()
  $src.Dispose()
}

function Cover-Crop($srcPath, $outPath, $outW, $outH) {
  # scale-to-fill: масштабируем так, чтобы закрыть обе стороны, затем центр-кроп
  $src = [System.Drawing.Image]::FromFile($srcPath)
  $scale = [Math]::Max($outW / $src.Width, $outH / $src.Height)
  $scaledW = [int][Math]::Ceiling($src.Width * $scale)
  $scaledH = [int][Math]::Ceiling($src.Height * $scale)
  $bmp = New-Object System.Drawing.Bitmap($outW, $outH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $x = [int](($outW - $scaledW) / 2)
  $y = [int](($outH - $scaledH) / 2)
  $dstRect = New-Object System.Drawing.Rectangle($x, $y, $scaledW, $scaledH)
  $g.DrawImage($src, $dstRect)
  $g.Dispose()
  Save-JpegPng $bmp $outPath
  $bmp.Dispose()
  $src.Dispose()
}

Resize-Image "$root\icon.png" "$root\cover-square.png" 800 800
Cover-Crop "$root\cover-wide.png" "$root\cover-landscape.png" 1920 1080

foreach ($f in @('cover-square.png','cover-landscape.png')) {
  $img = [System.Drawing.Image]::FromFile("$root\$f")
  Write-Output ("{0}: {1}x{2}" -f $f, $img.Width, $img.Height)
  $img.Dispose()
}
