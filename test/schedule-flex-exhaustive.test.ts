// shiftbook 联合排程（schedule-flex）独立穷举对照测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 单独运行：node --test test/schedule-flex-exhaustive.test.ts
// 单例复跑：node --test --test-name-pattern <案例标识> test/schedule-flex-exhaustive.test.ts
//   （案例标识见失败输出，如 fixed-chain-delay、gen-03；生成案例的种子一并印在
//    测试名与失败输出中，同一标识复跑必然复现同一案例）
//
// 独立判定依据（对照求解器与产品代码的关系）：
// - 对照求解器完全写在本文件内，不 import、不调用、不复制 app.ts 的求解器
//   （solveFlexPlan）、候选开始边界闭包或任何区间计算（合并/扣除/覆盖判定）；
//   日历换算也用逐年逐月累加的朴素算法，而非产品的 civil-from-days。
// - 每个资源的开放、有效停用、有效预约当前安排统一表示为逐分钟布尔占用数组
//   （开放分钟置真，有效停用与有效预约占用分钟置假；已取消预约/停用与未兑现
//   候补不进入数组）。区间左闭右开由“分钟粒度”自然表达，端点相接可行。
// - 对照求解只适用于小型场景：逐项在窗口内【逐分钟】枚举全部合法开始，按需求
//   组顺序以字典序枚举互异资源组合（每组恰选一个、一项所选互不相同、全程固定
//   不拼接间断），按清单顺序深度优先试探，新项之间仅共同资源的分钟重叠才冲突；
//   首个完整方案即“按清单顺序逐项先比开始分钟、再按组序比资源标识字符串”的
//   唯一最小方案；穷举穷尽仍无完整方案即独立判定无整体解。
//
// 覆盖范围：
// - 固定案例：三项结束约束传递使前项延后（fixed-chain-delay）、换资源与延后
//   共同决定可行性（fixed-switch-and-delay）、多组共享候选整体不足
//   （fixed-shared-shortage / fixed-shared-shortage-items，各自可行整体不可行）、
//   多个完整方案时前项资源取舍优先于后项开始时间（fixed-item-resource-priority）、
//   相接/间断开放、重叠停用、预约与停用端点相接、跨午夜（fixed-midnight-adjacent）、
//   已取消预约/停用与未兑现候补不阻挡（fixed-cancelled-not-blocking）。
// - 生成案例：固定种子 GEN_SEED=20261007，每案例种子为 GEN_SEED+序号，共
//   GEN_COUNT=16 例（gen-01..gen-16），确定性生成、适合本地反复运行。生成范围：
//   时间域 2026-10-12T00:00 起 2880 分钟（两天，自然覆盖跨午夜）；2–4 个资源，
//   各 1–2 段开放（第二段一半概率与第一段相接，否则随机，可能间断或重叠）；
//   0–2 段有效停用（同资源第二段一半概率与之重叠），30% 附加一段已取消停用；
//   0–2 项有效预约（30% 附加一项已取消预约，逐分钟扫描空位放置，经命令行创建
//   再取消）；40% 登记一项等待中的固定候补；每单 1–3 项，窗口长 120–480 分钟，
//   时长 30–180 分钟（30% 恰等于窗口），1–2 个需求组，每组 1–3 个候选（随机
//   顺序书写）。有解/无解由对照独立判定，两种结果都纳入断言。
// - 每个案例：在独立临时数据文件上全部经命令行提交；同一案例把组内候选倒序
//   书写后在另一份相同数据上重跑，须得到同一方案。
// - 有解：退出 0，按清单顺序核对每项实际开始、结束与按组所选资源，与对照结果
//   完全一致（不只判断可行）；由新进程 list-bookings 查询全部新增预约（数量、
//   资源、有效状态、普通预约身份），数据文件内既有记录逐条不变。无解：退出 1
//   且说明原因，数据文件逐字节不变、预约计数不推进、不留部分预约。
// - 断言比较业务内容（起止时间、资源、状态、数量），不比对整段输出措辞；
//   任一断言失败即非零退出，输出含种子、案例标识、初始安排、完整清单、预期
//   与实际结果；不读取默认数据文件、不访问网络；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');

// 生成案例参数（范围与案例数固定，确定性可复现）
const GEN_SEED = 20261007;
const GEN_COUNT = 16;
const GEN_BASE = '2026-10-12T00:00'; // 生成时间域起点
const GEN_HORIZON = 2880; // 生成时间域长度（分钟）：两天，覆盖跨午夜

