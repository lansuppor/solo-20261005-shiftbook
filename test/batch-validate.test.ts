// shiftbook 共享批次校验（validateBatchTargets）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-* / 重新读取文件）；
// - 覆盖：整批交换成功与真实批内冲突、非标识顺序的多项失败、停用造成的覆盖不足、
//   改期/取消后的重放预约占用、保存失败与无变化操作的文件保护；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, statSync} from 'node:fs';
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

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-validate-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(df: string, name: string, open: Array<[string, string]> = OPEN_ALL): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function createBooking(df: string, resources: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking'];
  for (const r of resources) args.push('--resource', r);
  args.push('--start', start, '--end', end);
  ok(df, args, ctx);
}

function writeManifest(dir: string, name: string, items: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}, null, 2) + '\n');
  return p;
}

function writeIcal(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function event(uid: string, start: string, end: string): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nEND:VEVENT\n`;
}

function ical(...events: string[]): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${events.join('')}END:VCALENDAR\n`;
}

// 由新进程之外直接读取保存结果（JSON 数据文件本身即持久化结果）
function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function bookingOf(store: any, id: string): any {
  const b = store.bookings.find((x: any) => x.id === id);
  assert.ok(b, `预约 ${id} 应存在`);
  return b;
}

function assertArrangement(
  store: any,
  id: string,
  start: string,
  end: string,
  resources: string[],
  ctx: string,
): void {
  const b = bookingOf(store, id);
  assert.equal(b.start, start, `[${ctx}] ${id} 开始时间`);
  assert.equal(b.end, end, `[${ctx}] ${id} 结束时间`);
  assert.deepEqual(b.resourceIds, [...resources].sort(), `[${ctx}] ${id} 资源集合`);
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 数据文件应逐字节保留`);
}

// ---------------------------------------------------------------------------
// 1. 整批交换成功（逐项会被对方旧占用阻挡，整批可行）与真实批内冲突
// ---------------------------------------------------------------------------

test('批量改期：整批交换时段成功；真实批内冲突双方互列且整批不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 交换时段：逐项改期会被对方旧占用阻挡，整批校验排除本批占用后可行
  const swap = writeManifest(dir, 'swap.json', [
    {bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
  ]);
  const r1 = ok(df, ['reschedule-batch', swap], '整批交换时段');
  assert.match(r1.stdout, /O0001/);
  let store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '交换后');
  assertArrangement(store, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '交换后');
  // 由新进程回读保存结果
  const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(dayView.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/);
  assert.match(dayView.stdout, /B0002 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/);

  // 真实批内冲突：两项目标在同一资源上时间重叠，双方都报告对方
  const clash = writeManifest(dir, 'clash.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T14:30', end: '2026-10-12T15:30', resourceIds: ['R0001']},
  ]);
  const bytesBefore = readFileSync(df);
  const r2 = bizFail(df, ['reschedule-batch', clash], '真实批内冲突');
  assert.match(r2.stderr, /共 2 项不满足条件/);
  assert.match(r2.stderr, /第 1 项 B0001 目标 2026-10-12T14:00 → 2026-10-12T15:00/);
  assert.match(r2.stderr, /第 2 项 B0002 目标 2026-10-12T14:30 → 2026-10-12T15:30/);
  assert.match(
    r2.stderr,
    /本批第 2 项 B0002（活动 2026-10-12T14:30 → 2026-10-12T15:30）：[\s\S]*?R0001（甲）：本目标实际占用[\s\S]*第 2 项目标实际占用/,
    '第 1 项列出对方标识、目标时间、共同资源与双方实际占用',
  );
  assert.match(
    r2.stderr,
    /本批第 1 项 B0001（活动 2026-10-12T14:00 → 2026-10-12T15:00）：[\s\S]*?R0001（甲）：本目标实际占用[\s\S]*第 1 项目标实际占用/,
    '第 2 项列出对方标识、目标时间、共同资源与双方实际占用',
  );
  assertFileBytes(df, bytesBefore, '批内冲突逐字节保留');
  store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '整批不变');
  assertArrangement(store, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '整批不变');
  assert.equal(store.batchOps.length, 1, '不留新操作记录');
  assert.equal(store.batchSeq, 1, '操作计数不变');
});

// ---------------------------------------------------------------------------
// 2. 非标识顺序的多项失败：按清单（提交）顺序报告，与预约标识顺序无关
// ---------------------------------------------------------------------------

test('批量改期：非标识顺序提交的多项失败按清单顺序全部报告', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001，仅白天开放
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');
  createBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0003');
  createBooking(df, ['R0001'], '2026-10-12T14:00', '2026-10-12T15:00', '批外预约 B0004');

  // 清单顺序为 B0003、B0001、B0002（非标识顺序）：
  // 第 1 项与批外 B0004 冲突；第 2 项超出开放时间；第 3 项同时与 B0004 及第 1 项冲突
  const manifest = writeManifest(dir, 'multi.json', [
    {bookingId: 'B0003', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
    {bookingId: 'B0001', start: '2026-10-12T21:00', end: '2026-10-12T22:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T14:30', end: '2026-10-12T15:30', resourceIds: ['R0001']},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(df, ['reschedule-batch', manifest], '多项失败');
  assert.match(r.stderr, /共 3 项不满足条件（按清单顺序）/);
  const i1 = r.stderr.indexOf('第 1 项 B0003 目标');
  const i2 = r.stderr.indexOf('第 2 项 B0001 目标');
  const i3 = r.stderr.indexOf('第 3 项 B0002 目标');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, '失败项按清单顺序而非标识顺序报告');
  assert.match(r.stderr, /第 1 项 B0003[\s\S]*?B0004（活动 2026-10-12T14:00 → 2026-10-12T15:00）/, '批外冲突');
  assert.match(r.stderr, /第 2 项 B0001[\s\S]*?开放不足资源:[\s\S]*?R0001/, '开放不足');
  assert.match(
    r.stderr,
    /第 3 项 B0002[\s\S]*?本批第 1 项 B0003（活动 2026-10-12T14:00 → 2026-10-12T15:00）：[\s\S]*?R0001（甲）：本目标实际占用[\s\S]*第 1 项目标实际占用/,
    '批内冲突列对方标识、目标时间、共同资源与双方实际占用',
  );
  assertFileBytes(df, bytesBefore, '多项失败逐字节保留');
  const store = readStore(df);
  assertArrangement(store, 'B0003', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], '整批不变');
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assert.equal(store.batchSeq, 0, '操作计数不变');
});

// ---------------------------------------------------------------------------
// 3. 停用造成的覆盖不足（系列入口）：列出不足资源与相关有效停用标识和时间
// ---------------------------------------------------------------------------

test('创建系列：有效停用造成覆盖不足，解除后整批成功', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-19T00:00', '--end', '2026-10-20T00:00'],
    '有效停用 C0001',
  );

  // 第 2 项成员（2026-10-19）落入停用区间：整批失败，列出相关停用标识与时间
  const args = [
    'create-series', '--resource', 'R0001',
    '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', '--count', '3',
  ];
  const bytesBefore = readFileSync(df);
  const r = bizFail(df, args, '停用造成覆盖不足');
  assert.match(r.stderr, /系列创建失败：共 1 项不满足条件（按发生顺序）/);
  assert.match(r.stderr, /第 2 项 2026-10-19T10:00 → 2026-10-19T11:00/);
  assert.match(r.stderr, /开放不足资源:[\s\S]*?R0001/);
  assert.match(r.stderr, /相关有效停用: C0001（2026-10-19T00:00 → 2026-10-20T00:00）/);
  assertFileBytes(df, bytesBefore, '系列失败逐字节保留');
  let store = readStore(df);
  assert.equal(store.bookings.length, 0, '不创建任何成员');
  assert.equal(store.series.length, 0, '不创建系列');
  assert.equal(store.bookingSeq, 0, '预约计数不变');
  assert.equal(store.seriesSeq, 0, '系列计数不变');
  const seriesView = ok(df, ['list-series'], '新进程系列查询');
  assert.match(seriesView.stdout, /暂无预约系列/);

  // 解除停用后同一请求整批成功，标识从 S0001/B0001 起分配（未被失败尝试消费）
  ok(df, ['cancel-closure', 'C0001'], '解除停用');
  const r2 = ok(df, args, '解除后创建系列');
  assert.match(r2.stdout, /已创建按周重复系列 S0001/);
  assert.match(r2.stdout, /第 2 项 B0002: 2026-10-19T10:00 → 2026-10-19T11:00/);
  store = readStore(df);
  assert.equal(store.bookings.length, 3);
  assert.equal(store.seriesSeq, 1);
  const seriesView2 = ok(df, ['list-series'], '新进程确认系列成员');
  assert.match(seriesView2.stdout, /B0002 \[有效\] 2026-10-19T10:00 → 2026-10-19T11:00/);
});

// ---------------------------------------------------------------------------
// 4. 改期/取消后的重放预约占用：重放项按当前安排与状态参与既有占用，
//    不用首次导入快照代替现状
// ---------------------------------------------------------------------------

test('导入：重放预约改期后按新安排占用、取消后不再占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const f1 = writeIcal(dir, 'a.ics', ical(event('uid-a', '20261012T100000', '20261012T110000')));
  ok(df, ['import-ical', f1, '--resource', 'R0001'], '首次导入 uid-a（B0001）');
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'],
    '改期重放源预约',
  );

  // 重放 uid-a（首次导入快照为 10:00-11:00）+ 新项 uid-b 10:00-11:00：
  // B0001 当前已改到 15:00-16:00，原时段不再占用，新项可行
  const f2 = writeIcal(dir, 'b.ics', ical(
    event('uid-a', '20261012T100000', '20261012T110000'),
    event('uid-b', '20261012T100000', '20261012T110000'),
  ));
  const r1 = ok(df, ['import-ical', f2, '--resource', 'R0001'], '改期后重放+新项');
  assert.match(r1.stdout, /新增 1 项，重放 1 项/);
  assert.match(r1.stdout, /uid-a[\s\S]*?当前安排: 2026-10-12T15:00 → 2026-10-12T16:00/);
  let store = readStore(df);
  assertArrangement(store, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '新项占用原时段');

  // 新项 uid-c 15:30-16:30 与 B0001 的当前安排（而非首次导入快照）冲突：整批拒绝
  const f3 = writeIcal(dir, 'c.ics', ical(
    event('uid-a', '20261012T100000', '20261012T110000'),
    event('uid-c', '20261012T153000', '20261012T163000'),
  ));
  const bytesBefore = readFileSync(df);
  const r2 = bizFail(df, ['import-ical', f3, '--resource', 'R0001'], '与改期后安排冲突');
  assert.match(r2.stderr, /uid-c[\s\S]*?B0001（活动 2026-10-12T15:00 → 2026-10-12T16:00）：[\s\S]*?R0001（甲）：本次发生实际占用[\s\S]*?B0001实际占用 2026-10-12T15:00 → 2026-10-12T16:00/, '按当前安排参与占用');
  assertFileBytes(df, bytesBefore, '冲突整批未导入');
  assert.equal(readStore(df).bookings.length, 2);

  // 取消 B0001 后：重放报告已取消且不复活；同一 uid-c 不再受阻（取消不占用）
  ok(df, ['cancel-booking', 'B0001'], '取消重放源预约');
  const r3 = ok(df, ['import-ical', f3, '--resource', 'R0001'], '取消后重放+新项');
  assert.match(r3.stdout, /uid-a[\s\S]*?当前状态: 已取消/);
  assert.match(r3.stdout, /uid-c[\s\S]*?新预约 B0003/);
  store = readStore(df);
  assert.equal(bookingOf(store, 'B0001').status, 'cancelled', '重放不复活已取消预约');
  assertArrangement(store, 'B0003', '2026-10-12T15:30', '2026-10-12T16:30', ['R0001'], '取消后新项可行');
  const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(dayView.stdout, /B0001 \[已取消\] 2026-10-12T15:00 → 2026-10-12T16:00/);
  assert.match(dayView.stdout, /B0003 \[已预约\] 2026-10-12T15:30 → 2026-10-12T16:30/);
});

// ---------------------------------------------------------------------------
// 5. 保存失败与无变化操作的文件保护
// ---------------------------------------------------------------------------

test('文件保护：保存失败逐字节保留且不消费标识；无变化操作不写文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');

  // (a) 无变化批量改期：成功但不写文件、不建记录、不推进计数
  const noop = writeManifest(dir, 'noop.json', [
    {bookingId: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
  ]);
  const bytesBefore = readFileSync(df);
  const mtimeBefore = statSync(df).mtimeMs;
  const r1 = ok(df, ['reschedule-batch', noop], '无变化批量改期');
  assert.match(r1.stdout, /无业务变化/);
  assertFileBytes(df, bytesBefore, '无变化提交不写文件');
  assert.equal(statSync(df).mtimeMs, mtimeBefore, '修改时间不变');
  let store = readStore(df);
  assert.equal(store.batchOps.length, 0);
  assert.equal(store.batchSeq, 0);

  // (b) 全重放导入：成功但不写文件、不推进计数
  const f = writeIcal(dir, 'a.ics', ical(event('uid-x', '20261012T160000', '20261012T170000')));
  ok(df, ['import-ical', f, '--resource', 'R0001'], '首次导入 uid-x（B0002）');
  const bytesAfterImport = readFileSync(df);
  const r2 = ok(df, ['import-ical', f, '--resource', 'R0001'], '全重放导入');
  assert.match(r2.stdout, /全部为重放/);
  assertFileBytes(df, bytesAfterImport, '全重放不写文件');
  store = readStore(df);
  assert.equal(store.bookingSeq, 2, '预约计数不变');
  assert.equal(store.imports.length, 1, '不新增导入身份');

  // (c) 保存失败：同一原数据放到保存必然失败的位置（文件名 255 字节）
  const change = writeManifest(dir, 'change.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r3 = bizFail(longFile, ['reschedule-batch', change], '保存失败批量改期');
  assert.ok(!r3.stdout.includes('成功'), '不报告成功');
  assert.ok(!r3.stdout.includes('O0001'), '不报告操作标识');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  store = readStore(longFile);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '没有部分改期');
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assert.equal(store.batchSeq, 0, '标识未消费');

  // (d) 同一原数据在可保存位置重试：成功且操作标识未被失败尝试消费
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r4 = ok(retryFile, ['reschedule-batch', change], '可保存位置重试');
  assert.match(r4.stdout, /O0001/, '标识未被消费，仍为 O0001');
  store = readStore(retryFile);
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '重试生效');
  assert.equal(store.batchSeq, 1);
  const opsView = ok(retryFile, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(opsView.stdout, /O0001 \[未撤销\]/);
});
