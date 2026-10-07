// shiftbook schedule-flex 项间关系（先后及衔接间隔）约束回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings 等）；
// - 覆盖：不同资源项之间的最小/零间隔约束、最大间隔倒逼前项延后、多个前项与
//   链式传播、逆清单关系（含零间隔）、跨日夜链条与停用端点相接、关系决定开始
//   后再按资源标识字典序取舍、关系书写顺序不影响结果、非法关系（非数组/非对象/
//   未知字段/非整数或越界序号/自指/重复/最小大于最大/负数/有向环）整单拒绝、
//   关系导致无整体解（含两个前项互相矛盾）、真实保存失败与重试（标识未消费）、
//   新进程查询持久安排并独立改期/取消（关系只约束创建时求解）；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件（<名>.<pid>.tmp）必然超出文件名长度上限，
// 从而在不调整任何权限的前提下，可重复地触发真实保存失败。
const LONG_NAME = 'g'.repeat(250) + '.json';

// ---------------------------------------------------------------------------
// 基础设施
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

function bizFail(df: string, args: string[], ctx: string): CliResult {
  const r = runCli(df, args);
  assert.equal(
    r.status,
    1,
    `[${ctx}] 期望退出 1，实际 ${r.status}\n命令: ${args.join(' ')}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
  return r;
}

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-rel-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  type = 'venue',
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

interface FlexRelation {
  from: number;
  to: number;
  minMinutes?: number;
  maxMinutes?: number;
}

function writeManifest(dir: string, name: string, items: unknown[], relations?: FlexRelation[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(relations === undefined ? {items} : {items, relations}) + '\n', 'utf8');
  return p;
}

function writeRaw(dir: string, name: string, text: string): string {
  const p = join(dir, name);
  writeFileSync(p, text, 'utf8');
  return p;
}

function scheduleFlex(df: string, manifest: string, ctx: string): CliResult {
  return ok(df, ['schedule-flex', manifest], ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败/查询不得改动数据文件（逐字节比对）`);
}

interface ExpectedItem {
  id: string;
  start: string;
  end: string;
  picks: string[];
}

// 断言联合排程输出：按清单顺序的各项标识、起止时间与按组对应的资源
function assertPlan(r: CliResult, expected: ExpectedItem[], ctx: string): void {
  assert.match(
    r.stdout,
    new RegExp(`联合排程成功：已按清单顺序原子创建 ${expected.length} 项预约`),
    `[${ctx}] 成功提示\nstdout:\n${r.stdout}`,
  );
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`- 第 ${i + 1} 项 -> ${e.id}: ${e.start} → ${e.end}`),
      `[${ctx}] 第 ${i + 1} 项起止时间\nstdout:\n${r.stdout}`,
    );
    e.picks.forEach((id, g) => {
      assert.match(
        r.stdout,
        new RegExp(`第 ${g + 1} 组: ${id}（`),
        `[${ctx}] 第 ${i + 1} 项第 ${g + 1} 组应选 ${id}\nstdout:\n${r.stdout}`,
      );
    });
  });
}

// 断言落盘的预约记录：普通预约（无系列归属）、有效、资源集合按标识排序
function assertBooking(
  df: string,
  id: string,
  start: string,
  end: string,
  resourceIds: string[],
  ctx: string,
): void {
  const store = readStore(df);
  const b = (store.bookings as any[]).find((x) => x.id === id);
  assert.ok(b, `[${ctx}] 应存在预约 ${id}`);
  assert.equal(b.start, start, `[${ctx}] ${id} 开始时间`);
  assert.equal(b.end, end, `[${ctx}] ${id} 结束时间`);
  assert.deepEqual(b.resourceIds, [...resourceIds].sort(), `[${ctx}] ${id} 资源集合`);
  assert.equal(b.status, 'active', `[${ctx}] ${id} 状态`);
  assert.equal(b.seriesId, undefined, `[${ctx}] ${id} 不加入系列`);
}