// ---------------------------------------------------------------------------
// 命令行基础设施（与既有回归同一风格：全部经命令行入口、独立临时数据文件）
// ---------------------------------------------------------------------------

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(dataFile: string, args: string[]): CliResult {
  const r = spawnSync(process.execPath, [APP, '--data', dataFile, ...args], {encoding: 'utf8'});
  if (r.error) throw r.error;
  return {status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
}

function ok(df: string, args: string[], ctx: string): CliResult {
  const r = runCli(df, args);
  assert.equal(
    r.status,
    0,
    `[${ctx}] 期望退出 0，实际 ${r.status}\n命令: ${args.join(' ')}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
  return r;
}

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-exhaustive-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

// ---------------------------------------------------------------------------
// 案例定义
// ---------------------------------------------------------------------------

interface CaseItem {
  window: [string, string]; // 窗口开始/结束（YYYY-MM-DDTHH:mm）
  duration: number; // 所需连续分钟数
  groups: string[][]; // 有顺序的需求组，每组为候选资源标识（书写顺序无关）
}

interface CaseSpec {
  id: string; // 案例标识（即测试名，可用于单例复跑）
  resources: Array<{open: Array<[string, string]>; type?: string; name?: string}>;
  closures?: Array<{resource: number; start: string; end: string; cancel?: boolean}>;
  bookings?: Array<{resources: number[]; start: string; end: string; cancel?: boolean}>;
  waitlist?: Array<{resources: number[]; start: string; end: string}>; // 等待中的固定候补
  items: CaseItem[];
}

const resId = (i: number): string => `R${String(i + 1).padStart(4, '0')}`;
const idToIndex = (id: string): number => Number(id.slice(1)) - 1;

// ---------------------------------------------------------------------------
// 独立日历换算：逐年逐月朴素累加（刻意不用产品的 civil-from-days 算法）
// ---------------------------------------------------------------------------

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function dim(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// YYYY-MM-DDTHH:mm -> 自 0001-01-01T00:00 起的分钟数
function toMinutes(dt: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(dt);
  assert.ok(m, `测试内部时间格式: ${dt}`);
  const [, ys, ms, ds, hs, mis] = m;
  const y = Number(ys);
  const mo = Number(ms);
  const d = Number(ds);
  let days = 0;
  for (let yy = 1; yy < y; yy++) days += isLeap(yy) ? 366 : 365;
  for (let mm = 1; mm < mo; mm++) days += dim(y, mm);
  days += d - 1;
  return days * 1440 + Number(hs) * 60 + Number(mis);
}

// 分钟数 -> YYYY-MM-DDTHH:mm（toMinutes 的逆，同样逐年逐月还原）
function toText(min: number): string {
  let days = Math.floor(min / 1440);
  const rem = min - days * 1440;
  let y = 1;
  for (;;) {
    const dy = isLeap(y) ? 366 : 365;
    if (days < dy) break;
    days -= dy;
    y++;
  }
  let mo = 1;
  for (;;) {
    const dm = dim(y, mo);
    if (days < dm) break;
    days -= dm;
    mo++;
  }
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${p(mo)}-${p(days + 1)}T${p(Math.floor(rem / 60))}:${p(rem % 60)}`;
}

// ---------------------------------------------------------------------------
// 独立穷举对照求解器
// 逐分钟布尔占用表示开放/有效停用/有效预约；逐分钟枚举全部合法开始，按组序
// 字典序枚举互异资源组合，按清单顺序深度优先；首个完整方案即约定最小方案，
// 穷尽无解即独立判定无整体解。
// ---------------------------------------------------------------------------

interface OraclePlacement {
  startMin: number;
  endMin: number;
  picks: string[]; // 按需求组顺序
}

// 每个资源的逐分钟空闲数组：开放分钟为真，有效停用与有效预约占用分钟为假；
// 已取消预约/停用与未兑现候补不进入表示
function buildFreeArrays(spec: CaseSpec): {minT: number; free: boolean[][]} {
  const times: number[] = [];
  for (const r of spec.resources) for (const [s, e] of r.open) times.push(toMinutes(s), toMinutes(e));
  for (const c of spec.closures ?? []) times.push(toMinutes(c.start), toMinutes(c.end));
  for (const b of spec.bookings ?? []) times.push(toMinutes(b.start), toMinutes(b.end));
  for (const it of spec.items) times.push(toMinutes(it.window[0]), toMinutes(it.window[1]));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const n = maxT - minT;

  const free = spec.resources.map((r) => {
    const f = new Array<boolean>(n).fill(false);
    for (const [s, e] of r.open) {
      for (let m = toMinutes(s); m < toMinutes(e); m++) f[m - minT] = true;
    }
    return f;
  });
  for (const c of spec.closures ?? []) {
    if (c.cancel) continue; // 已取消停用不阻挡
    const f = free[c.resource];
    for (let m = toMinutes(c.start); m < toMinutes(c.end); m++) f[m - minT] = false;
  }
  for (const b of spec.bookings ?? []) {
    if (b.cancel) continue; // 已取消预约不阻挡
    for (const r of b.resources) {
      const f = free[r];
      for (let m = toMinutes(b.start); m < toMinutes(b.end); m++) f[m - minT] = false;
    }
  }
  return {minT, free};
}

function oracleSolve(spec: CaseSpec): OraclePlacement[] | null {
  const {minT, free} = buildFreeArrays(spec);
  const width = free.length > 0 ? free[0].length : 0;
  const items = spec.items.map((it) => ({
    winS: toMinutes(it.window[0]),
    winE: toMinutes(it.window[1]),
    duration: it.duration,
    // 组内候选排序后按字典序枚举：候选书写顺序不影响结果
    groups: it.groups.map((g) => [...g].sort()),
  }));

  // 已放置新项对各资源的逐分钟占用（随试探入栈/出栈增减）
  const used = spec.resources.map(() => new Array<boolean>(width).fill(false));
  const spanFree = (ri: number, s: number, e: number): boolean => {
    const f = free[ri];
    const u = used[ri];
    for (let m = s; m < e; m++) if (!f[m - minT] || u[m - minT]) return false;
    return true;
  };
  const mark = (ri: number, s: number, e: number, v: boolean): void => {
    const u = used[ri];
    for (let m = s; m < e; m++) u[m - minT] = v;
  };

  const plan: OraclePlacement[] = [];
  const dfsItem = (i: number): boolean => {
    if (i === items.length) return true;
    const it = items[i];
    // 逐分钟枚举窗口内全部合法开始（开始升序）
    for (let s = it.winS; s + it.duration <= it.winE; s++) {
      const e = s + it.duration;
      // 同一开始上按需求组顺序字典序升序枚举互异资源组合
      const picks: number[] = [];
      const dfsGroup = (g: number): boolean => {
        if (g === it.groups.length) {
          for (const ri of picks) if (!spanFree(ri, s, e)) return false;
          for (const ri of picks) mark(ri, s, e, true);
          plan.push({startMin: s, endMin: e, picks: picks.map(resId)});
          if (dfsItem(i + 1)) return true;
          plan.pop();
          for (const ri of picks) mark(ri, s, e, false);
          return false;
        }
        for (const id of it.groups[g]) {
          const ri = idToIndex(id);
          if (picks.includes(ri)) continue; // 一项所选资源互不相同
          picks.push(ri);
          if (dfsGroup(g + 1)) return true;
          picks.pop();
        }
        return false;
      };
      if (dfsGroup(0)) return true;
    }
    return false;
  };
  return dfsItem(0) ? plan : null;
}

// ---------------------------------------------------------------------------
// 确定性生成器（mulberry32；同一种子必然生成同一案例）
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCase(seed: number, index: number): CaseSpec {
  const rng = mulberry32(seed);
  const ri = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const base = toMinutes(GEN_BASE);
  const at = (off: number): string => toText(base + off);
  const H = GEN_HORIZON;

  // 资源：2–4 个，各 1–2 段开放（第二段一半概率与第一段相接，否则随机）
  const nRes = ri(2, 4);
  const resources: CaseSpec['resources'] = [];
  for (let r = 0; r < nRes; r++) {
    const open: Array<[string, string]> = [];
    const len1 = ri(240, 900);
    const s1 = ri(0, H - len1);
    open.push([at(s1), at(s1 + len1)]);
    if (rng() < 0.6) {
      let s2: number;
      let len2: number;
      if (rng() < 0.5) {
        s2 = s1 + len1; // 相接
        len2 = Math.min(ri(60, 480), H - s2);
      } else {
        len2 = ri(60, 480); // 随机：可能间断或重叠
        s2 = ri(0, H - len2);
      }
      if (len2 >= 60) open.push([at(s2), at(s2 + len2)]);
    }
    resources.push({open, name: `资源${r + 1}`});
  }

  // 停用：0–2 段有效（同资源第二段一半概率与之重叠），30% 附加一段已取消
  const closures: NonNullable<CaseSpec['closures']> = [];
  const closureSpans: Array<{resource: number; s: number; e: number}> = [];
  const nCl = ri(0, 2);
  for (let c = 0; c < nCl; c++) {
    const res = ri(0, nRes - 1);
    let s: number;
    let len: number;
    const prev = closureSpans.find((x) => x.resource === res);
    if (prev !== undefined && rng() < 0.5) {
      s = ri(prev.s, prev.e - 1); // 与同资源既有停用重叠
      len = Math.min(ri(30, 240), H - s);
    } else {
      len = ri(30, 240);
      s = ri(0, H - len);
    }
    if (len < 30) continue;
    closures.push({resource: res, start: at(s), end: at(s + len)});
    closureSpans.push({resource: res, s, e: s + len});
  }
  if (rng() < 0.3) {
    const len = ri(30, 240);
    const s = ri(0, H - len);
    closures.push({resource: ri(0, nRes - 1), start: at(s), end: at(s + len), cancel: true});
  }

  // 逐分钟可用表示（开放扣除有效停用），供放置预约与候补使用
  const avail: boolean[][] = resources.map((r) => {
    const f = new Array<boolean>(H).fill(false);
    for (const [s, e] of r.open) {
      for (let m = toMinutes(s) - base; m < toMinutes(e) - base; m++) f[m] = true;
    }
    return f;
  });
  for (const c of closures) {
    if (c.cancel) continue;
    for (let m = toMinutes(c.start) - base; m < toMinutes(c.end) - base; m++) avail[c.resource][m] = false;
  }

  // 预约：0–2 项有效（逐分钟扫描空位放置，创建时必然合法），30% 附加一项已取消
  const bookings: NonNullable<CaseSpec['bookings']> = [];
  const placeBooking = (cancel: boolean): void => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = ri(0, nRes - 1);
      const dur = ri(30, 120);
      const s = ri(0, H - dur);
      let fits = true;
      for (let m = s; m < s + dur; m++) {
        if (!avail[res][m]) {
          fits = false;
          break;
        }
      }
      if (!fits) continue;
      for (let m = s; m < s + dur; m++) avail[res][m] = false;
      bookings.push({resources: [res], start: at(s), end: at(s + dur), ...(cancel ? {cancel: true as const} : {})});
      return;
    }
  };
  const nB = ri(0, 2);
  for (let b = 0; b < nB; b++) placeBooking(false);
  if (rng() < 0.3) placeBooking(true);

  // 候补：40% 登记一项等待中的固定候补（只需实际可用时间完整覆盖，允许冲突）
  const waitlist: NonNullable<CaseSpec['waitlist']> = [];
  if (rng() < 0.4) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = ri(0, nRes - 1);
      const s = ri(0, H - 60);
      let covered = true;
      for (let m = s; m < s + 60; m++) {
        if (!avail[res][m]) {
          covered = false;
          break;
        }
      }
      if (!covered) continue;
      waitlist.push({resources: [res], start: at(s), end: at(s + 60)});
      break;
    }
  }

  // 清单：1–3 项；窗口 120–480 分钟；时长 30–180（30% 恰等于窗口）；
  // 1–2 个需求组，每组 1–3 个候选（随机顺序书写）
  const items: CaseItem[] = [];
  const nIt = ri(1, 3);
  for (let i = 0; i < nIt; i++) {
    const winLen = ri(120, 480);
    const winS = ri(0, H - winLen);
    const duration = rng() < 0.3 ? winLen : ri(30, Math.min(winLen, 180));
    const nGroups = ri(1, Math.min(2, nRes));
    const groups: string[][] = [];
    for (let g = 0; g < nGroups; g++) {
      const nCand = ri(1, Math.min(3, nRes));
      const idxs = [...Array(nRes).keys()];
      for (let k = idxs.length - 1; k > 0; k--) {
        const j = Math.floor(rng() * (k + 1));
        [idxs[k], idxs[j]] = [idxs[j], idxs[k]];
      }
      groups.push(idxs.slice(0, nCand).map(resId));
    }
    items.push({window: [at(winS), at(winS + winLen)], duration, groups});
  }

  return {
    id: `gen-${String(index).padStart(2, '0')}`,
    resources,
    closures,
    bookings,
    waitlist,
    items,
  };
}

