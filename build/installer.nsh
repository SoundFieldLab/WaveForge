; WaveForge native assisted setup UI. The electron-builder install Section remains authoritative.
!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

!define WF_W 880
!define WF_H 580
!define WF_CX 280
!define WF_ANIM_X 280
!define WF_ANIM_Y 532
!define WF_ANIM_W 600
!define WF_ANIM_H 48
!define WF_IDBACK 3
!define WF_STM_SETIMAGE 0x0172
!define WF_SS_BITMAP 0x0000000E
!define WF_SS_NOTIFY 0x00000100
!define WF_WS_CHILD 0x40000000
!define WF_WS_VISIBLE 0x10000000
!define WF_WS_TABSTOP 0x00010000
!define WF_WS_CLIPCHILDREN 0x02000000
!define WF_WM_NCLBUTTONDOWN 0x00A1
!define WF_HTCAPTION 2
!define WF_EM_SCROLLCARET 0x00B7
!define WF_EM_SETMARGINS 0x00D3
!define WF_EC_LEFTMARGIN 0x0001
!define WF_EC_RIGHTMARGIN 0x0002
!define WF_PBM_GETPOS 0x0408
!define WF_PBM_SETBARCOLOR 0x0409
!define WF_PBM_SETBKCOLOR 0x2001

!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "你确定要取消 ${PRODUCT_NAME} 的安装吗？"

!ifndef BUILD_UNINSTALLER
!define MUI_CUSTOMFUNCTION_GUIINIT WaveGuiInit
Var WaveTheme
Var WaveInstallScope
Var WaveForceAllUsers
Var WaveIsUpdate
Var WaveDesktopShortcutState
Var WaveAgreementState
Var WavePage
Var WaveBackground
Var WaveBackgroundImage
Var WaveAnimation
Var WaveAnimationImage
Var WaveAnimationFrame
Var WaveAnimationTheme
Var WaveAnimationTickCount
Var WaveAnimTheme0
Var WaveAnimTheme1
Var WaveAnimTheme2
Var WaveAnimTheme3
Var WaveAnimTheme4
Var WaveAnimTheme5
Var WaveAnimTheme6
Var WaveAnimTheme7
Var WaveAnimTheme8
Var WaveAnimTheme9
Var WaveAnimTheme10
Var WaveAnimTheme11
Var WaveAnimTheme12
Var WaveAnimTheme13
Var WaveAnimTheme14
Var WaveAnimTheme15
Var WaveAnimDark0
Var WaveAnimDark1
Var WaveAnimDark2
Var WaveAnimDark3
Var WaveAnimDark4
Var WaveAnimDark5
Var WaveAnimDark6
Var WaveAnimDark7
Var WaveAnimDark8
Var WaveAnimDark9
Var WaveAnimDark10
Var WaveAnimDark11
Var WaveAnimDark12
Var WaveAnimDark13
Var WaveAnimDark14
Var WaveAnimDark15
Var WaveAnimLight0
Var WaveAnimLight1
Var WaveAnimLight2
Var WaveAnimLight3
Var WaveAnimLight4
Var WaveAnimLight5
Var WaveAnimLight6
Var WaveAnimLight7
Var WaveAnimLight8
Var WaveAnimLight9
Var WaveAnimLight10
Var WaveAnimLight11
Var WaveAnimLight12
Var WaveAnimLight13
Var WaveAnimLight14
Var WaveAnimLight15
Var WaveClose
Var WaveCloseImage
Var WaveCloseCurrentImage
Var WaveCloseLevel
Var WaveCloseTicks
Var WaveCloseInitialDone
Var WaveCloseWasHover
Var WaveCloseTarget
Var WaveCloseTheme0
Var WaveCloseTheme1
Var WaveCloseTheme2
Var WaveCloseTheme3
Var WaveCloseTheme4
Var WaveCloseTheme5
Var WaveCloseDark0
Var WaveCloseDark1
Var WaveCloseDark2
Var WaveCloseDark3
Var WaveCloseDark4
Var WaveCloseDark5
Var WaveCloseLight0
Var WaveCloseLight1
Var WaveCloseLight2
Var WaveCloseLight3
Var WaveCloseLight4
Var WaveCloseLight5
Var WaveBack
Var WaveNext
Var WaveBrowseButton
Var WaveDirEdit
Var WaveSpaceLabel
Var WaveDesktopShortcutControl
Var WaveLicenseCheck
Var WaveProgressPath
Var WaveProgressPathText
Var WaveFinishPath
Var WaveInstFilesActive
Var WaveFinishActive
Var WaveEnterDown
Var WaveSpaceDown
Var WavePointerDown
Var WavePointerWasDown
Var WaveCursorX
Var WaveCursorY
Var WaveImageNormalTemp
Var WaveImageHoverTemp
Var WaveImagePressedTemp
Var WaveHoverControl
Var WaveHoverNormal
Var WaveHoverImage
Var WaveHoverPressed
Var WaveHoverCurrent
Var WaveHoverControl2
Var WaveHoverNormal2
Var WaveHoverImage2
Var WaveHoverPressed2
Var WaveHoverCurrent2
Var WaveHoverControl3
Var WaveHoverNormal3
Var WaveHoverImage3
Var WaveHoverPressed3
Var WaveHoverCurrent3
Var WaveHoverControl4
Var WaveHoverNormal4
Var WaveHoverImage4
Var WaveHoverPressed4
Var WaveHoverCurrent4
Var WaveThemeDark
Var WaveThemeLight
Var WaveScopeCurrent
Var WaveScopeAll
Var WaveFont
Var WaveSmallFont
Var WavePathError
Var WaveRequiredMb
Var WaveProbeFile
Var WaveValidatedPath

!macro WaveLoadImage OUT FILE
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\${FILE}", i 0, i 0, i 0, i 0x10) p.s'
  Pop ${OUT}
!macroend

!macro WaveAnimationHandle OUT THEME FRAME
  ${If} "${THEME}" == "theme"
    StrCpy ${OUT} $WaveAnimTheme${FRAME}
  ${ElseIf} "${THEME}" == "dark"
    StrCpy ${OUT} $WaveAnimDark${FRAME}
  ${Else}
    StrCpy ${OUT} $WaveAnimLight${FRAME}
  ${EndIf}
!macroend

!macro WaveCloseHandle OUT THEME LEVEL
  ${If} ${THEME} == "theme"
    StrCpy ${OUT} $WaveCloseTheme${LEVEL}
  ${ElseIf} ${THEME} == "dark"
    StrCpy ${OUT} $WaveCloseDark${LEVEL}
  ${Else}
    StrCpy ${OUT} $WaveCloseLight${LEVEL}
  ${EndIf}
!macroend

!macro WaveLoadAnimationSet VARPREFIX FILETHEME
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}0 "anim-${FILETHEME}-0.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}1 "anim-${FILETHEME}-1.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}2 "anim-${FILETHEME}-2.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}3 "anim-${FILETHEME}-3.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}4 "anim-${FILETHEME}-4.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}5 "anim-${FILETHEME}-5.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}6 "anim-${FILETHEME}-6.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}7 "anim-${FILETHEME}-7.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}8 "anim-${FILETHEME}-8.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}9 "anim-${FILETHEME}-9.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}10 "anim-${FILETHEME}-10.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}11 "anim-${FILETHEME}-11.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}12 "anim-${FILETHEME}-12.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}13 "anim-${FILETHEME}-13.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}14 "anim-${FILETHEME}-14.bmp"
  !insertmacro WaveLoadImage $WaveAnim${VARPREFIX}15 "anim-${FILETHEME}-15.bmp"
!macroend

!macro WaveLoadCloseSet VARPREFIX FILETHEME
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}0 "close-${FILETHEME}-0.bmp"
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}1 "close-${FILETHEME}-1.bmp"
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}2 "close-${FILETHEME}-2.bmp"
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}3 "close-${FILETHEME}-3.bmp"
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}4 "close-${FILETHEME}-4.bmp"
  !insertmacro WaveLoadImage $WaveClose${VARPREFIX}5 "close-${FILETHEME}-5.bmp"
!macroend

!macro WaveRegisterHover CONTROL NORMAL HOVER PRESSED
  ${If} $WaveHoverControl == ""
    StrCpy $WaveHoverControl ${CONTROL}
    StrCpy $WaveHoverNormal ${NORMAL}
    StrCpy $WaveHoverImage ${HOVER}
    StrCpy $WaveHoverPressed ${PRESSED}
    StrCpy $WaveHoverCurrent ${NORMAL}
  ${ElseIf} $WaveHoverControl2 == ""
    StrCpy $WaveHoverControl2 ${CONTROL}
    StrCpy $WaveHoverNormal2 ${NORMAL}
    StrCpy $WaveHoverImage2 ${HOVER}
    StrCpy $WaveHoverPressed2 ${PRESSED}
    StrCpy $WaveHoverCurrent2 ${NORMAL}
  ${ElseIf} $WaveHoverControl3 == ""
    StrCpy $WaveHoverControl3 ${CONTROL}
    StrCpy $WaveHoverNormal3 ${NORMAL}
    StrCpy $WaveHoverImage3 ${HOVER}
    StrCpy $WaveHoverPressed3 ${PRESSED}
    StrCpy $WaveHoverCurrent3 ${NORMAL}
  ${Else}
    StrCpy $WaveHoverControl4 ${CONTROL}
    StrCpy $WaveHoverNormal4 ${NORMAL}
    StrCpy $WaveHoverImage4 ${HOVER}
    StrCpy $WaveHoverPressed4 ${PRESSED}
    StrCpy $WaveHoverCurrent4 ${NORMAL}
  ${EndIf}
!macroend

