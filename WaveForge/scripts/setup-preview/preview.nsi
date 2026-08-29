; ============================================================
; WaveForge 澜音工坊 — 安装器 UI 预览（6 阶段：主题→欢迎→协议→目录→进度→完成）
; 静态设计烤进位图（generate-installer-ui.mjs），真实控件叠位，
; 背景创建后 SetWindowPos 置底保证按钮可点；按钮 BS_BITMAP+BS_FLAT 扁平化。
; 用法：npm run preview:setup   注意：UTF-8 with BOM
; ============================================================
Unicode true

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"

!ifndef SRC
  !error "SRC not defined - run via npm run preview:setup"
!endif
!ifndef APP_VERSION
  !define APP_VERSION "0.1.4"
!endif

!cd "${SRC}/build/ui"

Name "WaveForge 澜音工坊"
Caption "WaveForge 澜音工坊 安装向导"
OutFile "${SRC}/release/setup-preview.exe"
RequestExecutionLevel user
Icon "${SRC}/build/setup-icon.ico"
ShowInstDetails nevershow

; ---------- 常量 ----------
!define W 880
!define H 580
!define RAIL 232
!define CX 280
!ifndef WM_COMMAND
  !define WM_COMMAND 0x0111
!endif
!ifndef IDOK
  !define IDOK 1
!endif
!ifndef IDCANCEL
  !define IDCANCEL 2
!endif
!define IDBACK 3
!ifndef BM_SETIMAGE
  !define BM_SETIMAGE 0x00F7
!endif
!ifndef BS_BITMAP
  !define BS_BITMAP 0x0080
!endif
!ifndef BS_FLAT
  !define BS_FLAT 0x8000
!endif
!ifndef PBM_SETPOS
  !define PBM_SETPOS 0x0404
!endif
!ifndef PBM_SETBARCOLOR
  !define PBM_SETBARCOLOR 0x0409
!endif
!ifndef PBM_SETBKCOLOR
  !define PBM_SETBKCOLOR 0x040A
!endif

; ---------- 变量 ----------
Var Theme
Var Phase
Var InstallDir
Var hwnd
Var BgCtrl
Var CardDark
Var CardLight
Var hDirEdit
Var hLicenseText
Var hLicenseCheck
Var hLicenseHint
Var hProgress
Var hProgressText
Var ProgressVal
Var hBackBtn
Var hNextBtn
Var hvC
Var hvH1
Var hvN1
Var hvV1
Var hvH2
Var hvN2
Var hvV2
Var hvH3
Var hvN3
Var hvV3
Var hvPrev
!define __hvCount 0
Var fBody
Var fSub

; ---------- 工具 ----------
Function HideStdButtonsFn
  GetDlgItem $0 $HWNDPARENT ${IDOK}
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT ${IDCANCEL}
  ShowWindow $0 ${SW_HIDE}
  GetDlgItem $0 $HWNDPARENT ${IDBACK}
  ShowWindow $0 ${SW_HIDE}
FunctionEnd

Function hoverTick
  System::Call "user32::GetCursorPos(*i.r0, *i.r1)"
  ; 槽 1
  ${If} $hvC >= 1
    System::Call "*(i 0, i 0, i 0, i 0) p.r6"
    System::Call "user32::GetWindowRect(i $hvH1, p r6)"
    System::Call "*$r6(i.r2, i.r3, i.r4, i.r5)"
    ${If} $0 >= $r2
    ${AndIf} $0 <= $r4
    ${AndIf} $1 >= $r3
    ${AndIf} $1 <= $r5
      ${If} $hvPrev <> 1
        SendMessage $hvH1 ${BM_SETIMAGE} 0 $hvV1
        StrCpy $hvPrev 1
      ${EndIf}
    ${Else}
      ${If} $hvPrev == 1
        SendMessage $hvH1 ${BM_SETIMAGE} 0 $hvN1
        StrCpy $hvPrev 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; 槽 2
  ${If} $hvC >= 2
    System::Call "*(i 0, i 0, i 0, i 0) p.r6"
    System::Call "user32::GetWindowRect(i $hvH2, p r6)"
    System::Call "*$r6(i.r2, i.r3, i.r4, i.r5)"
    ${If} $0 >= $r2
    ${AndIf} $0 <= $r4
    ${AndIf} $1 >= $r3
    ${AndIf} $1 <= $r5
      ${If} $hvPrev <> 2
        SendMessage $hvH2 ${BM_SETIMAGE} 0 $hvV2
        StrCpy $hvPrev 2
      ${EndIf}
    ${Else}
      ${If} $hvPrev == 2
        SendMessage $hvH2 ${BM_SETIMAGE} 0 $hvN2
        StrCpy $hvPrev 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
  ; 槽 3
  ${If} $hvC >= 3
    System::Call "*(i 0, i 0, i 0, i 0) p.r6"
    System::Call "user32::GetWindowRect(i $hvH3, p r6)"
    System::Call "*$r6(i.r2, i.r3, i.r4, i.r5)"
    ${If} $0 >= $r2
    ${AndIf} $0 <= $r4
    ${AndIf} $1 >= $r3
    ${AndIf} $1 <= $r5
      ${If} $hvPrev <> 3
        SendMessage $hvH3 ${BM_SETIMAGE} 0 $hvV3
        StrCpy $hvPrev 3
      ${EndIf}
    ${Else}
      ${If} $hvPrev == 3
        SendMessage $hvH3 ${BM_SETIMAGE} 0 $hvN3
        StrCpy $hvPrev 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

