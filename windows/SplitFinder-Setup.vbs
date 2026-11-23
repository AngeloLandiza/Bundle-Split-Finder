' Double-click launcher (minimal window). Runs SplitFinder-Setup.bat.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\SplitFinder-Setup.bat""", 1, True