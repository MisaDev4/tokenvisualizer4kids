<#
.SYNOPSIS
    Puts an "Ideas" shortcut on the Desktop, pointing at Ideas.cmd in the repo root.

.DESCRIPTION
    Run once, by hand. It is idempotent: running it again just rewrites the same
    shortcut in place, so it is also the repair tool if the repo ever moves.

    It also draws ideas\Ideas.ico (a lightbulb on the app's own dark tile) using
    System.Drawing, which ships with Windows PowerShell -- no new dependencies,
    no packaging step. If drawing fails for any reason the shortcut falls back to
    Electron's own icon rather than failing outright.

.PARAMETER IconOnly
    Redraw the icon and stop. Touches no shortcut. Useful after editing the glyph.

.PARAMETER IconPath
    Where to write the .ico. Defaults to ideas\Ideas.ico next to this script.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\ideas\make-shortcut.ps1
#>
[CmdletBinding()]
param(
    [switch] $IconOnly,
    [string] $IconPath
)

$ErrorActionPreference = 'Stop'

$ideasDir = $PSScriptRoot
$root     = Split-Path $ideasDir -Parent
$launcher = Join-Path $root 'Ideas.cmd'
if (-not $IconPath) { $IconPath = Join-Path $ideasDir 'Ideas.ico' }

# --- the glyph ---------------------------------------------------------------
# Drawn once at 256 px and downsampled, so the shapes have to stay chunky: a
# filament or a hairline border is gone by the time Explorer asks for 16 px.
function New-IdeasBitmap {
    param([int] $S = 256)

    $bmp = New-Object System.Drawing.Bitmap($S, $S, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $k = $S / 256.0
    $u = { param($v) [float]($v * $k) }   # 256-space -> pixel

    # Rounded tile in the apps' page colour, so the icon reads as one of the family.
    $tile = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = & $u 52; $d = $r * 2; $m = & $u 6; $w = (& $u 256) - $m * 2
    $tile.AddArc($m, $m, $d, $d, 180, 90)
    $tile.AddArc($m + $w - $d, $m, $d, $d, 270, 90)
    $tile.AddArc($m + $w - $d, $m + $w - $d, $d, $d, 0, 90)
    $tile.AddArc($m, $m + $w - $d, $d, $d, 90, 90)
    $tile.CloseFigure()
    $tileBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 26, 26, 25))    # --card #1A1A19
    $g.FillPath($tileBrush, $tile)

    # The bulb: accent blue, big enough to survive a 16 px downsample.
    $bulb = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 57, 135, 229))       # --accent #3987E5
    $g.FillEllipse($bulb, (& $u 62), (& $u 44), (& $u 132), (& $u 132))
    # Neck: a wedge tying the glass to the base, or the two shapes read as a
    # circle and a brick once they get small.
    $neck = New-Object System.Drawing.Drawing2D.GraphicsPath
    $neck.AddPolygon(@(
        (New-Object System.Drawing.PointF((& $u 92),  (& $u 150))),
        (New-Object System.Drawing.PointF((& $u 164), (& $u 150))),
        (New-Object System.Drawing.PointF((& $u 152), (& $u 186))),
        (New-Object System.Drawing.PointF((& $u 104), (& $u 186)))))
    $g.FillPath($bulb, $neck)

    # Screw base in the muted ink, two bands with a gap the eye can still find.
    $base = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 195, 194, 183))      # --ink2 #C3C2B7
    $g.FillRectangle($base, (& $u 102), (& $u 190), (& $u 52), (& $u 22))
    $g.FillRectangle($base, (& $u 110), (& $u 218), (& $u 36), (& $u 18))

    $g.Dispose()
    foreach ($o in @($tile, $neck, $tileBrush, $bulb, $base)) { $o.Dispose() }
    return $bmp
}