!macro WaveImageButton OUT X Y W H FILE HOVER PRESSED CLICK
  ${NSD_CreateBitmap} ${X} ${Y} ${W} ${H} ""
  Pop ${OUT}
  ${NSD_AddStyle} ${OUT} ${WF_SS_NOTIFY}|${WF_WS_TABSTOP}
  !insertmacro WaveLoadImage $WaveImageNormalTemp "${FILE}"
  !insertmacro WaveLoadImage $WaveImageHoverTemp "${HOVER}"
  !insertmacro WaveLoadImage $WaveImagePressedTemp "${PRESSED}"
  SendMessage ${OUT} ${WF_STM_SETIMAGE} 0 $WaveImageNormalTemp
  ${NSD_OnClick} ${OUT} ${CLICK}
  !insertmacro WaveRegisterHover ${OUT} $WaveImageNormalTemp $WaveImageHoverTemp $WaveImagePressedTemp
!macroend

!macro WaveThemeButton OUT X Y W H KIND TEXT CLICK
  ${If} $WaveTheme == "dark"
    !insertmacro WaveImageButton ${OUT} ${X} ${Y} ${W} ${H} "btn-${KIND}-dark-${TEXT}.bmp" "btn-${KIND}-dark-${TEXT}-hover.bmp" "btn-${KIND}-dark-${TEXT}-pressed.bmp" ${CLICK}
  ${Else}
    !insertmacro WaveImageButton ${OUT} ${X} ${Y} ${W} ${H} "btn-${KIND}-light-${TEXT}.bmp" "btn-${KIND}-light-${TEXT}-hover.bmp" "btn-${KIND}-light-${TEXT}-pressed.bmp" ${CLICK}
  ${EndIf}
!macroend

!macro WaveResetControls
  StrCpy $WaveHoverControl ""
  StrCpy $WaveHoverControl2 ""
  StrCpy $WaveHoverControl3 ""
  StrCpy $WaveHoverControl4 ""
  StrCpy $WaveHoverCurrent ""
  StrCpy $WaveHoverCurrent2 ""
  StrCpy $WaveHoverCurrent3 ""
  StrCpy $WaveHoverCurrent4 ""
  StrCpy $WaveEnterDown "0"
  StrCpy $WaveSpaceDown "0"
  StrCpy $WavePointerDown "0"
  StrCpy $WavePointerWasDown "0"
!macroend

!macro WaveHideBuilderButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT ${WF_IDBACK}
  ShowWindow $0 ${SW_HIDE}
!macroend

!macro WaveDeleteImage IMAGE
  ${If} ${IMAGE} != ""
    System::Call "gdi32::DeleteObject(p ${IMAGE})"
    StrCpy ${IMAGE} ""
  ${EndIf}
!macroend

!macro WaveReleaseAnimationSet VARPREFIX
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}0
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}1
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}2
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}3
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}4
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}5
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}6
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}7
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}8
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}9
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}10
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}11
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}12
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}13
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}14
  !insertmacro WaveDeleteImage $WaveAnim${VARPREFIX}15
!macroend

!macro WaveReleaseCloseSet VARPREFIX
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}0
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}1
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}2
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}3
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}4
  !insertmacro WaveDeleteImage $WaveClose${VARPREFIX}5
!macroend

!macro WaveReleaseImages NORMAL HOVER PRESSED
  ${If} ${PRESSED} != ""
  ${AndIf} ${PRESSED} != ${HOVER}
  ${AndIf} ${PRESSED} != ${NORMAL}
    System::Call "gdi32::DeleteObject(p ${PRESSED})"
  ${EndIf}
  ${If} ${HOVER} != ""
  ${AndIf} ${HOVER} != ${NORMAL}
    System::Call "gdi32::DeleteObject(p ${HOVER})"
  ${EndIf}
  !insertmacro WaveDeleteImage ${NORMAL}
  StrCpy ${HOVER} ""
  StrCpy ${PRESSED} ""
!macroend

!macro WavePageStop
  ${NSD_KillTimer} WaveHoverTick
  ${NSD_KillTimer} WaveCloseFadeTick
  !insertmacro WaveDeleteImage $WaveBackgroundImage
  !insertmacro WaveReleaseImages $WaveHoverNormal $WaveHoverImage $WaveHoverPressed
  !insertmacro WaveReleaseImages $WaveHoverNormal2 $WaveHoverImage2 $WaveHoverPressed2
  !insertmacro WaveReleaseImages $WaveHoverNormal3 $WaveHoverImage3 $WaveHoverPressed3
  !insertmacro WaveReleaseImages $WaveHoverNormal4 $WaveHoverImage4 $WaveHoverPressed4
  StrCpy $WaveAnimation ""
  StrCpy $WaveProgressPath ""
  StrCpy $WaveProgressPathText ""
  StrCpy $WavePage ""
  StrCpy $WaveBackground ""
  StrCpy $WaveClose ""
  !insertmacro WaveResetControls
!macroend

Function .onGUIEnd
  !insertmacro WavePageStop
  !insertmacro WaveReleaseAnimationSet Theme
  !insertmacro WaveReleaseAnimationSet Dark
  !insertmacro WaveReleaseAnimationSet Light
  !insertmacro WaveReleaseCloseSet Theme
  !insertmacro WaveReleaseCloseSet Dark
  !insertmacro WaveReleaseCloseSet Light
  !insertmacro WaveDeleteImage $WaveFont
  !insertmacro WaveDeleteImage $WaveSmallFont
FunctionEnd

!macro WaveCreateAnimation THEME
  StrCpy $WaveAnimationTheme "${THEME}"
  StrCpy $WaveAnimationFrame "0"
  StrCpy $WaveAnimationTickCount "0"
  ${NSD_CreateBitmap} ${WF_ANIM_X} ${WF_ANIM_Y} ${WF_ANIM_W} ${WF_ANIM_H} ""
  Pop $WaveAnimation
  !insertmacro WaveAnimationHandle $WaveAnimationImage "${THEME}" 0
  SendMessage $WaveAnimation ${WF_STM_SETIMAGE} 0 $WaveAnimationImage
!macroend

!macro WavePageStart PAGE
  !insertmacro WavePageStop
  nsDialogs::Create 1018
  Pop $WavePage
  ${If} $WavePage == error
    Abort
  ${EndIf}
  System::Call "user32::MoveWindow(p $WavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  !insertmacro WaveResetControls
  !insertmacro WaveHideBuilderButtons
  ${If} $WaveTheme == "dark"
    StrCpy $0 "$PLUGINSDIR\${PAGE}-dark.bmp"
    StrCpy $WaveCloseImage $WaveCloseDark5
    StrCpy $1 "dark"
  ${Else}
    StrCpy $0 "$PLUGINSDIR\${PAGE}-light.bmp"
    StrCpy $WaveCloseImage $WaveCloseLight5
    StrCpy $1 "light"
  ${EndIf}
  ${NSD_CreateBitmap} 0 0 ${WF_W} ${WF_H} ""
  Pop $WaveBackground
  ${NSD_SetBitmap} $WaveBackground $0 $WaveBackgroundImage
  !insertmacro WaveCreateAnimation $1
  Call WaveCreateClose
  ${NSD_CreateTimer} WaveHoverTick 250
!macroend

!macro WavePageReady
  System::Call "user32::SetWindowPos(p $WaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  nsDialogs::Show
!macroend

!macro customInit
  StrCpy $WaveIsUpdate "0"
  StrCpy $WaveForceAllUsers "0"
  ${GetParameters} $0
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    StrCpy $WaveIsUpdate "1"
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/allusers" $1
  ${IfNot} ${Errors}
    StrCpy $WaveForceAllUsers "1"
  ${EndIf}
  ${If} ${Silent}
    StrCpy $WaveDesktopShortcutState "1"
    Return
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${BUILD_RESOURCES_DIR}\ui\*.bmp"
  StrCpy $WaveTheme "dark"
  StrCpy $WaveDesktopShortcutState "1"
  StrCpy $WaveAgreementState "0"
  !insertmacro WaveLoadCloseSet Theme theme
  !insertmacro WaveLoadCloseSet Dark dark
  !insertmacro WaveLoadCloseSet Light light
  !insertmacro WaveLoadAnimationSet Theme theme
  !insertmacro WaveLoadAnimationSet Dark dark
  !insertmacro WaveLoadAnimationSet Light light
  System::Call "gdi32::CreateFontW(i -15,i 0,i 0,i 0,i 400,i 0,i 0,i 0,i 1,i 0,i 0,i 5,i 0,w 'Microsoft YaHei UI') p.r0"
  StrCpy $WaveFont $0
  System::Call "gdi32::CreateFontW(i -13,i 0,i 0,i 0,i 400,i 0,i 0,i 0,i 1,i 0,i 0,i 5,i 0,w 'Microsoft YaHei UI') p.r0"
  StrCpy $WaveSmallFont $0
  ${If} $WaveForceAllUsers == "1"
    StrCpy $WaveInstallScope "all"
  ${ElseIf} $installMode == "all"
    StrCpy $WaveInstallScope "all"
  ${Else}
    StrCpy $WaveInstallScope "current"
  ${EndIf}
  !ifdef WF_PREVIEW
    StrCpy $INSTDIR "D:\WaveForge"
  !else
    !insertmacro GetDParameter $1
    ${If} $1 == ""
    ${AndIf} $hasPerUserInstallation == "0"
    ${AndIf} $hasPerMachineInstallation == "0"
      System::Call 'kernel32::GetDriveTypeW(w "D:\\") i.r2'
      ${If} $2 == 3
        StrCpy $INSTDIR "D:\WaveForge"
      ${EndIf}
    ${EndIf}
  !endif
!macroend

!macro customWelcomePage
  Page custom WaveThemeCreate WaveThemeLeave
  Page custom WaveWelcomeCreate WavePageLeave
  Page custom WaveLicenseCreate WaveLicenseLeave
!macroend

