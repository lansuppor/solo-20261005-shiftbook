// shiftbook 多目标批次校验（共用无写入副作用校验）命令行回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-*）或直接读取数据文件断言；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。
//
// 覆盖：交换成功与真实批内冲突、非标识顺序的多项失败、停用造成的覆盖不足、
// 改期或取消后的重放预约占用，以及保存失败与无变化操作的文件保护。

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
// 1. 交换成功与真实批内冲突（批量改期）
// ---------------------------------------------------------------------------

test('批量改期：整批交换时段成功；真实批内冲突双方均报告且整批不变', (t) => {
  // (a) 交换成功：逐项改期会被对方旧占用阻挡，整批交换可行
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
    createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

    const manifest = writeManifest(dir, 'swap.json', [
      {bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
      {bookingId: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
    ]);
    const r = ok(df, ['reschedule-batch', manifest], '整批交换时段');
    assert.match(r.stdout, /O0001/);

    // 由新进程回读保存结果
    const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
    assert.match(dayView.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/);
    assert.match(dayView.stdout, /B0002 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/);
    const store = readStore(df);
    assertArrangement(store, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '交换生效');
    assertArrangement(store, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '交换生效');
  }

  // (b) 真实批内冲突：两项目标时间重叠且共用资源，双方项都列出对方，整批不变
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
    createBooking(df, ['R0001'], '2026-10-12T14:00', '2026-10-12T15:00', 'B0002');

    const bytesBefore = readFileSync(df);
    const manifest = writeManifest(dir, 'clash.json', [
      {bookingId: 'B0001', start: '2026-10-12T12:00', end: '2026-10-12T13:00', resourceIds: ['R0001']},
      {bookingId: 'B0002', start: '2026-10-12T12:30', end: '2026-10-12T13:30', resourceIds: ['R0001']},
    ]);
    const r = bizFail(df, ['reschedule-batch', manifest], '真实批内冲突');
    assert.match(r.stderr, /共 2 项不满足条件/);
    // 批内冲突双方都报告，且列出对方标识与目标时间
    assert.match(r.stderr, /第 1 项 B0001 目标 2026-10-12T12:00 → 2026-10-12T13:00：[\s\S]*B0002（本批第 2 项目标 2026-10-12T12:30 → 2026-10-12T13:30）：共同资源 R0001/);
    assert.match(r.stderr, /第 2 项 B0002 目标 2026-10-12T12:30 → 2026-10-12T13:30：[\s\S]*B0001（本批第 1 项目标 2026-10-12T12:00 → 2026-10-12T13:00）：共同资源 R0001/);
    assertFileBytes(df, bytesBefore, '批内冲突整批不变');
    const store = readStore(df);
    assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '原安排不变');
    assertArrangement(store, 'B0002', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '原安排不变');
    assert.equal(store.batchOps.length, 0, '不留操作记录');
    assert.equal(store.batchSeq, 0, '操作计数不变');
  }
});

// ---------------------------------------------------------------------------
// 2. 非标识顺序的多项失败：按提交（清单）顺序报告，失败项全部列出
// ---------------------------------------------------------------------------

test('批量改期：非标识顺序提交的多项失败按清单顺序报告（开放不足 + 批外冲突）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');
  createBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0003');
  createBooking(df, ['R0001'], '2026-10-12T14:00', '2026-10-12T15:00', '批外预约 B0004');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '停用 C0001');

  // 清单顺序与标识顺序相反：B0003 落入停用（覆盖不足），B0001 撞上批外 B0004，B0002 可行
  const bytesBefore = readFileSync(df);
  const manifest = writeManifest(dir, 'multi.json', [
    {bookingId: 'B0003', start: '2026-10-12T16:00', end: '2026-10-12T17:00', resourceIds: ['R0001']},
    {bookingId: 'B0001', start: '2026-10-12T14:30', end: '2026-10-12T15:30', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T18:00', end: '2026-10-12T19:00', resourceIds: ['R0001']},
  ]);
  const r = bizFail(df, ['reschedule-batch', manifest], '非标识顺序多项失败');
  assert.match(r.stderr, /共 2 项不满足条件（按清单顺序）/);
  // 按清单顺序：第 1 项 B0003（停用覆盖不足）先于第 2 项 B0001（批外冲突）
  const iB3 = r.stderr.indexOf('第 1 项 B0003 目标 2026-10-12T16:00 → 2026-10-12T17:00');
  const iB1 = r.stderr.indexOf('第 2 项 B0001 目标 2026-10-12T14:30 → 2026-10-12T15:30');
  assert.ok(iB3 >= 0, '应报告第 1 项 B0003');
  assert.ok(iB1 > iB3, '第 2 项 B0001 应出现在第 1 项 B0003 之后（按清单顺序而非标识顺序）');
  assert.ok(!r.stderr.includes('第 3 项 B0002 目标'), '可行项不应列为失败');
  // 失败诊断含业务定位：相关有效停用标识与时间、冲突预约及共同资源
  assert.match(r.stderr, /相关有效停用: C0001（2026-10-12T16:00 → 2026-10-12T17:00）/);
  assert.match(r.stderr, /B0004（2026-10-12T14:00 → 2026-10-12T15:00）：共同资源 R0001/);
  assertFileBytes(df, bytesBefore, '多项失败整批不变');
  const store = readStore(df);
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assert.equal(store.batchSeq, 0, '操作计数不变');
});