// ---------------------------------------------------------------------------
// 1. 不同资源的项之间关系同样生效：最小间隔使后项等待，零间隔允许紧接
// ---------------------------------------------------------------------------

test('不同资源：最小间隔让后项延后（无资源冲突），零间隔要求紧接', (t) => {
  const dir = tempDir(t);

  // (a) 两项各用各的资源，本可同时 09:00；关系 1→2 间隔 [15,60] 迫使后项 10:15
  const df = join(dir, 'a.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  const m1 = writeManifest(
    dir,
    'plan-a.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 15, maxMinutes: 60}],
  );
  const r1 = scheduleFlex(df, m1, '不同资源最小间隔');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:15', end: '2026-10-12T11:15', picks: ['R0002']},
    ],
    '不同资源最小间隔',
  );
  assertBooking(df, 'B0002', '2026-10-12T10:15', '2026-10-12T11:15', ['R0002'], '落盘');

  // (b) min=max=0：不同资源也必须端点紧接，后项排到 10:00
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲');
  addResource(df2, '乙');
  const m2 = writeManifest(
    dir,
    'plan-b.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 0, maxMinutes: 0}],
  );
  const r2 = scheduleFlex(df2, m2, '零间隔紧接');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']},
    ],
    '零间隔紧接',
  );
});

// ---------------------------------------------------------------------------
// 2. 最大间隔迫使前项延后：资源互不相同，纯由关系驱动
// ---------------------------------------------------------------------------

test('最大间隔迫使前项延后：后项窗口固定 11:00，前项不得早于 9:30', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // 第 2 项窗口恰等于时长，只能 11:00-12:00；第 1 项本可 9:00 开始（不同资源，
  // 无任何冲突），但关系最大间隔 30 要求 s2-(s1+60) ≤ 30，即 s1 ≥ 9:30；
  // 区间 [9:30,10:00] 内按取舍取最早 9:30
  const m = writeManifest(
    dir,
    'plan.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T11:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, maxMinutes: 30}],
  );
  const r = scheduleFlex(df, m, '最大间隔倒逼前项');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T09:30', end: '2026-10-12T10:30', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0002']},
    ],
    '最大间隔倒逼前项',
  );
  assertBooking(df, 'B0001', '2026-10-12T09:30', '2026-10-12T10:30', ['R0001'], '落盘');
});

// ---------------------------------------------------------------------------
// 3. 多个前项同时生效；链式关系多跳传播候选分钟
// ---------------------------------------------------------------------------

test('多个前项：后项开始须同时满足两条入边；链式间隔逐跳累加', (t) => {
  const dir = tempDir(t);

  // (a) 第 3 项有两个前项：前项 1 9:00-9:30（要求间隔 ≥15 → s3≥9:45），
  //     前项 2 9:00-10:00（要求间隔 ≥0 → s3≥10:00）；取 10:00
  const df = join(dir, 'a.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  const m1 = writeManifest(
    dir,
    'plan-a.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T09:30', duration: 30, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002']]},
      {window: '2026-10-12T09:00/2026-10-12T13:00', duration: 30, groups: [['R0003']]},
    ],
    [
      {from: 1, to: 3, minMinutes: 15},
      {from: 2, to: 3, minMinutes: 0, maxMinutes: 120},
    ],
  );
  const r1 = scheduleFlex(df, m1, '多个前项');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T09:30', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
      {id: 'B0003', start: '2026-10-12T10:00', end: '2026-10-12T10:30', picks: ['R0003']},
    ],
    '多个前项',
  );

  // (b) 链条 1→2（10 分钟）、2→3（10 分钟），同一资源：9:00 / 10:10 / 11:20
  const df2 = join(dir, 'b.json');
  addResource(df2, '唯一会议室'); // R0001
  const m2 = writeManifest(
    dir,
    'plan-b.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T15:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T15:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T15:00', duration: 60, groups: [['R0001']]},
    ],
    [
      {from: 1, to: 2, minMinutes: 10},
      {from: 2, to: 3, minMinutes: 10},
    ],
  );
  const r2 = scheduleFlex(df2, m2, '链式间隔');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:10', end: '2026-10-12T11:10', picks: ['R0001']},
      {id: 'B0003', start: '2026-10-12T11:20', end: '2026-10-12T12:20', picks: ['R0001']},
    ],
    '链式间隔',
  );
});

