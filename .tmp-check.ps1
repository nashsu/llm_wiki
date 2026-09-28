"rust procs: " + (Get-Process cargo, rustc -ErrorAction SilentlyContinue | Measure-Object).Count
$w = Get-Process llm-wiki -ErrorAction SilentlyContinue
if ($w) { "llm-wiki pid " + $w.Id + " started " + $w.StartTime.ToString('HH:mm:ss') } else { "llm-wiki not running" }
$c = Get-NetTCPConnection -LocalPort 19828 -State Listen -ErrorAction SilentlyContinue
if ($c) { "api 19828 up" } else { "api 19828 down" }
"now: " + (Get-Date -Format 'HH:mm:ss')
