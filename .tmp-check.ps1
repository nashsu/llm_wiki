Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
  Where-Object { $_.OwningProcess -in 44684, 47352 } |
  Select-Object OwningProcess, RemoteAddress, RemotePort | Format-Table -AutoSize
