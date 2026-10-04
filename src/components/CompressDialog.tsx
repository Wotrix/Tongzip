/**
 * 创建压缩包面板 — 现代简洁:
 * 文件区(可拖入/增删) · 名称/位置 · 格式 · 等级 · 密码 · 分卷
 * 字典/固实/多线程/加密文件头等参数收进「高级设置」,默认折叠。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveFormat, CompressJob } from '@shared/types';
import { Modal, useToast } from './ui';
import { IconArchive, IconAdd, IconChevronDown, IconClose, IconFolder, IconWarn } from './icons';
import { FORMAT_EXT, SAVE_FILTERS, basename, parentDir } from '../lib/format';
import type { AppApi } from '../App';

const FORMATS: { v: ArchiveFormat; label: string; hint: string }[] = [
  { v: '7z', label: '7Z', hint: '压缩率最高,推荐' },
  { v: 'zip', label: 'ZIP', hint: '兼容性最好' },
  { v: 'tar.gz', label: 'TAR.GZ', hint: 'Linux / macOS 通用' },
  { v: 'tar.xz', label: 'TAR.XZ', hint: '更高压缩率的 tar' },
  { v: 'tar', label: 'TAR', hint: '仅打包不压缩' },
];

const LEVELS: { v: number; label: string }[] = [
  { v: 0, label: '仅存储' },
  { v: 1, label: '最快' },
  { v: 3, label: '快速' },
  { v: 5, label: '标准(推荐)' },
  { v: 7, label: '较高' },
  { v: 9, label: '极限' },
];

const DICTS = ['1m', '4m', '16m', '32m', '64m'];
const SOLIDS = ['auto', 'on', 'off', '1g', '64m', '32m'];

/** 本身已是高压缩格式的后缀:再压几乎不会变小,只会多出档案头开销 */
const PRECOMPRESSED = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'avif', 'tiff',
  'mp3', 'aac', 'ogg', 'opus', 'flac', 'm4a',
  'mp4', 'mov', 'mkv', 'webm', 'wmv', 'm4v',
  'zip', '7z', 'rar', 'gz', 'bz2', 'xz', 'zst', 'tgz', 'txz',
  'apk', 'jar', 'epub', 'iso', 'cab', 'wim', 'pdf', 'woff', 'woff2',
]);

