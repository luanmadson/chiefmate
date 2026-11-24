# Removes what install.ps1 created: the scheduled tasks, the shortcuts and the chiefmate: address.
# Your settings (config/chiefmate.json), the history (data/) and the working copies (workspaces/) stay.
# To stop a running Chiefmate, close it from the Task Manager (node.exe) or restart the computer.
$root = Split-Path -Parent $PSScriptRoot
Get-ScheduledTask -TaskPath '\Chiefmate\' -ErrorAction SilentlyContinue | ForEach-Object {
  Unregister-ScheduledTask -TaskPath $_.TaskPath -TaskName $_.TaskName -Confirm:$false
  Write-Host "Task removed: $($_.TaskName)"
}
try {
  $service = New-Object -ComObject Schedule.Service
  $service.Connect()
  $service.GetFolder('\').DeleteFolder('Chiefmate', 0)
} catch { }
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $shortcut = Join-Path $folder 'Chiefmate.lnk'
  if (Test-Path $shortcut) { Remove-Item $shortcut; Write-Host "Shortcut removed: $shortcut" }
}
if (Test-Path 'HKCU:\Software\Classes\chiefmate') {
  Remove-Item 'HKCU:\Software\Classes\chiefmate' -Recurse
  Write-Host 'Address chiefmate: removed.'
}
Write-Host "Done. The folder $root was left as it is."
