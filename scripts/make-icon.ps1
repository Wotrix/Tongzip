# TongZip 图标生成:按 Logo 几何绘制多尺寸 PNG + 组装 ICO
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
if (-not (Test-Path $buildDir)) { New-Item -ItemType Directory -Path $buildDir | Out-Null }

function Draw-Raster([int]$px) {
  $bmp = New-Object System.Drawing.Bitmap($px, $px, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $script:g = [System.Drawing.Graphics]::FromImage($bmp)
  $g = $script:g
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $jade  = [System.Drawing.Color]::FromArgb(255, 23, 121, 88)
  $bg    = [System.Drawing.Color]::FromArgb(255, 247, 248, 249)
  $line  = [System.Drawing.Color]::FromArgb(255, 221, 225, 229)
  $rs = [double]($px * 0.1875)
  $rect = New-Object System.Drawing.RectangleF(0.5, 0.5, ($px - 1.0), ($px - 1.0))
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $rs * 2
  $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
  $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
  $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($bg)
  $g.FillPath($brush, $path)
  $penBg = New-Object System.Drawing.Pen($line, [Math]::Max(1.0, $px * 0.008))
  $g.DrawPath($penBg, $path)

  function RR([single]$x, [single]$y, [single]$w, [single]$h) {
    $r = [Math]::Min($w, $h) * 0.5
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $p.AddArc($x, $y, $r * 2, $r * 2, 180, 90)
    $p.AddArc($x + $w - $r * 2, $y, $r * 2, $r * 2, 270, 90)
    $p.AddArc($x + $w - $r * 2, $y + $h - $r * 2, $r * 2, $r * 2, 0, 90)
    $p.AddArc($x, $y + $h - $r * 2, $r * 2, $r * 2, 90, 90)
    $p.CloseFigure()
    $b = New-Object System.Drawing.SolidBrush($jade)
    $script:g.FillPath($b, $p)
    $b.Dispose(); $p.Dispose()
  }

  $stroke = [single]($px * 0.062)
  $cx = $px / 2.0
  $gap = $px * 0.13
  $x1 = $cx - $gap - $stroke / 2
  $x2 = $cx + $gap - $stroke / 2
  $yTop = $px * 0.18
  $yBot = $px * 0.82
  RR ([single]$x1) ([single]$yTop) ([single]$stroke) ([single]($yBot - $yTop))
  RR ([single]$x2) ([single]$yTop) ([single]$stroke) ([single]($yBot - $yTop))
  # 三道横梁由宽到窄 —— 传达「被收紧/压缩」的语义
  $hy = [single]($stroke * 0.46)
  $full = ($x2 + $stroke) - $x1
  foreach ($i in 0..2) {
    $w = [single]($full * (0.92 - 0.17 * $i))
    $x = [single]($cx - $w / 2.0)
    $y = [single]($px * (0.36 + 0.14 * $i) - $hy / 2)
    RR $x $y $w $hy
  }

  $g.Dispose()
  return $bmp
}

# 1) build/icon.png (256px,dev 窗口图标)
$big = Draw-Raster 256
$pngPath = Join-Path $buildDir 'icon.png'
$big.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# 2) 各尺寸 PNG 内存流
$sizes = 256, 128, 64, 48, 32, 16
$streams = foreach ($s in $sizes) {
  $bmp = Draw-Raster $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  $ms
}

# 3) 组装 ICO(PNG 负载,Vista+ 兼容)
$icoPath = Join-Path $buildDir 'icon.ico'
$fsOut = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fsOut)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $len = [uint32]$streams[$i].Length
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([byte]($(if ($s -ge 256) { 0 } else { $s })))
  $bw.Write([uint16]0); $bw.Write([uint16]0)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset)
  $offset += $len
}
foreach ($ms in $streams) { $bw.Write($ms.ToArray()); $ms.Dispose() }
$bw.Flush(); $bw.Close(); $fsOut.Dispose()

Write-Host "OK icon.png + icon.ico -> $icoPath"
Get-Item $pngPath, $icoPath | Select-Object Name, Length
