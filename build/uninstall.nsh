; TongZip NSIS 自定义卸载脚本(经 package.json build.nsis.include 注入)
;
; 目的(ISS-03):electron-builder 默认卸载只删程序文件,不动应用运行期写入的
; HKCU\Software\Classes shell 集成键(RC-14 实测:卸载后残留 ~73 个键 + 38 个
; OpenWithProgids 值,其 command 指向已删除的 exe = 死链菜单/文件类型)。
;
; 做法:在卸载器 un.onInit 阶段(此时 $INSTDIR\TongZip.exe 尚在),无头调用应用自身的
; uninstallShell —— 单一数据源,只删 TongZip 自写的键(shell\TongZip、TongZip.* ProgID、
; 自己写过的 open\command/DefaultIcon、默认应用登记),绝不触碰用户 UserChoice。
; 更新场景(isUpdated)跳过:新版本装好会由应用重新按需注册,卸载钩子不该抹掉。
!macro customUnInit
  ${ifNot} ${isUpdated}
    DetailPrint "TongZip: cleaning shell integration (HKCU)..."
    ExecWait '"$INSTDIR\TongZip.exe" --uninstall-shell"' $0
    DetailPrint "TongZip shell cleanup exit code: $0"
  ${endIf}
!macroend
