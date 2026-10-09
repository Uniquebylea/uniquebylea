@echo off
chcp 65001 > nul
echo ====================================================================
echo   🌟 BILDER-OPTIMIERER FÜR UNIQUE BY LEA 🌟
echo ====================================================================
echo.
echo Dieses Skript verkleinert alle deine Bilder automatisch auf eine 
echo webfreundliche Größe (max. 1200px) und optimiert die Dateigröße,
echo damit deine neue Website blitzschnell lädt!
echo.
echo Deine Originale im Ordner "images" bleiben völlig unangetastet. 
echo Die verkleinerten Bilder werden im neuen Ordner "images_ready" gespeichert.
echo.
echo Drücke eine beliebige Taste, um den Vorgang zu starten...
pause > nul
echo.
echo Optimiere Bilder... Bitte warten...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command " ^
Add-Type -AssemblyName System.Drawing; ^
$srcDir = Join-Path $pwd 'images'; ^
$destDir = Join-Path $pwd 'images_ready'; ^
if (-not (Test-Path $srcDir)) { ^
    Write-Host 'Ordner \"images\" nicht gefunden!' -ForegroundColor Red; ^
    Write-Host 'Bitte stelle sicher, dass dieser Ordner existiert und deine Bilder enthält.' -ForegroundColor Yellow; ^
    exit; ^
} ^
if (-not (Test-Path $destDir)) { ^
    New-Item -ItemType Directory -Path $destDir | Out-Null; ^
} ^
$files = Get-ChildItem -Path $srcDir -File | Where-Object { $_.Extension -match '^\.(jpg|jpeg|png)$' }; ^
$total = $files.Count; ^
if ($total -eq 0) { ^
    Write-Host 'Keine Bilder (.jpg, .jpeg, .png) im Ordner \"images\" gefunden!' -ForegroundColor Yellow; ^
    exit; ^
} ^
$count = 0; ^
foreach ($file in $files) { ^
    $count++; ^
    $pct = [math]::Round(($count / $total) * 100); ^
    Write-Progress -Activity 'Optimiere Bilder' -Status \"$count von $total ($pct%)\" -PercentComplete $pct; ^
    try { ^
        $img = [System.Drawing.Image]::FromFile($file.FullName); ^
        $maxSize = 1200.0; ^
        $ratio = 1.0; ^
        if ($img.Width -gt $img.Height) { ^
            if ($img.Width -gt $maxSize) { $ratio = $maxSize / $img.Width; } ^
        } else { ^
            if ($img.Height -gt $maxSize) { $ratio = $maxSize / $img.Height; } ^
        } ^
        $newWidth = [int]($img.Width * $ratio); ^
        $newHeight = [int]($img.Height * $ratio); ^
        $bmp = New-Object System.Drawing.Bitmap($newWidth, $newHeight); ^
        $g = [System.Drawing.Graphics]::FromImage($bmp); ^
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; ^
        $g.DrawImage($img, 0, 0, $newWidth, $newHeight); ^
        $destPath = Join-Path $destDir $file.Name; ^
        $format = $img.RawFormat; ^
        $img.Dispose(); ^
        $g.Dispose(); ^
        $bmp.Save($destPath, $format); ^
        $bmp.Dispose(); ^
        Write-Host \"[OK] $($file.Name) -> auf $newWidth x $newHeight px verkleinert\"; ^
    } catch { ^
        Write-Host \"[FEHLER] $($file.Name) konnte nicht verarbeitet werden: $_\" -ForegroundColor Red; ^
    } ^
} ^
Write-Host ''; ^
Write-Host '====================================================================' -ForegroundColor Green; ^
Write-Host '   🎉 FERTIG! Alle Bilder wurden optimiert in \"images_ready\" abgelegt! 🎉' -ForegroundColor Green; ^
Write-Host '====================================================================' -ForegroundColor Green; ^
"

echo.
echo Drücke eine beliebige Taste, um dieses Fenster zu schließen.
pause > nul
Gemini Notebook kann fehlerhafte Informationen ausgeben. Bitte überprüfen Sie die Antworten.