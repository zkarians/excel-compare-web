$src = "C:\Users\Administrator\.gemini\antigravity\brain\ee538145-694c-4936-8736-a1721efce797\app_icon_1784642556403.png"
$dst = "C:\Users\Administrator\Documents\gemini\Excelcompare\build\icon.png"
Copy-Item $src -Destination $dst -Force
Write-Host "Done"