// ---------------------------------------------------------------------------
// 案例执行与核对
// ---------------------------------------------------------------------------

// 经命令行在指定数据文件上搭建案例的初始安排
function setupCase(df: string, spec: CaseSpec, ctx: string): void {
  spec.resources.forEach((r, i) => {
    const args = ['add-resource', '--type', r.type ?? 'venue', '--name', r.name ?? `资源${i + 1}`];
    for (const [s, e] of r.open) args.push('--open', `${s}/${e}`);
    ok(df, args, `${ctx} 登记资源 ${resId(i)}`);
  });
  (spec.closures ?? []).forEach((c, i) => {
    const id = `C${String(i + 1).padStart(4, '0')}`;
    ok(df, ['add-closure', '--resource', resId(c.resource), '--start', c.start, '--end', c.end], `${ctx} 登记停用 ${id}`);
    if (c.cancel) ok(df, ['cancel-closure', id], `${ctx} 取消停用 ${id}`);
  });
  (spec.bookings ?? []).forEach((b, i) => {
    const id = `B${String(i + 1).padStart(4, '0')}`;
    const args = ['create-booking'];
    for (const r of b.resources) args.push('--resource', resId(r));
    args.push('--start', b.start, '--end', b.end);
    ok(df, args, `${ctx} 创建预约 ${id}`);
    if (b.cancel) ok(df, ['cancel-booking', id], `${ctx} 取消预约 ${id}`);
  });
  (spec.waitlist ?? []).forEach((w, i) => {
    const args = ['add-waitlist'];
    for (const r of w.resources) args.push('--resource', resId(r));
    args.push('--start', w.start, '--end', w.end);
    ok(df, args, `${ctx} 登记候补 W${String(i + 1).padStart(4, '0')}（等待中，不阻挡）`);
  });
}

