' Starts Chiefmate in the background, with no window. Used at Windows sign-in, when the computer wakes up
' for a mission, and by the app shortcut. If Chiefmate is already running, it does nothing.
Option Explicit
Dim fso, shell, folder
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(folder & "\data") Then fso.CreateFolder(folder & "\data")
shell.CurrentDirectory = folder
shell.Run "cmd /c node src\cli.mjs server >> data\server.log 2>&1", 0, False
