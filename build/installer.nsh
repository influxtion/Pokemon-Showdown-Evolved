; Custom NSIS hooks for electron-builder.
;
; electron-builder 26 decides whether the app is running by asking PowerShell
; (Get-CimInstance Win32_Process). Its availability probe only looks at the exit
; code, so Wine's stub powershell.exe, which exits 0 without running anything,
; passes the probe. Every "is the app running?" query then reports yes, the
; kill never "works", and the installer stops on "cannot be closed".
;
; This replaces the probe: PowerShell counts as available only when it is not
; Wine and it prints a value it had to compute. Otherwise the stock tasklist
; fallback is used. The rest of the stock check (_CHECK_APP_RUNNING) is reused.

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  Var /GLOBAL IsPowerShellAvailable ; 0 = available, 1 = not available
  StrCpy $IsPowerShellAvailable 1

  ; Wine always creates this key; real Windows never has it.
  ClearErrors
  EnumRegKey $R0 HKCU "Software\Wine" 0
  ${if} ${Errors}
    nsExec::ExecToStack `"$PowerShellPath" -NoProfile -NonInteractive -C "if ((Get-Command Get-CimInstance -ErrorAction SilentlyContinue) -and ((Get-ExecutionPolicy -Scope Process) -ne 'Restricted')) { [Console]::Out.Write('PSE' + '_READY') }"`
    Pop $R0 ; exit code
    Pop $R1 ; stdout
    ${if} $R0 == 0
    ${andIf} $R1 == "PSE_READY"
      StrCpy $IsPowerShellAvailable 0
    ${endIf}
  ${endIf}
  ClearErrors

  !insertmacro _CHECK_APP_RUNNING
!macroend
