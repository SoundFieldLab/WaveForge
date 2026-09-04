$p = Start-Process -FilePath 'release/win-unpacked/WaveForge 澜音工坊.exe' -PassThru -WindowStyle Hidden
foreach ($i in 1..20) { Start-Sleep 1; try { $null = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3002/health' -TimeoutSec 3; break } catch {} }
$w1 = 'C:\Windows\Media\Alarm01.wav'
$w2 = (Get-ChildItem 'C:\Windows\Media' -Filter '*.wav' | Where-Object { $_.Name -ne 'Alarm01.wav' } | Select-Object -First 1).FullName
Write-Host "文件A: $(Split-Path $w1 -Leaf)   文件B: $(Split-Path $w2 -Leaf)"
function Esc($f) { $f.Replace('\', '\\') }
try {
  $a1 = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3002/analyze' -Method POST -ContentType 'application/json' -Body ('{"trackKey":"d1","audioPath":"' + (Esc $w1) + '","duration":5}') -TimeoutSec 60).Content | ConvertFrom-Json
  Write-Host "[节拍 A] 特征块数: $($a1.beatFeatures.Count)  首块置信度: $($a1.beatConfidence[0])"
} catch { Write-Host "[节拍 A] FAIL: $($_.Exception.Message)" }
try {
  $a2 = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3002/analyze' -Method POST -ContentType 'application/json' -Body ('{"trackKey":"d2","audioPath":"' + (Esc $w2) + '","duration":5}') -TimeoutSec 60).Content | ConvertFrom-Json
  Write-Host "[节拍 B] 特征块数: $($a2.beatFeatures.Count)  首块置信度: $($a2.beatConfidence[0])"
} catch { Write-Host "[节拍 B] FAIL: $($_.Exception.Message)" }
try {
  $l1 = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3003/lufs' -Method POST -ContentType 'application/json' -Body ('{"trackKey":"L1","audioPath":"' + (Esc $w1) + '"}') -TimeoutSec 30).Content | ConvertFrom-Json
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $l2 = (Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3003/lufs' -Method POST -ContentType 'application/json' -Body ('{"trackKey":"L2","audioPath":"' + (Esc $w2) + '"}') -TimeoutSec 30).Content | ConvertFrom-Json
  $sw.Stop()
  Write-Host "[响度] 文件A=$($l1.integratedLufs) LUFS   文件B=$($l2.integratedLufs) LUFS   B耗时=$($sw.ElapsedMilliseconds)ms（不同文件=独立真测量）"
} catch { Write-Host "[响度] FAIL: $($_.Exception.Message)" }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
Write-Output 'DONE'