function writeManifest(dir: string, name: string, spec: CaseSpec, reversed: boolean): string {
  const items = spec.items.map((it) => ({
    window: `${it.window[0]}/${it.window[1]}`,
    duration: it.duration,
    groups: reversed ? it.groups.map((g) => [...g].reverse()) : it.groups,
  }));
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}) + '\n', 'utf8');
  return p;
}

interface ActualItem {
  id: string;
  start: string;
  end: string;
  picks: string[]; // 按需求组顺序
}

// 从成功输出中解析业务内容：各项标识、起止时间与按组对应的资源
function parsePlan(stdout: string, ctx: string): ActualItem[] {
  const items: ActualItem[] = [];
  let cur: ActualItem | null = null;
  for (const line of stdout.split('\n')) {
    const mi = /^- 第 (\d+) 项 -> (B\d{4}): (\S+) → (\S+)（\d+ 分钟）$/.exec(line);
    if (mi) {
      cur = {id: mi[2], start: mi[3], end: mi[4], picks: []};
      items.push(cur);
      continue;
    }
    const mg = /^ {4}第 (\d+) 组: (R\d{4})（/.exec(line);
    if (mg && cur !== null) {
      assert.equal(Number(mg[1]), cur.picks.length + 1, `[${ctx}] 组号应按顺序出现\nstdout:\n${stdout}`);
      cur.picks.push(mg[2]);
    }
  }
  return items;
}

