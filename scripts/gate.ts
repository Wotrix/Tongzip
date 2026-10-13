/**
 * 阶段 3.5 — 一键质量门禁(Windows)
 * 按序执行六步,任何硬项失败 → 非零退出码;不允许跳步或以模拟结果顶替真实验证:
 *  1) typecheck        electron + renderer 双工程 tsc
 *  2) selftest         86 项功能/安全断言(Node 直调真实模块)
 *  3) build/dist       vite 构建 + electron-builder 打包(portable + nsis)
 *  4) 产物核查         安装包/portable 存在,引擎哈希一致,许可证与关键资源在位,
 *                      app.asar 内含 3.4 持久化代码(防止拿旧产物蒙混过关)
 *  5) 崩溃演练         真实打包产物 + 强制终止 + 重启恢复核验(不可被模拟测试替代)
 *  6) 依赖审计         runtime 依赖 HIGH/CRITICAL 硬失败;全量审计(含 dev 工具链)仅报告
 * 平台原则:崩溃演练与产物只能在 Windows 验证,其他平台直接失败,不假装通过。
 * 超时纪律:每一步都有硬超时;崩溃演练自带进程/目录清理钩子。
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const R = process.cwd();
const pkg = JSON.parse(fs.readFileSync(path.join(R, 'package.json'), 'utf8')) as { version: string };
const RELEASE = path.join(R, 'release');
let results: { name: string; ok: boolean; ms: number; note?: string }[] = [];

function step(name: string, fn: () => string | void): void {
  const t0 = Date.now();
  process.stdout.write(`\n=== [${name}] ===\n`);
  try {
    const note = fn();
    results.push({ name, ok: true, ms: Date.now() - t0, note: note ?? undefined });
    console.log(`--- [${name}] PASS (${((Date.now() - t0) / 1000).toFixed(1)}s)${note ? ` ${note}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: (e as Error).message.slice(0, 300) });
    console.error(`--- [${name}] FAIL: ${(e as Error).message}`);
  }
}

/** 捕获输出并校验尾记;expect 缺失视为失败(防旧 bundle 的误导性 PASS) */
function runChecked(label: string, bin: string, args: string[], timeoutMs: number, expect?: string): string {
  const r = spawnSync(bin, args, { cwd: R, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  process.stdout.write(out.split('\n').slice(-25).join('\n') + '\n');
  if (r.error) throw new Error(`${label} 无法执行:${r.error.message}`);
  if (r.signal) throw new Error(`${label} 被终止(${r.signal},超时 ${timeoutMs}ms)`);
  if (r.status !== 0) throw new Error(`${label} 退出码 ${r.status}`);
  if (expect && !out.includes(expect)) throw new Error(`${label} 输出缺少标记「${expect}」(不认未声明的成功)`);
  return out;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function mustFile(file: string, minBytes = 1): void {
  if (!fs.existsSync(file)) throw new Error(`产物缺失:${path.relative(R, file)}`);
  const sz = fs.statSync(file).size;
  if (sz < minBytes) throw new Error(`产物异常(${path.relative(R, file)} 仅 ${sz}B,预期 ≥ ${minBytes}B)`);
}
const nodeBin = process.execPath;
const esbuildShim = path.join(R, 'node_modules', 'esbuild', 'bin', 'esbuild');
const tscBin = path.join(R, 'node_modules', 'typescript', 'bin', 'tsc');
const viteBin = path.join(R, 'node_modules', 'vite', 'bin', 'vite.js');
const builderCli = path.join(R, 'node_modules', 'electron-builder', 'cli.js');
const tmp = (n: string) => path.join(R, '.tmp', n);
const ESBUILD_ARGS = (src: string, out: string) =>
  [esbuildShim, src, '--bundle', '--platform=node', '--target=node20', `--outfile=${out}`, '--log-level=error'];

/* ---------------- 步骤实现 ---------------- */

function checkEnv(): void {
  for (const f of ['package.json', 'electron/main.ts', 'scripts/selftest.ts', 'scripts/crash-test.ts']) {
    mustFile(path.join(R, f));
  }
  for (const b of [tscBin, esbuildShim, viteBin, builderCli]) mustFile(b);
}

function typecheck(): void {
  runChecked('tsc(electron)', nodeBin, [tscBin, '-p', 'tsconfig.electron.json'], 180_000);
  runChecked('tsc(renderer)', nodeBin, [tscBin, '-p', 'tsconfig.json'], 180_000);
}

function selftest(): void {
  runChecked('bundle(selftest)', nodeBin, ESBUILD_ARGS('scripts/selftest.ts', '.tmp/selftest.cjs'), 60_000);
  runChecked('selftest', nodeBin, [tmp('selftest.cjs')], 300_000, 'ALL PASSED');
}

function buildAndDist(): void {
  runChecked('vite build', nodeBin, [viteBin, 'build'], 300_000);
  runChecked('electron-builder', nodeBin, [builderCli, '--win'], 900_000);
}

function auditArtifacts(): void {
  const v = pkg.version;
  /* 安装包与 portable 双产物 */
  mustFile(path.join(RELEASE, `TongZip Setup ${v}.exe`), 1024 * 1024);
  mustFile(path.join(RELEASE, `TongZip ${v}.exe`), 1024 * 1024);
  const unpacked = path.join(RELEASE, 'win-unpacked');
  mustFile(path.join(unpacked, 'TongZip.exe'), 1024 * 1024);
  /* 引擎:随包文件与源文件逐字节同哈希(篡改/漏更即刻暴露) */
  const engSrc = path.join(R, 'engine', '7za.exe');
  const engOut = path.join(unpacked, 'resources', 'engine', '7za.exe');
  mustFile(engSrc); mustFile(engOut);
  if (sha256(engSrc) !== sha256(engOut)) throw new Error('产物内 7za.exe 与源 engine/7za.exe 哈希不一致');
  /* 许可证与关键资源 */
  mustFile(path.join(unpacked, 'resources', 'licenses', 'LICENSE-7-Zip.txt'), 1000);
  mustFile(path.join(unpacked, 'resources', 'licenses', 'THIRD-PARTY-NOTICES.txt'), 100);
  mustFile(path.join(unpacked, 'resources', 'archive.ico'), 1000);
  mustFile(path.join(unpacked, 'resources', 'app.asar'), 1024 * 1024);
  /* asar 未压缩存文本:用字符串字面量验证 3.4 持久化代码真的打进了产物(防旧产物蒙混)。
     只选 minify 后仍原样保留的标记:文件名/IPC 通道串/UI 文案,不用会被改名的标识符 */
  const asar = fs.readFileSync(path.join(unpacked, 'resources', 'app.asar'));
  for (const marker of ['tongzip-history.json', 'tongzip-txn.json', 'tz:history-get', '上次运行中断']) {
    if (!asar.includes(marker)) throw new Error(`app.asar 缺少实现标记「${marker}」(产物与源码不同步)`);
  }
}

function crashDrill(): void {
  if (process.platform !== 'win32') throw new Error('崩溃演练依赖 Windows 进程模型(taskkill/CIM),非 Windows 环境不得跳过或模拟通过');
  runChecked('bundle(crash-test)', nodeBin, ESBUILD_ARGS('scripts/crash-test.ts', '.tmp/crash-test.cjs'), 60_000);
  runChecked('crash-drill', nodeBin, [tmp('crash-test.cjs')], 1_200_000, 'CRASH DRILL ALL PASSED');
}

/** npm 是 .cmd,须经 cmd /c;runtime HIGH/CRITICAL=硬失败,全量(含 dev)=仅报告不判定。
 *  国内镜像 registry 常未实现 audit 端点:执行失败 ≠ 审计通过,先用当前源、再退官方源,
 *  两者都拿不到结果才判 FAIL;真实漏洞(退出码非零且报告含漏洞行)同样 FAIL */
function npmAudit(extra: string[]): { code: number | null; out: string } {
  const comspec = process.env.ComSpec ?? 'cmd.exe';
  const r = spawnSync(comspec, ['/d', '/s', '/c', 'npm', 'audit', '--no-fund', ...extra],
    { cwd: R, encoding: 'utf8', timeout: 240_000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function isAuditEndpointError(out: string): boolean {
  return /NOT_IMPLEMENTED|audit endpoint|advisories\/bulk|ENOTFOUND|EAI_AGAIN|socket hang up|ETIMEDOUT|404/i.test(out);
}
function dependencyAudit(): string {
  let a = npmAudit(['--omit=dev', '--audit-level=high']);
  let registryArgs: string[] = [];
  if (a.code !== 0 && isAuditEndpointError(a.out)) {
    console.log('当前 registry 不支持 audit 端点,改用官方 registry 重试…');
    registryArgs = ['--registry=https://registry.npmjs.org'];
    a = npmAudit(['--omit=dev', '--audit-level=high', ...registryArgs]);
  }
  if (a.code !== 0) {
    if (isAuditEndpointError(a.out)) throw new Error(`runtime 审计在镜像与官方源均未能执行(不等于通过):${a.out.split('\n').find((l) => /error/i.test(l)) ?? '未知错误'}`);
    throw new Error(`runtime 依赖存在 HIGH/CRITICAL 漏洞(审计报告见上)`);
  }
  const full = npmAudit(registryArgs);
  const summary = full.out.split('\n').find((l) => /vulnerabilit/i.test(l)) ?? '(全量审计未取到摘要)';
  console.log(`dev 工具链告警(仅报告,不阻断门禁):${summary.trim()}`);
  return 'runtime 零 HIGH/CRITICAL';
}

/* ---------------- 主流程 ---------------- */

try {
  checkEnv();
} catch (e) {
  console.error(`环境不完整:${(e as Error).message}`);
  process.exit(1);
}
step('1/6 typecheck', typecheck);
step('2/6 selftest(86 断言)', selftest);
step('3/6 vite build + electron 打包', buildAndDist);
step('4/6 产物核查(哈希/许可证/资源/代码同步)', auditArtifacts);
step('5/6 真实崩溃演练', crashDrill);
step('6/6 依赖安全审计', dependencyAudit);

console.log('\n================ 门禁汇总 ================');
let failed = 0;
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(42)} ${(r.ms / 1000).toFixed(1).padStart(6)}s  ${r.note ?? ''}`);
  if (!r.ok) failed++;
}
if (failed) { console.error(`\nGATE FAILED(${failed} 项未过)`); process.exit(1); }
console.log('\nGATE PASSED');
