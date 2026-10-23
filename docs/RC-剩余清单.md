# TongZip 1.0.0 · RC 剩余清单（仅未关闭项）

**基线**：RC6 基线提交 `59dc26a487206c80b94109dc19c006d448a14904`（任务窗完成态动画/绿色进度条；含 RC4 自动更新；已本地 + 干净检出 npm ci 双复验，哈希见 `docs/phase4/rc-freeze.json` files.rc6CleanRebuild + rc6CleanReverify；历史 RC5 `2a6c5cd`、RC4 `c56a392`、RC3 `291e00b`、RC2 `33fd6c5` 与原冻结 `e7f9eda` 证据保留不改写）；RC-D1、RC-B7 自动化腿、RC-C3/C4/C9/C10 UI 冒烟自动化腿、**ISS-11/ISS-14 修复回归、自动更新链路、任务窗自动关闭/完成态动画**已关闭（见《RC-验收工作表》§1/§3/§4 与矩阵文档 §8.1~§8.8）。
判定只用三态：**已验证通过 / 有条件接受 / 未验证**。本清单列全部未关闭项；已关闭项不重复收录。

## 1. 下一轮自动化（AI 执行，按此优先级）

| ID | 项 | 状态 | 证据路径 | 责任人 | 下一步 |
|---|---|---|---|---|---|
| RC-C3 | ZIP 中文密码预检拦截 + ASCII/7Z 出路的 **UI 冒烟自动化** | 已验证通过（自动化腿+截图辅助） | `docs/phase4/rcui-smoke.json`（UI-C3-01）+ `docs/phase4/rcui-shots/rc-c3-*.png` | AI（已完成） | 关闭；真机走查为可选加强项，不阻断 |
| RC-C4 | 压缩格式意图一致性 **UI 冒烟自动化**（明示可达/复合 token 识别/意图=产物/未知拒绝） | **已验证通过（自动化腿）**——曾实锤 ISS-11，经负责人定档发布阻断并例外解冻修复（提交 `33fd6c5`），四腿 UI-C4-01~04 全绿，含真实生成文件 gzip 魔数核验 | `docs/phase4/rcui-smoke.json`（UI-C4-01~04）+ 截图 rc-c4-*.png（含 unknown-token-error-toast）+ 矩阵文档 §8.3 | AI（已完成） | 关闭；真机 Explorer 菜单实测并入 §3 RC-B1/B3 |
| RC-C9 | 恶意包/炸弹 **UI 双击场景熔断呈现**冒烟 | 已验证通过（自动化腿：真实 `--extract-here` 命令链熔断，toast 与 IPC `UNSAFE_PATH` 一致、零落地） | `docs/phase4/rcui-smoke.json`（UI-C9-01）+ 截图 rc-c9-guard-toast.png | AI（已完成） | 关闭自动化腿；炸弹体积/超大样本仍归 C5/C7 人工项 |
| RC-C10 | 真实 UI 操作后密码零泄漏 grep 核验 | 已验证通过 | `docs/phase4/rcui-smoke.json`（UI-C10-01，哨兵词 0 命中） | AI（已完成） | 关闭 |

纪律：§1 各项均为**测试新增**；发现缺陷只登记不定改，产品代码改动须经负责人定档批准例外解冻后方可执行（ISS-11 即此流程首例：定档→解冻→修复→回归→新 RC 提交）。

## 2. 需负责人决策后执行

| ID | 项 | 状态 | 证据路径 | 责任人 | 下一步 |
|---|---|---|---|---|---|
| RC-D9 | 第二台机器独立复核（**负责人已定档方案②**：不新增 CI workflow） | 未验证（RC6 任务窗自动关闭已建立；待负责人在第二台机器执行后回填结果与留痕方可关闭） | 本机双腿：`rc-verify-gate.log`（e7f9eda）+ `rc2-verify-gate.log`（33fd6c5）+ `rc3-verify-gate.log`（291e00b）+ `rc4-verify-gate.log`（c56a392）+ `rc6-verify-gate.log`（59dc26a,npm ci）；预演：`rc-d9-dryrun-*.log` | 负责人 | 按 §6 在第二台 Windows 机器执行：独立目录 clone **59dc26a**（不得复制工作树冒充）→ 记录环境版本 → `npm ci` → `npm run gate` + `npm run fmt-matrix` → 全留痕回填本清单 |
| 远程同步 | 冻结提交 `e7f9eda`、证据提交 `5741c16`、修复基线 `33fd6c5`、RC3 `291e00b`、RC4 `c56a392`、RC6 `59dc26a` 尚未 push 至 origin | — | — | 负责人 | 与 RC-D9 同批决策（同一推送动作；RC-D9 操作单§6 依赖 origin 可达或改用 U 盘介质 clone） |