Function startHoverTimer
  ${NSD_KillTimer} hoverTick
  StrCpy $hvC 0
  StrCpy $hvPrev 0
  ${NSD_CreateTimer} hoverTick 50
FunctionEnd

Function GoNextFn
  ; 标准按钮挂在父窗口上，必须发给 $HWNDPARENT 才能推进
  SendMessage $HWNDPARENT ${WM_COMMAND} ${IDOK} 0
FunctionEnd

Function GoBackFn
  SendMessage $HWNDPARENT ${WM_COMMAND} ${IDBACK} 0
FunctionEnd

!define MakeImgBtn `!insertmacro _MakeImgBtn `
!macro _MakeImgBtn OUTVAR X Y W H FILE CLICKFN
  ${NSD_CreateButton} ${X} ${Y} ${W} ${H} ""
  Pop ${OUTVAR}
  ${NSD_AddStyle} ${OUTVAR} ${BS_BITMAP}|${BS_FLAT}
  System::Call "uxtheme::SetWindowTheme(i ${OUTVAR}, w '', w '')"
  Push "$PLUGINSDIR\${FILE}"
  System::Call "user32::LoadImage(p 0, ts, i 0, i 0, i 0, i 0x10) p.r1"
  Push "$PLUGINSDIR\${FILE}-hover.bmp"
  System::Call "user32::LoadImage(p 0, ts, i 0, i 0, i 0, i 0x10) p.r2"
  SendMessage ${OUTVAR} ${BM_SETIMAGE} 0 $1
  ${NSD_OnClick} ${OUTVAR} ${CLICKFN}
  ; 注册悬停槽（唯一标签防冲突）
  IntOp $hvC $hvC + 1
  !undef __hvCur
  !define __hvCur ${__hvCount}
  !undef __hvCount
  !define /math __hvCount ${__hvCur} + 1
  IntCmp $hvC 1 __hv1_${__hvCur} __hvDone_${__hvCur} __hv2_${__hvCur}
  __hv1_${__hvCur}:
    StrCpy $hvH1 ${OUTVAR}
    StrCpy $hvN1 $1
    StrCpy $hvV1 $2
    Goto __hvDone_${__hvCur}
  __hv2_${__hvCur}:
    IntCmp $hvC 2 __hv2a_${__hvCur} __hvDone_${__hvCur} __hv3_${__hvCur}
    __hv2a_${__hvCur}:
      StrCpy $hvH2 ${OUTVAR}
      StrCpy $hvN2 $1
      StrCpy $hvV2 $2
      Goto __hvDone_${__hvCur}
    __hv3_${__hvCur}:
      StrCpy $hvH3 ${OUTVAR}
      StrCpy $hvN3 $1
      StrCpy $hvV3 $2
  __hvDone_${__hvCur}:
!macroend

; 页面背景（按主题选深/浅）
!define SetPageBg `!insertmacro _SetPageBg `
!macro _SetPageBg PAGE
  StrCpy $0 "$PLUGINSDIR\${PAGE}-light.bmp"
  IntCmp $Theme 1 0 +2 +2
  StrCpy $0 "$PLUGINSDIR\${PAGE}-dark.bmp"
  ${NSD_CreateBitmap} 0 0 ${W} ${H} ""
  Pop $BgCtrl
  ${NSD_SetBitmap} $BgCtrl $0 $2
!macroend

