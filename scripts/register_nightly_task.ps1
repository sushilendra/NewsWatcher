# Registers a Windows scheduled task that updates NewsWatcher news every night,
# even when the web app isn't running. Run once:  .\scripts\register_nightly_task.ps1
# Remove later with:  Unregister-ScheduledTask -TaskName NewsWatcherNightly -Confirm:$false
# Runs at 02:30 with --if-missed: if the web app is running it has already updated at 02:00,
# so the task does nothing; if the app isn't running, the task does the day's update.
param(
    [string]$Time = "2:30AM",
    [string]$TaskName = "NewsWatcherNightly"
)

$root = Split-Path -Parent $PSScriptRoot
$cmd = Get-Command node -ErrorAction SilentlyContinue
$node = if ($cmd) { $cmd.Source } else { "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "node.exe not found; install Node.js first" }

$action  = New-ScheduledTaskAction -Execute $node -Argument "`"$root\src\update.js`" --if-missed" -WorkingDirectory $root
# Two triggers; --if-missed means at most one real update per day either way.
$daily = New-ScheduledTaskTrigger -Daily -At $Time
# At logon (2 min delay so Wi-Fi can connect): catches up after the laptop was shut down.
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = "PT2M"

# Laptop-friendly settings:
#  - StartWhenAvailable: if the PC was off/asleep at 02:30, run as soon as possible afterwards
#  - run on battery and don't stop when unplugged (it's a few seconds of downloading)
#  - retry 3 times, 10 minutes apart, if a run fails (e.g. no network yet)
#  - never wake the laptop just for this
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10) -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($daily, $logon) -Settings $settings `
    -Description "Fetches the latest news for NewsWatcher topics (once a day; catches up at logon)" -Force | Out-Null

Write-Host "Registered '$TaskName': daily at $Time and at logon, using $node"