## 3. 真机人工验收（负责人执行，AI 不代判）

| ID | 项 | 状态 | 留痕要求 | 责任人 |
|---|---|---|---|---|
| RC-A1~A10 | Win10/Win11 全链路、长路径、网络盘、U 盘、普通权限、磁盘将满、注销恢复、独占锁、portable 受限目录 | 未验证 | 每项：系统版本/条件/结果/失败复现步骤/证据文件（工作表 §2） | 负责人 |
| RC-B1/B2/B3/B4 | Explorer 菜单**实际渲染**肉眼核对、双击/OpenWith 实开、卸载后菜单无死链肉眼复核、重装后功能全重跑（含 **RC-B7 人工腿**：升级前后菜单渲染） | 未验证（自动化腿已过，不代替肉眼） | 每后缀截图 + 注册表前后对照（工作表 §3） | 负责人 |
| RC-B5 | 卸载对 %APPDATA%\TongZip 实际处置 → **ISS-04 定档** | 未验证 | 卸载向导截图 + 目录核查 | 负责人 |
| RC-B6 | 升级安装后设置/历史/最近保留（userData 面；B7 只证注册表关联面） | 未验证 | 升级前后 userData 对比 | 负责人 |
| RC-C1/C2 | 真 RAR/RAR5/ISO 与 lzma/lzma86/zipx 真实样本可读性 → **ISS-09 定档** | 未验证 | 样本来源+结果（工作表 §4） | 负责人 |
| RC-C5~C8 | 损坏归档、错误密码 UI 三路、>4GB/>8GB 超大档（条件绑定不外推）、解压冲突各分支 | 未验证 | 条件表+逐例 journal | 负责人 |
| RC-D4~D8 | 发布说明终稿确认（NotSigned/格式边界/**自动更新仅安装版**/已知限制/x64-only 文案审查） | **草稿已覆盖全部披露项**（并补全密码参数可见性/>2GB 完整性策略/恢复语义 3 项），待终稿签署 | 《发布说明草稿-1.0.0.md》逐项核对签署 | 负责人 |

## 4. 未定档问题

| ID | 项 | 状态 | 关闭路径 |
|---|---|---|---|
| ISS-04 | 卸载时个人数据处置与说明书 12.3 对照 | 未定档 | RC-B5 人工结果 → 负责人定档 |
| ISS-09 | lzma 族/zipx 能力边界口径 | 未定档 | RC-C2 真实样本 → 负责人定档 |
| ISS-15 | RC7 干净 gate 首跑 C2 偶发残留 `mod.7z.*.tztmp.tmp`（单独 crash 与完整 gate 复跑均通过；主工作区未复现） | 未定档（崩溃恢复残留候选） | 负责人定档：恢复后清理 `.tztmp.tmp` / 调整 C2 断言 / 登记已知限制；不影响 RC7 UI 修复与 D9 目标（仍 RC6 `59dc26a`） |

（ISS-14 曾列于此：RC-D9 预演发现依赖审计阻断（vite 6.4.3）；经负责人批准最小修复（锁文件升 6.4.5），已关闭并建立 RC3 基线 `291e00b`，见矩阵文档 §8.5。）

（ISS-11 曾列于此:负责人定档为发布阻断→例外解冻修复→回归证据齐全,**已关闭**,见矩阵文档 §8.3 与 §1 RC-C4 行,不再收录。）

范围外功能候选（不进入 1.0 发布闸门，终裁前不实施）：**ISS-12 完整文件关联管理**（格式清单/逐格式关联状态/修复/重新检查）、**ISS-13 右键菜单「添加到现有压缩包」**。均已登记于矩阵文档问题清单，待解冻或 1.0 后由负责人定档排期。

## 5. 发布闸门现状（快照）