// ---------------------------------------------------------------------------
// 3. 停用造成的覆盖不足（创建系列 + 撤销恢复）
// ---------------------------------------------------------------------------

test('覆盖不足：有效停用使系列成员与撤销恢复受阻，列出相关停用标识与时间', (t) => {
  // (a) 创建系列：第二项落入有效停用，整批失败且不推进任何计数
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T12:00'], '停用 C0001');

    const bytesBefore = readFileSync(df);
    const r = bizFail(
      df,
      ['create-series', '--resource', 'R0001', '--start', '2026-10-05T10:00', '--end', '2026-10-05T11:00', '--count', '3'],
      '系列成员落入停用',
    );
    assert.match(r.stderr, /共 1 项不满足条件（按发生顺序）/);
    assert.match(r.stderr, /第 2 项 2026-10-12T10:00 → 2026-10-12T11:00：[\s\S]*相关有效停用: C0001（2026-10-12T09:00 → 2026-10-12T12:00）/);
    assertFileBytes(df, bytesBefore, '系列整批失败不写文件');
    const store = readStore(df);
    assert.equal(store.series.length, 0, '不创建系列');
    assert.equal(store.bookings.length, 0, '不创建成员');
    assert.equal(store.seriesSeq, 0, '系列计数不变');
    assert.equal(store.bookingSeq, 0, '预约计数不变');
  }

  // (b) 撤销恢复：改期后原时段被停用覆盖，恢复受阻并列出停用；解除后恢复成功
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
    const manifest = writeManifest(dir, 'op.json', [
      {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
    ]);
    ok(df, ['reschedule-batch', manifest], '批量改期 O0001');
    ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T12:00'], '停用 C0001 覆盖原时段');

    const bytesBefore = readFileSync(df);
    const r = bizFail(df, ['undo-batch-op', 'O0001'], '停用使恢复受阻');
    assert.match(r.stderr, /第 1 项 B0001 恢复为 2026-10-12T09:00 → 2026-10-12T10:00：[\s\S]*相关有效停用: C0001（2026-10-12T08:00 → 2026-10-12T12:00）/);
    assertFileBytes(df, bytesBefore, '恢复受阻整笔不变');
    let store = readStore(df);
    assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '安排不变');
    assert.equal(store.batchOps[0].status, 'active', '记录状态不变');

    ok(df, ['cancel-closure', 'C0001'], '解除停用');
    ok(df, ['undo-batch-op', 'O0001'], '解除后恢复成功');
    // 由新进程回读保存结果
    const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
    assert.match(dayView.stdout, /B0001 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/);
    store = readStore(df);
    assert.equal(store.batchOps[0].status, 'undone', '记录已撤销');
  }
});

// ---------------------------------------------------------------------------
// 4. 改期或取消后的重放预约占用（iCalendar 导入）
// ---------------------------------------------------------------------------

test('导入：重放关联预约按当前安排和状态参与占用，不用首次导入快照代替现状', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const f1 = writeIcal(dir, 'first.ics', ical(event('uid-old', '20261012T100000', '20261012T110000')));
  ok(df, ['import-ical', f1, '--resource', 'R0001'], '首次导入 uid-old -> B0001');

  // 改期后：重放项关联预约按当前安排（15:00-16:00）参与占用，新项撞上即受阻
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'], '改期 B0001');
  const fMix = writeIcal(dir, 'mix.ics', ical(
    event('uid-old', '20261012T100000', '20261012T110000'), // 重放（快照时间 10:00）
    event('uid-new', '20261012T150000', '20261012T160000'), // 撞上 B0001 当前安排
  ));
  const r1 = bizFail(df, ['import-ical', fMix, '--resource', 'R0001'], '新项撞上重放预约当前安排');
  assert.match(r1.stderr, /uid-new[\s\S]*B0001（2026-10-12T15:00 → 2026-10-12T16:00）：共同资源 R0001/);
  assert.equal(readStore(df).bookings.length, 1, '整批未导入');

  // 快照时间（10:00-11:00）此时空闲：新项可以使用，证明不按快照占用
  const fSnap = writeIcal(dir, 'snap.ics', ical(event('uid-at-snapshot', '20261012T100000', '20261012T110000')));
  ok(df, ['import-ical', fSnap, '--resource', 'R0001'], '快照时间空闲可导入 -> B0002');

  // 取消后：重放项关联预约不再占用，其当前时段可被新项使用
  ok(df, ['cancel-booking', 'B0001'], '取消 B0001');
  const fAfterCancel = writeIcal(dir, 'after-cancel.ics', ical(
    event('uid-old', '20261012T100000', '20261012T110000'), // 重放（已取消，不复活）
    event('uid-freed', '20261012T150000', '20261012T160000'), // B0001 已取消，此时段空闲
  ));
  const r2 = ok(df, ['import-ical', fAfterCancel, '--resource', 'R0001'], '取消后重放 + 新项占用其时段');
  assert.match(r2.stdout, /新增 1 项，重放 1 项/);
  assert.match(r2.stdout, /当前状态: 已取消/);

  // 由新进程回读保存结果
  const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(dayView.stdout, /B0001 \[已取消\] 2026-10-12T15:00 → 2026-10-12T16:00/);
  assert.match(dayView.stdout, /B0003 \[已预约\] 2026-10-12T15:00 → 2026-10-12T16:00/);
  const store = readStore(df);
  assert.equal(bookingOf(store, 'B0001').status, 'cancelled', '重放不复活已取消预约');
  assertArrangement(store, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '快照时间新预约');
  assertArrangement(store, 'B0003', '2026-10-12T15:00', '2026-10-12T16:00', ['R0001'], '取消后时段新预约');
  assert.equal(store.bookingSeq, 3, '预约计数按实际新增推进');
});