!macro customInstallMode
  ${If} $WaveIsUpdate != "1"
    ${If} $WaveInstallScope == "all"
      StrCpy $isForceMachineInstall "1"
    ${Else}
      StrCpy $isForceCurrentInstall "1"
    ${EndIf}
  ${EndIf}
!macroend

!macro customPageAfterChangeDir
  Page custom WaveOptionsCreate WaveOptionsLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE WaveInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW WaveInstFilesShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE WaveInstFilesLeave
!macroend

!macro customFinishPage
  Function WaveFinishRun
    !ifdef WF_PREVIEW
      Quit
    !else
      ${If} $WaveIsUpdate == "1"
        StrCpy $1 "--updated"
      ${Else}
        StrCpy $1 ""
      ${EndIf}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
      Quit
    !endif
  FunctionEnd
  Page custom WaveFinishCreate WavePageLeave
!macroend

!macro customInstall
  ${IfNot} ${Silent}
  ${AndIf} $WaveDesktopShortcutState != "1"
    Delete "$newDesktopLink"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend

Function WaveApplyWindowShape
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4) i.r0'
  ${If} $0 != 0
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i ${WF_W}, i ${WF_H}, i 28, i 28) p.r1'
    System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p r1, i 1) i.r0'
    ${If} $0 == 0
      System::Call 'gdi32::DeleteObject(p r1)'
    ${EndIf}
  ${EndIf}
  System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r0"
  IntOp $0 $0 | ${WF_WS_CLIPCHILDREN}
  System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)"
FunctionEnd

Function WaveGuiInit
  ${If} ${Silent}
    Return
  ${EndIf}
  System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r0"
  IntOp $0 $0 & 0xFF3BFFFF
  System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)"
  System::Call "user32::SetWindowTextW(p $HWNDPARENT, w '')"
  System::Call "user32::GetSystemMetrics(i 0) i.r0"
  IntOp $0 $0 - ${WF_W}
  IntOp $0 $0 / 2
  System::Call "user32::GetSystemMetrics(i 1) i.r1"
  IntOp $1 $1 - ${WF_H}
  IntOp $1 $1 / 2
  System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i ${WF_W}, i ${WF_H}, i 0x0020)"
  Call WaveApplyWindowShape
FunctionEnd

Function WaveCreateClose
  ${NSD_CreateBitmap} 828 10 40 40 ""
  Pop $WaveClose
  ${NSD_AddStyle} $WaveClose ${WF_SS_NOTIFY}
  StrCpy $WaveCloseLevel "5"
  StrCpy $WaveCloseTicks "0"
  StrCpy $WaveCloseInitialDone "0"
  StrCpy $WaveCloseWasHover "0"
  StrCpy $WaveCloseTarget "5"
  StrCpy $WaveCloseCurrentImage $WaveCloseImage
  SendMessage $WaveClose ${WF_STM_SETIMAGE} 0 $WaveCloseCurrentImage
  ${NSD_OnClick} $WaveClose WaveCancel
FunctionEnd

Function WaveAnimationTick
  ${If} $WaveAnimation == ""
    Return
  ${EndIf}
  System::Call "user32::IsWindowVisible(p $HWNDPARENT) i.r0"
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call "user32::IsIconic(p $HWNDPARENT) i.r0"
  ${If} $0 != 0
    Return
  ${EndIf}
  System::Call "user32::GetForegroundWindow() p.r0"
  ${If} $0 != $HWNDPARENT
    Return
  ${EndIf}
  IntOp $WaveAnimationTickCount $WaveAnimationTickCount + 1
  ${If} $WaveInstFilesActive == "1"
    ${If} $WaveAnimationTickCount < 5
      Return
    ${EndIf}
  ${Else}
    ${If} $WaveAnimationTickCount < 1
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $WaveAnimationTickCount "0"
  IntOp $WaveAnimationFrame $WaveAnimationFrame + 1
  IntOp $WaveAnimationFrame $WaveAnimationFrame % 16
  ${Switch} $WaveAnimationFrame
    ${Case} 0
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 0
      ${Break}
    ${Case} 1
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 1
      ${Break}
    ${Case} 2
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 2
      ${Break}
    ${Case} 3
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 3
      ${Break}
    ${Case} 4
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 4
      ${Break}
    ${Case} 5
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 5
      ${Break}
    ${Case} 6
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 6
      ${Break}
    ${Case} 7
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 7
      ${Break}
    ${Case} 8
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 8
      ${Break}
    ${Case} 9
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 9
      ${Break}
    ${Case} 10
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 10
      ${Break}
    ${Case} 11
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 11
      ${Break}
    ${Case} 12
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 12
      ${Break}
    ${Case} 13
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 13
      ${Break}
    ${Case} 14
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 14
      ${Break}
    ${Default}
      !insertmacro WaveAnimationHandle $WaveAnimationImage $WaveAnimationTheme 15
  ${EndSwitch}
  SendMessage $WaveAnimation ${WF_STM_SETIMAGE} 0 $WaveAnimationImage
FunctionEnd

!macro WaveHoverSlot CONTROL NORMAL HOVER PRESSED CURRENT
  ${If} ${CONTROL} != ""
    StrCpy $8 ${NORMAL}
    System::Call "user32::GetWindowRect(p ${CONTROL}, @r9)"
    System::Call "*$9(i.r2, i.r3, i.r4, i.r5)"
    System::Free $9
    ${If} $WaveCursorX >= $2
    ${AndIf} $WaveCursorX <= $4
    ${AndIf} $WaveCursorY >= $3
    ${AndIf} $WaveCursorY <= $5
      ${If} $WavePointerDown != 0
        StrCpy $8 ${PRESSED}
      ${Else}
        StrCpy $8 ${HOVER}
      ${EndIf}
    ${EndIf}
    ${If} ${CURRENT} != $8
      SendMessage ${CONTROL} ${WF_STM_SETIMAGE} 0 $8
      StrCpy ${CURRENT} $8
    ${EndIf}
  ${EndIf}
!macroend

Function WaveUpdateCloseImage
  ${Switch} $WaveCloseLevel
    ${Case} 0
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 0
      ${Break}
    ${Case} 1
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 1
      ${Break}
    ${Case} 2
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 2
      ${Break}
    ${Case} 3
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 3
      ${Break}
    ${Case} 4
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 4
      ${Break}
    ${Default}
      !insertmacro WaveCloseHandle $8 $WaveAnimationTheme 5
  ${EndSwitch}
  ${If} $WaveCloseCurrentImage != $8
    SendMessage $WaveClose ${WF_STM_SETIMAGE} 0 $8
    StrCpy $WaveCloseCurrentImage $8
  ${EndIf}
FunctionEnd

Function WaveCloseFadeTick
  ${If} $WaveCloseLevel < $WaveCloseTarget
    IntOp $WaveCloseLevel $WaveCloseLevel + 1
    Call WaveUpdateCloseImage
  ${ElseIf} $WaveCloseLevel > $WaveCloseTarget
    IntOp $WaveCloseLevel $WaveCloseLevel - 1
    Call WaveUpdateCloseImage
  ${Else}
    ${NSD_KillTimer} WaveCloseFadeTick
  ${EndIf}
FunctionEnd

Function WaveStartCloseFade
  ${NSD_KillTimer} WaveCloseFadeTick
  ${If} $WaveCloseLevel != $WaveCloseTarget
    ${NSD_CreateTimer} WaveCloseFadeTick 40
  ${EndIf}
FunctionEnd

Function WaveHoverTick
  System::Call "user32::IsWindowVisible(p $HWNDPARENT) i.r0"
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call "user32::IsIconic(p $HWNDPARENT) i.r0"
  ${If} $0 != 0
    Return
  ${EndIf}
  System::Call "user32::GetForegroundWindow() p.r0"
  ${If} $0 != $HWNDPARENT
    Return
  ${EndIf}
  System::Call "user32::GetCursorPos(@r9)"
  System::Call "*$9(i.r0, i.r1)"
  System::Free $9
  StrCpy $WaveCursorX $0
  StrCpy $WaveCursorY $1
  StrCpy $WavePointerWasDown $WavePointerDown
  System::Call "user32::GetAsyncKeyState(i 1) i.r6"
  IntOp $WavePointerDown $6 & 0x8000
  System::Call "user32::GetWindowRect(p $WaveClose, @r9)"
  System::Call "*$9(i.r2, i.r3, i.r4, i.r5)"
  System::Free $9
  ${If} $WaveCursorX >= $2
  ${AndIf} $WaveCursorX <= $4
  ${AndIf} $WaveCursorY >= $3
  ${AndIf} $WaveCursorY <= $5
    StrCpy $WaveCloseWasHover "1"
    StrCpy $WaveCloseTarget "5"
    Call WaveStartCloseFade
    ${If} $WaveInstFilesActive == "1"
    ${AndIf} $WavePointerDown != 0
    ${AndIf} $WavePointerWasDown == 0
      Call WaveCancel
    ${EndIf}
  ${Else}
    ${If} $WaveCloseInitialDone == "0"
      IntOp $WaveCloseTicks $WaveCloseTicks + 1
      ${If} $WaveCloseTicks >= 20
        StrCpy $WaveCloseInitialDone "1"
        StrCpy $WaveCloseTarget "0"
        Call WaveStartCloseFade
      ${EndIf}
    ${ElseIf} $WaveCloseWasHover == "1"
      StrCpy $WaveCloseWasHover "0"
      StrCpy $WaveCloseTarget "0"
      Call WaveStartCloseFade
    ${EndIf}
    System::Call "user32::GetWindowRect(p $HWNDPARENT, @r9)"
    System::Call "*$9(i.r2, i.r3, i.r4, i.r5)"
    System::Free $9
    IntOp $7 $3 + 52
    ${If} $WavePointerDown != 0
    ${AndIf} $WaveCursorY >= $3
    ${AndIf} $WaveCursorY <= $7
      SendMessage $HWNDPARENT ${WF_WM_NCLBUTTONDOWN} ${WF_HTCAPTION} 0
    ${EndIf}
  ${EndIf}
  !insertmacro WaveHoverSlot $WaveHoverControl $WaveHoverNormal $WaveHoverImage $WaveHoverPressed $WaveHoverCurrent
  !insertmacro WaveHoverSlot $WaveHoverControl2 $WaveHoverNormal2 $WaveHoverImage2 $WaveHoverPressed2 $WaveHoverCurrent2
  !insertmacro WaveHoverSlot $WaveHoverControl3 $WaveHoverNormal3 $WaveHoverImage3 $WaveHoverPressed3 $WaveHoverCurrent3
  !insertmacro WaveHoverSlot $WaveHoverControl4 $WaveHoverNormal4 $WaveHoverImage4 $WaveHoverPressed4 $WaveHoverCurrent4
  System::Call "user32::GetFocus() p.r7"
  System::Call "user32::GetAsyncKeyState(i 13) i.r6"
  IntOp $6 $6 & 0x8000
  ${If} $6 != 0
  ${AndIf} $WaveEnterDown == "0"
    StrCpy $WaveEnterDown "1"
    Call WaveKeyboardActivate
  ${ElseIf} $6 == 0
    StrCpy $WaveEnterDown "0"
  ${EndIf}
  System::Call "user32::GetAsyncKeyState(i 32) i.r6"
  IntOp $6 $6 & 0x8000
  ${If} $6 != 0
  ${AndIf} $WaveSpaceDown == "0"
    StrCpy $WaveSpaceDown "1"
    Call WaveKeyboardActivate
  ${ElseIf} $6 == 0
    StrCpy $WaveSpaceDown "0"
  ${EndIf}
  !ifdef WF_PREVIEW
    ${If} $WaveInstFilesActive == "1"
      SendMessage $WaveProgressPath ${WF_PBM_GETPOS} 0 0 $0
      ${If} $0 == 0
        SendMessage $WaveProgressPath ${PBM_SETPOS} 11400 0
      ${EndIf}
    ${EndIf}
  !endif
  Call WaveAnimationTick
