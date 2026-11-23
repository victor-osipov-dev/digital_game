# Собирает cover-portrait.png 1080x1920 из artwork\cover-wide.png и artwork\icon.png.
# Фон — цвет верхней кромки обложки; стык растушёвывается; иконка обрезается
# по скруглённому прямоугольнику (у PNG углы залиты чёрным), под ней — название.
Add-Type -AssemblyName System.Drawing
$root = 'C:\Users\victor\Desktop\Projects\games\digital_game\babylon\artwork'
$out = "$root\cover-portrait.png"
$W = 1080; $H = 1920

$cover = [System.Drawing.Bitmap]::FromFile("$root\cover-wide.png")
$icon = [System.Drawing.Image]::FromFile("$root\icon.png")

$covW = $W
$covH = [int][Math]::Round($cover.Height * $W / $cover.Width)
$covY = $H - $covH

$topColor = $cover.GetPixel([int]($cover.Width / 2), 2)

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias

$g.Clear($topColor)

# Мягкое светлое пятно за иконкой
$iconSize = 640
$iconX = [int](($W - $iconSize) / 2)
$iconY = 210
$glowRect = New-Object System.Drawing.Rectangle(
  [int]($iconX - 120), [int]($iconY - 90), [int]($iconSize + 240), [int]($iconSize + 220))
$glowPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$glowPath.AddEllipse($glowRect)
$glowBrush = New-Object System.Drawing.Drawing2D.PathGradientBrush($glowPath)
$glowBrush.CenterColor = [System.Drawing.Color]::FromArgb(60, 255, 255, 255)
$glowBrush.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 255, 255))
$g.FillPath($glowBrush, $glowPath)
$glowBrush.Dispose()
$glowPath.Dispose()

# Иконка: клип по скруглённому квадрату, чтобы срезать чёрные углы
$radius = [int]($iconSize * 0.20)
$overscan = 8
$iconPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$iconPath.AddArc($iconX, $iconY, $radius * 2, $radius * 2, 180, 90)
$iconPath.AddArc($iconX + $iconSize - $radius * 2, $iconY, $radius * 2, $radius * 2, 270, 90)
$iconPath.AddArc($iconX + $iconSize - $radius * 2, $iconY + $iconSize - $radius * 2, $radius * 2, $radius * 2, 0, 90)
$iconPath.AddArc($iconX, $iconY + $iconSize - $radius * 2, $radius * 2, $radius * 2, 90, 90)
$iconPath.CloseFigure()
$g.SetClip($iconPath)
# Кроп исходника: убирает чёрную тень, залитую по периметру PNG иконки
$crop = [int]($icon.Width * 0.05)
$srcRect = New-Object System.Drawing.Rectangle($crop, $crop, ($icon.Width - ($crop * 2)), ($icon.Height - ($crop * 2)))
$destRect = New-Object System.Drawing.RectangleF(
  [float]($iconX - $overscan), [float]($iconY - $overscan),
  [float]($iconSize + $overscan * 2), [float]($iconSize + $overscan * 2))
$g.DrawImage($icon, $destRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.ResetClip()
$iconPath.Dispose()

# Название под иконкой
$font = New-Object System.Drawing.Font('Arial', 88, [System.Drawing.FontStyle]::Bold)
$cream = [System.Drawing.Color]::FromArgb(255, 242, 232, 207)
$shadow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 0, 20, 60))
$brush = New-Object System.Drawing.SolidBrush($cream)
$text = 'Anti-Sclerosis'
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$textY = $iconY + $iconSize + 40
$g.DrawString($text, $font, $shadow, [float]($W / 2 + 5), [float]($textY + 6), $fmt)
$g.DrawString($text, $font, $brush, [float]($W / 2), [float]$textY, $fmt)
$brush.Dispose()
$shadow.Dispose()
$font.Dispose()
$fmt.Dispose()

# Обложка внизу
$g.DrawImage($cover, 0, $covY, $covW, $covH)

# Растушёвка стыка: 140px градиента от фона к прозрачному поверх верха обложки
$feather = 140
$featherRect = New-Object System.Drawing.Rectangle(0, $covY, $W, $feather)
$featherBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  $featherRect,
  [System.Drawing.Color]::FromArgb(255, $topColor.R, $topColor.G, $topColor.B),
  [System.Drawing.Color]::FromArgb(0, $topColor.R, $topColor.G, $topColor.B),
  [float]90, [float]0)
$g.FillRectangle($featherBrush, $featherRect)
$featherBrush.Dispose()

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$cover.Dispose()
$icon.Dispose()

$chk = [System.Drawing.Image]::FromFile($out)
Write-Output ("cover-portrait.png: {0}x{1}" -f $chk.Width, $chk.Height)
$chk.Dispose()