- 未关闭发布阻断项：**无**（ISS-11/ISS-14 已关闭；自动更新已接入；任务窗完成态动画+成功后自动关闭。RC6 基线 `59dc26a` 经 npm ci 全新安装 + 干净检出 gate 6/6、fmt 72/0、audit 0；主工作区 gate 6/6 + rcui EXIT=0；自动更新检查/下载链路、任务窗完成态截图与自动关闭均实测）。
- 但按负责人执行顺序，**当前发布状态=暂不发布正式 1.0.0**：后续依次为 ②第二台机器复核 RC-D9（§6）→ ③真机人工验收 RC-A/B/C（§3，尤其 Explorer 菜单、安装升级、真实归档样本、异常场景）→ ④发布终裁。RC-B1/B3 人工腿仍是硬门槛。
- 已关闭自动化项汇总：RC-C3/**C4**/C9/C10 UI 冒烟自动化腿（`docs/phase4/rcui-smoke.json` 8 条 records 全 ok + 截图 7 张，被测 exe 哈希命中 rc-freeze.json RC6/RC4/RC3/RC2 清单——内容层自 RC2 起相同）。
- ARM64 红线持续有效：任何对外文案不得承诺原生 ARM64。

**发布终裁五项条件（负责人定档，2026-10；须同时满足）**

| # | 条件 | 当前状态 |
|---|---|---|
| 1 | RC-D9 完成并有可复核证据 | **未满足**——RC6 `59dc26a` 已建立并完成本机 npm ci 复验；待第二台机器按 §6 执行 |
| 2 | 所有强制人工验收项关闭 | **未满足**——RC-A/B/C 人工项未全部走完（RC-B1/B3 为硬门槛） |
| 3 | 不存在未关闭的发布阻断缺陷 | **已满足**——ISS-11 关闭后无其他已确认阻断 |
| 4 | 剩余有条件接受项均有明确风险说明与接受记录 | **部分满足**——发布说明草稿待 RC-D4~D8 终稿确认签署 |
| 5 | 最终发布包与冻结提交对应关系可复核，发布说明与实际能力一致 | **待终裁前复核**——RC-D1 已关闭；发布说明待落稿核对 |

终裁前纪律：不引入新的产品代码变更（修复、探针、文档证据除外）；任何新发现缺陷按三态登记，未经负责人定档不得改代码。

## 6. RC-D9 操作单 · 第二台 Windows 机器独立复核（负责人执行）

**目标**：在与开发机隔离的环境独立验证 **RC6 基线提交 `59dc26a`** 的可复现构建与全部自动化门禁，产出可复核留痕。**不得复制当前工作树冒充独立检出**；本仓库不新增 CI workflow（负责人定档）。

**目标提交与证据提交的关系（执行前必读）**
- **被测目标：`59dc26a487206c80b94109dc19c006d448a14904`**（RC6：任务窗口完成态动画/绿色进度条 + 2.4s 自动关闭；含 RC4 自动更新能力）。
- **`c56a392`、`291e00b`、`33fd6c5` 已不是 D9 目标**：`c56a392` 为 RC4（任务窗仍常驻），`291e00b` 为 ISS-14 修复（无自动更新），`33fd6c5` 锁文件审计必失败。三者作为历史证据保留，不改写。
- **哈希基准**：`rc-freeze.json` 的 `files.rc6CleanRebuild` + `rc6CleanReverify`（由 `59dc26a` 干净检出 + npm ci 重建；内容层 exe=`9123afb9…`/asar=`1e7f3d27…`/7za=`b0cfdeaf…`；容器层为 NSIS 非确定性）。**检出树内自带的 `rc-freeze.json` 只含旧块**——权威 RC6 清单在本清单所在的证据提交中，判读时不得只看检出树内旧文件。
- 若改在 RC6 证据提交检出（HEAD≠59dc26a），必须在留痕表注明"HEAD=证据提交，产品代码 diff vs `59dc26a` = 0"；**默认目标仍为 `59dc26a`**。

**前置条件**
- 第二台 Windows x64 机器（建议 Win10/11，管理员可选但非必需——gate 含真实安装卸载演练，若环境受限跑不动某步，按"未验证"登记而非判失败）。
- 网络可达 origin 仓库；不可达时改为在开发机 `git bundle create tongzip-rc2.bundle --all` 走 U 盘介质，异机 `git clone tongzip-rc2.bundle tongzip` 后同样 checkout 指定提交（bundle 方式须在留痕表注明介质与传递路径）。