FunctionEnd

Function WaveKeyboardActivate
  ${If} $7 == $WaveHoverControl
  ${OrIf} $7 == $WaveHoverControl2
  ${OrIf} $7 == $WaveHoverControl3
  ${OrIf} $7 == $WaveHoverControl4
    System::Call "user32::GetDlgCtrlID(p r7) i.r6"
    SendMessage $WavePage ${WM_COMMAND} $6 $7
  ${EndIf}
FunctionEnd

Function WaveCancel
  ${If} $WaveFinishActive == "1"
    Call WaveFinishDone
    Return
  ${EndIf}
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd
Function WaveNext
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function WaveBack
  SendMessage $HWNDPARENT ${WM_COMMAND} ${WF_IDBACK} 0
FunctionEnd

Function WaveSkipInitialPage
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $WaveIsUpdate == "1"
    Abort
  ${EndIf}
  ${If} $WaveForceAllUsers == "1"
    StrCpy $WaveInstallScope "all"
    Abort
  ${EndIf}
FunctionEnd

Function WaveThemeCreate
  Call WaveSkipInitialPage
  !insertmacro WavePageStop
  nsDialogs::Create 1018
  Pop $WavePage
  System::Call "user32::MoveWindow(p $WavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  !insertmacro WaveResetControls
  !insertmacro WaveHideBuilderButtons
  ${NSD_CreateBitmap} 0 0 ${WF_W} ${WF_H} ""
  Pop $WaveBackground
  ${NSD_SetBitmap} $WaveBackground "$PLUGINSDIR\theme.bmp" $WaveBackgroundImage
  !insertmacro WaveCreateAnimation theme
  !insertmacro WaveImageButton $WaveThemeDark 138 304 284 172 "card-dark.bmp" "card-dark-hover.bmp" "card-dark-pressed.bmp" WaveThemeDarkClick
  !insertmacro WaveImageButton $WaveThemeLight 458 304 284 172 "card-light.bmp" "card-light-hover.bmp" "card-light-pressed.bmp" WaveThemeLightClick
  ${If} $WaveInstallScope == "all"
    !insertmacro WaveImageButton $WaveScopeCurrent 250 246 140 34 "scope-current-normal.bmp" "scope-current-normal.bmp" "scope-current-normal.bmp" WaveScopeCurrentClick
    !insertmacro WaveImageButton $WaveScopeAll 390 246 220 34 "scope-all-selected.bmp" "scope-all-selected.bmp" "scope-all-selected.bmp" WaveScopeAllClick
  ${Else}
    !insertmacro WaveImageButton $WaveScopeCurrent 250 246 140 34 "scope-current-selected.bmp" "scope-current-selected.bmp" "scope-current-selected.bmp" WaveScopeCurrentClick
    !insertmacro WaveImageButton $WaveScopeAll 390 246 220 34 "scope-all-normal.bmp" "scope-all-normal.bmp" "scope-all-normal.bmp" WaveScopeAllClick
  ${EndIf}
  StrCpy $WaveCloseImage $WaveCloseTheme5
  StrCpy $WaveAnimationTheme "theme"
  Call WaveCreateClose
  ${NSD_CreateTimer} WaveHoverTick 250
  System::Call "user32::SetWindowPos(p $WaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  nsDialogs::Show
FunctionEnd
Function WaveThemeDarkClick
  StrCpy $WaveTheme "dark"
  Call WaveNext
FunctionEnd
Function WaveThemeLightClick
  StrCpy $WaveTheme "light"
  Call WaveNext
FunctionEnd
Function WaveScopeCurrentClick
  ${If} $WaveInstallScope != "current"
    StrCpy $WaveInstallScope "current"
    Call WaveUpdateScopeVisual
  ${EndIf}
FunctionEnd
Function WaveScopeAllClick
  ${If} $WaveInstallScope != "all"
    StrCpy $WaveInstallScope "all"
    Call WaveUpdateScopeVisual
  ${EndIf}
FunctionEnd
Function WaveUpdateScopeVisual
  ${If} $WaveInstallScope == "all"
    StrCpy $0 "$PLUGINSDIR\scope-current-normal.bmp"
    StrCpy $1 "$PLUGINSDIR\scope-all-selected.bmp"
  ${Else}
    StrCpy $0 "$PLUGINSDIR\scope-current-selected.bmp"
    StrCpy $1 "$PLUGINSDIR\scope-all-normal.bmp"
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w r0, i 0, i 0, i 0, i 0x10) p.r2'
  System::Call 'user32::LoadImageW(p 0, w r1, i 0, i 0, i 0, i 0x10) p.r3'
  SendMessage $WaveScopeCurrent ${WF_STM_SETIMAGE} 0 $2 $4
  SendMessage $WaveScopeAll ${WF_STM_SETIMAGE} 0 $3 $5
  !insertmacro WaveReleaseImages $WaveHoverNormal3 $WaveHoverImage3 $WaveHoverPressed3
  !insertmacro WaveReleaseImages $WaveHoverNormal4 $WaveHoverImage4 $WaveHoverPressed4
  StrCpy $WaveHoverNormal3 $2
  StrCpy $WaveHoverImage3 $2
  StrCpy $WaveHoverPressed3 $2
  StrCpy $WaveHoverCurrent3 $2
  StrCpy $WaveHoverNormal4 $3
  StrCpy $WaveHoverImage4 $3
  StrCpy $WaveHoverPressed4 $3
  StrCpy $WaveHoverCurrent4 $3
FunctionEnd
Function WaveThemeLeave
  !insertmacro WavePageStop
FunctionEnd
Function WavePageLeave
  !insertmacro WavePageStop
FunctionEnd

Function WaveWelcomeCreate
  Call WaveSkipInitialPage
  !insertmacro WavePageStart welcome
  !insertmacro WaveThemeButton $WaveBack ${WF_CX} 452 160 44 secondary 取消安装 WaveCancel
  !insertmacro WaveThemeButton $WaveNext 700 452 160 44 primary 下一步 WaveNext
  !insertmacro WavePageReady
FunctionEnd

Function WaveLicenseCreate
  Call WaveSkipInitialPage
  !insertmacro WavePageStart license
  ${If} $WaveTheme == "dark"
    StrCpy $0 "agreement-dark-unchecked.bmp"
    ${If} $WaveAgreementState == "1"
      StrCpy $0 "agreement-dark-checked.bmp"
    ${EndIf}
  ${Else}
    StrCpy $0 "agreement-light-unchecked.bmp"
    ${If} $WaveAgreementState == "1"
      StrCpy $0 "agreement-light-checked.bmp"
    ${EndIf}
  ${EndIf}
  !insertmacro WaveImageButton $WaveLicenseCheck ${WF_CX} 408 380 34 "$0" "$0" "$0" WaveLicenseToggle
  !insertmacro WaveThemeButton $WaveBack ${WF_CX} 452 120 44 secondary 上一步 WaveBack
  !insertmacro WaveThemeButton $WaveNext 660 452 200 44 primary 同意并继续 WaveLicenseNext
  Call WaveUpdateAgreementVisual
  !insertmacro WavePageReady
FunctionEnd

