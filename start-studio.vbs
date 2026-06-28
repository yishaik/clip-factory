' start-studio.vbs — launch Clip Factory Studio fully detached (survives the spawning shell)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "D:\Projects\clip-factory"
sh.Environment("PROCESS")("PORT") = "8013"
sh.Run "cmd /c node studio.mjs > studio.log 2>&1", 0, False