// 有解时核对落盘内容：数量、资源、有效状态、普通预约身份；既有记录逐条不变
function verifyStore(df: string, before: any, spec: CaseSpec, actual: ActualItem[], diag: string): void {
  const after = readStore(df);
  assert.deepEqual(after.resources, before.resources, `既有资源不变${diag}`);
  assert.deepEqual(after.closures, before.closures, `既有停用记录（含已取消）不变${diag}`);
  assert.deepEqual(after.waitlist, before.waitlist, `既有候补不变（不自动处理候补）${diag}`);
  assert.deepEqual(after.series, before.series, `不创建系列${diag}`);
  assert.deepEqual(after.batchOps, before.batchOps, `不产生批量改期记录${diag}`);
  assert.deepEqual(after.imports, before.imports, `既有导入身份不变${diag}`);
  assert.equal(after.bookings.length, before.bookings.length + spec.items.length, `新增预约数量 = 清单项数${diag}`);
  assert.equal(after.bookingSeq, before.bookingSeq + spec.items.length, `预约计数恰推进清单项数${diag}`);
  for (const b of before.bookings) {
    assert.deepEqual(
      after.bookings.find((x: any) => x.id === b.id),
      b,
      `既有预约 ${b.id} 不变${diag}`,
    );
  }
  for (const a of actual) {
    const rec = after.bookings.find((x: any) => x.id === a.id);
    assert.ok(rec, `新预约 ${a.id} 已落盘${diag}`);
    assert.equal(rec.start, a.start, `${a.id} 落盘开始时间${diag}`);
    assert.equal(rec.end, a.end, `${a.id} 落盘结束时间${diag}`);
    assert.equal(rec.status, 'active', `${a.id} 有效状态${diag}`);
    assert.equal(rec.seriesId, undefined, `${a.id} 普通预约身份（无系列归属）${diag}`);
    assert.deepEqual(rec.resourceIds, [...a.picks].sort(), `${a.id} 落盘资源集合${diag}`);
  }
}