Function WaveUpdateAgreementVisual
  ${If} $WaveTheme == "dark"
    StrCpy $0 "dark"
  ${Else}
    StrCpy $0 "light"
  ${EndIf}
  ${If} $WaveAgreementState == "1"
    StrCpy $1 "$PLUGINSDIR\agreement-$0-checked.bmp"
    StrCpy $2 "$PLUGINSDIR\btn-primary-$0-同意并继续.bmp"
    StrCpy $3 "$PLUGINSDIR\btn-primary-$0-同意并继续-hover.bmp"
    StrCpy $4 "$PLUGINSDIR\btn-primary-$0-同意并继续-pressed.bmp"
  ${Else}
    StrCpy $1 "$PLUGINSDIR\agreement-$0-unchecked.bmp"
    StrCpy $2 "$PLUGINSDIR\btn-primary-$0-同意并继续-disabled.bmp"
    StrCpy $3 $2
    StrCpy $4 $2
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w r1, i 0, i 0, i 0, i 0x10) p.r5'
  SendMessage $WaveLicenseCheck ${WF_STM_SETIMAGE} 0 $5 $6
  !insertmacro WaveReleaseImages $WaveHoverNormal $WaveHoverImage $WaveHoverPressed
  StrCpy $WaveHoverNormal $5
  StrCpy $WaveHoverImage $5
  StrCpy $WaveHoverPressed $5
  StrCpy $WaveHoverCurrent $5
  System::Call 'user32::LoadImageW(p 0, w r2, i 0, i 0, i 0, i 0x10) p.r5'
  System::Call 'user32::LoadImageW(p 0, w r3, i 0, i 0, i 0, i 0x10) p.r6'
  System::Call 'user32::LoadImageW(p 0, w r4, i 0, i 0, i 0, i 0x10) p.r7'
  SendMessage $WaveNext ${WF_STM_SETIMAGE} 0 $5 $8
  !insertmacro WaveReleaseImages $WaveHoverNormal3 $WaveHoverImage3 $WaveHoverPressed3
  StrCpy $WaveHoverNormal3 $5
  StrCpy $WaveHoverImage3 $6
  StrCpy $WaveHoverPressed3 $7
  StrCpy $WaveHoverCurrent3 $5
FunctionEnd
Function WaveLicenseToggle
  ${If} $WaveAgreementState == "1"
    StrCpy $WaveAgreementState "0"
  ${Else}
    StrCpy $WaveAgreementState "1"
  ${EndIf}
  Call WaveUpdateAgreementVisual
FunctionEnd
Function WaveLicenseNext
  ${If} $WaveAgreementState == "1"
    Call WaveNext
  ${Else}
    MessageBox MB_ICONINFORMATION "请先阅读并勾选同意以上条款。"
  ${EndIf}
FunctionEnd
Function WaveLicenseLeave
  ${If} $WaveAgreementState != "1"
    Abort
  ${EndIf}
  !insertmacro WavePageStop
FunctionEnd

Function WaveOptionsCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  ${If} $WaveIsUpdate == "1"
    Abort
  ${EndIf}
  !insertmacro WavePageStart dir
  ${NSD_CreateText} 310 226 446 24 "$INSTDIR"
  Pop $WaveDirEdit
  System::Call "user32::GetWindowLongW(p $WaveDirEdit, i -16) i.r0"
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call "user32::SetWindowLongW(p $WaveDirEdit, i -16, i r0)"
  System::Call "user32::GetWindowLongW(p $WaveDirEdit, i -20) i.r0"
  IntOp $0 $0 & 0xFFFFFDFF
  System::Call "user32::SetWindowLongW(p $WaveDirEdit, i -20, i r0)"
  SendMessage $WaveDirEdit ${WM_SETFONT} $WaveFont 1
  SendMessage $WaveDirEdit ${WF_EM_SETMARGINS} ${WF_EC_LEFTMARGIN}|${WF_EC_RIGHTMARGIN} 0x000C000C
  ${If} $WaveTheme == "dark"
    SetCtlColors $WaveDirEdit 0xE8EEF8 0x111C2F
  ${Else}
    SetCtlColors $WaveDirEdit 0x172033 0xFFFFFF
  ${EndIf}
  ${NSD_OnChange} $WaveDirEdit WaveDirectoryChanged
  !insertmacro WaveThemeButton $WaveBrowseButton 776 215 52 44 secondary 浏览 WaveBrowse
  ${NSD_CreateLabel} 322 303 490 18 ""
  Pop $WaveSpaceLabel
  SendMessage $WaveSpaceLabel ${WM_SETFONT} $WaveSmallFont 1
  ${If} $WaveTheme == "dark"
    SetCtlColors $WaveSpaceLabel 0xE8EEF8 0x1B2940
    StrCpy $0 "desktop-dark-$WaveDesktopShortcutState.bmp"
  ${Else}
    SetCtlColors $WaveSpaceLabel 0x172033 0xF0F4F9
    StrCpy $0 "desktop-light-$WaveDesktopShortcutState.bmp"
  ${EndIf}
  ${If} $WaveDesktopShortcutState == "1"
    ${If} $WaveTheme == "dark"
      StrCpy $0 "desktop-dark-checked.bmp"
    ${Else}
      StrCpy $0 "desktop-light-checked.bmp"
    ${EndIf}
  ${Else}
    ${If} $WaveTheme == "dark"
      StrCpy $0 "desktop-dark-unchecked.bmp"
    ${Else}
      StrCpy $0 "desktop-light-unchecked.bmp"
    ${EndIf}
  ${EndIf}
  !insertmacro WaveImageButton $WaveDesktopShortcutControl ${WF_CX} 408 260 34 "$0" "$0" "$0" WaveDesktopShortcutToggle
  !insertmacro WaveThemeButton $WaveBack 560 452 120 44 secondary 上一步 WaveBack
  !insertmacro WaveThemeButton $WaveNext 700 452 160 44 primary 安装 WaveNext
  Call WaveUpdateSpace
  SendMessage $WaveDirEdit ${EM_SETSEL} -1 -1
  SendMessage $WaveDirEdit ${WF_EM_SCROLLCARET} 0 0
  System::Call "user32::SetFocus(p $WaveNext)"
  !insertmacro WavePageReady
FunctionEnd
Function WaveDirectoryChanged
  Call WaveUpdateSpace
FunctionEnd
Function WaveValidatePathSyntax
  StrCpy $WavePathError ""
  StrCpy $WaveValidatedPath ""
  StrCpy $0 $0 -1
  ${If} $0 == ""
    StrCpy $WavePathError "安装路径不能为空。"
    Return
  ${EndIf}
  StrCpy $7 $0 1 -1
  ${If} $7 == " "
  ${OrIf} $7 == "."
    StrCpy $WavePathError "安装路径不能以空格或句点结尾。"
    Return
  ${EndIf}
  StrCpy $1 $0 1
  StrCpy $2 $0 1 1
  StrCpy $3 $0 1 2
  StrCpy $7 $0 1 3
  ${If} $1 == "\"
  ${AndIf} $2 == "\"
  ${AndIf} $7 == "\"
    ${If} $3 == "?"
    ${OrIf} $3 == "."
      StrCpy $WavePathError "不支持 Windows 设备路径。"
      Return
    ${EndIf}
  ${EndIf}
  ${If} $1 == "\"
  ${AndIf} $2 == "\"
    StrCpy $WavePathError "不支持网络 UNC 路径，请选择本地磁盘。"
    Return
  ${EndIf}
  ${If} $2 != ":"
  ${OrIf} $3 != "\"
    StrCpy $WavePathError "请输入盘符开头的绝对路径，例如 C:\Program Files\WaveForge。"
    Return
  ${EndIf}
  StrCpy $4 0
  StrLen $5 $0
  ${DoWhile} $4 < $5
    StrCpy $6 $0 1 $4
    ${If} $4 > 1
      ${If} $6 == ":"
      ${OrIf} $6 == "*"
      ${OrIf} $6 == "?"
      ${OrIf} $6 == '"'
      ${OrIf} $6 == "<"
      ${OrIf} $6 == ">"
      ${OrIf} $6 == "|"
        StrCpy $WavePathError "安装路径包含 Windows 不允许的字符。"
        Return
      ${EndIf}
    ${EndIf}
    IntOp $4 $4 + 1
  ${Loop}
  System::Call 'kernel32::GetFullPathNameW(w r0, i ${NSIS_MAX_STRLEN}, w .r1, p 0) i.r2'
  ${If} $2 == 0
    StrCpy $WavePathError "无法解析安装路径。"
    Return
  ${EndIf}
  StrCpy $WaveValidatedPath $1
  ${GetRoot} "$WaveValidatedPath" $2
  ${If} $2 == ""
    StrCpy $WavePathError "安装路径没有有效的本地磁盘根目录。"
    Return
  ${EndIf}
  ${GetFileName} "$WaveValidatedPath" $3
  ${GetBaseName} "$3" $4
  ${If} $4 == "CON"
  ${OrIf} $4 == "PRN"
  ${OrIf} $4 == "AUX"
  ${OrIf} $4 == "NUL"
  ${OrIf} $4 == "COM1"
  ${OrIf} $4 == "COM2"
  ${OrIf} $4 == "COM3"
  ${OrIf} $4 == "COM4"
  ${OrIf} $4 == "COM5"
  ${OrIf} $4 == "COM6"
  ${OrIf} $4 == "COM7"
  ${OrIf} $4 == "COM8"
  ${OrIf} $4 == "COM9"
  ${OrIf} $4 == "LPT1"
  ${OrIf} $4 == "LPT2"
  ${OrIf} $4 == "LPT3"
  ${OrIf} $4 == "LPT4"
  ${OrIf} $4 == "LPT5"
  ${OrIf} $4 == "LPT6"
  ${OrIf} $4 == "LPT7"
  ${OrIf} $4 == "LPT8"
  ${OrIf} $4 == "LPT9"
    StrCpy $WavePathError "安装路径不能使用 Windows 保留设备名。"
  ${EndIf}
FunctionEnd

