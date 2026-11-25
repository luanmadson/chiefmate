' The watchdog's check (src/watch.mjs), with no window: the Windows task "Watchdog" runs it every 10 minutes.
' It waits for the check to end, so the task never runs two checks at once.
Option Explicit
Dim fso, shell
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.Run "node src\cli.mjs watch", 0, True
