// shiftbook schedule-flex 独立穷举对照测试
//
// 运行：
//   npm test                         （随全部回归一起执行）
//   node --test test/schedule-flex-exhaustive.test.ts
// 单例复跑（只跑某一个案例，失败信息中会给出案例标识）：
//   FLEX_CASE=fixed-04-resource-before-later-start node --test test/schedule-flex-exhaustive.test.ts
//   FLEX_CASE=gen-0017 node --test test/schedule-flex-exhaustive.test.ts
//
// 本文件是 schedule-flex 的“独立对照”回归，与既有 schedule-flex.test.ts 的区别：
// 既有用例按预置预期逐场景断言；本文件不引用 app.ts 的任何实现，而是自带一份
// 朴素穷举对照器，对每个小型场景独立判定是否存在整体解、独立求出唯一最小方案，
// 再经现有命令行入口提交，逐业务字段核对产品输出与落盘结果。
//
// 独立判定依据（对照器只用于这些小型场景，与产品代码无共享）：
// - 时间全部折算为分钟整数（测试专用，直接用 Date.UTC 解析清单里的营业地时间
//   文本，不依赖机器时区；与产品的日历换算各自独立实现）；
// - 以逐分钟的资源占用位图表示三类事实：开放区间置位、有效停用清位、有效预约
//   的当前安排清位；已取消预约、已取消停用与未兑现候补一律不写入位图（不阻挡）；
// - 不调用、不复制产品的求解器、候选开始闭包或区间合并/扣除算法：对每一项，
//   在其窗口内逐分钟枚举全部合法开始分钟，并按需求组顺序枚举“每组恰选一个、
//   同项互异”的全部资源组合，逐分钟核对每个所选资源在整段 [s, s+duration)
//   都可用（资源全程固定、不拼接间断；端点相接因左闭右开而允许）；
// - 整单可行性由清单顺序的深度优先枚举独立判定；所有完整可行方案按清单顺序
//   逐项比较（先比开始分钟，再按需求组顺序逐位比资源标识字符串），第一个完整
//   方案即唯一最小方案；枚举不到完整方案即独立判定“无整体解”。
//
// 覆盖范围：
// - 固定案例：①三项结束约束经传递把前项顶到最晚；②换资源与延后共同决定可行
//   性（停用端点）；③多组共享候选导致整体不足（无解、文件逐字节不变）；
//   ④存在多个完整方案时，前项资源取舍优先于后项开始时间（且组内候选倒序书写
//   结果不变）；⑤已取消预约/停用与未兑现候补不阻挡；⑥相接或间断开放、重叠
//   停用、预约与停用端点相接、跨午夜；
// - 固定种子生成案例（SEED = 0x5f1eb00c，共 GEN_CASES = 40 个，全部以
//   2026-10-13 为营业日、10 分钟为栅格，确定性产生且范围有界，适合本地反复
//   运行）：资源 3-4 个；每资源为单段开放（07:00-08:50 起、17:00-19:50 止）
//   或两段开放（接缝在 10:00-14:50，端点相接或留 10-50 分钟间断）；停用
//   0-2 条（两条时同资源且时间重叠，单条可能与开放端点相接）；清单项 2-4
//   项，时长 30 或 60 分钟，窗口位于 08:00-19:00 且余量取 0/30/60/90/120/180
//   分钟，需求组 1-2 组、每组 1-3 个候选，并偏向让多项共享 R0001 以制造整体
//   不足（不放既有预约：占用口径由 fixed-05 专门覆盖）。当前种子下有解 31、
//   无整体解 9；每个生成案例还会把组内候选倒序书写后在独立数据上重跑，必须
//   得到同一方案（或同样无解）。
//
// 断言只比较业务内容（退出码、逐项开始/结束/按组所选资源、数量/状态/普通
// 预约身份、既有记录是否逐字节保持），不比较整段输出措辞；新增预约由新进程
// 执行 list-bookings 查询核对。全部数据位于独立临时目录，不读取默认业务数据，
// 不访问网络；结束清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');

// 固定种子：生成案例由此确定性地产生，失败信息可凭种子与案例序号复跑。
const SEED = 0x5f1eb00c;
const GEN_CASES = 40; // 生成案例数（范围明确有界，单文件本地反复运行）

const ONLY = process.env.FLEX_CASE?.trim() || undefined;

// ---------------------------------------------------------------------------
// 测试专用时间换算（与产品实现相互独立；仅解析/格式化 YYYY-MM-DDTHH:mm）
// ---------------------------------------------------------------------------

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function toMin(value: string): number {
  const m = DT_RE.exec(value);
  assert.ok(m, `对照器收到非法时间文本: ${value}`);
  const [, y, mo, d, h, mi] = m;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)) / 60000;
}

