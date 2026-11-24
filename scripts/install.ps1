# Installs Chiefmate on Windows. Safe to run again at any time: it replaces what already exists.
#  1. starts Chiefmate in the background when you sign in to Windows;
#  2. wakes the computer from sleep 3 minutes before each scheduled mission (config/chiefmate.json);
#  3. creates the "Chiefmate" app shortcuts on the desktop and in the Start menu;
#  4. registers the chiefmate: address, which the notifications use to open the app.
# Run it again after changing the missions' schedules.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$startHidden = Join-Path $root 'scripts\start-hidden.vbs'
$openApp = Join-Path $root 'scripts\open.vbs'
$icon = Join-Path $root 'ui\chiefmate.ico'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$configFile = Join-Path $root 'config\chiefmate.json'
if (-not (Test-Path $configFile)) {
  Copy-Item (Join-Path $root 'config\example.json') $configFile
  Write-Host "Settings created from the example: $configFile"
}
$config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$action = New-ScheduledTaskAction -Execute $wscript -Argument "`"$startHidden`"" -WorkingDirectory $root
$noLimit = [TimeSpan]::Zero

# 1. Start at sign-in
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit $noLimit -MultipleInstances IgnoreNew
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskPath '\Chiefmate\' -TaskName 'Start at sign-in' -Action $action -Trigger $logon -Settings $settings -Description 'Starts Chiefmate in the background when you sign in to Windows.' -Force | Out-Null
Write-Host 'Task created: start Chiefmate at sign-in.'

# 2. Wake up before the scheduled missions
$dayNames = @{ sun = 'Sunday'; mon = 'Monday'; tue = 'Tuesday'; wed = 'Wednesday'; thu = 'Thursday'; fri = 'Friday'; sat = 'Saturday' }
$triggers = @()
foreach ($mission in $config.missions.PSObject.Properties) {
  $schedule = $mission.Value.schedule
  if (-not $schedule -or -not $schedule.days) { continue }
  $days = @($schedule.days | ForEach-Object { $dayNames[$_.Substring(0, 3).ToLower()] } | Where-Object { $_ })
  if ($days.Count -eq 0) { continue }
  $time = [datetime]::ParseExact($schedule.time, 'HH:mm', $null).AddMinutes(-3)
  $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek $days -At $time
  Write-Host ("Mission {0}: wakes the computer on {1} at {2}" -f $mission.Name, ($days -join ', '), $time.ToString('HH:mm'))
}
if ($triggers.Count -gt 0) {
  $wake = New-ScheduledTaskSettingsSet -WakeToRun -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit $noLimit -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath '\Chiefmate\' -TaskName 'Wake for missions' -Action $action -Trigger $triggers -Settings $wake -Description 'Wakes the computer from sleep before the scheduled Chiefmate missions.' -Force | Out-Null
  Write-Host 'Task created: wake the computer before the missions.'
} elseif (Get-ScheduledTask -TaskPath '\Chiefmate\' -TaskName 'Wake for missions' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskPath '\Chiefmate\' -TaskName 'Wake for missions' -Confirm:$false
  Write-Host 'No scheduled missions: the wake-up task was removed.'
}

# 3. App shortcuts on the desktop and in the Start menu (they open the app window, with no browser bar)
foreach ($folder in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
  $target = Join-Path $folder 'Chiefmate.lnk'
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($target)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "`"$openApp`""
  $shortcut.WorkingDirectory = $root
  $shortcut.Description = 'Chiefmate: a command center for AI agents'
  $shortcut.IconLocation = "$icon,0"
  $shortcut.Save()
  Write-Host "Shortcut created: $target"
}

# 4. The chiefmate: address (Windows notifications open the app on the right section)
$key = 'HKCU:\Software\Classes\chiefmate'
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:Chiefmate'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
New-Item -Path "$key\DefaultIcon" -Force | Out-Null
Set-ItemProperty -Path "$key\DefaultIcon" -Name '(Default)' -Value "$icon,0"
New-Item -Path "$key\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value "`"$wscript`" `"$openApp`" `"%1`""
Write-Host 'Address chiefmate: registered.'