// ---------------------------------------------------------------------------
// 5. 保存失败与无变化操作的文件保护
// ---------------------------------------------------------------------------

test('文件保护：保存失败逐字节保留且标识未消费；无变化操作不写文件', (t) => {
  // (a) 保存失败（导入）：退出 1、不报告成功、原文件逐字节保留、标识未消费，可重试
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    const ics = writeIcal(dir, 'a.ics', ical(event('uid-save', '20261012T100000', '20261012T110000')));

    const origBytes = readFileSync(df);
    const longFile = join(dir, LONG_NAME);
    writeFileSync(longFile, origBytes);
    const r = bizFail(longFile, ['import-ical', ics, '--resource', 'R0001'], '保存失败导入');
    assert.ok(!r.stdout.includes('导入完成'), '不报告成功');
    assert.ok(!r.stdout.includes('B0001'), '不报告预约标识');
    assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
    let store = readStore(longFile);
    assert.equal(store.bookings.length, 0, '没有部分导入');
    assert.equal(store.imports.length, 0, '不留导入身份');
    assert.equal(store.bookingSeq, 0, '预约计数不变');

    // 同一原数据在可保存位置重试：成功且标识未被失败尝试消费
    const retryFile = join(dir, 'retry.json');
    writeFileSync(retryFile, origBytes);
    const r2 = ok(retryFile, ['import-ical', ics, '--resource', 'R0001'], '可保存位置重试');
    assert.match(r2.stdout, /B0001/, '标识未被消费，仍为 B0001');
    store = readStore(retryFile);
    assert.equal(store.bookings.length, 1);
    assert.equal(store.imports.length, 1);
    assert.equal(store.bookingSeq, 1);
  }

  // (b) 无变化批量改期：成功但不写文件、不建记录、不推进计数
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');

    const manifest = writeManifest(dir, 'noop.json', [
      {bookingId: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
    ]);
    const bytesBefore = readFileSync(df);
    const mtimeBefore = statSync(df).mtimeMs;
    const r = ok(df, ['reschedule-batch', manifest], '无变化批量改期');
    assert.match(r.stdout, /无业务变化/);
    assertFileBytes(df, bytesBefore, '无变化提交不写文件');
    assert.equal(statSync(df).mtimeMs, mtimeBefore, '修改时间不变');
    const store = readStore(df);
    assert.equal(store.batchOps.length, 0, '不建操作记录');
    assert.equal(store.batchSeq, 0, '操作计数不变');
  }

  // (c) 全重放导入：成功但不写文件、不推进计数
  {
    const dir = tempDir(t);
    const df = join(dir, 'data.json');
    addResource(df, '甲'); // R0001
    const ics = writeIcal(dir, 'a.ics', ical(event('uid-replay', '20261012T100000', '20261012T110000')));
    ok(df, ['import-ical', ics, '--resource', 'R0001'], '首次导入');

    const bytesBefore = readFileSync(df);
    const mtimeBefore = statSync(df).mtimeMs;
    const r = ok(df, ['import-ical', ics, '--resource', 'R0001'], '全重放导入');
    assert.match(r.stdout, /全部为重放/);
    assertFileBytes(df, bytesBefore, '全重放不写文件');
    assert.equal(statSync(df).mtimeMs, mtimeBefore, '修改时间不变');
    const store = readStore(df);
    assert.equal(store.bookings.length, 1, '不重建预约');
    assert.equal(store.bookingSeq, 1, '预约计数不变');
  }
});