; 页面骨架：对话框 + 背景 + 隐藏标准按钮 + 右上角 X
!define PageStart `!insertmacro _PageStart `
!macro _PageStart PAGE
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  StrCpy $hwnd $0
  System::Call "user32::MoveWindow(i $hwnd, i 0, i 0, i ${W}, i ${H}, i 1)"
  Call HideStdButtonsFn
  ${SetPageBg} ${PAGE}
  Call startHoverTimer
!macroend

; 主题化按钮
!define ThemeBtn `!insertmacro _ThemeBtn `
!macro _ThemeBtn OUTVAR X Y W H KIND TEXT CLICKFN
  StrCpy $5 "light"
  IntCmp $Theme 1 0 +2 +2
  StrCpy $5 "dark"
  ${MakeImgBtn} ${OUTVAR} ${X} ${Y} ${W} ${H} btn-${KIND}-$5-${TEXT}.bmp ${CLICKFN}
!macroend

; ---------- 初始化 ----------
Function .onInit
  InitPluginsDir
  File "/oname=$PLUGINSDIR\theme.bmp" "theme.bmp"
  File "/oname=$PLUGINSDIR\card-dark.bmp" "card-dark.bmp"
  File "/oname=$PLUGINSDIR\card-light.bmp" "card-light.bmp"
  File "/oname=$PLUGINSDIR\welcome-dark.bmp" "welcome-dark.bmp"
  File "/oname=$PLUGINSDIR\welcome-light.bmp" "welcome-light.bmp"
  File "/oname=$PLUGINSDIR\license-dark.bmp" "license-dark.bmp"
  File "/oname=$PLUGINSDIR\license-light.bmp" "license-light.bmp"
  File "/oname=$PLUGINSDIR\dir-dark.bmp" "dir-dark.bmp"
  File "/oname=$PLUGINSDIR\dir-light.bmp" "dir-light.bmp"
  File "/oname=$PLUGINSDIR\inst-dark.bmp" "inst-dark.bmp"
  File "/oname=$PLUGINSDIR\inst-light.bmp" "inst-light.bmp"
  File "/oname=$PLUGINSDIR\finish-dark.bmp" "finish-dark.bmp"
  File "/oname=$PLUGINSDIR\finish-light.bmp" "finish-light.bmp"
  File "/oname=$PLUGINSDIR\btn-primary-dark-下一步.bmp" "btn-primary-dark-下一步.bmp"
  File "/oname=$PLUGINSDIR\btn-primary-light-下一步.bmp" "btn-primary-light-下一步.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-dark-上一步.bmp" "btn-secondary-dark-上一步.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-light-上一步.bmp" "btn-secondary-light-上一步.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-dark-取消安装.bmp" "btn-secondary-dark-取消安装.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-light-取消安装.bmp" "btn-secondary-light-取消安装.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-dark-完成.bmp" "btn-secondary-dark-完成.bmp"
  File "/oname=$PLUGINSDIR\btn-secondary-light-完成.bmp" "btn-secondary-light-完成.bmp"
  File "/oname=$PLUGINSDIR\btn-primary-dark-立即打开.bmp" "btn-primary-dark-立即打开.bmp"
  File "/oname=$PLUGINSDIR\btn-primary-light-立即打开.bmp" "btn-primary-light-立即打开.bmp"

  StrCpy $Theme 1
  StrCpy $InstallDir "D:\WaveForge"
  System::Call "gdi32::CreateFontW(i -14,i 0,i 0,i 0,i 400,i 0,i 0,i 0,i 1,i 0,i 0,i 5,i 0,t 'Microsoft YaHei UI') p.r0"
  StrCpy $fBody $0
  System::Call "gdi32::CreateFontW(i -12,i 0,i 0,i 0,i 400,i 0,i 0,i 0,i 1,i 0,i 0,i 5,i 0,t 'Microsoft YaHei UI') p.r0"
  StrCpy $fSub $0
FunctionEnd

Function .onGUIInit
  ; 原生标题栏：保留标题+关闭，去掉最小化/最大化按钮
  System::Call "user32::GetWindowLongW(i $HWNDPARENT, i -16) i.r0"
  IntOp $0 $0 & 0xFFFCFFFF
  System::Call "user32::SetWindowLongW(i $HWNDPARENT, i -16, i r0) i.r1"
  ; 标题文字清空（只留右上角关闭按钮）
  StrCpy $R8 ""
  System::Call "user32::SetWindowTextW(i $HWNDPARENT, w r8)"
  System::Call "user32::GetSystemMetrics(i 0) i.r0"
  IntOp $2 $0 - ${W}
  IntOp $2 $2 / 2
  System::Call "user32::GetSystemMetrics(i 1) i.r1"
  IntOp $3 $1 - ${H}
  IntOp $3 $3 / 2
  System::Call "user32::MoveWindow(i $HWNDPARENT, i r2, i r3, i ${W}, i ${H}, i 1)"
  System::Call "dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 33, *i 2, i 4) i.r0"
