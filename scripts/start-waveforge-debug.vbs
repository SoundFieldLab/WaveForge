Option Explicit

Dim shell, fso, projectDir, nodeExe, debugScript, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"
debugScript = projectDir & "\scripts\start-waveforge-debug.mjs"

shell.CurrentDirectory = projectDir
command = Quote(nodeExe) & " " & Quote(debugScript)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function