// 有解时由新进程按日查询：全部新增预约可见，数量、资源、状态、身份正确
function verifyListBookings(df: string, spec: CaseSpec, actual: ActualItem[], diag: string): void {
  const newIntervals = actual.map((a) => [toMinutes(a.start), toMinutes(a.end)] as [number, number]);
  const oldIntervals = (spec.bookings ?? []).map((b) => [toMinutes(b.start), toMinutes(b.end)] as [number, number]);
  const days = new Set<number>();
  for (const [s, e] of newIntervals) {
    for (let d = Math.floor(s / 1440); d <= Math.floor((e - 1) / 1440); d++) days.add(d);
  }
  for (const d of [...days].sort((a, b) => a - b)) {
    const dateText = toText(d * 1440).slice(0, 10);
    const r = ok(df, ['list-bookings', '--date', dateText], `新进程按日查询 ${dateText}${diag}`);
    const all = [...oldIntervals, ...newIntervals];
    const count = all.filter(([s, e]) => s < (d + 1) * 1440 && e > d * 1440).length;
    assert.ok(
      r.stdout.includes(`共 ${count} 条`),
      `${dateText} 当天预约总数应为 ${count}${diag}\nstdout:\n${r.stdout}`,
    );
    const lines = r.stdout.split('\n');
    actual.forEach((a, i) => {
      const [s, e] = newIntervals[i];
      if (!(s < (d + 1) * 1440 && e > d * 1440)) return;
      const idx = lines.findIndex((l) => l.startsWith(`- ${a.id} [已预约] ${a.start} → ${a.end}`));
      assert.ok(idx >= 0, `新进程查询可见 ${a.id}（已预约、时间与对照一致）${diag}\nstdout:\n${r.stdout}`);
      let end = lines.findIndex((l, j) => j > idx && l.startsWith('- '));
      if (end === -1) end = lines.length;
      const block = lines.slice(idx, end);
      const resLine = block.find((l) => l.startsWith('    资源: '));
      assert.ok(resLine !== undefined, `${a.id} 应有资源行${diag}\nstdout:\n${r.stdout}`);
      for (const p of a.picks) {
        assert.ok(resLine.includes(p), `${a.id} 资源行应含 ${p}${diag}\n资源行: ${resLine}`);
      }
      assert.ok(!block.some((l) => l.includes('所属系列')), `${a.id} 普通预约身份（不属于系列）${diag}\nstdout:\n${r.stdout}`);
    });
  }
}

interface HandItem {
  start: string;
  end: string;
  picks: string[];
}

