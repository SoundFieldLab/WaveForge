; WaveForge setup UI preview. Reuses the production electron-builder include verbatim.
Unicode true
!include "MUI2.nsh"

!ifndef SRC
  !error "SRC not defined - run via npm run preview:setup"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.4"
!endif
!ifndef ESTIMATED_SIZE
  !define ESTIMATED_SIZE 0
!endif

!define PRODUCT_NAME "WaveForge 澜音工坊"
!define WF_PREVIEW
!define BUILD_RESOURCES_DIR "${SRC}/build"
!define isUpdated `0 == 1`

Name "${PRODUCT_NAME}"
Caption "${PRODUCT_NAME} 安装向导"
OutFile "${SRC}/release/setup-preview.exe"
RequestExecutionLevel user
Icon "${SRC}/build/setup-icon.ico"
ShowInstDetails nevershow
AutoCloseWindow true

Var installMode
Var isForceMachineInstall
Var isForceCurrentInstall
Var newDesktopLink
Var launchLink
Var ReviewTarget

!addincludedir "${SRC}"
!addincludedir "${SRC}/node_modules/app-builder-lib/templates/nsis/include"
!include "build\installer.nsh"

Function .onInit
  StrCpy $installMode "current"
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\WaveForge"
  !insertmacro customInit
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/review=" $ReviewTarget
  ${If} ${Errors}
    StrCpy $ReviewTarget ""
  ${EndIf}
  ${If} $ReviewTarget != ""
    StrCpy $WaveTheme "dark"
    ${IfThen} $ReviewTarget == "welcome-light" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "license-light-unchecked" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "license-light-checked" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "directory-light" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "progress-light" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "finish-light" ${|} StrCpy $WaveTheme "light" ${|}
    ${IfThen} $ReviewTarget == "license-dark-checked" ${|} StrCpy $WaveAgreementState "1" ${|}
    ${IfThen} $ReviewTarget == "license-light-checked" ${|} StrCpy $WaveAgreementState "1" ${|}
  ${EndIf}
FunctionEnd

Function .onGUIInit
  Call WaveGuiInit
  System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Setup Preview [$ReviewTarget]")'
FunctionEnd

Function ReviewThemeCreate
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "theme-hidden"
  ${OrIf} $ReviewTarget == "theme-hover"
    Call WaveThemeCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Function ReviewWelcomeCreate
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "welcome-dark"
  ${OrIf} $ReviewTarget == "welcome-light"
    System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Setup Preview [$ReviewTarget]")'
    Call WaveWelcomeCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Function ReviewLicenseCreate
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "license-dark-unchecked"
  ${OrIf} $ReviewTarget == "license-dark-checked"
  ${OrIf} $ReviewTarget == "license-light-unchecked"
  ${OrIf} $ReviewTarget == "license-light-checked"
    Call WaveLicenseCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Function ReviewDirectoryCreate
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "directory-dark"
  ${OrIf} $ReviewTarget == "directory-light"
    System::Call 'user32::SetWindowTextW(p $HWNDPARENT, w "WaveForge Setup Preview [$ReviewTarget]")'
    Call WaveOptionsCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Function ReviewInstFilesPre
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "progress-dark"
  ${OrIf} $ReviewTarget == "progress-light"
    Call WaveInstFilesPre
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Function ReviewFinishCreate
  ${If} $ReviewTarget == ""
  ${OrIf} $ReviewTarget == "finish-dark"
  ${OrIf} $ReviewTarget == "finish-light"
    Call WaveFinishCreate
  ${Else}
    Abort
  ${EndIf}
FunctionEnd

Page custom ReviewThemeCreate WaveThemeLeave
Page custom ReviewWelcomeCreate WavePageLeave
Page custom ReviewLicenseCreate WaveLicenseLeave
Page custom ReviewDirectoryCreate WaveOptionsLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE ReviewInstFilesPre
!define MUI_PAGE_CUSTOMFUNCTION_SHOW WaveInstFilesShow
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE WaveInstFilesLeave
!insertmacro MUI_PAGE_INSTFILES
Function WaveFinishRun
  Quit
FunctionEnd
Page custom ReviewFinishCreate WavePageLeave

Section "Preview"
  DetailPrint "正在预览安装界面..."
  Sleep 200
  SendMessage $WaveProgressPath ${PBM_SETPOS} 11400 0
  Sleep 2400
SectionEnd
