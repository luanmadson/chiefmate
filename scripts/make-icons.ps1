# Draws Chiefmate's icons (a brass anchor on a dark background): the app's PNGs and the shortcut's .ico.
# Runs in Windows PowerShell (it uses System.Drawing). Usage: powershell -File scripts\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$folder = Join-Path $root 'ui'

function Draw-Anchor([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::FromArgb(255, 14, 17, 21))
  $s = $size / 64.0
  $frame = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 46, 53, 65)), ([Math]::Max(1, 1.5 * $s))
  $g.DrawRectangle($frame, 0.5 * $s, 0.5 * $s, $size - 1.5 * $s, $size - 1.5 * $s)
  $brass = [System.Drawing.Color]::FromArgb(255, 201, 164, 93)
  $pen = New-Object System.Drawing.Pen $brass, ([Math]::Max(1.2, 4.2 * $s))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Square
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Square
  $g.DrawEllipse($pen, 27 * $s, 9 * $s, 10 * $s, 10 * $s)        # ring
  $g.DrawLine($pen, 32 * $s, 19 * $s, 32 * $s, 53 * $s)          # shank
  $g.DrawLine($pen, 22 * $s, 26 * $s, 42 * $s, 26 * $s)          # stock
  $g.DrawArc($pen, 15 * $s, 22 * $s, 34 * $s, 32 * $s, 20, 140)  # arms
  $g.DrawLine($pen, 15.5 * $s, 40 * $s, 12 * $s, 34 * $s)        # left fluke
  $g.DrawLine($pen, 48.5 * $s, 40 * $s, 52 * $s, 34 * $s)        # right fluke
  $g.Dispose()
  return $bmp
}

function Save-Png([int]$size, [string]$file) {
  $bmp = Draw-Anchor $size
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

Save-Png 32 (Join-Path $folder 'icon-32.png')
Save-Png 192 (Join-Path $folder 'icon-192.png')
Save-Png 512 (Join-Path $folder 'icon-512.png')

# An .ico with PNGs inside (16, 32, 48 and 256 px), which Windows accepts since Vista.
$sizes = 16, 32, 48, 256
$images = foreach ($size in $sizes) {
  $bmp = Draw-Anchor $size
  $stream = New-Object System.IO.MemoryStream
  $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  , $stream.ToArray()
}
$output = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $output
$w.Write([UInt16]0); $w.Write([UInt16]1); $w.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $side = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
  $w.Write([byte]$side); $w.Write([byte]$side); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([UInt16]1); $w.Write([UInt16]32)
  $w.Write([UInt32]$images[$i].Length); $w.Write([UInt32]$offset)
  $offset += $images[$i].Length
}
foreach ($image in $images) { $w.Write($image) }
$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $folder 'chiefmate.ico'), $output.ToArray())
Write-Host 'Icons written to ui\'