// ---------------------------------------------------------------------------
// 4. 逆清单关系：关系方向与清单顺序相反，前项序号更大
// ---------------------------------------------------------------------------

test('逆清单关系：后项（清单第 2 项）先发生，第 1 项按 [10,20] 间隔延后；零间隔同理', (t) => {
  const dir = tempDir(t);

  // (a) 关系 2→1，间隔 [10,20]：第 2 项窗口固定 9:00-10:00，
  //     第 1 项（不同资源）本可 9:00，现只能在 10:10..10:20 开始，取 10:10
  const df = join(dir, 'a.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  const m1 = writeManifest(
    dir,
    'plan-a.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 2, to: 1, minMinutes: 10, maxMinutes: 20}],
  );
  const r1 = scheduleFlex(df, m1, '逆清单间隔');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T10:10', end: '2026-10-12T11:10', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
    ],
    '逆清单间隔',
  );
  assertBooking(df, 'B0001', '2026-10-12T10:10', '2026-10-12T11:10', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0002'], '落盘');

  // (b) 关系 2→1 零间隔：第 1 项 9:00 要求第 2 项 8:00（越窗不可行），
  //     故最小方案为第 2 项 9:00、第 1 项 10:00 紧接
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲');
  addResource(df2, '乙');
  const m2 = writeManifest(
    dir,
    'plan-b.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T11:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T11:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 2, to: 1, minMinutes: 0, maxMinutes: 0}],
  );
  const r2 = scheduleFlex(df2, m2, '逆清单零间隔');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
    ],
    '逆清单零间隔',
  );
});

// ---------------------------------------------------------------------------
// 5. 跨日链条与停用端点相接；关系决定开始后再按资源标识字典序取舍
// ---------------------------------------------------------------------------

test('跨日：零间隔链条跨过午夜并与停用两端相接；取舍先服从关系再取字典序资源', (t) => {
  const dir = tempDir(t);

  // (a) 跨日窗口 10-12 22:00 至 10-13 03:00，三项 60 分钟：1→2 零间隔，
  //     2→3 间隔 [0,60]；停用 00:00-01:00 使第 2 项结束恰贴停用起点、
  //     第 3 项开始恰贴停用终点（间隔恰为 60 分钟停用长度）
  const df = join(dir, 'a.json');
  addResource(df, '跨日场地'); // R0001
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-13T00:00', '--end', '2026-10-13T01:00'],
    '跨日停用 C0001',
  );
  const m1 = writeManifest(
    dir,
    'plan-a.json',
    [
      {window: '2026-10-12T22:00/2026-10-13T03:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T22:00/2026-10-13T03:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T22:00/2026-10-13T03:00', duration: 60, groups: [['R0001']]},
    ],
    [
      {from: 1, to: 2, minMinutes: 0, maxMinutes: 0},
      {from: 2, to: 3, minMinutes: 0, maxMinutes: 60},
    ],
  );
  const r1 = scheduleFlex(df, m1, '跨日间隔链条');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T22:00', end: '2026-10-12T23:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T23:00', end: '2026-10-13T00:00', picks: ['R0001']},
      {id: 'B0003', start: '2026-10-13T01:00', end: '2026-10-13T02:00', picks: ['R0001']},
    ],
    '跨日间隔链条',
  );
  assertBooking(df, 'B0002', '2026-10-12T23:00', '2026-10-13T00:00', ['R0001'], '第 2 项结束贴停用起点');
  assertBooking(df, 'B0003', '2026-10-13T01:00', '2026-10-13T02:00', ['R0001'], '第 3 项开始贴停用终点');

  // (b) 取舍：第 1 项只用 R0001 于 9:00-10:00；第 2 项候选 [R0001,R0002]，
  //     关系 min=0 禁止它在 10:00 前开始（尽管 R0002 9:00 即空闲）；10:00 可行
  //     后再按字典序取 R0001（端点相接不冲突），而非 9:00 的 R0002
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲'); // R0001
  addResource(df2, '乙'); // R0002
  const m2 = writeManifest(
    dir,
    'plan-b.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 0, maxMinutes: 240}],
  );
  const r2 = scheduleFlex(df2, m2, '关系下的字典序取舍');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
    ],
    '关系下的字典序取舍',
  );
});