Function WaveUpdateSpace
  ${NSD_GetText} $WaveDirEdit $0
  Call WaveValidatePathSyntax
  ${If} $WavePathError != ""
    ${NSD_SetText} $WaveSpaceLabel "$WavePathError"
    Return
  ${EndIf}
  ${GetRoot} "$WaveValidatedPath" $1
  ${DriveSpace} "$1" "/D=F /S=M" $2
  ${If} $2 == ""
    ${NSD_SetText} $WaveSpaceLabel "磁盘 $1 · 空间信息暂不可用"
    Return
  ${EndIf}
  !ifdef ESTIMATED_SIZE
    IntOp $WaveRequiredMb ${ESTIMATED_SIZE} / 1024
    IntOp $WaveRequiredMb $WaveRequiredMb + 1
    IntOp $3 $WaveRequiredMb / 10
    IntOp $3 $3 + $WaveRequiredMb
    IntOp $3 $3 + 64
    ${If} $2 < $3
      ${NSD_SetText} $WaveSpaceLabel "磁盘 $1 · 可用 $2 MB · 至少需要 $3 MB（含余量）"
    ${Else}
      ${NSD_SetText} $WaveSpaceLabel "磁盘 $1 · 可用 $2 MB · 预计 $WaveRequiredMb MB，已保留余量"
    ${EndIf}
  !else
    StrCpy $WaveRequiredMb 0
    ${NSD_SetText} $WaveSpaceLabel "磁盘 $1 · 可用 $2 MB · 安装体积以构建包为准"
  !endif
FunctionEnd
Function WaveBrowse
  nsDialogs::SelectFolderDialog "选择 ${PRODUCT_NAME} 安装目录" "$INSTDIR"
  Pop $0
  ${If} $0 != error
  ${AndIf} $0 != ""
    ${NSD_SetText} $WaveDirEdit $0
    Call WaveUpdateSpace
  ${EndIf}
FunctionEnd
Function WaveDesktopShortcutToggle
  ${If} $WaveDesktopShortcutState == "1"
    StrCpy $WaveDesktopShortcutState "0"
  ${Else}
    StrCpy $WaveDesktopShortcutState "1"
  ${EndIf}
  ${If} $WaveTheme == "dark"
    StrCpy $0 "$PLUGINSDIR\desktop-dark-unchecked.bmp"
    ${If} $WaveDesktopShortcutState == "1"
      StrCpy $0 "$PLUGINSDIR\desktop-dark-checked.bmp"
    ${EndIf}
  ${Else}
    StrCpy $0 "$PLUGINSDIR\desktop-light-unchecked.bmp"
    ${If} $WaveDesktopShortcutState == "1"
      StrCpy $0 "$PLUGINSDIR\desktop-light-checked.bmp"
    ${EndIf}
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w r0, i 0, i 0, i 0, i 0x10) p.r1'
  SendMessage $WaveDesktopShortcutControl ${WF_STM_SETIMAGE} 0 $1 $2
  !insertmacro WaveReleaseImages $WaveHoverNormal2 $WaveHoverImage2 $WaveHoverPressed2
  StrCpy $WaveHoverNormal2 $1
  StrCpy $WaveHoverImage2 $1
  StrCpy $WaveHoverPressed2 $1
  StrCpy $WaveHoverCurrent2 $1
FunctionEnd
Function WaveOptionsLeave
  ${NSD_GetText} $WaveDirEdit $0
  Call WaveValidatePathSyntax
  ${If} $WavePathError != ""
    MessageBox MB_ICONEXCLAMATION "$WavePathError"
    Abort
  ${EndIf}
  ${GetRoot} "$WaveValidatedPath" $1
  ${DriveSpace} "$1" "/D=F /S=M" $2
  ${If} $2 == ""
    MessageBox MB_ICONEXCLAMATION "无法读取目标磁盘的可用空间。"
    Abort
  ${EndIf}
  !ifdef ESTIMATED_SIZE
    IntOp $WaveRequiredMb ${ESTIMATED_SIZE} / 1024
    IntOp $WaveRequiredMb $WaveRequiredMb + 1
    IntOp $3 $WaveRequiredMb / 10
    IntOp $3 $3 + $WaveRequiredMb
    IntOp $3 $3 + 64
    ${If} $2 < $3
      MessageBox MB_ICONEXCLAMATION "目标磁盘空间不足。可用 $2 MB，至少需要 $3 MB（含安装余量）。"
      Abort
    ${EndIf}
  !endif
  ClearErrors
  CreateDirectory "$WaveValidatedPath"
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "无法创建安装目录。请检查路径、权限和保留设备名。"
    Abort
  ${EndIf}
  ClearErrors
  GetTempFileName $WaveProbeFile "$WaveValidatedPath"
  ${If} ${Errors}
  ${OrIf} $WaveProbeFile == ""
    MessageBox MB_ICONEXCLAMATION "安装目录不可写。请选择具有写入权限的本地目录。"
    Abort
  ${EndIf}
  Delete "$WaveProbeFile"
  ${If} ${Errors}
    MessageBox MB_ICONEXCLAMATION "无法清理安装目录写入探针，请检查安全软件或目录权限。"
    Abort
  ${EndIf}
  StrCpy $INSTDIR $WaveValidatedPath
  !insertmacro WavePageStop
FunctionEnd

Function WaveInstFilesPre
  !insertmacro WavePageStop
  StrCpy $WaveInstFilesActive "0"
FunctionEnd
Function WaveInstFilesShow
  ${If} ${Silent}
    Return
  ${EndIf}
  FindWindow $WavePage "#32770" "" $HWNDPARENT
  ${If} $WavePage == ""
    Return
  ${EndIf}
  System::Call "user32::MoveWindow(p $WavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  !insertmacro WaveResetControls
  ${If} $WaveTheme == "light"
    StrCpy $0 "$PLUGINSDIR\inst-light.bmp"
    StrCpy $WaveCloseImage $WaveCloseLight5
    StrCpy $1 "light"
  ${Else}
    StrCpy $0 "$PLUGINSDIR\inst-dark.bmp"
    StrCpy $WaveCloseImage $WaveCloseDark5
    StrCpy $1 "dark"
  ${EndIf}
  System::Call 'user32::LoadImageW(p 0, w r0, i 0, i 0, i 0, i 0x10) p.r2'
  StrCpy $WaveBackgroundImage $2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${WF_WS_CHILD}|${WF_WS_VISIBLE}|${WF_SS_BITMAP}, i 0, i 0, i ${WF_W}, i ${WF_H}, p $WavePage, p 0, p 0, p 0) p.r3'
  StrCpy $WaveBackground $3
  SendMessage $WaveBackground ${WF_STM_SETIMAGE} 0 $2
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${WF_WS_CHILD}|${WF_WS_VISIBLE}|${WF_SS_BITMAP}, i ${WF_ANIM_X}, i ${WF_ANIM_Y}, i ${WF_ANIM_W}, i ${WF_ANIM_H}, p $WavePage, p 0, p 0, p 0) p.r3'
  StrCpy $WaveAnimation $3
  StrCpy $WaveAnimationTheme $1
  StrCpy $WaveAnimationFrame "0"
  StrCpy $WaveAnimationTickCount "0"
  !insertmacro WaveAnimationHandle $WaveAnimationImage $1 0
  SendMessage $WaveAnimation ${WF_STM_SETIMAGE} 0 $WaveAnimationImage
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${WF_WS_CHILD}|${WF_WS_VISIBLE}|${WF_SS_NOTIFY}|${WF_SS_BITMAP}, i 828, i 10, i 40, i 40, p $WavePage, p 0, p 0, p 0) p.r3'
  StrCpy $WaveClose $3
  SendMessage $WaveClose ${WF_STM_SETIMAGE} 0 $WaveCloseImage
  GetDlgItem $WaveProgressPath $WavePage 1004
  System::Call "user32::MoveWindow(p $WaveProgressPath, i 304, i 204, i 512, i 12, i 1)"
  System::Call 'uxtheme::SetWindowTheme(p $WaveProgressPath, w "", w "")'
  System::Call "user32::GetWindowLongW(p $WaveProgressPath, i -16) i.r0"
  IntOp $0 $0 & 0xFF7FFFFF
  System::Call "user32::SetWindowLongW(p $WaveProgressPath, i -16, i r0)"
  ${If} $WaveTheme == "light"
    SendMessage $WaveProgressPath ${WF_PBM_SETBARCOLOR} 0 0xCE6B24
    SendMessage $WaveProgressPath ${WF_PBM_SETBKCOLOR} 0 0xF9F4F0
  ${Else}
    SendMessage $WaveProgressPath ${WF_PBM_SETBARCOLOR} 0 0xF7914B
    SendMessage $WaveProgressPath ${WF_PBM_SETBKCOLOR} 0 0x40291B
  ${EndIf}
  System::Call "user32::SetWindowPos(p $WaveProgressPath, p 0, i 0, i 0, i 0, i 0, i 0x0013)"
  GetDlgItem $0 $WavePage 1006
  System::Call "user32::MoveWindow(p $0, i 304, i 232, i 512, i 30, i 1)"
  ${NSD_CreateLabel} 304 272 512 20 "目标：$INSTDIR"
  Pop $WaveProgressPathText
  SendMessage $WaveProgressPathText ${WM_SETFONT} $WaveSmallFont 1
  ${If} $WaveTheme == "light"
    SetCtlColors $WaveProgressPathText 0x607086 0xF7F9FC
  ${Else}
    SetCtlColors $WaveProgressPathText 0x9AAAC0 0x0F172A
  ${EndIf}
  GetDlgItem $0 $WavePage 1005
  ShowWindow $0 ${SW_HIDE}
  System::Call "user32::SetWindowPos(p $WaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  StrCpy $WaveInstFilesActive "1"
  ${NSD_CreateTimer} WaveHoverTick 250
FunctionEnd
Function WaveInstFilesLeave
  StrCpy $WaveInstFilesActive "0"
  !insertmacro WavePageStop
FunctionEnd

