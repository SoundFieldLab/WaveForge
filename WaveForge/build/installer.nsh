; ─────────────────────────────────────────────────────────────
; WaveForge 澜音工坊 — 安装器文案定制
; 本文件被 electron-builder 自动 include（位于主 NSIS 模板之前），
; 因此这些 define 会在 MUI 页面实例化前生效。
; 注意：文件必须为 UTF-8 with BOM，NSIS 3 才按 UTF-8 解析中文。
; ─────────────────────────────────────────────────────────────

; 欢迎页
!define MUI_WELCOMEPAGE_TITLE "欢迎安装 ${PRODUCT_NAME}"
!define MUI_WELCOMEPAGE_TEXT "本向导将引导你完成 ${PRODUCT_NAME} 的安装。$\r$\n$\r$\n点击「下一步」继续。你可以随时点击「取消」退出安装。"

; 完成页
!define MUI_FINISHPAGE_TITLE "安装完成"
!define MUI_FINISHPAGE_TEXT "${PRODUCT_NAME} 已成功安装到你的电脑。$\r$\n$\r$\n点击「完成」关闭本向导。"
!define MUI_FINISHPAGE_RUN_TEXT "立即运行 ${PRODUCT_NAME}"

; 卸载器
!define MUI_UNWELCOMEPAGE_TITLE "卸载 ${PRODUCT_NAME}"
!define MUI_UNWELCOMEPAGE_TEXT "本向导将卸载 ${PRODUCT_NAME} 及其组件。$\r$\n$\r$\n点击「下一步」继续。"
!define MUI_UNFINISHPAGE_TITLE "卸载完成"
!define MUI_UNFINISHPAGE_TEXT "${PRODUCT_NAME} 已从你的电脑上移除。"

; 中途取消确认
!define MUI_ABORTWARNING
!define MUI_ABORTWARNING_TEXT "你确定要取消 ${PRODUCT_NAME} 的安装吗？"