// ---------------------------------------------------------------------------
// 6. 关系书写顺序不影响结果（与场景 3a 同清单、关系倒序书写，结果一致）
// ---------------------------------------------------------------------------

test('关系书写顺序不影响结果', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');
  addResource(df, '丙');
  const m = writeManifest(
    dir,
    'plan.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T09:30', duration: 30, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002']]},
      {window: '2026-10-12T09:00/2026-10-12T13:00', duration: 30, groups: [['R0003']]},
    ],
    // 倒序书写，且第 1 条附带不同的可选字段
    [
      {from: 2, to: 3, maxMinutes: 120, minMinutes: 0},
      {to: 3, from: 1, minMinutes: 15},
    ],
  );
  const r = scheduleFlex(df, m, '关系倒序书写');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T09:30', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
      {id: 'B0003', start: '2026-10-12T10:00', end: '2026-10-12T10:30', picks: ['R0003']},
    ],
    '关系倒序书写结果一致',
  );
});

// ---------------------------------------------------------------------------
// 7. 非法关系整单拒绝（退出 1）：文件逐字节不变，不产生记录、不消费标识
// ---------------------------------------------------------------------------

test('非法关系：非数组/非对象/未知字段/序号非整数或越界/自指/重复/最小大于最大/负数/有向环整单拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  addResource(df, '三号会议室'); // R0003
  const bytesBefore = readFileSync(df);

  const ITEM = '{"window":"2026-10-12T09:00/2026-10-12T12:00","duration":60,"groups":[["R0001"]]}';
  const ITEM2 = '{"window":"2026-10-12T09:00/2026-10-12T12:00","duration":60,"groups":[["R0002"]]}';
  const ITEM3 = '{"window":"2026-10-12T09:00/2026-10-12T12:00","duration":60,"groups":[["R0003"]]}';

  const reject = (name: string, text: string, re: RegExp, ctx: string): void => {
    const r = bizFail(df, ['schedule-flex', writeRaw(dir, name, text)], ctx);
    assert.match(r.stderr, re, `[${ctx}] 错误提示\nstderr:\n${r.stderr}`);
  };

  reject('n1.json', `{"items":[${ITEM},${ITEM2}],"relations":5}`, /relations 必须是数组/, 'relations 非数组');
  reject('n2.json', `{"items":[${ITEM},${ITEM2}],"relations":null}`, /relations 必须是数组/, 'relations 为 null');
  reject('n3.json', `{"items":[${ITEM},${ITEM2}],"relations":[5]}`, /第 1 条关系 必须是对象/, '关系非对象');
  reject(
    'n4.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":2,"gap":5}]}`,
    /未知字段 “gap”/,
    '关系未知字段',
  );
  reject(
    'n5.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":"1","to":2}]}`,
    /from（前项序号） 必须是从 1 开始的清单序号/,
    '序号非整数（字符串）',
  );
  reject(
    'n6.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":1.5}]}`,
    /to（后项序号） 必须是从 1 开始的清单序号/,
    '序号小数',
  );
  reject('n7.json', `{"items":[${ITEM},${ITEM2}],"relations":[{"from":0,"to":2}]}`, /序号越界：0/, '序号 0 越界');
  reject('n8.json', `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1}]}`, /to（后项序号） 必须是从 1 开始的清单序号/, '缺少 to');
  reject(
    'n9.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":3}]}`,
    /序号越界：3（清单共 2 项/,
    '序号超出清单长度',
  );
  reject('n10.json', `{"items":[${ITEM}],"relations":[{"from":1,"to":1}]}`, /不能指向同一项/, '自指');
  reject(
    'n11.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":2},{"from":1,"to":2,"maxMinutes":5}]}`,
    /有向关系只能出现一次/,
    '重复有向关系（间隔不同仍拒绝）',
  );
  reject(
    'n12.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":2,"minMinutes":31,"maxMinutes":30}]}`,
    /最小间隔 31 分钟大于最大间隔 30 分钟/,
    '最小大于最大',
  );
  reject(
    'n13.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":2,"minMinutes":-1}]}`,
    /minMinutes（最小间隔） 必须是非负整数分钟/,
    '负间隔',
  );
  reject(
    'n14.json',
    `{"items":[${ITEM},${ITEM2}],"relations":[{"from":1,"to":2,"maxMinutes":1.5}]}`,
    /maxMinutes（最大间隔） 必须是非负整数分钟/,
    '间隔小数',
  );
  reject(
    'n15.json',
    `{"items":[${ITEM},${ITEM2},${ITEM3}],"relations":[{"from":1,"to":2},{"from":2,"to":3},{"from":3,"to":1}]}`,
    /关系存在有向环/,
    '三项有向环',
  );
  reject(
    'n16.json',
    `{"items":[${ITEM},${ITEM2},${ITEM3}],"relations":[{"from":1,"to":2},{"from":2,"to":3},{"from":3,"to":1}]}`,
    /1->2、2->3、3->1/,
    '环上关系全部列出',
  );

  assertFileBytes(df, bytesBefore, '全部非法关系请求后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '非法关系不产生记录');
  assert.equal(store.bookingSeq, 0, '非法关系不消耗标识');
});

