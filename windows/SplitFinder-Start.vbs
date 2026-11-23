' Double-click launcher. Starts agent + Chrome without keeping this window open.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run """" & dir & "\SplitFinder-Start.bat""", 0, False