FunctionEnd

; ============================================================
; 阶段 0：主题选择（卡片烤进 theme.bmp，按钮作点击层）
; ============================================================
Page custom themeCreate themeLeave
Page custom welcomeCreate welcomeLeave
Page custom licenseCreate licenseLeave
Page custom dirCreate dirLeave
Page custom instCreate instLeave
Page custom finishCreate finishLeave

Function themeCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  StrCpy $hwnd $0
  System::Call "user32::MoveWindow(i $hwnd, i 0, i 0, i ${W}, i ${H}, i 1)"
  Call HideStdButtonsFn
  ${NSD_CreateBitmap} 0 0 ${W} ${H} ""
  Pop $BgCtrl
  ${NSD_SetBitmap} $BgCtrl "$PLUGINSDIR\theme.bmp" $2
  ${MakeImgBtn} $CardDark 138 316 284 172 card-dark.bmp themeDarkClick
  ${MakeImgBtn} $CardLight 458 316 284 172 card-light.bmp themeLightClick
  Call startHoverTimer
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  nsDialogs::Show
FunctionEnd

Function themeDarkClick
  StrCpy $Theme 1
  Call GoNextFn
FunctionEnd

Function themeLightClick
  StrCpy $Theme 0
  Call GoNextFn
FunctionEnd

Function themeLeave
FunctionEnd

; ============================================================
; 阶段 1：欢迎
; ============================================================
Function welcomeCreate
  StrCpy $Phase 1
  ${PageStart} welcome
  ${ThemeBtn} $hBackBtn ${CX} 500 120 44 secondary 取消安装 welcomeCancel
  ${ThemeBtn} $hNextBtn 700 500 160 44 primary 下一步 welcomeNext
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  nsDialogs::Show
FunctionEnd

Function welcomeCancel
  SendMessage $HWNDPARENT ${WM_COMMAND} ${IDCANCEL} 0
FunctionEnd

Function welcomeNext
  Call GoNextFn
FunctionEnd

Function welcomeLeave
FunctionEnd

; ============================================================
; 阶段 2：用户协议
; ============================================================
Function licenseCreate
  StrCpy $Phase 2
  ${PageStart} license
  nsDialogs::CreateControl "EDIT" \
    "${WS_VISIBLE}|${WS_CHILD}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL}" \
    "${WS_EX_CLIENTEDGE}" ${CX} 146 560 268 ""
  Pop $hLicenseText
  ${NSD_SetText} $hLicenseText "WaveForge 澜音工坊 用户协议$\r$\n$\r$\n\
欢迎使用 WaveForge 澜音工坊。安装即视为同意以下条款：$\r$\n\
1. 本软件为个人免费软件，禁止商业用途与转售。$\r$\n\
2. 聚合内容版权归各平台及原作者所有，请勿侵权使用。$\r$\n\
3. 登录凭据仅保存在本地，不上传。$\r$\n\
4. 软件按现状提供，使用风险自负。$\r$\n\
5. 安装并继续使用即视为同意本协议。"
  ${NSD_CreateCheckbox} ${CX} 436 420 26 "我已阅读并同意《用户协议》"
  Pop $hLicenseCheck
  ${NSD_OnClick} $hLicenseCheck licenseCheckClick
  ${NSD_CreateLabel} ${CX} 468 420 20 ""
  Pop $hLicenseHint
  ${ThemeBtn} $hBackBtn ${CX} 500 120 44 secondary 上一步 licenseBack
  ${ThemeBtn} $hNextBtn 660 500 200 44 primary 下一步 licenseNext
  EnableWindow $hNextBtn 0
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  nsDialogs::Show
FunctionEnd

Function licenseCheckClick
  ${NSD_GetChecked} $hLicenseCheck $0
  ${If} $0 == ${BST_CHECKED}
    EnableWindow $hNextBtn 1
  ${Else}
    EnableWindow $hNextBtn 0
  ${EndIf}
FunctionEnd

Function licenseBack
  Call GoBackFn