// ---------------------------------------------------------------------------
// 8. 关系导致无整体解：退出 1、明确提示、无部分方案、标识不消费
// ---------------------------------------------------------------------------

test('关系导致无整体解：最小间隔不可达、最大间隔不可达、两个前项互相矛盾', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  const bytesBefore = readFileSync(df);

  // 最小间隔 120：前项窗口恰 60 分钟只能 9:00-10:00 结束，后项 30 分钟窗口
  // 12:00 结束（最迟 11:30 开始），s2 ≥ 12:00 与 s2 ≤ 11:30 矛盾
  const m1 = writeManifest(
    dir,
    'bad-min.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 30, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 120}],
  );
  const r1 = bizFail(df, ['schedule-flex', m1], '最小间隔不可达');
  assert.match(r1.stderr, /无整体解/);
  assert.match(r1.stderr, /项间关系/);
  assertFileBytes(df, bytesBefore, '最小间隔不可达后');

  // 最大间隔 0：不同资源，前项最迟 10:00 结束、后项最早 11:00 开始，间隔至少 60
  const m2 = writeManifest(
    dir,
    'bad-max.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T11:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, maxMinutes: 0}],
  );
  const r2 = bizFail(df, ['schedule-flex', m2], '最大间隔不可达');
  assert.match(r2.stderr, /无整体解/);
  assertFileBytes(df, bytesBefore, '最大间隔不可达后');

  // 两个前项互相矛盾：前项 1 要求 s3≥11:00，前项 2 要求 s3≤10:00
  const m3 = writeManifest(
    dir,
    'bad-two-prev.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002']]},
      {window: '2026-10-12T09:00/2026-10-12T13:00', duration: 30, groups: [['R0003']]},
    ],
    [
      {from: 1, to: 3, minMinutes: 60},
      {from: 2, to: 3, maxMinutes: 0},
    ],
  );
  const r3 = bizFail(df, ['schedule-flex', m3], '两个前项矛盾');
  assert.match(r3.stderr, /无整体解/);
  assertFileBytes(df, bytesBefore, '矛盾前项后');

  let store = readStore(df);
  assert.equal(store.bookings.length, 0, '无解不留部分预约');
  assert.equal(store.bookingSeq, 0, '无解不消耗标识');

  // 标识未消费：随后可行（带关系）请求从 B0001 开始
  const mOk = writeManifest(
    dir,
    'ok.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 0}],
  );
  const r4 = scheduleFlex(df, mOk, '无解后可行请求');
  assertPlan(
    r4,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']},
    ],
    '标识未消费',
  );
  store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookingSeq, 2);
});

