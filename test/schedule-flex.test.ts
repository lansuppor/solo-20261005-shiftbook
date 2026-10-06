// shiftbook 多项弹性预约联合排程与原子创建（schedule-flex）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings 等）；
// - 覆盖：前项换资源或延后才有解（不逐项贪选最早）、整体无解（含各自可行
//   整体不可行）、多方案按清单顺序的取舍（先开始分钟、再按组序资源标识字典序）、
//   跨日窗口与停用端点相接、开放相接合并、各类占用（已取消预约与未兑现候补
//   不阻挡）、真实保存失败与重试（标识未消费）、重复提交即新请求、新进程查询
//   持久安排并独立改期/取消、不加入系列且不自动处理候补、用法与非法清单退出码、
//   损坏数据与旧格式文件；
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
const LONG_NAME = 'f'.repeat(250) + '.json';

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

function usageFail(df: string, args: string[], ctx: string): CliResult {
  const r = runCli(df, args);
  assert.equal(
    r.status,
    2,
    `[${ctx}] 期望退出 2，实际 ${r.status}\n命令: ${args.join(' ')}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
  return r;
}

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-schedule-flex-test-'));
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

function writeManifest(dir: string, name: string, items: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}) + '\n', 'utf8');
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
// 1. 前项换资源才有解：不能逐项贪选较小标识；候选书写顺序不影响结果
// ---------------------------------------------------------------------------

test('前项换资源才有解：第 1 项须让出 R0001，组内候选书写顺序不影响结果', (t) => {
  const dir = tempDir(t);

  // (a) 第 1 组若贪选 R0001，第 2 项（只有 R0001）将无可选：必须回溯让第 1 项改选 R0002
  const df = join(dir, 'a.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  const m1 = writeManifest(dir, 'plan-a.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);
  const r1 = scheduleFlex(df, m1, '前项换资源');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '前项换资源',
  );
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0002'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '落盘');

  // (b) 组内候选倒序书写，结果不变
  const df2 = join(dir, 'b.json');
  addResource(df2, '一号会议室');
  addResource(df2, '二号会议室');
  const m2 = writeManifest(dir, 'plan-b.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002', 'R0001']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);
  const r2 = scheduleFlex(df2, m2, '候选倒序');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '候选倒序结果一致',
  );
});

// ---------------------------------------------------------------------------
// 2. 前项延后才有解：清单顺序不限定活动发生先后
// ---------------------------------------------------------------------------

test('前项延后才有解：第 1 项被后项的占用顶到 10:00，仍按清单顺序取舍', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001

  // 第 2 项窗口恰等于时长，只能占 09:00-10:00；第 1 项若取最早 09:00 则整体无解，
  // 必须延后到 10:00（其开始 = 第 2 项占用结束）
  const m = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 90, groups: [['R0001']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);
  const r = scheduleFlex(df, m, '前项延后');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:30', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '前项延后',
  );
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:30', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '落盘');
});

// ---------------------------------------------------------------------------
// 3. 整体无解：明确提示、退出 1、不保存部分方案、不消耗标识；含各自可行整体不可行
// ---------------------------------------------------------------------------

test('整体无解：退出 1 且明确提示，不产生记录/占用/计数变化，后续可行请求标识不被消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 各自可行但整体不可行：两项可瓜分 R0001/R0002，第三项（只要 R0001）再无资源
  const mBad = writeManifest(dir, 'bad.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r1 = bizFail(df, ['schedule-flex', mBad], '整体无解');
  assert.match(r1.stderr, /无整体解/, '明确提示无整体解');
  assert.ok(!r1.stdout.includes('联合排程成功'), '不报告成功');
  assertFileBytes(df, bytesBefore, '无解后');
  let store = readStore(df);
  assert.equal(store.bookings.length, 0, '不保存部分方案');
  assert.equal(store.bookingSeq, 0, '标识计数不变');

  // 同一资源被两项全程争抢也无解（窗口恰等于时长）
  const mBad2 = writeManifest(dir, 'bad2.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);
  const r2 = bizFail(df, ['schedule-flex', mBad2], '同一资源两次争抢');
  assert.match(r2.stderr, /无整体解/);
  assertFileBytes(df, bytesBefore, '再次无解后');

  // 失败不消耗标识：随后可行请求仍从 B0001 开始
  const mOk = writeManifest(dir, 'ok.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  const r3 = scheduleFlex(df, mOk, '无解后的可行请求');
  assertPlan(r3, [{id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '标识未消费');
  store = readStore(df);
  assert.equal(store.bookings.length, 1, '仅本次一项预约');
  assert.equal(store.bookingSeq, 1);
});

// ---------------------------------------------------------------------------
// 4. 方案取舍：逐项先比开始分钟，再按需求组顺序比资源标识字典序
// ---------------------------------------------------------------------------

test('方案取舍：更早开始优先于更小标识；同开始按组序取字典序最小序列', (t) => {
  const dir = tempDir(t);

  // (a) R0001 标识更小但 10:00 才开放；R0002 08:00 即可用：取更早开始（R0002）
  const df1 = join(dir, 'a.json');
  addResource(df1, '晚开放场地', [['2026-10-12T10:00', '2026-10-12T20:00']]); // R0001
  addResource(df1, '早开放场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002
  const m1 = writeManifest(dir, 'plan-a.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  const r1 = scheduleFlex(df1, m1, '更早开始优先');
  assertPlan(r1, [{id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']}], '更早开始优先');

  // (b) 两项同窗口同候选：第 1 项同开始取字典序最小序列，第 2 项取剩余最小
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲'); // R0001
  addResource(df2, '乙'); // R0002
  const m2 = writeManifest(dir, 'plan-b.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  const r2 = scheduleFlex(df2, m2, '同开始字典序');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
    ],
    '同开始字典序',
  );

  // (c) 第 1 项固定后，第 2 项先比开始分钟再比资源：08:00 的 R0002 胜过 09:00 的 R0001
  const df3 = join(dir, 'c.json');
  addResource(df3, '甲'); // R0001
  addResource(df3, '乙'); // R0002
  const m3 = writeManifest(dir, 'plan-c.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  const r3 = scheduleFlex(df3, m3, '后项先比开始');
  assertPlan(
    r3,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
    ],
    '后项先比开始',
  );

  // (d) 多需求组：同开始按组顺序逐位比较资源标识
  const df4 = join(dir, 'd.json');
  addResource(df4, '甲'); // R0001
  addResource(df4, '乙'); // R0002
  addResource(df4, '丙'); // R0003
  const m4 = writeManifest(dir, 'plan-d.json', [
    {
      window: '2026-10-12T08:00/2026-10-12T12:00',
      duration: 60,
      groups: [
        ['R0002', 'R0003'],
        ['R0001', 'R0002'],
      ],
    },
  ]);
  const r4 = scheduleFlex(df4, m4, '多组字典序');
  // 第 1 组最小可选 R0002，第 2 组随后取 R0001（[R0002,R0001] < [R0003,R0001]）
  assertPlan(r4, [{id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002', 'R0001']}], '多组字典序');
  assertBooking(df4, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001', 'R0002'], '落盘资源集合排序');
});

// ---------------------------------------------------------------------------
// 5. 跨日窗口、停用端点相接与开放相接合并
// ---------------------------------------------------------------------------

test('跨日窗口：结束贴停用起点、开始贴停用终点均可行；相接开放先合并', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '跨日场地', [['2026-10-12T08:00', '2026-10-13T20:00']]); // R0001
  // 两段相接开放应合并为连续开放（预约可跨越 12:00 接缝）
  addResource(df, '分段开放场地', [
    ['2026-10-12T08:00', '2026-10-12T12:00'],
    ['2026-10-12T12:00', '2026-10-12T20:00'],
  ]); // R0002
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T21:00', '--end', '2026-10-13T01:00'],
    '跨日有效停用 C0001',
  );

  const m = writeManifest(dir, 'plan.json', [
    // 最早可行 20:00 → 21:00，结束恰与停用起点相接（左闭右开，可行）
    {window: '2026-10-12T20:00/2026-10-13T02:00', duration: 60, groups: [['R0001']]},
    // 下一可行段从停用终点 01:00 开始，开始恰与停用终点相接
    {window: '2026-10-12T20:00/2026-10-13T02:00', duration: 60, groups: [['R0001']]},
    // 跨越相接开放接缝 12:00：10:30 → 12:30 须由两段开放合并后连续覆盖
    {window: '2026-10-12T10:30/2026-10-12T13:00', duration: 120, groups: [['R0002']]},
  ]);
  const r = scheduleFlex(df, m, '跨日与停用端点');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T20:00', end: '2026-10-12T21:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-13T01:00', end: '2026-10-13T02:00', picks: ['R0001']},
      {id: 'B0003', start: '2026-10-12T10:30', end: '2026-10-12T12:30', picks: ['R0002']},
    ],
    '跨日与停用端点',
  );
  assertBooking(df, 'B0001', '2026-10-12T20:00', '2026-10-12T21:00', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-13T01:00', '2026-10-13T02:00', ['R0001'], '落盘');
  assertBooking(df, 'B0003', '2026-10-12T10:30', '2026-10-12T12:30', ['R0002'], '落盘');
});

// ---------------------------------------------------------------------------
// 6. 占用口径：有效预约阻挡，已取消预约与未兑现候补不阻挡；端点相接可行
// ---------------------------------------------------------------------------

test('占用口径：已取消预约与未兑现候补不阻挡，新项与既有预约端点相接可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅'); // R0001

  // 已取消预约不阻挡：09:00-10:00 曾预约但已取消
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], 'B0001');
  ok(df, ['cancel-booking', 'B0001'], '取消 B0001');
  // 有效预约占用 10:00-11:00
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], 'B0002');
  // 未兑现候补不阻挡：登记 11:00-12:00 固定候补（等待中）
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '未兑现候补 W0001',
  );

  // 最早可行：09:00 → 10:00（取消记录不阻挡，结束与 B0002 起点相接）
  const m = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T09:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ]);
  const r = scheduleFlex(df, m, '占用口径');
  assertPlan(r, [{id: 'B0003', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '占用口径');

  // 候补不被自动处理：仍为等待中
  const store = readStore(df);
  assert.equal(store.waitlist.length, 1, '不创建额外候补');
  assert.equal(store.waitlist[0].status, 'waiting', '不自动处理候补');
  assert.equal(store.waitlist[0].bookingId, undefined, '候补无兑现关联');
});

// ---------------------------------------------------------------------------
// 7. 真实保存失败与重试：退出 1、原文件逐字节保留、标识未消费；换可写位置重试成功
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且原数据逐字节保留，同一原数据重试成功且标识未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const manifest = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);

  // 同一原数据放到保存必然失败的位置（文件名 255 字节，临时文件名超限）
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

  // 在可保存的位置用同一原数据重试：成功且标识未被失败尝试消费
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = scheduleFlex(retryFile, manifest, '可保存位置重试');
  assertPlan(r2, [{id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '重试标识未消费');
  assertBooking(retryFile, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '重试生效');
});

// ---------------------------------------------------------------------------
// 8. 持久化与独立性：新进程查询持久安排，可独立改期/取消；不加入系列；
//    重复提交是新的创建请求（不按路径或内容去重）
// ---------------------------------------------------------------------------

test('新进程查询持久安排并独立改期/取消；重复提交即新请求', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  const manifest = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T09:00/2026-10-12T11:00', duration: 60, groups: [['R0001']]},
  ]);

  const r1 = scheduleFlex(df, manifest, '首次提交');
  assertPlan(r1, [{id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '首次提交');

  // 相同清单再次提交是新的创建请求：新预约端点相接排在 10:00
  const r2 = scheduleFlex(df, manifest, '重复提交');
  assertPlan(r2, [{id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']}], '重复提交即新请求');

  // 新进程按日查询：两条持久安排均可见
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/, 'B0001 持久可查');
  assert.match(list.stdout, /B0002 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0002 持久可查');

  // 不加入系列
  let store = readStore(df);
  assert.equal(store.series.length, 0, '不创建系列');
  const series = ok(df, ['list-series'], '新进程查询系列');
  assert.ok(!series.stdout.includes('B0001') && !series.stdout.includes('B0002'), '系列查询不含新预约');

  // 独立改期其中一项（标识不变），另一项不受影响
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '独立改期 B0001');
  assertBooking(df, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '改期后');
  assertBooking(df, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '另一项不受影响');

  // 独立取消其中一项，另一项仍有效
  ok(df, ['cancel-booking', 'B0002'], '独立取消 B0002');
  store = readStore(df);
  assert.equal((store.bookings as any[]).find((b) => b.id === 'B0002').status, 'cancelled', 'B0002 已取消');
  assert.equal((store.bookings as any[]).find((b) => b.id === 'B0001').status, 'active', 'B0001 仍有效');

  // 取消与改期后原时段释放：再次提交同一清单回到最早的 09:00
  const r3 = scheduleFlex(df, manifest, '取消后再提交');
  assertPlan(r3, [{id: 'B0003', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '取消后时段释放');
});

// ---------------------------------------------------------------------------
// 9. 用法错误（退出 2）与非法清单（退出 1），均不改动数据文件
// ---------------------------------------------------------------------------

test('用法错误退出 2，非法清单退出 1，均不产生记录或计数变化', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  const bytesBefore = readFileSync(df);

  // 用法错误（退出 2）
  usageFail(df, ['schedule-flex'], '缺少清单文件');
  usageFail(df, ['schedule-flex', 'a.json', 'b.json'], '多余位置参数');
  usageFail(df, ['schedule-flex', '--window', 'x'], '未知选项');

  // 清单不可读 / 损坏（退出 1）
  let r = bizFail(df, ['schedule-flex', join(dir, 'missing.json')], '清单不存在');
  assert.match(r.stderr, /无法读取预约清单/);
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json', 'utf8');
  r = bizFail(df, ['schedule-flex', badJson], '清单损坏');
  assert.match(r.stderr, /已损坏，不是合法 JSON/);

  // 结构非法（退出 1）
  const writeRaw = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };
  r = bizFail(df, ['schedule-flex', writeRaw('n1.json', '[]')], '顶层非对象');
  assert.match(r.stderr, /顶层必须是对象/);
  r = bizFail(df, ['schedule-flex', writeRaw('n2.json', '{"items": [], "x": 1}')], '未知顶层字段');
  assert.match(r.stderr, /未知字段 “x”/);
  r = bizFail(df, ['schedule-flex', writeRaw('n3.json', '{"items": []}')], '空清单');
  assert.match(r.stderr, /至少包含一项/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n4.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 60, "groups": [["R0001"]], "note": 1}]}')],
    '未知项字段',
  );
  assert.match(r.stderr, /未知字段 “note”/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n5.json', '{"items": [{"window": "2026-10-12T09:00", "duration": 60, "groups": [["R0001"]]}]}')],
    '窗口缺结束',
  );
  assert.match(r.stderr, /窗口格式非法/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n6.json', '{"items": [{"window": "2026-10-12T10:00/2026-10-12T09:00", "duration": 60, "groups": [["R0001"]]}]}')],
    '窗口结束早于开始',
  );
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n7.json', '{"items": [{"window": "2026-02-30T09:00/2026-10-12T10:00", "duration": 60, "groups": [["R0001"]]}]}')],
    '窗口日期不真实',
  );
  assert.match(r.stderr, /不是真实有效的时间/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n8.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 0, "groups": [["R0001"]]}]}')],
    '时长为 0',
  );
  assert.match(r.stderr, /duration 必须是正整数分钟/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n9.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 1.5, "groups": [["R0001"]]}]}')],
    '时长非整数',
  );
  assert.match(r.stderr, /duration 必须是正整数分钟/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n10.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 120, "groups": [["R0001"]]}]}')],
    '时长超过窗口',
  );
  assert.match(r.stderr, /超过窗口长度/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n11.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 60, "groups": []}]}')],
    '需求组为空',
  );
  assert.match(r.stderr, /至少一个有顺序的需求组/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n12.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 60, "groups": [[]]}]}')],
    '空需求组',
  );
  assert.match(r.stderr, /必须是非空数组/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n13.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 60, "groups": [["R0001", "R0001"]]}]}')],
    '组内重复',
  );
  assert.match(r.stderr, /候选资源重复: R0001/);
  r = bizFail(
    df,
    ['schedule-flex', writeRaw('n14.json', '{"items": [{"window": "2026-10-12T09:00/2026-10-12T10:00", "duration": 60, "groups": [["R0009"]]}]}')],
    '未知资源',
  );
  assert.match(r.stderr, /未知资源标识: R0009/);

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '失败请求不产生记录');
  assert.equal(store.bookingSeq, 0, '失败请求不消耗标识');
});

// ---------------------------------------------------------------------------
// 10. 损坏数据文件退出 1 并保留原样；旧格式文件可直接排程
// ---------------------------------------------------------------------------

test('损坏数据文件退出 1 并保留原样；旧格式文件可直接联合排程', (t) => {
  const dir = tempDir(t);
  const manifest = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0001']]},
  ]);

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad-data.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r1 = bizFail(bad, ['schedule-flex', manifest], '损坏数据文件');
  assert.match(r1.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件失败后');

  // 旧格式文件（只有 version 与 resources，无后续版本字段）：直接可排程
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
    }) + '\n',
    'utf8',
  );
  const r2 = scheduleFlex(old, manifest, '旧文件排程');
  assertPlan(r2, [{id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']}], '旧文件排程');
  assertBooking(old, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '旧文件落盘');
});