# A 32-bit bottom-up DIB with the trailing AND mask -- the classic ICO payload.
# Every Windows icon consumer reads this; PNG entries are only safe at 256, so
# that is the only size that gets one.
function ConvertTo-IconDib {
    param([System.Drawing.Bitmap] $Bitmap)

    $w = $Bitmap.Width; $h = $Bitmap.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
    $data = $Bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                             [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $rows = New-Object 'byte[][]' $h
    try {
        for ($y = 0; $y -lt $h; $y++) {
            $row = New-Object byte[] ($w * 4)
            [System.Runtime.InteropServices.Marshal]::Copy(
                [IntPtr]($data.Scan0.ToInt64() + [int64]($y * $data.Stride)), $row, 0, $row.Length)
            $rows[$y] = $row
        }
    } finally { $Bitmap.UnlockBits($data) }

    $maskStride = [int][Math]::Ceiling($w / 32.0) * 4     # 1 bpp, rows padded to 4 bytes
    $ms = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter($ms)
    $bw.Write([UInt32] 40)                 # BITMAPINFOHEADER
    $bw.Write([Int32] $w)
    $bw.Write([Int32] ($h * 2))            # colour rows + mask rows, as the format demands
    $bw.Write([UInt16] 1)
    $bw.Write([UInt16] 32)
    $bw.Write([UInt32] 0)                  # BI_RGB
    $bw.Write([UInt32] ($w * $h * 4 + $h * $maskStride))
    $bw.Write([Int32] 0); $bw.Write([Int32] 0)
    $bw.Write([UInt32] 0); $bw.Write([UInt32] 0)
    for ($y = $h - 1; $y -ge 0; $y--) { $bw.Write($rows[$y]) }   # DIBs are bottom-up
    # The alpha channel carries the transparency; the AND mask stays clear.
    $bw.Write((New-Object byte[] ($h * $maskStride)))
    $bw.Flush()
    $out = $ms.ToArray()
    $bw.Dispose(); $ms.Dispose()
    return $out
}

# ICO container by hand: 6-byte ICONDIR, one 16-byte ICONDIRENTRY per size, then
# the payloads back to back.
function Write-IdeasIcon {
    param([string] $Path)

    Add-Type -AssemblyName System.Drawing
    $sizes  = @(256, 48, 32, 16)
    $master = New-IdeasBitmap 256
    $blobs  = @()
    try {
        foreach ($s in $sizes) {
            $frame = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
            $fg    = [System.Drawing.Graphics]::FromImage($frame)
            $fg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $fg.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $fg.DrawImage($master, (New-Object System.Drawing.Rectangle(0, 0, $s, $s)))
            $fg.Dispose()
            if ($s -ge 256) {
                $ms = New-Object System.IO.MemoryStream
                $frame.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
                $blobs += ,@($s, $ms.ToArray())
                $ms.Dispose()
            } else {
                $blobs += ,@($s, (ConvertTo-IconDib $frame))
            }
            $frame.Dispose()
        }
    } finally { $master.Dispose() }

    $out = New-Object System.IO.MemoryStream
    $bw  = New-Object System.IO.BinaryWriter($out)
    $bw.Write([UInt16] 0); $bw.Write([UInt16] 1); $bw.Write([UInt16] $blobs.Count)
    $offset = 6 + 16 * $blobs.Count
    foreach ($b in $blobs) {
        $s = [int] $b[0]; $bytes = [byte[]] $b[1]
        $bw.Write([byte] ($(if ($s -ge 256) { 0 } else { $s })))   # 0 means 256
        $bw.Write([byte] ($(if ($s -ge 256) { 0 } else { $s })))
        $bw.Write([byte] 0)          # palette entries: none, it's 32-bit
        $bw.Write([byte] 0)          # reserved
        $bw.Write([UInt16] 1)        # colour planes
        $bw.Write([UInt16] 32)       # bits per pixel
        $bw.Write([UInt32] $bytes.Length)
        $bw.Write([UInt32] $offset)
        $offset += $bytes.Length
    }
    foreach ($b in $blobs) { $bw.Write([byte[]] $b[1]) }
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($Path, $out.ToArray())
    $bw.Dispose(); $out.Dispose()
}

# --- go ----------------------------------------------------------------------
$iconOk = $false
try {
    Write-IdeasIcon -Path $IconPath
    $iconOk = $true
    Write-Host "icon   $IconPath"
} catch {
    Write-Warning "Couldn't draw the icon ($($_.Exception.Message)) -- falling back to Electron's."
}

if ($IconOnly) { return }

if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Ideas.cmd isn't next to the ideas\ folder (looked for $launcher). Keep this script inside the repo."
}

# Electron's icon is the fallback: if the app can run at all, this file exists.
$iconRef = if ($iconOk) { "$IconPath,0" }
           else { (Join-Path $root 'town\node_modules\electron\dist\electron.exe') + ',0' }

$desktop = [Environment]::GetFolderPath('Desktop')   # follows a OneDrive-redirected Desktop
$lnkPath = Join-Path $desktop 'Ideas.lnk'

$shell = New-Object -ComObject WScript.Shell
try {
    $lnk = $shell.CreateShortcut($lnkPath)           # opens the existing one if there is one
    $lnk.TargetPath       = $launcher
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation     = $iconRef
    $lnk.Description      = 'Ideas - the board for Token Tracker and Token Town'
    $lnk.WindowStyle      = 7                        # minimised: the launcher's console never lands on screen
    $lnk.Save()
} finally {
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

Write-Host "shortcut $lnkPath"
Write-Host "  -> $launcher"
Write-Host "Double-click Ideas on your Desktop."
