; Additions to electron-builder's Windows installer.
;
; An update runs the old version's uninstaller first. It moves every file aside before
; deleting anything, and gives up (code 2, "Failed to uninstall old application files")
; if any one file is in use, whether by Focus Orb still closing or by some other program,
; such as security software checking files just after the app quit. The installer then
; stopped on a message box. These macros make that path patient and never a dead end,
; and leave a note that the app copies into its log on the next start.

; Where the note goes: the app's own log folder (%APPDATA%\focus-orb\logs).
!macro FO_NOTE TEXT
  CreateDirectory "$APPDATA\focus-orb\logs"
  FileOpen $R9 "$APPDATA\focus-orb\logs\installer-note.txt" a
  FileSeek $R9 0 END
  FileWrite $R9 "${TEXT}$\r$\n"
  FileClose $R9
!macroend

; Replaces the stock "is the app still running" check, which goes through PowerShell.
; Waits up to 10 s for Focus Orb (only this user's copies) to finish closing by itself,
; then ends it, then waits up to 5 s more. Plain tasklist and taskkill, nothing else.
!macro customCheckAppRunning
  StrCpy $R1 0
  fo_check:
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${if} $R0 != 0
      Goto fo_closed
    ${endIf}
    IntOp $R1 $R1 + 1
    ${if} $R1 == 20
      DetailPrint `Ending "${PRODUCT_NAME}".`
      nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /FI "USERNAME eq %USERNAME%" /IM "${APP_EXECUTABLE_FILENAME}"`
      Pop $R0
    ${endIf}
    ${if} $R1 > 30
      Goto fo_closed
    ${endIf}
    Sleep 500
    Goto fo_check
  fo_closed:
  ; a moment for Windows to let go of the files the app had open
  Sleep 500
!macroend

; Replaces the stock check after the old version's uninstaller has run. Instead of
; giving up after a few seconds, keep trying for about a minute; if the old files still
; cannot be moved, install over the top rather than stop.
!macro customUnInstallCheck
  ${if} ${Errors}
    ; no old uninstaller could be started: nothing to remove, or a fresh install
    ClearErrors
  ${elseif} $R0 != 0
    StrCpy $R6 1
    fo_retry:
      ${if} $R6 > 12
        !insertmacro FO_NOTE "Update: the old version's files stayed in use (uninstaller code $R0, $R6 tries over about a minute); installed over the top."
        Goto fo_done
      ${endIf}
      Sleep 5000
      IntOp $R6 $R6 + 1
      ClearErrors
      ; electron-builder copies the old uninstaller here before running it (installUtil.nsh)
      ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$INSTDIR' $R0
      ${if} $R0 == 0
        !insertmacro FO_NOTE "Update: the old version's files were in use at first; removed on try $R6."
        Goto fo_done
      ${endIf}
      Goto fo_retry
  ${endIf}
  fo_done:
!macroend
