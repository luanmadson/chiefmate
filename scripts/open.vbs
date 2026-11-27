' Opens Chiefmate in an app window (no browser bar), starting Chiefmate first if needed.
' Accepts "chiefmate:<section>", which comes from the Windows notifications: for example, chiefmate:operations.
Option Explicit
Dim fso, shell, folder, address, section, pattern, browser, candidate, i
section = ""

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
folder = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
address = "http://localhost:4747/"

If WScript.Arguments.Count > 0 Then
  section = LCase(WScript.Arguments(0))
  If Left(section, 10) = "chiefmate:" Then section = Mid(section, 11)
  section = Replace(section, "/", "")
  Set pattern = New RegExp
  pattern.Pattern = "^[a-z]{1,20}$"
  If pattern.Test(section) Then
    address = address & "#" & section
  Else
    section = ""
  End If
End If

Function IsRunning()
  Dim http, ok
  ok = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", "http://localhost:4747/api/health", False
  http.Send
  If Err.Number = 0 Then ok = (http.Status = 200)
  On Error GoTo 0
  IsRunning = ok
End Function

' Chiefmate opens the window itself, with a code that lets the app act as the owner (src/owner.mjs).
Function OpenedByChiefmate()
  Dim http, ok
  ok = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 3000, 3000
  http.Open "POST", "http://localhost:4747/api/owner/window", False
  http.setRequestHeader "content-type", "application/json"
  http.setRequestHeader "x-chiefmate", "1"
  http.Send "{""section"":""" & section & """}"
  If Err.Number = 0 Then ok = (http.Status = 200 And InStr(http.responseText, """opened"":true") > 0)
  On Error GoTo 0
  OpenedByChiefmate = ok
End Function

If Not IsRunning() Then
  shell.Run "wscript.exe """ & folder & "\scripts\start-hidden.vbs""", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If IsRunning() Then Exit For
  Next
End If

If OpenedByChiefmate() Then WScript.Quit

browser = ""
For Each candidate In Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
    shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
    shell.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe")
  If browser = "" And fso.FileExists(candidate) Then browser = candidate
Next

If browser <> "" Then
  shell.Run """" & browser & """ --app=" & address & " --window-size=1480,940", 1, False
Else
  shell.Run address, 1, False
End If
