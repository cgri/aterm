; Explorer context menu: "Open in aterm" on the background of a folder window.
;
; SHCTX is electron-builder's hive macro — HKCU here, because `perMachine: false`
; means the installer never elevates and an HKLM write would fail.
; %V is the folder the window shows, and the only thing that works under
; Directory\Background: %1 is empty there.
;
; --open-dir="%V", never --open-dir "%V": a launch that meets a running aterm
; arrives as Chromium's re-serialised command line, which sorts the switches
; ahead of the bare arguments — the path would no longer follow the switch it
; belongs to. Attached to the switch it survives.

!define ATERM_SHELL_KEY "Software\Classes\Directory\Background\shell\aterm"

!macro customInstall
  WriteRegStr SHCTX "${ATERM_SHELL_KEY}" "" "Open in aterm"
  WriteRegStr SHCTX "${ATERM_SHELL_KEY}" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr SHCTX "${ATERM_SHELL_KEY}\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --open-dir="%V"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "${ATERM_SHELL_KEY}"
!macroend