// 执行一个案例：独立穷举对照 -> 命令行提交 -> 业务内容核对 -> 候选倒序重跑
function checkCase(
  t: {after: (fn: () => void) => void; diagnostic: (msg: string) => void},
  spec: CaseSpec,
  seedLabel: string,
  hand: HandItem[] | null | undefined,
): void {
  const dir = tempDir(t);
  const oracle = oracleSolve(spec);
  const oracleText =
    oracle === null
      ? null
      : oracle.map((p) => ({start: toText(p.startMin), end: toText(p.endMin), picks: p.picks}));
  t.diagnostic(`对照判定: ${oracleText === null ? '无整体解' : `有解 ${JSON.stringify(oracleText)}`}`);
  const diag =
    `\n===== 对照失败诊断（可据此处信息单例复跑）=====` +
    `\n案例标识: ${spec.id}` +
    `\n种子: ${seedLabel}` +
    `\n初始安排与完整清单: ${JSON.stringify(spec)}` +
    `\n对照（独立穷举）预期: ${oracleText === null ? '无整体解' : JSON.stringify(oracleText)}`;

  if (hand !== undefined) {
    assert.deepEqual(oracleText, hand, `对照结果应符合固定案例设计意图${diag}`);
  }

  // 在一份独立临时数据上提交清单并核对（reversed=false 原样，true 组内候选倒序）
  const runOnce = (reversed: boolean): ActualItem[] | null => {
    const df = join(dir, reversed ? 'data-rev.json' : 'data.json');
    const ctx = `案例 ${spec.id}${reversed ? '（候选倒序）' : ''}`;
    setupCase(df, spec, ctx);
    const before = readStore(df);
    const bytesBefore = readFileSync(df);
    const manifest = writeManifest(dir, reversed ? 'plan-rev.json' : 'plan.json', spec, reversed);
    const r = runCli(df, ['schedule-flex', manifest]);

    if (oracleText === null) {
      // 独立判定无整体解：退出 1、说明原因、文件逐字节不变、不留部分预约
      assert.equal(
        r.status,
        1,
        `无整体解应退出 1，实际 ${r.status}${diag}\n实际 stderr:\n${r.stderr}\n实际 stdout:\n${r.stdout}`,
      );
      assert.match(r.stderr, /无整体解/, `退出 1 须说明无整体解原因${diag}\n实际 stderr:\n${r.stderr}`);
      assert.ok(!r.stdout.includes('联合排程成功'), `不得报告成功${diag}\n实际 stdout:\n${r.stdout}`);
      assert.ok(bytesBefore.equals(readFileSync(df)), `无解时数据文件逐字节不变${diag}`);
      const after = readStore(df);
      assert.equal(after.bookings.length, before.bookings.length, `不留部分预约${diag}`);
      assert.equal(after.bookingSeq, before.bookingSeq, `预约计数不推进${diag}`);
      return null;
    }

    assert.equal(
      r.status,
      0,
      `有解应退出 0，实际 ${r.status}${diag}\n实际 stderr:\n${r.stderr}\n实际 stdout:\n${r.stdout}`,
    );
    assert.ok(
      r.stdout.includes(`联合排程成功：已按清单顺序原子创建 ${spec.items.length} 项预约`),
      `成功提示与项数${diag}\n实际 stdout:\n${r.stdout}`,
    );
    const actual = parsePlan(r.stdout, ctx);
    assert.equal(actual.length, spec.items.length, `输出项数 = 清单项数${diag}\n实际 stdout:\n${r.stdout}`);
    actual.forEach((a, i) => {
      const expId = `B${String(before.bookingSeq + i + 1).padStart(4, '0')}`;
      const exp = oracleText[i];
      assert.deepEqual(
        a,
        {id: expId, start: exp.start, end: exp.end, picks: exp.picks},
        `第 ${i + 1} 项须与对照最小方案完全一致（标识、开始、结束、按组资源）${diag}\n实际 stdout:\n${r.stdout}`,
      );
    });
    verifyStore(df, before, spec, actual, diag);
    verifyListBookings(df, spec, actual, diag);
    return actual;
  };

  const planNormal = runOnce(false);
  const planReversed = runOnce(true);
  if (planNormal === null) {
    assert.equal(planReversed, null, `候选倒序后仍须判定无整体解${diag}`);
  } else {
    assert.deepEqual(planReversed, planNormal, `同一案例组内候选倒序书写后仍须得到同一方案${diag}`);
  }
}

// ---------------------------------------------------------------------------
// 固定案例
// ---------------------------------------------------------------------------

