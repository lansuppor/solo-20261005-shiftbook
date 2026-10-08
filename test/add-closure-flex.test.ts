// shiftbook add-closure 附本地弹性改期清单（停用与替代安排一次原子提交）回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings、
//   list-closures、list-batch-ops、list-series、list-waitlist、import-ical 重放）；
// - 覆盖：不附清单原行为（重叠拒绝/端点相接成功）、换资源才能成立、同开始先比
//   开始分钟再按组序字典序、候选与清单书写顺序不影响结果、腾挪链（额外纳入他项
//   才成立）、漏项一次性列全并拒绝、整单无解、撤销受阻（停用仍有效时整笔拒绝、
//   取消停用后整笔恢复、期间被改则一致性拒绝）、混合身份（系列/导入/候补兑现，
//   归属与关联保留）、无变化只推进停用计数、取消停用不自动恢复预约、非法清单与
//   用法错误退出码、真实保存失败与重试（停用与操作标识均未消费）、锁竞争退出 1；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件（<名>.<pid>.tmp）必然超出文件名长度上限，
// 可重复触发真实保存失败。
const LONG_NAME = 'c'.repeat(250) + '.json';

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-add-closure-flex-test-'));
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

function addBooking(df: string, resources: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking'];
  for (const r of resources) args.push('--resource', r);
  args.push('--start', start, '--end', end);
  ok(df, args, ctx);
}

interface FlexItem {
  bookingId: string;
  window: string;
  groups: string[][];
}

function writeManifest(dir: string, name: string, items: FlexItem[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}) + '\n', 'utf8');
  return p;
}

function writeRawManifest(dir: string, name: string, raw: string): string {
  const p = join(dir, name);
  writeFileSync(p, raw, 'utf8');
  return p;
}