function fmtMin(min: number): string {
  const d = new Date(min * 60000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}`;
}

function dateOf(min: number): string {
  return fmtMin(min).slice(0, 10);
}

// ---------------------------------------------------------------------------
// 业务数据快照的最小结构（字段直接读自 app.ts 落盘的 JSON，不复用其类型/代码）
// ---------------------------------------------------------------------------

interface SnapResource {
  id: string;
  name: string;
  open: Array<[string, string]>;
}
interface SnapBooking {
  id: string;
  resourceIds: string[];
  start: string;
  end: string;
  status: string;
  seriesId?: string;
}
interface SnapClosure {
  resourceId: string;
  start: string;
  end: string;
  status: string;
}
interface SnapStore {
  resourceSeq: number;
  bookingSeq: number;
  seriesSeq: number;
  waitlistSeq: number;
  closureSeq: number;
  batchSeq: number;
  resources: SnapResource[];
  bookings: SnapBooking[];
  series: unknown[];
  waitlist: Array<Record<string, unknown>>;
  closures: SnapClosure[];
  batchOps: unknown[];
  imports: unknown[];
}

// ---------------------------------------------------------------------------
// 独立穷举对照器
// ---------------------------------------------------------------------------

interface OracleItem {
  startRaw: string;
  endRaw: string;
  duration: number;
  groups: string[][]; // 按需求组顺序的候选（组内书写顺序不影响对照结论）
}
interface OraclePlacement {
  startMin: number;
  endMin: number;
  picks: string[]; // 按需求组顺序
}

// 逐分钟资源占用位图 + 全量枚举。返回 null 表示独立判定无整体解；
// 否则返回按约定比较关系求出的唯一最小方案。
function exhaustiveOracle(store: SnapStore, items: OracleItem[]): OraclePlacement[] | null {
  const h0 = Math.min(...items.map((i) => toMin(i.startRaw)));
  const h1 = Math.max(...items.map((i) => toMin(i.endRaw)));
  const span = h1 - h0;

  // 每个候选资源一张逐分钟位图：先全部置 0，开放处置 1，有效停用清 0，
  // 有效预约的当前安排清 0。取消记录与未兑现候补从不写入。
  const masks = new Map<string, Uint8Array>();
  const maskOf = (id: string): Uint8Array => {
    let a = masks.get(id);
    if (a === undefined) {
      a = new Uint8Array(span);
      masks.set(id, a);
    }
    return a;
  };
  const paint = (id: string, s: number, e: number, v: 0 | 1): void => {
    const a = Math.max(s, h0);
    const b = Math.min(e, h1);
    if (a >= b) return;
    const arr = maskOf(id);
    for (let t = a; t < b; t++) arr[t - h0] = v;
  };

  for (const r of store.resources) {
    for (const [s, e] of r.open) paint(r.id, toMin(s), toMin(e), 1);
  }
  for (const c of store.closures) {
    if (c.status === 'active') paint(c.resourceId, toMin(c.start), toMin(c.end), 0);
  }
  for (const b of store.bookings) {
    if (b.status === 'active') {
      for (const id of b.resourceIds) paint(id, toMin(b.start), toMin(b.end), 0);
    }
  }

  interface Option {
    s: number;
    picks: string[];
  }
  // 同项资源标识序列字典序比较（按需求组顺序逐位）
  const picksLess = (a: string[], b: string[]): boolean => {
    for (let g = 0; g < a.length; g++) {
      if (a[g] < b[g]) return true;
      if (a[g] > b[g]) return false;
    }
    return false;
  };

  // 每项的全部合法选择：逐分钟开始 × 按组互异资源组合 × 逐分钟可用
  const optionsPerItem: Option[][] = items.map((it) => {
    const ws = toMin(it.startRaw);
    const we = toMin(it.endRaw);
    const out: Option[] = [];
    const combos: string[][] = [];
    const acc: string[] = [];
    const gen = (g: number): void => {
      if (g === it.groups.length) {
        combos.push([...acc]);
        return;
      }
      for (const id of it.groups[g]) {
        if (acc.includes(id)) continue; // 同一预约的各组所选资源必须互异
        acc.push(id);
        gen(g + 1);
        acc.pop();
      }
    };
    gen(0);

    for (let s = ws; s + it.duration <= we; s++) {
      const e = s + it.duration;
      for (const picks of combos) {
        let usable = true;
        outer: for (const id of picks) {
          const arr = masks.get(id);
          if (arr === undefined) {
            usable = false;
            break;
          }
          for (let t = s; t < e; t++) {
            if (arr[t - h0] !== 1) {
              usable = false;
              break outer;
            }
          }
        }
        if (usable) out.push({s, picks});
      }
    }
    // 合法选择排序键：开始分钟升序，再按组序资源标识字典序
    out.sort((a, b) => (a.s !== b.s ? a.s - b.s : picksLess(a.picks, b.picks) ? -1 : 1));
    return out;
  });

  // 安排之间的冲突判定：共享同一资源且左闭右开重叠（端点相接允许）
  interface PlacementT {
    s: number;
    e: number;
    picks: string[];
  }
  const conflicts = (a: PlacementT, b: PlacementT): boolean => {
    for (const id of a.picks) {
      if (b.picks.includes(id) && a.s < b.e && b.s < a.e) return true;
    }
    return false;
  };

  // 清单顺序深度优先：选择已按 (开始分钟, 资源标识序列) 排序，首个完整方案
  // 即约定的唯一最小方案；每层对所有后续项做前向检查，剪枝“后续必败”分支
  // （该检查只剪“固定前缀下某项已无任何合法选择”的分支，不会误杀解）。
  const chosen: PlacementT[] = [];
  const completable = (itemIdx: number, p: PlacementT): boolean => {
    // 把 p 临时并入后，第 itemIdx 项是否仍存在合法选择
    const trial = [...chosen, p];
    for (const o of optionsPerItem[itemIdx]) {
      const q = {s: o.s, e: o.s + items[itemIdx].duration, picks: o.picks};
      if (trial.every((x) => !conflicts(x, q))) return true;
    }
    return false;
  };
  const dfs = (idx: number): PlacementT[] | null => {
    if (idx === items.length) return [];
    for (const o of optionsPerItem[idx]) {
      const p = {s: o.s, e: o.s + items[idx].duration, picks: o.picks};
      if (chosen.some((x) => conflicts(x, p))) continue;
      chosen.push(p);
      let forwardOk = true;
      for (let k = idx + 1; k < items.length; k++) {
        if (!completable(k, p)) {
          forwardOk = false;
          break;
        }
      }
      if (forwardOk) {
        const rest = dfs(idx + 1);
        if (rest !== null) {
          chosen.pop();
          return [p, ...rest];
        }
      }
      chosen.pop();
    }
    return null;
  };
  const sol = dfs(0);
  if (sol === null) return null;
  return sol.map((p) => ({startMin: p.s, endMin: p.e, picks: [...p.picks]}));
}

// ---------------------------------------------------------------------------
// 命令行基础设施（与既有回归同口径：每个案例独立 --data 临时文件、真实子进程）
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

function mustOk(dataFile: string, args: string[], ctx: string): CliResult {
  const r = runCli(dataFile, args);
  assert.equal(
    r.status,
    0,
    `[${ctx}] 准备阶段期望退出 0，实际 ${r.status}\n命令: ${args.join(' ')}\nstderr:\n${r.stderr}`,
  );
  return r;
}

function newTempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `shiftbook-flex-exh-${tag}-`));
}

function readStore(dataFile: string): SnapStore {
  return JSON.parse(readFileSync(dataFile, 'utf8')) as SnapStore;
}

function addResource(
  dataFile: string,
  name: string,
  open: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']],
): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  mustOk(dataFile, args, `登记资源 ${name}`);
}

function addClosure(dataFile: string, resourceId: string, start: string, end: string): void {
  mustOk(
    dataFile,
    ['add-closure', '--resource', resourceId, '--start', start, '--end', end],
    `登记停用 ${resourceId} ${start}/${end}`,
  );
}

function createBooking(dataFile: string, resourceIds: string[], start: string, end: string): void {
  const args = ['create-booking', '--start', start, '--end', end];
  for (const id of resourceIds) args.push('--resource', id);
  mustOk(dataFile, args, `既有预约 ${start}/${end}`);
}

function writeManifest(dir: string, name: string, items: OracleItem[]): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    JSON.stringify({
      items: items.map((i) => ({window: `${i.startRaw}/${i.endRaw}`, duration: i.duration, groups: i.groups})),
    }) + '\n',
    'utf8',
  );
  return p;
}

// 失败诊断信息：种子、案例标识、初始安排、完整清单、对照结果一并给出，可凭标识单例复跑
function describeCase(
  caseId: string,
  store: SnapStore,
  items: OracleItem[],
  oracle: OraclePlacement[] | null,
  detail = '',
): string {
  const suffix = detail ? `（${detail}）` : '';
  const lines = [
    `案例标识: ${caseId}${suffix}（固定种子 0x${SEED.toString(16)}；单例复跑: FLEX_CASE=${caseId} node --test test/schedule-flex-exhaustive.test.ts）`,
    '初始安排:',
    ...store.resources.map(
      (r) => `  资源 ${r.id}（${r.name}）开放: ${r.open.map(([s, e]) => `${s}/${e}`).join(' , ')}`,
    ),
    ...store.closures.map(
      (c) => `  停用 ${c.status}: ${c.resourceId} ${c.start} → ${c.end}`,
    ),
    ...store.bookings.map(
      (b) => `  预约 ${b.id} [${b.status}] ${b.start} → ${b.end} 资源=${b.resourceIds.join(',')}`,
    ),
    ...store.waitlist.map(
      (w) => `  候补 ${w.id as string} [${w.status as string}] ${w.start as string} → ${w.end as string}`,
    ),
    `完整清单: ${JSON.stringify(items)}`,
    `对照器结论: ${oracle === null ? '无整体解' : JSON.stringify(oracle.map((p) => ({start: fmtMin(p.startMin), end: fmtMin(p.endMin), picks: p.picks})))}`,
  ];
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 新进程查询：list-bookings 按天（跨午夜案例逐日查询），只解析业务字段
// ---------------------------------------------------------------------------

interface ListedBooking {
  status: string;
  start: string;
  end: string;
  resourceText: string;
  hasSeries: boolean;
}

function queryBookingsByDays(
  dataFile: string,
  days: string[],
): {found: Map<string, ListedBooking>; counts: Map<string, number>} {
  const found = new Map<string, ListedBooking>();
  const counts = new Map<string, number>();
  for (const day of days) {
    const r = mustOk(dataFile, ['list-bookings', '--date', day], `新进程查询 ${day}`);
    const cm = new RegExp(`^${day} 当天的预约（共 (\\d+) 条`).exec(r.stdout);
    if (cm) counts.set(day, Number(cm[1]));
    const lines = r.stdout.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^- (B\d{4}) \[(已预约|已取消)\] (\S+) → (\S+)\s*$/.exec(lines[i]);
      if (!m) continue;
      let resourceText = '';
      let hasSeries = false;
      for (let j = i + 1; j < lines.length && !lines[j].startsWith('- '); j++) {
        const rm = /^\s+资源: (.+)$/.exec(lines[j]);
        if (rm) resourceText = rm[1];
        if (/^\s+所属系列:/.test(lines[j])) hasSeries = true;
      }
      found.set(m[1], {status: m[2], start: m[3], end: m[4], resourceText, hasSeries});
    }
  }
  return {found, counts};
}

// ---------------------------------------------------------------------------
// 核心核对：对照器结论 vs 经命令行提交后的真实结果（业务字段逐项核对）
// ---------------------------------------------------------------------------

interface VerifyResult {
  oraclePlan: OraclePlacement[] | null;
}

function verifyFlex(
  caseId: string,
  dataFile: string,
  manifestFile: string,
  items: OracleItem[],
  detail = '',
): VerifyResult {
  const bytesBefore = readFileSync(dataFile);
  const storeBefore = readStore(dataFile);
  const expected = exhaustiveOracle(storeBefore, items);
  const ctx = describeCase(caseId, storeBefore, items, expected, detail);
  const r = runCli(dataFile, ['schedule-flex', manifestFile]);

  if (expected === null) {
    assert.equal(r.status, 1, `${ctx}\n\n无整体解案例应退出 1，实际 ${r.status}\nstdout:\n${r.stdout}`);
    assert.match(r.stderr, /无整体解/, `${ctx}\n\n应说明无整体解原因\nstderr:\n${r.stderr}`);
    assert.ok(
      !r.stdout.includes('联合排程成功'),
      `${ctx}\n\n无整体解不得报告成功\nstdout:\n${r.stdout}`,
    );
    assert.ok(
      bytesBefore.equals(readFileSync(dataFile)),
      `${ctx}\n\n无整体解后数据文件必须逐字节不变`,
    );
    const storeAfter = readStore(dataFile);
    assert.equal(storeAfter.bookings.length, storeBefore.bookings.length, `${ctx}\n\n不得留下部分预约`);
    assert.equal(storeAfter.bookingSeq, storeBefore.bookingSeq, `${ctx}\n\n预约计数不得推进`);
    assert.deepEqual(storeAfter.bookings, storeBefore.bookings, `${ctx}\n\n既有预约记录不得变化`);
    return {oraclePlan: null};
  }

  assert.equal(r.status, 0, `${ctx}\n\n有解案例应退出 0，实际 ${r.status}\nstderr:\n${r.stderr}`);

  const firstSeq0 = storeBefore.bookingSeq + 1;
  const n = items.length;
  // 从提交输出解析按清单顺序的逐项安排（开始/结束）与“按需求组顺序”的资源标识；
  // 组序信息只存在于本次提交输出（落盘仅存排序后的资源集合），这里只解析业务字段。
  const blocks = r.stdout
    .split('\n')
    .filter((ln) => /^- 第 \d+ 项 ->|^\s+第 \d+ 组:/.test(ln));
  const parsedPicks: string[][] = [];
  let cur: string[] | null = null;
  for (const ln of blocks) {
    const hm = /^- 第 (\d+) 项 -> (B\d{4}): (\S+) → (\S+?)（\d+ 分钟）$/.exec(ln);
    if (hm) {
      assert.equal(
        hm[2],
        `B${String(firstSeq0 + Number(hm[1]) - 1).padStart(4, '0')}`,
        `${ctx}\n\n输出第 ${hm[1]} 项预约标识应按清单顺序连续分配`,
      );
      assert.equal(hm[3], fmtMin(expected[Number(hm[1]) - 1].startMin), `${ctx}\n\n输出第 ${hm[1]} 项开始`);
      assert.equal(hm[4], fmtMin(expected[Number(hm[1]) - 1].endMin), `${ctx}\n\n输出第 ${hm[1]} 项结束`);
      cur = [];
      parsedPicks.push(cur);
      continue;
    }
    const gm = /^\s+第 (\d+) 组: (R\d{4})（/.exec(ln);
    if (gm && cur !== null) cur[Number(gm[1]) - 1] = gm[2];
  }
  assert.equal(parsedPicks.length, n, `${ctx}\n\n输出应列出全部 ${n} 项`);
  expected.forEach((p, i) => {
    assert.deepEqual(parsedPicks[i], p.picks, `${ctx}\n\n第 ${i + 1} 项按需求组顺序的资源取舍`);
  });

  const storeAfter = readStore(dataFile);
  const firstSeq = storeBefore.bookingSeq + 1;
  const expectedIds = expected.map((_, i) => `B${String(firstSeq + i).padStart(4, '0')}`);

  // 数量与计数
  assert.equal(storeAfter.bookings.length, storeBefore.bookings.length + n, `${ctx}\n\n新增预约数量`);
  assert.equal(storeAfter.bookingSeq, storeBefore.bookingSeq + n, `${ctx}\n\n预约计数推进数量`);

  // 既有记录全部不变（逐对象深比较），其他集合不变
  const afterById = new Map(storeAfter.bookings.map((b) => [b.id, b]));
  for (const old of storeBefore.bookings) {
    assert.deepEqual(afterById.get(old.id), old, `${ctx}\n\n既有预约 ${old.id} 不得变化`);
  }
  assert.deepEqual(storeAfter.resources, storeBefore.resources, `${ctx}\n资源记录不得变化`);
  assert.deepEqual(storeAfter.closures, storeBefore.closures, `${ctx}\n停用记录不得变化`);
  assert.deepEqual(storeAfter.waitlist, storeBefore.waitlist, `${ctx}\n候补记录不得变化`);
  assert.deepEqual(storeAfter.series, storeBefore.series, `${ctx}\n系列记录不得变化`);

  // 按清单顺序逐项核对实际开始、结束、按组所选资源（不依赖输出措辞）
  expected.forEach((p, i) => {
    const id = expectedIds[i];
    const b = afterById.get(id);
    assert.ok(b, `${ctx}\n\n应存在新预约 ${id}`);
    assert.equal(b!.start, fmtMin(p.startMin), `${ctx}\n\n${id} 实际开始必须与对照最小方案一致`);
    assert.equal(b!.end, fmtMin(p.endMin), `${ctx}\n\n${id} 实际结束必须与对照最小方案一致`);
    // 落盘资源集合按标识排序；按组所选资源经排序后与集合一致，组序另由下述 picks 核对
    assert.deepEqual(
      b!.resourceIds,
      [...p.picks].sort(),
      `${ctx}\n\n${id} 实际资源必须与对照最小方案按组所选一致`,
    );
    assert.equal(b!.status, 'active', `${ctx}\n\n${id} 必须为有效预约`);
    assert.equal(b!.seriesId, undefined, `${ctx}\n\n${id} 必须是普通预约（不加入系列）`);
  });

  // 新进程查询全部新增预约：数量、资源行、有效状态与普通预约身份
  const days = [];
  for (const b of storeAfter.bookings) {
    for (let t = toMin(b.start); t < toMin(b.end); t += 1440) days.push(dateOf(t));
  }
  const uniqueDays = [...new Set(days)].sort();
  const {found: listed, counts} = queryBookingsByDays(dataFile, uniqueDays);
  // 逐日数量：当日与 [00:00,次日00:00) 相交的全部记录（含已取消），与列表口径一致
  for (const day of uniqueDays) {
    const ds = toMin(`${day}T00:00`);
    const expectedCount = storeAfter.bookings.filter((b) => toMin(b.start) < ds + 1440 && ds < toMin(b.end)).length;
    assert.equal(counts.get(day) ?? 0, expectedCount, `${ctx}\n新进程查询 ${day} 的预约数量`);
  }
  const nameById = new Map(storeAfter.resources.map((x) => [x.id, x.name]));
  for (const id of expectedIds) {
    const l = listed.get(id);
    assert.ok(l, `${ctx}\n\n新进程查询应可见新预约 ${id}`);
    assert.equal(l!.status, '已预约', `${ctx}\n\n${id} 查询状态应为有效`);
    assert.equal(l!.hasSeries, false, `${ctx}\n\n${id} 查询结果应无系列归属（普通预约）`);
  }
  expected.forEach((p, i) => {
    const l = listed.get(expectedIds[i])!;
    assert.equal(l.start, fmtMin(p.startMin), `${ctx}\n${expectedIds[i]} 查询开始`);
    assert.equal(l.end, fmtMin(p.endMin), `${ctx}\n${expectedIds[i]} 查询结束`);
    for (const rid of p.picks) {
      assert.ok(
        l.resourceText.includes(`${rid}（${nameById.get(rid)}）`),
        `${ctx}\n${expectedIds[i]} 查询资源行应含 ${rid}（${nameById.get(rid)}），实际: ${l.resourceText}`,
      );
    }
  });

  return {oraclePlan: expected};
}

// 倒序书写组内候选后，在独立数据副本上必须得到同一方案
function verifyReversedCandidates(
  caseId: string,
  pristineFile: string,
  dir: string,
  items: OracleItem[],
  expected: OraclePlacement[] | null,
  detail = '',
): void {
  const suffix = caseId.replace(/[^A-Za-z0-9._-]/g, '-');
  const revFile = join(dir, `rev-${suffix}.json`);
  copyFileSync(pristineFile, revFile);
  const revItems = items.map((i) => ({...i, groups: i.groups.map((g) => [...g].reverse())}));
  const revManifest = writeManifest(dir, `rev-${suffix}.plan.json`, revItems);
  const r = runCli(revFile, ['schedule-flex', revManifest]);
  const storeBefore = readStore(pristineFile);
  const ctx = describeCase(caseId, storeBefore, revItems, expected, detail ? `${detail}；组内候选倒序` : '组内候选倒序');

  if (expected === null) {
    assert.equal(r.status, 1, `${ctx}\n倒序书写无解结论应一致`);
    assert.match(r.stderr, /无整体解/, `${ctx}\n倒序书写无解原因应一致`);
    assert.ok(readFileSync(pristineFile).equals(readFileSync(revFile)), `${ctx}\n倒序无解数据逐字节不变`);
    return;
  }
  assert.equal(r.status, 0, `${ctx}\n倒序书写应同样有解，实际 ${r.status}\nstderr:\n${r.stderr}`);
  // 按需求组顺序解析输出中的资源取舍（与正向提交同格式），逐位与对照方案一致
  const revPicks: string[][] = [];
  for (const ln of r.stdout.split('\n')) {
    const hm = /^- 第 (\d+) 项 -> B\d{4}: \S+ → \S+?（\d+ 分钟）$/.exec(ln);
    if (hm) {
      revPicks.push([]);
      continue;
    }
    const gm = /^\s+第 (\d+) 组: (R\d{4})（/.exec(ln);
    if (gm && revPicks.length > 0) revPicks[revPicks.length - 1][Number(gm[1]) - 1] = gm[2];
  }
  assert.equal(revPicks.length, expected.length, `${ctx}\n倒序输出项数`);
  const storeAfter = readStore(revFile);
  const firstSeq = storeBefore.bookingSeq + 1;
  expected.forEach((p, i) => {
    assert.deepEqual(revPicks[i], p.picks, `${ctx}\n倒序书写按组资源取舍必须一致`);
    const b = storeAfter.bookings.find((x) => x.id === `B${String(firstSeq + i).padStart(4, '0')}`)!;
    assert.equal(b.start, fmtMin(p.startMin), `${ctx}\n倒序书写开始必须一致`);
    assert.equal(b.end, fmtMin(p.endMin), `${ctx}\n倒序书写结束必须一致`);
    assert.deepEqual(b.resourceIds, [...p.picks].sort(), `${ctx}\n倒序书写资源集合必须一致`);
  });
}

// 固定案例的“现象锚点”：除对照器全量核对外，再显式锁定该案例要证明的事实
function assertAnchor(
  caseId: string,
  plan: OraclePlacement[] | null,
  anchor: Array<{start: string; end: string; picks: string[]}> | null,
  rerunId = caseId,
): void {
  if (plan === null) {
    assert.equal(anchor, null, `[${caseId}] 锚点：对照器判无解`);
    return;
  }
  const hint =
    `[${caseId}] 单例复跑: FLEX_CASE=${rerunId} node --test test/schedule-flex-exhaustive.test.ts\n` +
    `对照器最小方案: ${JSON.stringify(
      plan.map((p) => ({start: fmtMin(p.startMin), end: fmtMin(p.endMin), picks: p.picks})),
    )}\n`;
  assert.ok(anchor, `[${caseId}] 对照器判有解，锚点不应为 null`);
  assert.equal(plan.length, anchor!.length, `${hint}锚点项数`);
  plan.forEach((p, i) => {
    assert.equal(fmtMin(p.startMin), anchor![i].start, `${hint}第 ${i + 1} 项开始`);
    assert.equal(fmtMin(p.endMin), anchor![i].end, `${hint}第 ${i + 1} 项结束`);
    assert.deepEqual(p.picks, anchor![i].picks, `${hint}第 ${i + 1} 项按组资源`);
  });
}

function runTest(caseId: string, fn: (t: {after: (f: () => void) => void}) => void): void {
  if (ONLY && ONLY !== caseId) {
    test(caseId, {skip: `仅复跑 FLEX_CASE=${ONLY}`}, () => {});
    return;
  }
  test(caseId, (t) => fn(t));
}

// ---------------------------------------------------------------------------
// 固定案例 1：三项结束约束传递，把清单第 1 项顶到最晚
// ---------------------------------------------------------------------------

runTest('fixed-01-three-delay-chain', (t) => {
  const dir = newTempDir('f1');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001

  // 第 3 项窗口 09:00-10:30（最晚 09:30 开始），第 2 项最晚 10:30 开始。
  // 同一资源三项 60 分钟：第 3 项只能占 09:00-10:00，第 2 项被顶到 10:00，
  // 清单第 1 项的结束约束经两项传递，最终只能 11:00 开始（09:00、10:00 均整体无解）。
  const items: OracleItem[] = [
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T12:00', duration: 60, groups: [['R0001']]},
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T11:30', duration: 60, groups: [['R0001']]},
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T10:30', duration: 60, groups: [['R0001']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const {oraclePlan} = verifyFlex('fixed-01-three-delay-chain', df, manifest, items);
  assertAnchor('fixed-01-three-delay-chain', oraclePlan, [
    {start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']},
    {start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
    {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
  ]);
});

// ---------------------------------------------------------------------------
// 固定案例 2：换资源与延后共同决定可行性（停用/预约端点相接、取消停用不阻挡）
// ---------------------------------------------------------------------------

runTest('fixed-02-switch-and-delay', (t) => {
  const dir = newTempDir('f2');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  addResource(df, '午后停用会议室', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001
  addResource(df, '上午被占会议室'); // R0002 全年开放
  // R0001 有效停用 09:00-12:00：新预约结束可与停用起点相接，但停用后整窗不可用
  addClosure(df, 'R0001', '2026-10-12T09:00', '2026-10-12T12:00');
  // R0002 一条随后取消的停用（不得产生任何阻挡；须在占用预约之前登记）
  addClosure(df, 'R0002', '2026-10-12T08:00', '2026-10-12T09:00'); // C0002
  mustOk(df, ['cancel-closure', 'C0002'], '取消 R0002 上的停用');
  // R0002 上午被既有有效预约占用至 11:00
  createBooking(df, ['R0002'], '2026-10-12T08:00', '2026-10-12T11:00');

  // 第 2 项只能用 R0001 且窗口恰为 08:00-09:00，固定占用 08-09（结束与停用起点相接）。
  // 第 1 项 60 分钟：留在 R0001 —— 08-09 被第 2 项占用、09:00-12:00 停用，整窗无 60
  // 分钟连续空间，不可行；换到 R0002 —— 上午被既有预约占用，还必须延后到 11:00
  // （开始恰与既有预约终点相接，结束贴窗口终点）。换资源与延后缺一不可，共同决定
  // 唯一可行方案。
  const items: OracleItem[] = [
    {startRaw: '2026-10-12T08:00', endRaw: '2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    {startRaw: '2026-10-12T08:00', endRaw: '2026-10-12T09:00', duration: 60, groups: [['R0001']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const {oraclePlan} = verifyFlex('fixed-02-switch-and-delay', df, manifest, items);
  assertAnchor('fixed-02-switch-and-delay', oraclePlan, [
    {start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0002']},
    {start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
  ]);
});

// ---------------------------------------------------------------------------
// 固定案例 3：多组共享候选造成整体不足 → 无整体解（退出 1、原子性）
// ---------------------------------------------------------------------------

runTest('fixed-03-shared-shortage-no-solution', (t) => {
  const dir = newTempDir('f3');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 三项窗口恰为 60 分钟（开始固定 09:00）：前两项瓜分 R0001/R0002 后，
  // 第 3 项只要 R0001 —— 各自单独可行，整单无可行分配。
  const items: OracleItem[] = [
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const {oraclePlan} = verifyFlex('fixed-03-shared-shortage-no-solution', df, manifest, items);
  assertAnchor('fixed-03-shared-shortage-no-solution', oraclePlan, null);

  // 无解后计数未推进：随后的可行单仍从 B0001 开始（独立新进程提交）
  const okItems: OracleItem[] = [
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
  ];
  const okManifest = writeManifest(dir, 'ok.json', okItems);
  const {oraclePlan: okPlan} = verifyFlex(
    'fixed-03-shared-shortage-no-solution',
    df,
    okManifest,
    okItems,
    '无解后计数未推进的重试',
  );
  assertAnchor(
    'fixed-03-shared-shortage-no-solution（无解后重试）',
    okPlan,
    [{start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}],
    'fixed-03-shared-shortage-no-solution',
  );
});

// ---------------------------------------------------------------------------
// 固定案例 4：多个完整方案中，前项资源取舍优先于后项开始时间；候选倒序结果不变
// ---------------------------------------------------------------------------

runTest('fixed-04-resource-before-later-start', (t) => {
  const dir = newTempDir('f4');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 两个完整方案：
  //   方案甲：第 1 项 09:00 选 R0001 → 第 2 项（只能 R0001）被顶到 10:00
  //   方案乙：第 1 项 09:00 选 R0002 → 第 2 项可在 09:00
  // 第 1 项开始相同，先比其资源标识：R0001 < R0002，取方案甲——
  // 即使第 2 项因此更晚开始（前项资源取舍优先于后项开始时间）。
  const items: OracleItem[] = [
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const pristine = join(dir, 'pristine.json');
  copyFileSync(df, pristine);
  const {oraclePlan} = verifyFlex('fixed-04-resource-before-later-start', df, manifest, items);
  const anchor: Array<{start: string; end: string; picks: string[]}> = [
    {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    {start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
  ];
  assertAnchor('fixed-04-resource-before-later-start', oraclePlan, anchor);

  // 组内候选倒序书写：提交前数据的独立副本，方案必须完全相同
  verifyReversedCandidates('fixed-04-resource-before-later-start', pristine, dir, items, oraclePlan);
});

// ---------------------------------------------------------------------------
// 固定案例 5：已取消预约与未兑现候补不阻挡；取消记录、候补与既有预约保持不变
// ---------------------------------------------------------------------------

runTest('fixed-05-cancelled-and-waitlist-dont-block', (t) => {
  const dir = newTempDir('f5');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00'); // B0001
  mustOk(df, ['cancel-booking', 'B0001'], '取消 B0001');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00'); // B0002 有效
  mustOk(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '未兑现候补 W0001',
  );

  // 最早可行 09:00-10:00：取消记录不阻挡，结束与 B0002 起点相接
  const items: OracleItem[] = [
    {startRaw: '2026-10-12T09:00', endRaw: '2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const {oraclePlan} = verifyFlex('fixed-05-cancelled-and-waitlist-dont-block', df, manifest, items);
  assertAnchor('fixed-05-cancelled-and-waitlist-dont-block', oraclePlan, [
    {start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
  ]);

  const store = readStore(df);
  assert.equal((store.bookings.find((b) => b.id === 'B0001'))!.status, 'cancelled', '取消记录仍为 cancelled');
  assert.equal(store.waitlist.length, 1, '不新增候补');
  assert.equal(store.waitlist[0].status, 'waiting', '未兑现候补不被自动处理');
  assert.equal(store.waitlist[0].bookingId, undefined, '候补不得关联新预约');
});

// ---------------------------------------------------------------------------
// 固定案例 6：相接/间断开放、重叠停用、预约与停用端点相接、跨午夜
// ---------------------------------------------------------------------------

runTest('fixed-06-midnight-touching-open-overlapping-closures', (t) => {
  const dir = newTempDir('f6');
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const df = join(dir, 'data.json');
  // R0001：跨午夜开放 20:00-次日02:00，停用 22:00-23:00
  addResource(df, '跨午夜厅', [['2026-10-12T20:00', '2026-10-13T02:00']]);
  addClosure(df, 'R0001', '2026-10-12T22:00', '2026-10-12T23:00');
  // R0002：两段端点相接的开放（须合并才能支撑跨 22:00 接缝的预约）
  addResource(df, '接缝厅', [
    ['2026-10-12T20:00', '2026-10-12T22:00'],
    ['2026-10-12T22:00', '2026-10-13T01:00'],
  ]);
  // 两条相互重叠的有效停用，其并集为 20:30-21:30
  addClosure(df, 'R0002', '2026-10-12T20:30', '2026-10-12T21:00');
  addClosure(df, 'R0002', '2026-10-12T20:45', '2026-10-12T21:30');

  const items: OracleItem[] = [
    // R0001 第 1 项 20:00-21:00
    {startRaw: '2026-10-12T20:00', endRaw: '2026-10-13T02:00', duration: 60, groups: [['R0001']]},
    // R0001 第 2 项 21:00-22:00，结束与停用起点相接
    {startRaw: '2026-10-12T20:00', endRaw: '2026-10-13T02:00', duration: 60, groups: [['R0001']]},
    // R0001 第 3 项 23:00-24:00，开始与停用终点相接并跨午夜
    {startRaw: '2026-10-12T20:00', endRaw: '2026-10-13T02:00', duration: 60, groups: [['R0001']]},
    // R0002 第 4 项 20:00-20:30，结束与停用并集起点相接
    {startRaw: '2026-10-12T20:00', endRaw: '2026-10-13T01:00', duration: 30, groups: [['R0002']]},
    // R0002 第 5 项 21:30-23:30，开始与停用并集终点相接，且跨越相接开放接缝 22:00
    {startRaw: '2026-10-12T20:00', endRaw: '2026-10-13T01:00', duration: 120, groups: [['R0002']]},
  ];
  const manifest = writeManifest(dir, 'plan.json', items);
  const {oraclePlan} = verifyFlex(
    'fixed-06-midnight-touching-open-overlapping-closures',
    df,
    manifest,
    items,
  );
  assertAnchor('fixed-06-midnight-touching-open-overlapping-closures', oraclePlan, [
    {start: '2026-10-12T20:00', end: '2026-10-12T21:00', picks: ['R0001']},
    {start: '2026-10-12T21:00', end: '2026-10-12T22:00', picks: ['R0001']},
    {start: '2026-10-12T23:00', end: '2026-10-13T00:00', picks: ['R0001']},
    {start: '2026-10-12T20:00', end: '2026-10-12T20:30', picks: ['R0002']},
    {start: '2026-10-12T21:30', end: '2026-10-12T23:30', picks: ['R0002']},
  ]);
});

// ---------------------------------------------------------------------------
// 固定种子生成案例
//
// 生成范围（全部以 10 分钟为栅格、落在 2026-10-13 当天，确定性产生）：
// - 资源数 3-4 个；每资源单段开放（07:00-08:50 起、17:00-19:50 止），或两段
//   开放（接缝在 10:00-14:50，端点相接或留 10-50 分钟间断）；
// - 0-2 条有效停用：2 条时同一资源且时间重叠；单条可能与开放端点相接；
// - 清单项数 2-4；时长 30 或 60 分钟；窗口位于 08:00-19:00，余量取
//   0/30/60/90/120/180 分钟；需求组 1-2 组、每组 1-3 个候选，部分项只认
//   R0001 以制造跨项整体不足；不放既有预约（占用口径由 fixed-05 覆盖）。
// 每个案例除正向提交外，还把每组候选倒序后在独立副本上复跑，结果须一致。
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

interface GenSpec {
  id: string;
  resourceCount: number;
  opens: Array<[string, string][]>; // 按资源顺序
  closures: Array<{resource: string; start: string; end: string}>;
  items: OracleItem[];
}

const RESOURCE_NAMES = ['资源甲', '资源乙', '资源丙', '资源丁'];

function genSpec(rand: () => number, idx: number): GenSpec {
  const rid = (i: number) => `R${String(i + 1).padStart(4, '0')}`;
  const base = toMin('2026-10-13T00:00');
  // 栅格单位 10 分钟：42=07:00，48=08:00，114=19:00
  const t = (unit: number) => fmtMin(base + unit * 10);
  const pick = <X,>(arr: X[]): X => arr[Math.floor(rand() * arr.length)];

  const resourceCount = 3 + Math.floor(rand() * 2);
  const opens: Array<[string, string][]> = [];
  for (let r = 0; r < resourceCount; r++) {
    if (rand() < 0.62) {
      // 单段开放，覆盖清单项可能出现的 08:00-19:00 区间主体
      const a = 42 + Math.floor(rand() * 12); // 07:00-08:50 起
      const b = 102 + Math.floor(rand() * 18); // 17:00-19:50 止
      opens.push([[t(a), t(b)]]);
    } else {
      // 两段开放：端点相接（须合并）或留有 10-50 分钟间断；接缝在 10:00-14:50
      const a = 42 + Math.floor(rand() * 9);
      const m = 60 + Math.floor(rand() * 30);
      const touching = rand() < 0.5;
      const c = touching ? m : Math.min(119, m + 1 + Math.floor(rand() * 5));
      const b = 102 + Math.floor(rand() * 18);
      opens.push([
        [t(a), t(m)],
        [t(c), t(b)],
      ]);
    }
  }

  const closures: GenSpec['closures'] = [];
  const roll = rand();
  if (roll < 0.42) {
    // 一条
    const ri = Math.floor(rand() * resourceCount);
    const seg = pick(opens[ri]);
    const su = toMin(seg[0]) / 10 - base / 10;
    const eu = toMin(seg[1]) / 10 - base / 10;
    const durU = 2 + Math.floor(rand() * 4); // 20-50 分钟（10 分钟栅格）
    let sU: number;
    if (rand() < 0.25) sU = su; // 与开放起点相接
    else if (rand() < 0.25) sU = eu - durU; // 与开放终点相接
    else sU = su + Math.floor(rand() * Math.max(1, eu - su - durU));
    closures.push({resource: rid(ri), start: t(sU), end: t(sU + durU)});
  } else if (roll < 0.6) {
    // 两条相互重叠（同一资源）
    const ri = Math.floor(rand() * resourceCount);
    const seg = pick(opens[ri]);
    const su = toMin(seg[0]) / 10 - base / 10;
    const eu = toMin(seg[1]) / 10 - base / 10;
    const s1 = su + Math.floor(rand() * Math.max(1, eu - su - 6));
    const e1 = s1 + 3 + Math.floor(rand() * 3);
    const s2 = s1 + 1 + Math.floor(rand() * Math.max(1, e1 - s1 - 1));
    const e2 = Math.min(eu, e1 + 1 + Math.floor(rand() * 3));
    if (e2 > s2 && e1 <= eu && s2 < e1) {
      closures.push({resource: rid(ri), start: t(s1), end: t(e1)});
      closures.push({resource: rid(ri), start: t(s2), end: t(e2)});
    }
  }

  const itemCount = 2 + Math.floor(rand() * 3);
  const slacks = [0, 30, 60, 90, 120, 180];
  const items: OracleItem[] = [];
  for (let k = 0; k < itemCount; k++) {
    const duration = pick([30, 60]);
    const slack = pick(slacks);
    // 窗口在 08:00(48)-19:00(114) 内，10 分钟栅格
    const durU = duration / 10;
    const slackU = slack / 10;
    const maxStartUnit = 114 - durU - slackU;
    const sU = 48 + Math.floor(rand() * (maxStartUnit - 48));
    const eU = sU + durU + slackU;
    const groupCount = 1 + (rand() < 0.45 ? 1 : 0);
    const groups: string[][] = [];
    for (let g = 0; g < groupCount; g++) {
      let chosen: number[];
      if (g === 0 && rand() < 0.35) {
        // 强耦合：该组只认 R0001，多个此类项时间重叠时造成整体不足
        chosen = [0];
      } else {
        const size = 1 + Math.floor(rand() * Math.min(3, resourceCount));
        const pool = [...Array(resourceCount).keys()];
        chosen = [];
        for (let q = 0; q < size; q++) {
          const at = Math.floor(rand() * pool.length);
          chosen.push(pool.splice(at, 1)[0]);
        }
        // 偏向跨项耦合：半数小组确保带上 R0001
        if (g === 0 && !chosen.includes(0) && rand() < 0.5) chosen[0] = 0;
      }
      groups.push([...new Set(chosen)].sort((a, b) => a - b).map(rid));
    }
    items.push({startRaw: t(sU), endRaw: t(eU), duration, groups});
  }

  return {id: `gen-${String(idx + 1).padStart(4, '0')}`, resourceCount, opens, closures, items};
}

// 生成案例的开放与停用按案例不同：每案例经 CLI 在独立文件上建资源与停用
function prepareGenData(spec: GenSpec, dir: string): string {
  const df = join(dir, `${spec.id}.json`);
  for (let r = 0; r < spec.resourceCount; r++) {
    addResource(df, RESOURCE_NAMES[r], spec.opens[r]);
  }
  for (const c of spec.closures) addClosure(df, c.resource, c.start, c.end);
  return df;
}

// 预生成全部规格（确定性，失败时可打印完整规格）
const allSpecs: GenSpec[] = [];
{
  const rand = mulberry32(SEED);
  for (let i = 0; i < GEN_CASES; i++) allSpecs.push(genSpec(rand, i));
}
// 有解/无解两类都应出现（固定种子下的稳定性自检；若调整生成器请同步评估）
test(
  '生成案例自检：固定种子下有解与无整体解两类都被覆盖',
  ONLY ? {skip: `仅复跑 FLEX_CASE=${ONLY}`} : {},
  () => {
    let feasible = 0;
    for (const spec of allSpecs) {
      // 用空初始数据建对照场景所需快照：仅包含本 spec 的资源与停用
      const store: SnapStore = {
        resourceSeq: spec.resourceCount,
        bookingSeq: 0,
        seriesSeq: 0,
        waitlistSeq: 0,
        closureSeq: spec.closures.length,
        batchSeq: 0,
        resources: spec.opens.map((o, i) => ({
          id: `R${String(i + 1).padStart(4, '0')}`,
          name: RESOURCE_NAMES[i],
          open: o,
        })),
        bookings: [],
        series: [],
        waitlist: [],
        closures: spec.closures.map((c) => ({resourceId: c.resource, start: c.start, end: c.end, status: 'active'})),
        batchOps: [],
        imports: [],
      };
      if (exhaustiveOracle(store, spec.items) !== null) feasible++;
    }
    assert.ok(feasible > 0, '固定种子应生成至少一个有解案例');
    assert.ok(feasible < allSpecs.length, '固定种子应生成至少一个无整体解案例');
  },
);

for (const spec of allSpecs) {
  const caseId = spec.id;
  runTest(caseId, (t) => {
    const dir = newTempDir(spec.id);
    t.after(() => rmSync(dir, {recursive: true, force: true}));

    const df = prepareGenData(spec, dir);
    const pristineCopy = join(dir, `${spec.id}.pristine.json`);
    // 正向提交前的字节快照，供倒序复跑使用独立副本
    const manifest = writeManifest(dir, `${spec.id}.plan.json`, spec.items);
    const storeBefore = readStore(df);
    const expected = exhaustiveOracle(storeBefore, spec.items);
    copyFileSync(df, pristineCopy);

    const {oraclePlan} = verifyFlex(caseId, df, manifest, spec.items, `固定种子 0x${SEED.toString(16)}`);
    assert.equal(oraclePlan === null, expected === null, `${spec.id} 对照结论一致性`);

    // 组内候选倒序书写：同一案例、独立临时数据，方案（或无解决定）必须相同
    verifyReversedCandidates(caseId, pristineCopy, dir, spec.items, expected, `固定种子 0x${SEED.toString(16)}`);
  });
}