Function WaveFinishCreate
  ${If} ${Silent}
    Abort
  ${EndIf}
  StrCpy $WaveFinishActive "1"
  !insertmacro WavePageStart finish
  ${NSD_CreateLabel} 304 344 512 18 ""
  Pop $WaveFinishPath
  ${NSD_AddStyle} $WaveFinishPath ${WF_SS_NOTIFY}
  ${NSD_OnClick} $WaveFinishPath WaveCopyInstallPath
  SendMessage $WaveFinishPath ${WM_SETFONT} $WaveSmallFont 1
  ${If} $WaveTheme == "dark"
    SetCtlColors $WaveFinishPath 0xE8EEF8 0x162033
  ${Else}
    SetCtlColors $WaveFinishPath 0x172033 0xFFFFFF
  ${EndIf}
  ${NSD_SetText} $WaveFinishPath "$INSTDIR"
  System::Call "user32::InvalidateRect(p $WaveFinishPath, p 0, i 1)"
  !insertmacro WaveThemeButton $WaveBack ${WF_CX} 452 120 44 secondary 完成 WaveFinishDone
  !insertmacro WaveThemeButton $WaveNext 700 452 160 44 primary 立即打开 WaveFinishRun
  !insertmacro WavePageReady
FunctionEnd
Function WaveCopyInstallPath
  System::Call 'user32::OpenClipboard(p $HWNDPARENT) i.r0'
  ${If} $0 != 0
    System::Call 'user32::EmptyClipboard()'
    StrLen $1 $INSTDIR
    IntOp $1 $1 + 1
    IntOp $1 $1 * 2
    System::Call 'kernel32::GlobalAlloc(i 0x0042, i r1) p.r2'
    System::Call 'kernel32::GlobalLock(p r2) p.r3'
    System::Call 'kernel32::lstrcpyW(p r3, w "$INSTDIR")'
    System::Call 'kernel32::GlobalUnlock(p r2)'
    System::Call 'user32::SetClipboardData(i 13, p r2) p.r0'
    System::Call 'user32::CloseClipboard()'
  ${EndIf}
FunctionEnd

Function WaveFinishDone
  StrCpy $WaveFinishActive "0"
  !insertmacro WavePageStop
  Quit
FunctionEnd

!else
!ifdef removeDefaultUninstallWelcomePage
  !undef removeDefaultUninstallWelcomePage
!endif
!define MUI_CUSTOMFUNCTION_UNGUIINIT un.WaveUnGuiInit
!macro WaveUnLoadImage OUT FILE
  System::Call 'user32::LoadImageW(p 0, w "$PLUGINSDIR\${FILE}", i 0, i 0, i 0, i 0x10) p.s'
  Pop ${OUT}
!macroend
!define MUI_UNABORTWARNING
!define MUI_UNABORTWARNING_TEXT "你确定要取消卸载 ${PRODUCT_NAME} 吗？"

Var UnWavePage
Var UnWaveBackground
Var UnWaveBackgroundImage
Var UnWaveClose
Var UnWaveCloseCurrent
Var UnWaveCloseLevel
Var UnWaveCloseTicks
Var UnWaveCloseInitialDone
Var UnWaveCloseWasHover
Var UnWaveCloseTarget
Var UnWaveClose0
Var UnWaveClose1
Var UnWaveClose2
Var UnWaveClose3
Var UnWaveClose4
Var UnWaveClose5
Var UnWaveButton
Var UnWaveButtonImage
Var UnWaveButton2
Var UnWaveButtonImage2
Var UnWavePath
Var UnWaveScope
Var UnWaveProgress
Var UnWaveProgressActive
Var UnWaveFinishActive
Var UnWaveFont

!macro customUnInit
  ${IfNot} ${Silent}
    InitPluginsDir
    SetOutPath "$PLUGINSDIR"
    File "${BUILD_RESOURCES_DIR}\ui\*.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose0 "close-dark-0.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose1 "close-dark-1.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose2 "close-dark-2.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose3 "close-dark-3.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose4 "close-dark-4.bmp"
    !insertmacro WaveUnLoadImage $UnWaveClose5 "close-dark-5.bmp"
    System::Call "gdi32::CreateFontW(i -13,i 0,i 0,i 0,i 400,i 0,i 0,i 0,i 1,i 0,i 0,i 5,i 0,w 'Microsoft YaHei UI') p.r0"
    StrCpy $UnWaveFont $0
  ${EndIf}
!macroend

!macro customUnWelcomePage
  UninstPage custom un.WaveUnConfirmCreate un.WaveUnConfirmLeave
!macroend

!macro customUnInstall
  Call un.WaveUnInstFilesShow
!macroend

!macro customUninstallPage
  UninstPage custom un.WaveUnFinishCreate un.WaveUnFinishLeave
  !define MUI_PAGE_CUSTOMFUNCTION_PRE un.WaveSkipDefaultFinish
!macroend

!macro WaveUnDeleteImage IMAGE
  ${If} ${IMAGE} != ""
    System::Call 'gdi32::DeleteObject(p ${IMAGE})'
    StrCpy ${IMAGE} ""
  ${EndIf}
!macroend

Function un.WaveReleasePageImages
  ${NSD_KillTimer} un.WaveTick
  ${NSD_KillTimer} un.WaveCloseFadeTick
  !insertmacro WaveUnDeleteImage $UnWaveBackgroundImage
  !insertmacro WaveUnDeleteImage $UnWaveButtonImage
  !insertmacro WaveUnDeleteImage $UnWaveButtonImage2
  StrCpy $UnWaveBackground ""
  StrCpy $UnWaveButton ""
  StrCpy $UnWaveButton2 ""
  StrCpy $UnWaveClose ""
FunctionEnd

Function un.onGUIEnd
  Call un.WaveReleasePageImages
  !insertmacro WaveUnDeleteImage $UnWaveClose0
  !insertmacro WaveUnDeleteImage $UnWaveClose1
  !insertmacro WaveUnDeleteImage $UnWaveClose2
  !insertmacro WaveUnDeleteImage $UnWaveClose3
  !insertmacro WaveUnDeleteImage $UnWaveClose4
  !insertmacro WaveUnDeleteImage $UnWaveClose5
  !insertmacro WaveUnDeleteImage $UnWaveFont
FunctionEnd

Function un.WaveApplyWindowShape
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 33, *i 2, i 4) i.r0'
  ${If} $0 != 0
    System::Call 'gdi32::CreateRoundRectRgn(i 0, i 0, i ${WF_W}, i ${WF_H}, i 28, i 28) p.r1'
    System::Call 'user32::SetWindowRgn(p $HWNDPARENT, p r1, i 1) i.r0'
    ${If} $0 == 0
      System::Call 'gdi32::DeleteObject(p r1)'
    ${EndIf}
  ${EndIf}
  System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r0"
  IntOp $0 $0 | ${WF_WS_CLIPCHILDREN}
  System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)"
FunctionEnd

Function un.WaveUnGuiInit
  ${If} ${Silent}
    Return
  ${EndIf}
  System::Call "user32::GetWindowLongW(p $HWNDPARENT, i -16) i.r0"
  IntOp $0 $0 & 0xFF3BFFFF
  System::Call "user32::SetWindowLongW(p $HWNDPARENT, i -16, i r0)"
  System::Call "user32::SetWindowTextW(p $HWNDPARENT, w '')"
  System::Call "user32::GetSystemMetrics(i 0) i.r0"
  IntOp $0 $0 - ${WF_W}
  IntOp $0 $0 / 2
  System::Call "user32::GetSystemMetrics(i 1) i.r1"
  IntOp $1 $1 - ${WF_H}
  IntOp $1 $1 / 2
  System::Call "user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i ${WF_W}, i ${WF_H}, i 0x0020)"
  Call un.WaveApplyWindowShape
FunctionEnd

Function un.WaveHideBuilderButtons
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT ${WF_IDBACK}
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function un.WaveCreateClose
  ${NSD_CreateBitmap} 828 10 40 40 ""
  Pop $UnWaveClose
  ${NSD_AddStyle} $UnWaveClose ${WF_SS_NOTIFY}
  StrCpy $UnWaveCloseLevel 5
  StrCpy $UnWaveCloseTicks 0
  StrCpy $UnWaveCloseInitialDone 0
  StrCpy $UnWaveCloseWasHover 0
  StrCpy $UnWaveCloseTarget 5
  StrCpy $UnWaveCloseCurrent $UnWaveClose5
  SendMessage $UnWaveClose ${WF_STM_SETIMAGE} 0 $UnWaveCloseCurrent
  ${NSD_OnClick} $UnWaveClose un.WaveCloseClick
FunctionEnd

Function un.WaveUpdateClose
  StrCpy $8 $UnWaveClose0
  ${If} $UnWaveCloseLevel == 1
    StrCpy $8 $UnWaveClose1
  ${ElseIf} $UnWaveCloseLevel == 2
    StrCpy $8 $UnWaveClose2
  ${ElseIf} $UnWaveCloseLevel == 3
    StrCpy $8 $UnWaveClose3
  ${ElseIf} $UnWaveCloseLevel == 4
    StrCpy $8 $UnWaveClose4
  ${ElseIf} $UnWaveCloseLevel == 5
    StrCpy $8 $UnWaveClose5
  ${EndIf}
  ${If} $UnWaveCloseCurrent != $8
    SendMessage $UnWaveClose ${WF_STM_SETIMAGE} 0 $8
    StrCpy $UnWaveCloseCurrent $8
  ${EndIf}
FunctionEnd

Function un.WaveCloseFadeTick
  ${If} $UnWaveCloseLevel < $UnWaveCloseTarget
    IntOp $UnWaveCloseLevel $UnWaveCloseLevel + 1
    Call un.WaveUpdateClose
  ${ElseIf} $UnWaveCloseLevel > $UnWaveCloseTarget
    IntOp $UnWaveCloseLevel $UnWaveCloseLevel - 1
    Call un.WaveUpdateClose
  ${Else}
    ${NSD_KillTimer} un.WaveCloseFadeTick
  ${EndIf}