FunctionEnd

Function licenseNext
  ${NSD_GetChecked} $hLicenseCheck $0
  ${If} $0 == ${BST_CHECKED}
    Call GoNextFn
  ${Else}
    EnableWindow $hNextBtn 0
  ${EndIf}
FunctionEnd

Function licenseLeave
FunctionEnd

; ============================================================
; 阶段 3：安装目录
; ============================================================
Function dirCreate
  StrCpy $Phase 3
  ${PageStart} dir
  ${NSD_CreateText} ${CX} 200 440 36 "$InstallDir"
  Pop $hDirEdit
  ${ThemeBtn} $0 728 196 110 44 secondary 浏览 dirBrowse
  ${NSD_CreateCheckbox} ${CX} 292 400 26 "创建桌面快捷方式"
  Pop $0
  ${NSD_Check} $0
  ${ThemeBtn} $hBackBtn ${CX} 500 120 44 secondary 上一步 dirBack
  ${ThemeBtn} $hNextBtn 700 500 160 44 primary 下一步 dirNext
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  nsDialogs::Show
FunctionEnd

Function dirBrowse
  nsDialogs::SelectFolderDialog "选择 WaveForge 安装目录" "$InstallDir"
  Pop $0
  ${If} $0 <> ""
    StrCpy $InstallDir $0
    ${NSD_SetText} $hDirEdit "$0"
  ${EndIf}
FunctionEnd

Function dirBack
  Call GoBackFn
FunctionEnd

Function dirNext
  ${NSD_GetText} $hDirEdit $InstallDir
  ${If} $InstallDir <> ""
    Call GoNextFn
  ${EndIf}
FunctionEnd

Function dirLeave
FunctionEnd

; ============================================================
; 阶段 4：安装进度（动画）
; ============================================================
Function instCreate
  StrCpy $Phase 4
  StrCpy $ProgressVal 0
  ${PageStart} inst
  ${NSD_CreateProgressBar} ${CX} 210 560 12 ""
  Pop $hProgress
  System::Call "uxtheme::SetWindowTheme(i $hProgress, w '', w '')"
  ${If} $Theme == 1
    SendMessage $hProgress ${PBM_SETBARCOLOR} 0 "0x00F6823B"
  ${Else}
    SendMessage $hProgress ${PBM_SETBARCOLOR} 0 "0x00EB6325"
  ${EndIf}
  SendMessage $hProgress ${PBM_SETBKCOLOR} 0 "0x00F0F0F0"
  ${NSD_CreateLabel} ${CX} 244 560 26 "正在准备安装环境…"
  Pop $hProgressText
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  ${NSD_CreateTimer} onProgress 40
  nsDialogs::Show
FunctionEnd

Function onProgress
  IntOp $ProgressVal $ProgressVal + 1
  ${If} $ProgressVal >= 100
    StrCpy $ProgressVal 100
    ${NSD_KillTimer} onProgress
    SendMessage $hProgress ${PBM_SETPOS} 100 0
    ${NSD_SetText} $hProgressText "安装完成"
    Call GoNextFn
    Return
  ${EndIf}
  SendMessage $hProgress ${PBM_SETPOS} $ProgressVal 0
  ${If} $ProgressVal >= 90
    ${NSD_SetText} $hProgressText "正在完成安装…"
  ${ElseIf} $ProgressVal >= 60
    ${NSD_SetText} $hProgressText "正在创建快捷方式…"
  ${ElseIf} $ProgressVal >= 25
    ${NSD_SetText} $hProgressText "正在复制文件…"
  ${Else}
    ${NSD_SetText} $hProgressText "正在准备安装环境…"
  ${EndIf}
FunctionEnd

Function instLeave
FunctionEnd

; ============================================================
; 阶段 5：完成
; ============================================================
Function finishCreate
  StrCpy $Phase 5
  ${PageStart} finish
  ${ThemeBtn} $hBackBtn ${CX} 500 120 44 secondary 完成 finishDone
  ${ThemeBtn} $hNextBtn 700 500 160 44 primary 立即打开 finishOpen
  System::Call "user32::SetWindowPos(i $BgCtrl, i 1, i 0, i 0, i 0, i 0, i 0x0013) i.r0"
  nsDialogs::Show
FunctionEnd

Function finishDone
  Quit
FunctionEnd

Function finishOpen
  Quit
FunctionEnd

Function finishLeave
FunctionEnd

; 空安装段（预览不安装任何文件）
Section "-"
SectionEnd