**执行步骤（PowerShell 7，全部命令建议原样使用并保留完整输出）**
1. 独立工作目录：`New-Item -ItemType Directory -Path D:\rc-d9 -Force; Set-Location D:\rc-d9`
2. 拉取指定提交：`git clone <origin-url> tongzip; Set-Location tongzip; git checkout 59dc26a487206c80b94109dc19c006d448a14904`
3. 校验提交：`git rev-parse HEAD`（必须逐字符等于上述 SHA）+ `git status`（应干净）
4. 登记环境版本（写入留痕表）：`node -v; npm -v; $env:PROCESSOR_ARCHITECTURE; systeminfo | Select-String 'OS Name|OS Version'; git rev-parse HEAD`
5. 全新安装依赖（不许从别处拷贝 node_modules）：`npm ci`（记录退出码与耗时）
5b. **依赖审计预检**：`npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org`（记录退出码与报告）。RC6 `59dc26a` 预期 **0 漏洞**；若仍出现 HIGH/CRITICAL，停止并登记（不得以镜像 registry 的 audit 端点错误视为通过，必须用官方源取得明确结果）。
6. 门禁：`npm run gate *>&1 | Tee-Object -FilePath d9-gate.log`；`Write-Output $LASTEXITCODE`（预期 6/6 PASS、退出码 0；gate 含真实安装→崩溃→卸载演练与依赖审计，预计 6–8 分钟）
7. 格式矩阵：`npm run fmt-matrix *>&1 | Tee-Object -FilePath d9-fmt-matrix.log`；`Write-Output $LASTEXITCODE`（预期 72 项 0 不一致、退出码 0）
8. 产物哈希：`Get-FileHash release\win-unpacked\TongZip.exe,release\win-unpacked\resources\app.asar,release\win-unpacked\resources\engine\7za.exe,'release\TongZip Setup 1.0.0.exe','release\TongZip 1.0.0.exe' -Algorithm SHA256`（连同文件字节数一并登记）

**判读规则（负责人指令原文则）**
- 内容层基准（RC6 干净检出已证逐字节可复现）：win-unpacked `TongZip.exe`=`9123afb96372fb85675994db952fb701ee86df2996efe38f8d5de7ab9c0892e0`（189116928B）、`app.asar`=`1e7f3d275d065d3041a75bf0888ccabc2ec8fcd60f7555c10e6180bb2a2c5a07`（38999816B）、`7za.exe`=`b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95`（1231360B）。**内容层不一致=实质异常，须停下分析**（先核对 node/npm 版本与提交 SHA，再排查工具链差异），不得直接判通过。
- Setup/portable 容器层哈希预期与开发机不同（NSIS 非确定性,见 rc-freeze.json determinism 说明）——RC6 干净重建参考值：Setup `64905b89…`(81239587B)、portable `a9b4a3a8…`(80935224B)；如实登记差异即可,不判失败。
- 格式矩阵结果与 `docs/phase4/format-matrix.json` 对比时,忽略 `generatedAt`、`engine` 绝对路径、临时目录随机后缀三类环境痕迹字段,只比 72 项实质结果。
- 任何一步因缺依赖/环境不一致无法执行：该项登记**"未验证"**并注明原因，**不得用开发机旧日志补位**；RC-D9 仅在全部步骤完成且可复核时关闭。

**留痕回填表**（结果贴回《RC-剩余清单》§2 与本表,日志文件建议随证据提交入库）

| 字段 | 值 |
|---|---|
| 机器/系统版本 | |
| Node.js / npm 版本 | |
| 架构 (PROCESSOR_ARCHITECTURE) | |
| clone 来源（origin URL 或 bundle 介质） | |
| HEAD SHA（须=59dc26a487206c80b94109dc19c006d448a14904） | |
| 权威清单来源（RC6 `files.rc6CleanRebuild` + `rc6CleanReverify`；若改用证据提交检出须注明产品 diff=0） | |
| npm ci 退出码 / 耗时 | |
| gate 退出码 / 各步耗时 / 日志文件 | |
| fmt-matrix 退出码 / 项数 / 不一致数 / 日志文件 | |
| 内容层三哈希对比结果（逐一 一致/不一致） | |
| Setup / portable 哈希与字节数 | |
| 与冻结证据差异分析（如有） | |
| 未验证项及原因（如有） | |
| 执行人 / 日期 | |