function closureWith(
  df: string,
  resource: string,
  start: string,
  end: string,
  manifest: string,
  ctx: string,
): CliResult {
  return ok(df, ['add-closure', '--resource', resource, '--start', start, '--end', end, manifest], ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败不得改动数据文件（逐字节比对）`);
}

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
}

interface ExpectedMove {
  id: string;
  start: string;
  end: string;
  picks: string[];
}

// 断言 add-closure 附清单成功输出：停用标识、可选操作标识、各项时间与按组资源
function assertClosureMove(
  r: CliResult,
  closureId: string,
  opId: string | null,
  expected: ExpectedMove[],
  ctx: string,
): void {
  assert.match(r.stdout, new RegExp(`已登记停用 ${closureId}（停用与本地弹性改期清单已一次原子提交）`), `[${ctx}] 停用标识`);
  if (opId === null) {
    assert.match(r.stdout, /未生成改期操作记录/, `[${ctx}] 无变化应说明不建操作记录`);
    assert.ok(!/改期操作标识: O\d/.test(r.stdout), `[${ctx}] 不应出现操作标识`);
  } else {
    assert.match(
      r.stdout,
      new RegExp(`改期操作标识: ${opId}（共 ${expected.length} 项`),
      `[${ctx}] 操作标识与项数\nstdout:\n${r.stdout}`,
    );
  }
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`- 第 ${i + 1} 项 ${e.id}[（:][^\\n]*\\n?.*${e.start} → ${e.end}`),
      `[${ctx}] 第 ${i + 1} 项 ${e.id} 起止\nstdout:\n${r.stdout}`,
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

// ---------------------------------------------------------------------------
// 1. 不附清单：原行为不变（重叠拒绝并列全部受影响预约；端点相接成功）
// ---------------------------------------------------------------------------

test('不附清单：与有效预约重叠拒绝并列出全部标识；端点相接仍可登记', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  addBooking(df, ['R0001'], '2026-10-12T11:30', '2026-10-12T12:30', 'B0002');

  const bytesBefore = readFileSync(df);
  const r = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:30', '--end', '2026-10-12T12:00'],
    '重叠拒绝',
  );
  assert.match(r.stderr, /无法登记停用/, '拒绝提示');
  assert.match(r.stderr, /B0001（2026-10-12T10:00 → 2026-10-12T11:00）/, '列出 B0001');
  assert.match(r.stderr, /B0002（2026-10-12T11:30 → 2026-10-12T12:30）/, '列出 B0002');
  assertFileBytes(df, bytesBefore, '重叠拒绝后');

  // 左闭右开：停用恰从预约结束开始（11:00）不算重叠，可登记
  const okTouch = ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30'],
    '端点相接',
  );
  assert.match(okTouch.stdout, /已登记停用 C0001\n/, '端点相接登记 C0001');
});

// ---------------------------------------------------------------------------
// 2. 换资源才能成立：窗口钉住时间，拟停用迫使改到另一资源（候选顺序不影响）
// ---------------------------------------------------------------------------

test('换资源才能成立：拟停用迫使同时间换到另一资源，候选倒序书写结果不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'a.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // 窗口恰为 10:00-11:00（时长=窗长，开始钉死），R0001 被拟停用扣除，只能选 R0002
  const m = writeManifest(dir, 'm-a.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '换资源');
  assertClosureMove(
    r,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '换资源',
  );
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '落盘换资源');
  const store = readStore(df);
  assert.equal(store.closureSeq, 1, '停用计数');
  assert.equal(store.batchSeq, 1, '操作计数');
  assert.deepEqual(store.closures.map((c: any) => [c.id, c.resourceId, c.status]), [['C0001', 'R0001', 'active']]);

  // 新进程持久查询
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程查询预约');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00[\s\S]*R0002（乙）/, '持久安排');
  const closures = ok(df, ['list-closures'], '新进程查询停用');
  assert.match(closures.stdout, /- C0001 \[有效\] 2026-10-12T10:00 → 2026-10-12T11:00/, '持久停用');

  // 候选倒序书写：结果不变
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲');
  addResource(df2, '乙');
  addBooking(df2, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const mRev = writeManifest(dir, 'm-b.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0002', 'R0001']]},
  ]);
  const r2 = closureWith(df2, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', mRev, '候选倒序');
  assertClosureMove(
    r2,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '候选倒序',
  );
});

// ---------------------------------------------------------------------------
// 3. 取舍：可同时间换资源或延后用原资源时，先比开始分钟（10:00 的 R0002 胜）
// ---------------------------------------------------------------------------

test('取舍：同时间换资源（10:00）优先于延后到 11:00 用原资源', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001（受停用影响）');
  // R0001、R0002 的 08:00-10:00 均被占：更早开始都不可行；R0001 在 11:00 后空，R0002 10:00 后空
  addBooking(df, ['R0001'], '2026-10-12T08:00', '2026-10-12T10:00', 'B0002（R0001 外部占用）');
  addBooking(df, ['R0002'], '2026-10-12T08:00', '2026-10-12T10:00', 'B0003（R0002 外部占用）');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '先比开始分钟');
  assertClosureMove(
    r,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '先比开始分钟',
  );
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '落盘');
});

// ---------------------------------------------------------------------------
// 4. 腾挪才能成立：只列受影响预约则无解；额外纳入阻挡的 B0002 后整单成立。
//    另验证清单顺序/候选顺序不影响最终安排。
// ---------------------------------------------------------------------------

test('腾挪链：额外纳入为腾挪调整的预约才有解；书写顺序不影响结果', (t) => {
  const dir = tempDir(t);

  function fresh(df: string): void {
    addResource(df, '甲'); // R0001
    addResource(df, '乙'); // R0002
    addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0001（受停用影响）');
    addBooking(df, ['R0002'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0002（挡在备选资源）');
  }

  // (a) 只列 B0001，窗口钉死 11-12：R0001 被停用、R0002 11-12 被未列入的 B0002 占用 → 无解
  const df1 = join(dir, 'a.json');
  fresh(df1);
  const mOnly = writeManifest(dir, 'only.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df1);
  const noSol = bizFail(
    df1,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00', mOnly],
    '只列受影响项无解',
  );
  assert.match(noSol.stderr, /无整体解/, '明确提示无整体解');
  assertFileBytes(df1, bytesBefore, '无解不留停用或改期');
  let store = readStore(df1);
  assert.equal(store.closures.length, 0, '无解不建停用');
  assert.equal(store.batchOps.length, 0, '无解不建操作记录');
  assert.equal(store.closureSeq, 0, '停用计数不变');
  assert.equal(store.batchSeq, 0, '操作计数不变');
  assertBooking(df1, 'B0001', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], 'B0001 原位');
  assertBooking(df1, 'B0002', '2026-10-12T11:00', '2026-10-12T12:00', ['R0002'], 'B0002 原位');

  // (b) 额外纳入 B0002：B0001 同时间换到 R0002，B0002 腾到 R0001 最早可行的 08:00
  const expected: ExpectedMove[] = [
    {id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0002']},
    {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
  ];
  const mChain = writeManifest(dir, 'chain.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0002', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = closureWith(df1, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', mChain, '腾挪链');
  assertClosureMove(r, 'C0001', 'O0001', expected, '腾挪链');

  // (c) 清单顺序与候选顺序全倒，数据相同 → 同一安排（按各自清单顺序展示）
  const df2 = join(dir, 'b.json');
  fresh(df2);
  const mChainRev = writeManifest(dir, 'chain-rev.json', [
    {bookingId: 'B0002', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0002', 'R0001']]},
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T12:00', groups: [['R0002', 'R0001']]},
  ]);
  const r2 = closureWith(df2, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', mChainRev, '倒序清单');
  assertClosureMove(
    r2,
    'C0001',
    'O0001',
    [
      {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0002']},
    ],
    '倒序清单',
  );
  assertBooking(df2, 'B0001', '2026-10-12T11:00', '2026-10-12T12:00', ['R0002'], '倒序 B0001');
  assertBooking(df2, 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001'], '倒序 B0002');
  store = readStore(df2);
  assert.deepEqual(store.batchOps[0].items.map((i: any) => i.bookingId), ['B0002', 'B0001'], '记录按清单顺序');
});

// ---------------------------------------------------------------------------
// 5. 漏项：与拟停用重叠的有效预约必须全列入；漏项一次性列全。已取消预约不要求。
// ---------------------------------------------------------------------------

test('漏项：列出全部遗漏标识并拒绝；已取消预约不要求列入；额外纳入非重叠预约允许', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  // 先建后取消：留下一条与拟停用重叠的已取消预约（不阻挡、不要求列入）
  addBooking(df, ['R0001'], '2026-10-12T09:30', '2026-10-12T10:30', 'B0001（建后取消）');
  ok(df, ['cancel-booking', 'B0001'], '取消 B0001');
  // 相接的有效预约：全部与停用 10:00-12:30 重叠但彼此不冲突
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002（列入）');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0003（漏）');
  addBooking(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T12:30', 'B0004（漏）');
  addBooking(df, ['R0002'], '2026-10-12T15:00', '2026-10-12T16:00', 'B0005（额外纳入，不重叠）');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0002', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0005', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:30', m],
    '漏项拒绝',
  );
  assert.match(r.stderr, /存在 2 项有效预约未纳入改期清单/, '说明遗漏数量');
  assert.match(r.stderr, /B0003（2026-10-12T11:00 → 2026-10-12T12:00）/, '列出 B0003');
  assert.match(r.stderr, /B0004（2026-10-12T12:00 → 2026-10-12T12:30）/, '列出 B0004');
  assert.ok(!/B0001/.test(r.stderr), '已取消预约不属于漏项');
  assertFileBytes(df, bytesBefore, '漏项拒绝后');

  // 同一停用补全清单（含 B0003、B0004，不含已取消的 B0001）即成功
  const mFull = writeManifest(dir, 'full.json', [
    {bookingId: 'B0002', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0003', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0004', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0005', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const ok2 = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:30', mFull, '补全后成功');
  assert.match(ok2.stdout, /已登记停用 C0001/, '补全后登记 C0001');
});

// ---------------------------------------------------------------------------
// 6. 撤销受阻：停用仍有效时整笔拒绝；取消停用后整笔恢复；期间另改则一致性拒绝
// ---------------------------------------------------------------------------

test('安全撤销只恢复改期不取消停用：受阻拒绝、解除后恢复、不一致仍拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001', 'R0002']]},
  ]);
  closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '产生 C0001/O0001');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '改到 R0002');

  // 停用仍有效：恢复到 R0001 10-11 被阻挡，整笔拒绝并指出相关停用 C0001
  const bytesBefore = readFileSync(df);
  const blocked = bizFail(df, ['undo-batch-op', 'O0001'], '撤销受阻');
  assert.match(blocked.stderr, /撤销 O0001 失败/, '受阻提示');
  assert.match(blocked.stderr, /相关有效停用: C0001（2026-10-12T10:00 → 2026-10-12T11:00）/, '指出阻挡停用');
  assertFileBytes(df, bytesBefore, '受阻后文件不变');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '受阻后安排不变');
  let store = readStore(df);
  assert.equal(store.batchOps[0].status, 'active', '记录仍未撤销');
  assert.equal(store.closures[0].status, 'active', '停用仍有效');

  // 取消停用不自动恢复预约
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '取消停用后预约不自动恢复');

  // 期间另改 B0001：与记录改期后安排不一致，撤销被拒
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00', '--resource', 'R0002'],
    '期间另改 B0001',
  );
  const mismatch = bizFail(df, ['undo-batch-op', 'O0001'], '一致性拒绝');
  assert.match(mismatch.stderr, /撤销 O0001 被拒绝/, '一致性拒绝提示');
  assert.match(mismatch.stderr, /不一致/, '说明不一致');

  // 恢复到记录改期后安排后再撤销：整笔恢复成功，停用保持已取消（不被撤销复活/改动）
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', '--resource', 'R0002'],
    '恢复一致',
  );
  const undone = ok(df, ['undo-batch-op', 'O0001'], '解除阻挡后撤销');
  assert.match(undone.stdout, /已安全撤销 O0001/, '撤销成功');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '恢复原安排');
  store = readStore(df);
  assert.equal(store.closures[0].status, 'cancelled', '撤销不改停用状态（仍已取消）');
  assert.equal(store.batchOps[0].status, 'undone', '记录已撤销');
  assert.equal(store.batchSeq, 1, '撤销不推进操作计数');
  assert.equal(store.closureSeq, 1, '撤销不推进停用计数');

  // 撤销后重提同一停用+清单：分配新的停用与操作标识（不复用）
  const r2 = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '撤销后重提');
  assertClosureMove(
    r2,
    'C0002',
    'O0002',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '撤销后重提分配新标识',
  );
});

// ---------------------------------------------------------------------------
// 7. 混合身份：系列成员/导入预约/候补兑现预约同批腾挪，归属与关联全部保留
// ---------------------------------------------------------------------------

test('混合身份：系列/导入/候补兑现预约同批改期，归属、导入身份与候补关联保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 系列 S0001：B0001（10-12 10:00）、B0002（10-19 10:00），均在 R0001
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', '--count', '2'],
    '创建系列',
  );
  // 导入独立事件 B0003（R0001 11:00）
  const ics = join(dir, 'events.ics');
  writeFileSync(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:closure-mix@example.com',
      'DTSTART:20261012T110000',
      'DTEND:20261012T120000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入 B0003');
  // 候补兑现 B0004（R0002 14:00，与拟停用不重叠，作为额外纳入项）
  ok(df, ['add-waitlist', '--resource', 'R0002', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '候补 W0001');
  ok(df, ['process-waitlist'], '兑现 B0004');

  // 停用 R0001 10:00-12:30：覆盖 B0001（系列，10-12 10:00）与 B0003（导入，11:00）；
  // B0002 是同系列下一周成员（10-19，不重叠）、B0004 为候补兑现（在 R0002，不重叠），
  // 二者作为额外纳入项保持原位
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T12:30/2026-10-12T20:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0002', window: '2026-10-19T08:00/2026-10-19T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0003', window: '2026-10-12T12:30/2026-10-12T20:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0004', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:30', m, '混合身份腾挪');
  assert.match(r.stdout, /已登记停用 C0001/, '停用 C0001');
  assert.match(r.stdout, /改期操作标识: O0001（共 4 项，变化 2 项/, 'B0002/B0004 不变，变化 2 项');
  assert.match(r.stdout, /第 1 项 B0001（系列 S0001，归属不变）/, '输出含系列归属');
  // 受影响两项在停用结束后同时开始（12:30），按组序资源字典序分到 R0001/R0002
  assert.match(r.stdout, /第 1 项 B0001（系列 S0001，归属不变）: 2026-10-12T12:30 → 2026-10-12T13:30/, 'B0001 新时间');
  assert.match(r.stdout, /第 3 项 B0003: 2026-10-12T12:30 → 2026-10-12T13:30/, 'B0003 新时间');

  // 归属与关联保留
  const store = readStore(df);
  const byId = new Map(store.bookings.map((b: any) => [b.id, b]));
  assert.equal(byId.get('B0001').seriesId, 'S0001', 'B0001 系列归属保留');
  assert.equal(byId.get('B0002').seriesId, 'S0001', 'B0002 系列归属保留');
  assert.equal(store.series.length, 1, '不新建系列');
  assert.equal(store.imports.length, 1, '导入身份保留');
  assert.equal(store.imports[0].uid, 'closure-mix@example.com', 'UID 关联保留');
  assert.equal(store.imports[0].bookingId, 'B0003', '导入关联预约不变');
  assert.equal(store.waitlist.length, 1, '不新建候补');
  assert.equal(store.waitlist[0].status, 'fulfilled', '候补兑现状态保留');
  assert.equal(store.waitlist[0].bookingId, 'B0004', '候补关联保留');
  assert.equal(store.waitlist[0].start, '2026-10-12T14:00', '候补原请求保留');
  // B0004 未变化：仍在 R0002 14:00
  assert.deepEqual(byId.get('B0004').resourceIds, ['R0002'], 'B0004 资源不变');
  assert.equal(byId.get('B0004').start, '2026-10-12T14:00', 'B0004 时间不变');

  // 操作记录按清单顺序含全部提交项与系列归属
  const ops = ok(df, ['list-batch-ops'], '新进程查询记录');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（4 项，按提交顺序）/, '记录 4 项');
  assert.match(ops.stdout, /第 1 项 B0001（系列 S0001）/, '记录含 B0001 系列归属');
  assert.match(ops.stdout, /第 2 项 B0002（系列 S0001）/, '记录含 B0002 系列归属');
  assert.match(ops.stdout, /第 4 项 B0004/, '记录含额外纳入的 B0004');

  // 新进程重放导入：不覆盖本地改期
  const replay = ok(df, ['import-ical', ics, '--resource', 'R0001'], '重放导入');
  assert.match(replay.stdout, /全部为重放/, '重放提示');

  // 新进程查询候补关联仍在
  const wl = ok(df, ['list-waitlist'], '新进程查询候补');
  assert.match(wl.stdout, /W0001[\s\S]*已兑现[\s\S]*B0004/, '候补关联持久');
});

// ---------------------------------------------------------------------------
// 8. 无变化：全部纳入项保持原位时只新建停用、不建操作记录、不推进操作计数
// ---------------------------------------------------------------------------

test('无变化：纳入项安排均不变，只推进停用计数；取消停用不自动恢复', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  // B0001 在 R0002，与 R0001 上的停用不重叠；作为唯一清单项保持原位
  addBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '无变化提交');
  assertClosureMove(
    r,
    'C0001',
    null,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '无变化提交',
  );
  const store = readStore(df);
  assert.equal(store.closureSeq, 1, '停用计数推进');
  assert.equal(store.batchSeq, 0, '操作计数不推进');
  assert.equal(store.closures.length, 1, '停用已落盘');
  assert.equal(store.batchOps.length, 0, '不建操作记录');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '安排不变');

  // list-batch-ops 明确提示无记录
  const ops = ok(df, ['list-batch-ops'], '查询操作记录');
  assert.match(ops.stdout, /暂无批量改期操作记录/, '无操作记录提示');

  // 取消停用不影响 B0001
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '取消停用不恢复/改动预约');

  // 每次成功登记都创建新停用：再登记一次（无变化）得 C0002
  const r2 = closureWith(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '再次登记');
  assert.match(r2.stdout, /已登记停用 C0002/, '新停用标识 C0002');
  const store2 = readStore(df);
  assert.equal(store2.closureSeq, 2, '停用计数继续推进');
  assert.equal(store2.batchSeq, 0, '操作计数仍不推进');
});

// ---------------------------------------------------------------------------
// 9. 非法输入与用法错误
// ---------------------------------------------------------------------------

test('非法清单/业务输入退出 1，用法错误退出 2；失败不留任何痕迹', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  addBooking(df, ['R0001'], '2026-10-12T13:00', '2026-10-12T14:00', 'B0002');
  const closureArgs = ['--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'];

  // 清单不可读 / 损坏
  const miss = join(dir, 'no-such.json');
  bizFail(df, ['add-closure', ...closureArgs, miss], '清单不可读');
  const badJson = writeRawManifest(dir, 'bad.json', '{不是 json');
  assert.match(bizFail(df, ['add-closure', ...closureArgs, badJson], '清单损坏').stderr, /已损坏，不是合法 JSON/);

  // 内容非法（沿用 reschedule-flex 校验文案）
  const badShape = writeRawManifest(dir, 'shape.json', JSON.stringify([{bookingId: 'B0001'}]));
  assert.match(bizFail(df, ['add-closure', ...closureArgs, badShape], '顶层非对象').stderr, /顶层必须是对象/);
  const unknownField = writeManifest(dir, 'uf.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']], note: 'x'},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, unknownField], '未知字段').stderr, /未知字段 “note”/);
  const emptyItems = writeRawManifest(dir, 'empty.json', JSON.stringify({items: []}));
  assert.match(bizFail(df, ['add-closure', ...closureArgs, emptyItems], '空清单').stderr, /至少包含一项/);
  const unknownBooking = writeManifest(dir, 'ub.json', [
    {bookingId: 'B0099', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, unknownBooking], '未知预约').stderr, /未知预约标识: B0099/);
  const dupBooking = writeManifest(dir, 'dup.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, dupBooking], '重复预约').stderr, /预约标识重复/);
  const unknownRes = writeManifest(dir, 'ur.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0099']]},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, unknownRes], '未知资源').stderr, /未知资源标识: R0099/);
  const shortWindow = writeManifest(dir, 'sw.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:15/2026-10-12T10:45', groups: [['R0001']]},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, shortWindow], '窗口短于时长').stderr, /窗口长度 30 分钟小于预约当前时长 60 分钟/);

  // 已取消预约拒绝（先合法取消 B0002，随后以取消后的文件为基线）
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  const bytesBefore = readFileSync(df);
  const cancelled = writeManifest(dir, 'cancelled.json', [
    {bookingId: 'B0002', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
  ]);
  assert.match(bizFail(df, ['add-closure', ...closureArgs, cancelled], '已取消预约').stderr, /预约 B0002 已取消，不能改期/);

  // 业务错误：未知停用资源、停用时间非法
  const goodManifest = writeManifest(dir, 'ok.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  bizFail(
    df,
    ['add-closure', '--resource', 'R0099', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', goodManifest],
    '未知停用资源',
  );
  bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T10:00', goodManifest],
    '停用时间非法',
  );

  // 用法错误：多个位置参数、缺少必需选项、未知选项
  usageFail(df, ['add-closure', ...closureArgs, goodManifest, join(dir, 'extra.json')], '两个位置参数');
  usageFail(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', goodManifest], '缺少 --end');
  usageFail(df, ['add-closure', ...closureArgs, '--bogus', 'x', goodManifest], '未知选项');

  // 全部失败后文件逐字节不变、计数不动
  assertFileBytes(df, bytesBefore, '全部失败后');
  const store = readStore(df);
  assert.equal(store.closureSeq, 0, '停用计数不动');
  assert.equal(store.batchSeq, 0, '操作计数不动');
});

// ---------------------------------------------------------------------------
// 10. 真实保存失败与重试：停用与操作标识均未消费，新进程查询持久结果
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且原数据逐字节保留，重试成功且 C/O 标识均未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const manifest = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001', 'R0002']]},
  ]);

  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(
    longFile,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', manifest],
    '保存失败',
  );
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assert.ok(!r.stdout.includes('已登记停用'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  const failed = readStore(longFile);
  assert.equal(failed.closures.length, 0, '不产生停用');
  assert.equal(failed.batchOps.length, 0, '不产生操作记录');
  assert.equal(failed.closureSeq, 0, '停用计数未消费');
  assert.equal(failed.batchSeq, 0, '操作计数未消费');
  assert.equal(failed.bookings[0].resourceIds[0], 'R0001', '原安排不变');

  // 可保存位置用同一原数据重试：C0001/O0001 均从 1 开始（未被失败尝试消费）
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = closureWith(retryFile, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', manifest, '重试成功');
  assertClosureMove(
    r2,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '重试标识未消费',
  );

  // 新进程查询持久结果
  const bl = ok(retryFile, ['list-bookings', '--date', '2026-10-12'], '新进程查询预约');
  assert.match(bl.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/, '持久预约');
  const cl = ok(retryFile, ['list-closures'], '新进程查询停用');
  assert.match(cl.stdout, /- C0001 \[有效\] 2026-10-12T10:00 → 2026-10-12T11:00/, '持久停用');
  const ops = ok(retryFile, ['list-batch-ops'], '新进程查询操作');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（1 项，按提交顺序）/, '持久操作记录');
});

// ---------------------------------------------------------------------------
// 11. 锁竞争：他进程持锁时退出 1 且原文件不变；持锁者提交不受影响
// ---------------------------------------------------------------------------

test('锁竞争：5 秒未取得保护退出 1，不留下停用/改期；持锁者提交保留', async (t) => {
  const dir = tempDir(t);
  const sync = join(dir, 'sync');
  mkdirSync(sync);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const manifest = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df);

  // 真实子进程取得保护后停在同步点（持锁不释放）
  const child: ChildProcess = spawn(
    process.execPath,
    [
      APP,
      '--data',
      df,
      'create-booking',
      '--resource',
      'R0002',
      '--start',
      '2026-10-12T09:00',
      '--end',
      '2026-10-12T10:00',
    ],
    {encoding: 'utf8', env: {...process.env, SHIFTBOOK_TEST_SYNC_DIR: sync}},
  );
  const childDone = new Promise<void>((resolveP, reject) => {
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolveP() : reject(new Error(`持锁进程退出码 ${status}`))));
  });
  const ready = join(sync, 'write-lock-acquired.ready');
  const deadline = Date.now() + 15000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error('等待持锁进程同步点超时');
    await new Promise((r) => setTimeout(r, 10));
  }

  // 附清单的停用提交在 5 秒等待后退出 1，不改动文件
  const r = runCli(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', manifest]);
  assert.equal(r.status, 1, '锁竞争应退出 1');
  assert.match(r.stderr, /正被其他进程占用/, '说明占用原因');
  assertFileBytes(df, bytesBefore, '竞争失败保持原文件');
  const store = readStore(df);
  assert.equal(store.closures.length, 0, '竞争失败不留停用');
  assert.equal(store.batchOps.length, 0, '竞争失败不留操作记录');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], 'B0001 未改期');

  // 放行持锁者：其提交保留，竞争者的内容未被部分写入
  writeFileSync(join(sync, 'write-lock-acquired.go'), '\n', 'utf8');
  await childDone;
  const after = readStore(df);
  assert.equal(after.bookings.length, 2, '持锁者的预约已提交，竞争者未部分写入');
  assert.equal(after.closures.length, 0, '竞争者未留下停用');
  assert.equal(after.batchOps.length, 0, '竞争者未留下操作记录');
  assert.equal(after.closureSeq, 0, '停用计数未被竞争消费');
  assert.equal(after.batchSeq, 0, '操作计数未被竞争消费');
});