// ---------------------------------------------------------------------------
// 9. 真实保存失败与重试：退出 1、原文件逐字节保留、标识未消费；重试成功
// ---------------------------------------------------------------------------

test('保存失败：带关系清单退出 1 且原数据逐字节保留，换可写位置重试成功且标识未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  const manifest = writeManifest(
    dir,
    'plan.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 15}],
  );

  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['schedule-flex', manifest], '保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assert.ok(!r.stdout.includes('联合排程成功'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  const store = readStore(longFile);
  assert.equal(store.bookings.length, 0, '不产生预约记录');
  assert.equal(store.bookingSeq, 0, '标识计数不变');

  // 换可写位置用同一原数据重试：成功、标识未消费、关系仍生效
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = scheduleFlex(retryFile, manifest, '可保存位置重试');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:15', end: '2026-10-12T11:15', picks: ['R0002']},
    ],
    '重试标识未消费且关系生效',
  );

  // 新进程查询持久结果
  const list = ok(retryFile, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/, 'B0001 持久可查');
  assert.match(list.stdout, /B0002 \[已预约\] 2026-10-12T10:15 → 2026-10-12T11:15/, 'B0002 持久可查');

  // 关系不持久化：存储中没有任何关系字段
  const saved = readStore(retryFile);
  assert.equal(saved.relations, undefined, '关系只用于创建时求解，不写入数据文件');
  assert.equal(saved.bookings[0].relation, undefined, '预约记录不携带关系字段');
});

// ---------------------------------------------------------------------------
// 10. 关系只约束创建时求解：随后各项可独立改期（破坏间隔）或取消，互不影响
// ---------------------------------------------------------------------------

test('持久结果可独立改期/取消：改期破坏原间隔不被阻止，另一项不受影响', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  const manifest = writeManifest(
    dir,
    'plan.json',
    [
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    [{from: 1, to: 2, minMinutes: 30, maxMinutes: 60}],
  );
  const r = scheduleFlex(df, manifest, '创建');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:30', end: '2026-10-12T11:30', picks: ['R0002']},
    ],
    '创建',
  );

  // 把 B0001 改到 14:00（与 B0002 的间隔已不满足原关系）：独立改期成功
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    '独立改期 B0001（可破坏原间隔）',
  );
  assertBooking(df, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], 'B0001 改期后');
  assertBooking(df, 'B0002', '2026-10-12T10:30', '2026-10-12T11:30', ['R0002'], 'B0002 不受影响');

  // 独立取消 B0002，B0001 仍有效
  ok(df, ['cancel-booking', 'B0002'], '独立取消 B0002');
  const store = readStore(df);
  assert.equal((store.bookings as any[]).find((b) => b.id === 'B0002').status, 'cancelled', 'B0002 已取消');
  assert.equal((store.bookings as any[]).find((b) => b.id === 'B0001').status, 'active', 'B0001 仍有效');
  assert.equal(store.series.length, 0, '不加入系列');
});
