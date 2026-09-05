!macro customInstall
  CreateDirectory "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
  CreateShortCut "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\ExcelCompare.lnk" "$INSTDIR\ExcelCompare.exe" "" "$INSTDIR\ExcelCompare.exe" 0
!macroend

!macro customUnInstall
  Delete "$APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\ExcelCompare.lnk"
!macroend
