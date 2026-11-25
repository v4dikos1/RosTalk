; RosTalk client installer hooks (stage 6.2).
;
; Included by the NSIS template through
; `bundle.windows.nsis.installerHooks` in tauri.conf.json.
;
; Anti-cheat hygiene: per-user only. This file writes HKCU keys for the
; `rostalk://` handler, removes the optional logon entry on uninstall and calls
; the client's `--purge-data` path when the user does not ask to keep the
; identity. It registers no service, driver, certificate, firewall rule or
; Defender exclusion, and it requests no elevation.
;
; Data removal is an explicit choice:
;   * Tauri's "Delete application data" box deletes the data (and the client
;     purges the keychain identity in the same step);
;   * with the box unchecked (the default shown by the stock template) the
;     uninstaller asks once; the default answer removes the data;
;   * silent/passive uninstall always removes; keeping requires the interactive
;     choice.
; The local identity lives in Windows Credential Manager, not only in the app
; data directory, so `rostalk.exe --purge-data` removes it too.

!macro ROSTALK_PURGE_USER_DATA
  ExecWait '"$INSTDIR\rostalk.exe" --purge-data'
  RMDir /r "$APPDATA\dev.rostalk.desktop"
  RMDir /r "$LOCALAPPDATA\dev.rostalk.desktop"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; RosTalk invitation links: rostalk://join?... opens the installed client.
  ; The same user can remove the key, and the uninstaller does.
  WriteRegStr HKCU "Software\Classes\rostalk" "" "URL:RosTalk invitation link"
  WriteRegStr HKCU "Software\Classes\rostalk" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\rostalk\DefaultIcon" "" "$INSTDIR\rostalk.exe,0"
  WriteRegStr HKCU "Software\Classes\rostalk\shell\open\command" "" '"$INSTDIR\rostalk.exe" "%1"'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Close the running client first: the WebView data files are locked while it
  ; runs, so a purge before this would leave them behind. On a silent/passive
  ; run the helper ends the process; interactively it asks. The template calls
  ; the same helper later and finds nothing to do.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\rostalk.exe" "RosTalk"

  ; The optional logon entry (tauri-plugin-autostart, value name "RosTalk").
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "RosTalk"

  ; The protocol handler belongs to the installation.
  DeleteRegKey HKCU "Software\Classes\rostalk"

  ; Tauri's built-in checkbox was checked, or the uninstaller is unattended:
  ; remove the identity and the app data.
  ${If} $DeleteAppDataCheckboxState = 1
    !insertmacro ROSTALK_PURGE_USER_DATA
  ${ElseIf} $PassiveMode = 1
    !insertmacro ROSTALK_PURGE_USER_DATA
  ${Else}
    ; The box was not checked (for example the raw uninstall.exe was run).
    ; Ask once; the silent default and the default button remove the data.
    MessageBox MB_YESNO|MB_ICONQUESTION "Keep your RosTalk identity and settings?$\r$\nОставить личность и настройки RosTalk?$\r$\n$\r$\nYes / Да — keep them.$\r$\nNo / Нет — remove them (default)." /SD IDNO IDYES rostalk_keep_user_data
    !insertmacro ROSTALK_PURGE_USER_DATA
    rostalk_keep_user_data:
  ${EndIf}
!macroend