FunctionEnd
Function un.WaveStartCloseFade
  ${NSD_KillTimer} un.WaveCloseFadeTick
  ${If} $UnWaveCloseLevel != $UnWaveCloseTarget
    ${NSD_CreateTimer} un.WaveCloseFadeTick 40
  ${EndIf}
FunctionEnd

Function un.WaveTick
  System::Call "user32::IsWindowVisible(p $HWNDPARENT) i.r0"
  ${If} $0 == 0
    Return
  ${EndIf}
  System::Call "user32::IsIconic(p $HWNDPARENT) i.r0"
  ${If} $0 != 0
    Return
  ${EndIf}
  System::Call "user32::GetForegroundWindow() p.r0"
  ${If} $0 != $HWNDPARENT
    Return
  ${EndIf}
  System::Call "user32::GetCursorPos(@r9)"
  System::Call "*$9(i.r0, i.r1)"
  System::Free $9
  System::Call "user32::GetWindowRect(p $UnWaveClose, @r9)"
  System::Call "*$9(i.r2, i.r3, i.r4, i.r5)"
  System::Free $9
  ${If} $0 >= $2
  ${AndIf} $0 <= $4
  ${AndIf} $1 >= $3
  ${AndIf} $1 <= $5
    StrCpy $UnWaveCloseWasHover 1
    StrCpy $UnWaveCloseTarget 5
    Call un.WaveStartCloseFade
  ${Else}
    ${If} $UnWaveCloseInitialDone == 0
      IntOp $UnWaveCloseTicks $UnWaveCloseTicks + 1
      ${If} $UnWaveCloseTicks >= 20
        StrCpy $UnWaveCloseInitialDone 1
        StrCpy $UnWaveCloseTarget 0
        Call un.WaveStartCloseFade
      ${EndIf}
    ${ElseIf} $UnWaveCloseWasHover == 1
      StrCpy $UnWaveCloseWasHover 0
      StrCpy $UnWaveCloseTarget 0
      Call un.WaveStartCloseFade
    ${EndIf}
  ${EndIf}
FunctionEnd

Function un.WaveCloseClick
  ${If} $UnWaveFinishActive == 1
    Quit
  ${ElseIf} $UnWaveProgressActive == 1
    MessageBox MB_ICONQUESTION|MB_YESNO "卸载正在进行。确定要尝试取消吗？" IDNO done
    SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
  ${Else}
    SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
  ${EndIf}
  done:
FunctionEnd

Function un.WaveCancel
  SendMessage $HWNDPARENT ${WM_COMMAND} 2 0
FunctionEnd
Function un.WaveStart
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd
Function un.WaveDone
  Quit
FunctionEnd

Function un.WaveUnConfirmCreate
  nsDialogs::Create 1018
  Pop $UnWavePage
  System::Call "user32::MoveWindow(p $UnWavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  Call un.WaveHideBuilderButtons
  ${NSD_CreateBitmap} 0 0 ${WF_W} ${WF_H} ""
  Pop $UnWaveBackground
  ${NSD_SetBitmap} $UnWaveBackground "$PLUGINSDIR\unconfirm-dark.bmp" $UnWaveBackgroundImage
  Call un.WaveCreateClose
  ${NSD_CreateLabel} 392 306 424 18 "$INSTDIR"
  Pop $UnWavePath
  SendMessage $UnWavePath ${WM_SETFONT} $UnWaveFont 1
  SetCtlColors $UnWavePath 0xE8EEF8 0x162033
  ReadRegStr $1 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $1 == $INSTDIR
  ${AndIf} $1 != ""
    StrCpy $0 "所有用户（需要管理员权限）"
  ${Else}
    StrCpy $0 "当前用户"
  ${EndIf}
  ${NSD_CreateLabel} 392 338 424 18 "$0"
  Pop $UnWaveScope
  SendMessage $UnWaveScope ${WM_SETFONT} $UnWaveFont 1
  SetCtlColors $UnWaveScope 0xE8EEF8 0x162033
  !insertmacro WaveUnLoadImage $UnWaveButtonImage2 "btn-secondary-dark-取消.bmp"
  ${NSD_CreateBitmap} 560 452 120 44 ""
  Pop $UnWaveButton2
  ${NSD_AddStyle} $UnWaveButton2 ${WF_SS_NOTIFY}|${WF_WS_TABSTOP}
  SendMessage $UnWaveButton2 ${WF_STM_SETIMAGE} 0 $UnWaveButtonImage2
  ${NSD_OnClick} $UnWaveButton2 un.WaveCancel
  !insertmacro WaveUnLoadImage $UnWaveButtonImage "btn-primary-dark-开始卸载.bmp"
  ${NSD_CreateBitmap} 700 452 160 44 ""
  Pop $UnWaveButton
  ${NSD_AddStyle} $UnWaveButton ${WF_SS_NOTIFY}|${WF_WS_TABSTOP}
  SendMessage $UnWaveButton ${WF_STM_SETIMAGE} 0 $UnWaveButtonImage
  ${NSD_OnClick} $UnWaveButton un.WaveStart
  System::Call "user32::SetWindowPos(p $UnWaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  ${NSD_CreateTimer} un.WaveTick 250
  nsDialogs::Show
FunctionEnd
Function un.WaveUnConfirmLeave
  Call un.WaveReleasePageImages
FunctionEnd

Function un.WaveUnInstFilesShow
  ${If} ${Silent}
    Return
  ${EndIf}
  FindWindow $UnWavePage "#32770" "" $HWNDPARENT
  System::Call "user32::MoveWindow(p $UnWavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  Call un.WaveHideBuilderButtons
  !insertmacro WaveUnLoadImage $UnWaveBackgroundImage "uninst-dark.bmp"
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${WF_WS_CHILD}|${WF_WS_VISIBLE}|${WF_SS_BITMAP}, i 0, i 0, i ${WF_W}, i ${WF_H}, p $UnWavePage, p 0, p 0, p 0) p.r3'
  StrCpy $UnWaveBackground $3
  SendMessage $UnWaveBackground ${WF_STM_SETIMAGE} 0 $UnWaveBackgroundImage
  System::Call 'user32::CreateWindowExW(i 0, w "STATIC", w "", i ${WF_WS_CHILD}|${WF_WS_VISIBLE}|${WF_SS_NOTIFY}|${WF_SS_BITMAP}, i 828, i 10, i 40, i 40, p $UnWavePage, p 0, p 0, p 0) p.r3'
  StrCpy $UnWaveClose $3
  StrCpy $UnWaveCloseLevel 5
  StrCpy $UnWaveCloseTicks 0
  StrCpy $UnWaveCloseInitialDone 0
  StrCpy $UnWaveCloseWasHover 0
  StrCpy $UnWaveCloseTarget 5
  StrCpy $UnWaveCloseCurrent $UnWaveClose5
  SendMessage $UnWaveClose ${WF_STM_SETIMAGE} 0 $UnWaveCloseCurrent
  GetDlgItem $UnWaveProgress $UnWavePage 1004
  System::Call "user32::MoveWindow(p $UnWaveProgress, i 304, i 204, i 512, i 12, i 1)"
  System::Call 'uxtheme::SetWindowTheme(p $UnWaveProgress, w "", w "")'
  SendMessage $UnWaveProgress ${WF_PBM_SETBARCOLOR} 0 0xF7914B
  SendMessage $UnWaveProgress ${WF_PBM_SETBKCOLOR} 0 0x40291B
  GetDlgItem $0 $UnWavePage 1006
  System::Call "user32::MoveWindow(p $0, i 304, i 232, i 512, i 30, i 1)"
  GetDlgItem $0 $UnWavePage 1005
  ShowWindow $0 ${SW_HIDE}
  System::Call "user32::SetWindowPos(p $UnWaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  StrCpy $UnWaveProgressActive 1
  ${NSD_CreateTimer} un.WaveTick 250
FunctionEnd
Function un.WaveUnInstFilesLeave
  StrCpy $UnWaveProgressActive 0
  Call un.WaveReleasePageImages
FunctionEnd

Function un.WaveUnFinishCreate
  Call un.WaveReleasePageImages
  StrCpy $UnWaveFinishActive 1
  nsDialogs::Create 1018
  Pop $UnWavePage
  System::Call "user32::MoveWindow(p $UnWavePage, i 0, i 0, i ${WF_W}, i ${WF_H}, i 1)"
  Call un.WaveHideBuilderButtons
  ${NSD_CreateBitmap} 0 0 ${WF_W} ${WF_H} ""
  Pop $UnWaveBackground
  ${NSD_SetBitmap} $UnWaveBackground "$PLUGINSDIR\unfinish-dark.bmp" $UnWaveBackgroundImage
  Call un.WaveCreateClose
  !insertmacro WaveUnLoadImage $UnWaveButtonImage "btn-primary-dark-完成卸载.bmp"
  ${NSD_CreateBitmap} 700 452 160 44 ""
  Pop $UnWaveButton
  ${NSD_AddStyle} $UnWaveButton ${WF_SS_NOTIFY}|${WF_WS_TABSTOP}
  SendMessage $UnWaveButton ${WF_STM_SETIMAGE} 0 $UnWaveButtonImage
  ${NSD_OnClick} $UnWaveButton un.WaveDone
  System::Call "user32::SetWindowPos(p $UnWaveBackground, p 1, i 0, i 0, i 0, i 0, i 0x0013)"
  ${NSD_CreateTimer} un.WaveTick 250
  nsDialogs::Show
FunctionEnd
Function un.WaveUnFinishLeave
  Call un.WaveReleasePageImages
FunctionEnd
Function un.WaveSkipDefaultFinish
  Abort
FunctionEnd
!endif