export default function CompressDialog({ sources, api, presetFormat, appendTo, onClose }: {
  sources: string[];
  api: AppApi;
  presetFormat?: ArchiveFormat;
  /** 现有压缩包路径:将源文件追加进去,输出锁定 */
  appendTo?: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const appendFormat: ArchiveFormat | null = appendTo
    ? (/\.zip$/i.test(appendTo) ? 'zip' : /\.7z$/i.test(appendTo) ? '7z' : null)
    : null;
  const [items, setItems] = useState<string[]>(sources);
  const [format, setFormat] = useState<ArchiveFormat>(appendFormat ?? presetFormat ?? '7z');
  const [level, setLevel] = useState(5);
  const [password, setPassword] = useState('');
  const [encOn, setEncOn] = useState(false);
  const [volOn, setVolOn] = useState(false);
  const [volume, setVolume] = useState('700m');
  const [output, setOutput] = useState('');
  const [touchedOut, setTouchedOut] = useState(false);
  const [adv, setAdv] = useState(false);
  /* 高级 */
  const [dict, setDict] = useState('16m');
  const [solid, setSolid] = useState('auto');
  const [mt, setMt] = useState(true);
  const [encHeaders, setEncHeaders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dropIn, setDropIn] = useState(false);

  const is7z = format === '7z';
  const canEnc = is7z || format === 'zip';
  const canVol = is7z || format === 'zip';

  /* 未指定预设时,格式/等级跟随用户默认设置 */
  const inited = useRef(false);
  const baseLevel = useRef(5);
  useEffect(() => {
    void window.tz.getSettings().then((s) => {
      if (inited.current) return;
      inited.current = true;
      if (!appendFormat && !presetFormat && s.defaultFormat) setFormat(s.defaultFormat);
      if (!appendTo && typeof s.defaultLevel === 'number') {
        baseLevel.current = s.defaultLevel;
        setLevel(s.defaultLevel);
      }
    });
  }, [appendFormat, presetFormat, appendTo]);

  /* 智能提示:所选全部为已压缩格式时自动切「仅存储」,避免白耗时间还变大 */
  const allPre = useMemo(() => items.length > 0 && items.every((p) => {
    const dot = p.lastIndexOf('.');
    return dot > 0 && PRECOMPRESSED.has(p.slice(dot + 1).toLowerCase());
  }), [items]);
  const levelTouched = useRef(false);
  const autoStore = useRef(false);
  useEffect(() => {
    if (appendTo || levelTouched.current) return;
    if (allPre && level !== 0) { setLevel(0); autoStore.current = true; }
    else if (!allPre && autoStore.current) { setLevel(baseLevel.current); autoStore.current = false; }
  }, [allPre, level, appendTo]);

  /* 输出路径跟随首个源文件与格式自动推导(用户手动改过则尊重) */
  useEffect(() => {
    if (appendTo) { setOutput(appendTo); return; }
    if (touchedOut || !items.length) return;
    void window.tz.defaultOutput(items).then((p) => {
      if (!p) return;
      setOutput(p.replace(/\.(7z|zip|tar(\.(gz|bz2|xz|zst))?|tgz|txz)$/i, FORMAT_EXT[format]));
    });
  }, [items, format, touchedOut, appendTo]);

  const addFiles = async () => {
    const r = await window.tz.pickFiles();
    if (r.ok && r.data.length) setItems((prev) => [...new Set([...prev, ...r.data])]);
  };
  const addFolder = async () => {
    const r = await window.tz.pickFolder();
    const dir = r.ok ? r.data : null;
    if (dir) setItems((prev) => (prev.includes(dir) ? prev : [...prev, dir]));
  };

  const volumeOk = useMemo(() => !volOn || /^\d+(\.\d+)?[kmg]?$/i.test(volume), [volOn, volume]);

  const start = async () => {
    if (!items.length) { toast('请先添加要压缩的文件或文件夹。', 'err'); return; }
    if (!output) { toast('请填写压缩包名称与保存位置。', 'err'); return; }
    if (!volumeOk) { toast('分卷大小格式应为 数字+单位,如 700m。', 'err'); return; }
    setBusy(true);
    const usePw = canEnc && (encOn || password);
    const job: CompressJob = {
      sources: items, output, format, level,
      dict: is7z ? dict : '16m',
      solid: is7z ? solid : 'auto',
      multiThread: mt,
      password: usePw ? password : undefined,
      encryptHeaders: is7z ? encHeaders : false,
      volume: canVol && volOn && volume ? volume : undefined,
    };
    const r = await window.tz.compress(job);
    if (!r.ok) { setBusy(false); toast(r.message, 'err'); return; }
    // 压缩启动即弹独立任务窗口(已在跑的任务一并展示,终态后自动关)
    void window.tz.taskWindowOpen();
    // 任务中心展示总体积(大目录递归求和可能稍慢,不阻塞任务启动)
    void window.tz.totalSize(items).then((sz) => {
      api.trackTask(r.data.taskId, 'compress', (j) => {
        setBusy(false);
        if (j.status === 'done') {
          toast(appendTo ? `已添加到 ${basename(output)}` : `已生成 ${basename(output)}`);
          if (appendTo) api.refreshArchive();
          onClose();
        } else if (j.status === 'error') {
          toast(j.message ?? '压缩失败', 'err');
        }
      }, { label: basename(output), totalBytes: sz.ok ? sz.data : undefined });
    });
  };

  return (
    <Modal title={appendTo ? '添加到压缩包' : '创建压缩包'} icon={<IconArchive />} onClose={onClose} width={620}>
      <div className="stack">

        {/* 拖拽区(参考图):常显虚线框 + 选择文件主按钮;已选文件以 chips 呈现 */}
        {!appendTo && (
          <div
            className={`drop-zone ${dropIn ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDropIn(true); }}
            onDragLeave={() => setDropIn(false)}
            onDrop={(e) => {
              e.preventDefault(); setDropIn(false);
              const p = Array.from(e.dataTransfer.files).map((f) => window.tz.pathForFile(f));
              if (p.length) setItems((prev) => [...new Set([...prev, ...p])]);
            }}
          >
            <IconFolder className="dz-folder" />
            <div className="dz-main">把文件或文件夹拖到这里</div>
            <div className="dz-hint">支持任意多个文件与文件夹混合</div>
            <div className="dz-btns">
              <button type="button" className="tbtn primary sm" onClick={() => void addFiles()}>选择文件</button>
              <button type="button" className="tbtn bordered sm" onClick={() => void addFolder()}>选择文件夹</button>
            </div>
          </div>
        )}
        {items.length > 0 && (
          <div className="chips">
            {items.map((s) => (
              <span className="chip" key={s} title={s}>
                <span>{basename(s)}</span>
                {!appendTo && (
                  <button onClick={() => setItems((prev) => prev.filter((x) => x !== s))}><IconClose /></button>
                )}
              </span>
            ))}
            {!appendTo && (
              <>
                <button className="tbtn sm" onClick={() => void addFiles()}><IconAdd /> 继续添加</button>
                <button className="tbtn sm" onClick={() => void addFolder()}><IconFolder /> 添加文件夹</button>
              </>
            )}
          </div>
        )}

        {/* 名称 + 格式 */}
        {!appendTo && (
          <div className="grid2">
            <div className="field">
              <label htmlFor="cz-name">压缩包名称</label>
              <input id="cz-name" className="input" value={basename(output)} placeholder="name.7z"
                onChange={(e) => {
                  const dir = output ? parentDir(output) : '';
                  setOutput(`${dir}\\${e.target.value}`);
                  setTouchedOut(true);
                }} />
            </div>
            <div className="field">
              <label>格式</label>
              <select className="input" value={format} onChange={(e) => setFormat(e.target.value as ArchiveFormat)}>
                {FORMATS.map((f) => <option key={f.v} value={f.v}>{f.label} — {f.hint}</option>)}
              </select>
            </div>
          </div>
        )}
        {appendTo && (
          <div className="note">目标压缩包:{basename(appendTo)}(格式固定为 {appendFormat?.toUpperCase() ?? '未知'})</div>
        )}

        {/* 保存位置 + 压缩等级 */}
        {!appendTo && (
          <div className="grid2">
            <div className="field">
              <label>保存位置</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" readOnly value={output ? parentDir(output) : ''} placeholder="选择文件夹…"
                  onClick={async () => {
                    const r = await window.tz.pickFolder();
                    if (r.ok && r.data) {
                      const name = basename(output) || `新建压缩包${FORMAT_EXT[format]}`;
                      setOutput(`${r.data}\\${name}`); setTouchedOut(true);
                    }
                  }} />
                <button type="button" className="tbtn bordered" onClick={async () => {
                  const r = await window.tz.saveAs(output || `新建压缩包${FORMAT_EXT[format]}`, SAVE_FILTERS);
                  if (r.ok && r.data) { setOutput(r.data); setTouchedOut(true); }
                }}>浏览</button>
              </div>
            </div>
            <div className="field">
              <label>压缩等级</label>
              <select className="input" value={level} disabled={format === 'tar'}
                onChange={(e) => { levelTouched.current = true; setLevel(Number(e.target.value)); }}>
                {LEVELS.map((l) => <option key={l.v} value={l.v}>{l.label}</option>)}
              </select>
              {allPre && (
                <div className="note pre-note">
                  <IconWarn />
                  <span>所选文件本身已是压缩格式(PNG/ZIP/MP4 等),再压几乎不会变小,反而会多出档案头开销。
                    {level === 0 ? '已自动切换为「仅存储」,直接打包不浪费 CPU。' : '建议切换为「仅存储」。'}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 密码 */}
        {canEnc && (
          <div className="field">
            <label className="checkline">
              <input type="checkbox" checked={encOn} onChange={(e) => setEncOn(e.target.checked)} />
              添加密码
            </label>
            {encOn && (
              <input className="input" type="password" autoFocus placeholder="输入密码" value={password}
                onChange={(e) => setPassword(e.target.value)} />
            )}
          </div>
        )}

        {/* 高级设置(默认折叠) */}
        <div className={`adv ${adv ? 'open' : ''}`}>
          <button type="button" className="adv-toggle" onClick={() => setAdv(!adv)}>
            <IconChevronDown className="chev" style={{ width: 14, height: 14 }} />
            高级设置
            <span className="note" style={{ marginLeft: 'auto', fontWeight: 400 }}>字典 · 固实 · 多线程 · 文件头加密</span>
          </button>
          {adv && (
            <div className="adv-body">
              {canVol && !appendTo && (
                <div className="field">
                  <label className="checkline">
                    <input type="checkbox" checked={volOn} onChange={(e) => setVolOn(e.target.checked)} />
                    分卷压缩(7Z / ZIP)
                  </label>
                  {volOn && (
                    <input className={`input ${!volumeOk && volume ? 'err' : ''}`} placeholder="每卷大小,如 700m / 4g"
                      value={volume} onChange={(e) => setVolume(e.target.value.trim())} />
                  )}
                </div>
              )}
              <div className="grid2">
                <div className="field">
                  <label>字典大小(仅 7Z)</label>
                  <select className="input" value={dict} disabled={!is7z} onChange={(e) => setDict(e.target.value)}>
                    {DICTS.map((d) => <option key={d} value={d}>{d.toUpperCase()}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>固实归档(仅 7Z)</label>
                  <select className="input" value={solid} disabled={!is7z} onChange={(e) => setSolid(e.target.value)}>
                    {SOLIDS.map((s) => <option key={s} value={s}>{s === 'auto' ? '自动' : s === 'on' ? '开启' : s === 'off' ? '关闭' : s.toUpperCase()}</option>)}
                  </select>
                </div>
              </div>
              <div className="rowline">
                <div>
                  <div className="rl-label">多线程加速(仅 7Z)</div>
                  <div className="rl-sub">利用全部 CPU 核心</div>
                </div>
                <button type="button" className={`switch ${mt ? 'on' : ''}`} disabled={!is7z} onClick={() => setMt(!mt)} />
              </div>
              {is7z && (
                <div className="rowline">
                  <div>
                    <div className="rl-label">加密文件头</div>
                    <div className="rl-sub">需密码才能看到文件名(配合密码使用)</div>
                  </div>
                  <button type="button" className={`switch ${encHeaders ? 'on' : ''}`} disabled={!encOn} onClick={() => setEncHeaders(!encHeaders)} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="foot">
          <button type="button" className="tbtn" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="tbtn primary" onClick={() => void start()} disabled={busy || !items.length || !output}>
            {busy ? '进行中…' : appendTo ? '添加到压缩包' : '创建压缩包'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