const FIXED_CASES: Array<{spec: CaseSpec; expect: HandItem[] | null}> = [
  {
    // 三项结束约束传递使前项延后：第 3 项固定在 09:00-10:00，第 2 项被顶到
    // 11:00，第 1 项再被顶到 10:00（s1 = s2 + d2，s2 = s3 + d3 的传递链）
    spec: {
      id: 'fixed-chain-delay',
      resources: [{open: [['2026-10-12T08:00', '2026-10-12T14:00']]}],
      items: [
        {window: ['2026-10-12T09:00', '2026-10-12T13:00'], duration: 60, groups: [['R0001']]},
        {window: ['2026-10-12T09:00', '2026-10-12T13:00'], duration: 60, groups: [['R0001']]},
        {window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001']]},
      ],
    },
    expect: [
      {start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']},
      {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
  },
  {
    // 换资源与延后共同决定可行性：R0001 剩余开放不足 90 分钟（必须换到 R0002），
    // R0002 又有有效停用覆盖 09:00-10:00（必须延后到 10:00）
    spec: {
      id: 'fixed-switch-and-delay',
      resources: [
        {open: [['2026-10-12T09:00', '2026-10-12T10:30']]},
        {open: [['2026-10-12T09:00', '2026-10-12T13:00']]},
      ],
      closures: [{resource: 1, start: '2026-10-12T09:00', end: '2026-10-12T10:00'}],
      items: [
        {window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001']]},
        {window: ['2026-10-12T09:00', '2026-10-12T13:00'], duration: 90, groups: [['R0001', 'R0002']]},
      ],
    },
    expect: [
      {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {start: '2026-10-12T10:00', end: '2026-10-12T11:30', picks: ['R0002']},
    ],
  },
  {
    // 多组共享候选造成整体不足：三个需求组共享两个资源，无法选出三个互异资源
    spec: {
      id: 'fixed-shared-shortage',
      resources: [
        {open: [['2026-10-12T09:00', '2026-10-12T12:00']]},
        {open: [['2026-10-12T09:00', '2026-10-12T12:00']]},
      ],
      items: [
        {
          window: ['2026-10-12T09:00', '2026-10-12T10:00'],
          duration: 60,
          groups: [['R0001', 'R0002'], ['R0001', 'R0002'], ['R0002']],
        },
      ],
    },
    expect: null,
  },
  {
    // 各自可行但整体不可行：三项窗口都恰等于时长（只能同占 09:00-10:00），
    // 两个资源不够三项互异分配
    spec: {
      id: 'fixed-shared-shortage-items',
      resources: [
        {open: [['2026-10-12T09:00', '2026-10-12T12:00']]},
        {open: [['2026-10-12T09:00', '2026-10-12T12:00']]},
      ],
      items: [
        {window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001', 'R0002']]},
        {window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001', 'R0002']]},
        {window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001']]},
      ],
    },
    expect: null,
  },
  {
    // 存在多个完整方案时，前项资源取舍优先于后项开始时间：
    // 方案甲（第1项 R0001@09:00，第2项 10:00）与方案乙（第1项 R0002@09:00，
    // 第2项 09:00）比较，第 1 项资源 R0001 < R0002 先决，甲胜出——尽管乙的第 2 项更早
    spec: {
      id: 'fixed-item-resource-priority',
      resources: [
        {open: [['2026-10-12T08:00', '2026-10-12T13:00']]},
        {open: [['2026-10-12T08:00', '2026-10-12T13:00']]},
      ],
      items: [
        {window: ['2026-10-12T09:00', '2026-10-12T12:00'], duration: 60, groups: [['R0001', 'R0002']]},
        {window: ['2026-10-12T09:00', '2026-10-12T12:00'], duration: 60, groups: [['R0001']]},
      ],
    },
    expect: [
      {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
    ],
  },
  {
    // 相接开放跨午夜合并为连续开放；间断开放另成一段；两条停用相互重叠；
    // 既有预约 B0002 的结束恰与停用 C0001 的开始相接；新项开始恰与停用结束、
    // 前一新项结束相接；窗口跨午夜
    spec: {
      id: 'fixed-midnight-adjacent',
      resources: [
        {
          open: [
            ['2026-10-12T20:00', '2026-10-13T00:00'],
            ['2026-10-13T00:00', '2026-10-13T08:00'],
            ['2026-10-13T10:00', '2026-10-13T12:00'],
          ],
        },
      ],
      closures: [
        {resource: 0, start: '2026-10-12T22:00', end: '2026-10-12T23:30'},
        {resource: 0, start: '2026-10-12T23:00', end: '2026-10-13T01:00'},
      ],
      bookings: [
        {resources: [0], start: '2026-10-12T20:00', end: '2026-10-12T21:00'},
        {resources: [0], start: '2026-10-12T21:00', end: '2026-10-12T22:00'},
      ],
      items: [
        {window: ['2026-10-12T19:00', '2026-10-13T02:00'], duration: 30, groups: [['R0001']]},
        {window: ['2026-10-12T21:00', '2026-10-13T03:00'], duration: 60, groups: [['R0001']]},
        {window: ['2026-10-13T09:00', '2026-10-13T13:00'], duration: 60, groups: [['R0001']]},
      ],
    },
    expect: [
      {start: '2026-10-13T01:00', end: '2026-10-13T01:30', picks: ['R0001']},
      {start: '2026-10-13T01:30', end: '2026-10-13T02:30', picks: ['R0001']},
      {start: '2026-10-13T10:00', end: '2026-10-13T11:00', picks: ['R0001']},
    ],
  },
  {
    // 已取消停用、已取消预约与未兑现候补均不阻挡：窗口内最早开始即可行
    spec: {
      id: 'fixed-cancelled-not-blocking',
      resources: [{open: [['2026-10-12T08:00', '2026-10-12T12:00']]}],
      closures: [{resource: 0, start: '2026-10-12T08:00', end: '2026-10-12T12:00', cancel: true}],
      bookings: [{resources: [0], start: '2026-10-12T09:00', end: '2026-10-12T10:00', cancel: true}],
      waitlist: [{resources: [0], start: '2026-10-12T09:00', end: '2026-10-12T10:00'}],
      items: [{window: ['2026-10-12T09:00', '2026-10-12T10:00'], duration: 60, groups: [['R0001']]}],
    },
    expect: [{start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}],
  },
];

for (const {spec, expect} of FIXED_CASES) {
  test(spec.id, (t) => checkCase(t, spec, '固定案例（无种子）', expect));
}

for (let k = 1; k <= GEN_COUNT; k++) {
  const seed = GEN_SEED + k;
  const spec = generateCase(seed, k);
  test(`${spec.id}（种子 ${seed}）`, (t) => checkCase(t, spec, String(seed), undefined));
}
