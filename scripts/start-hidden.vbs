' Starts Chiefmate in the background, with no window. Used at Windows sign-in, when the computer wakes up
' for a mission, and by the app shortcut. If Chiefmate is already running, it does nothing.
' Chiefmate writes its own log (data\server.log, with --log): a log redirected by cmd would stay locked while
' it runs, and the self-update could not restart it.
Option Explicit
Dim fso, shell
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
shell.Run "node src\cli.mjs server --log", 0, False
