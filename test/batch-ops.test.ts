// shiftbook 批量改期（reschedule-batch）与安全撤销（undo-batch-op）自动化回归测试
//
// 运行：npm test（等价于 node --test test/batch-ops.test.ts）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-* / 重新读取文件）；
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-batch-test-'));
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
// 1. 混合提交成功：普通预约 + 不同系列成员 + 候补兑现预约（含未变化项），互换时段
// ---------------------------------------------------------------------------

test('批量改期：普通预约、不同系列成员与候补兑现预约混合提交（含未变化项）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', '普通预约 B0001');
  ok(df, ['create-series', '--resource', 'R0002', '--start', '2026-10-05T10:00', '--end', '2026-10-05T11:00', '--count', '2'], '系列 S0001'); // B0002, B0003
  ok(df, ['create-series', '--resource', 'R0003', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00', '--count', '2'], '系列 S0002'); // B0004, B0005
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-14T10:00', '--end', '2026-10-14T11:00'], '候补 W0001');
  // W0002 与 B0004 冲突，处理时受阻继续等待；批量改期后该时段空出，但不得自动兑现
  ok(df, ['add-waitlist', '--resource', 'R0003', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00'], '候补 W0002');
  ok(df, ['process-waitlist'], '处理候补（W0001 兑现为 B0006，W0002 等待）');
  createBooking(df, ['R0003'], '2026-10-16T10:00', '2026-10-16T11:00', '无关预约 B0007');

  // 混合清单：B0001 与 B0003（S0001 成员）互换时段并整体替换资源；
  // B0004（S0002 成员）改时间并整体替换为多资源；B0006（候补兑现）为未变化项
  const manifest = writeManifest(dir, 'mixed.json', [
    {bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0002']},
    {bookingId: 'B0003', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
    {bookingId: 'B0004', start: '2026-10-15T14:00', end: '2026-10-15T15:30', resourceIds: ['R0003', 'R0001']},
    {bookingId: 'B0006', start: '2026-10-14T10:00', end: '2026-10-14T11:00', resourceIds: ['R0001']},
  ]);
  const r = ok(df, ['reschedule-batch', manifest], '混合批量改期');
  assert.match(r.stdout, /O0001/, '成功应返回操作标识 O0001');

  const store = readStore(df);
  // 互换时段与资源整体替换生效；系列归属不变
  assertArrangement(store, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '互换后');
  assertArrangement(store, 'B0003', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '互换后');
  assertArrangement(store, 'B0004', '2026-10-15T14:00', '2026-10-15T15:30', ['R0001', 'R0003'], '资源整体替换');
  assertArrangement(store, 'B0006', '2026-10-14T10:00', '2026-10-14T11:00', ['R0001'], '未变化项');
  assert.equal(bookingOf(store, 'B0003').seriesId, 'S0001', '系列归属不变');
  assert.equal(bookingOf(store, 'B0004').seriesId, 'S0002', '系列归属不变');
  assert.equal(bookingOf(store, 'B0001').seriesId, undefined, '普通预约无系列');
  // 无关预约不变
  assertArrangement(store, 'B0002', '2026-10-05T10:00', '2026-10-05T11:00', ['R0002'], '无关成员');
  assertArrangement(store, 'B0005', '2026-10-20T10:00', '2026-10-20T11:00', ['R0003'], '无关成员');
  assertArrangement(store, 'B0007', '2026-10-16T10:00', '2026-10-16T11:00', ['R0003'], '无关预约');
  // 不创建预约或系列、不推进任何标识计数（除操作计数）
  assert.equal(store.bookings.length, 7, '不创建预约');
  assert.equal(store.series.length, 2, '不创建系列');
  assert.equal(store.bookingSeq, 7, '预约计数不变');
  assert.equal(store.seriesSeq, 2, '系列计数不变');
  assert.equal(store.waitlistSeq, 2, '候补计数不变');
  assert.equal(store.batchSeq, 1, '操作计数推进为 1');

  // 操作记录：全部提交项的前后安排与清单顺序
  assert.equal(store.batchOps.length, 1, '恰好一条操作记录');
  const op = store.batchOps[0];
  assert.equal(op.id, 'O0001');
  assert.equal(op.status, 'active');
  assert.deepEqual(op.items.map((i: any) => i.bookingId), ['B0001', 'B0003', 'B0004', 'B0006'], '项按清单顺序');
  const [i1, i2, i3, i4] = op.items;
  assert.deepEqual(i1.before, {start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']});
  assert.deepEqual(i1.after, {start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0002']});
  assert.equal(i1.seriesId, undefined);
  assert.equal(i2.seriesId, 'S0001', '记录提交时系列归属');
  assert.deepEqual(i2.before, {start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0002']});
  assert.deepEqual(i2.after, {start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']});
  assert.equal(i3.seriesId, 'S0002');
  assert.deepEqual(i3.before, {start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0003']});
  assert.deepEqual(i3.after, {start: '2026-10-15T14:00', end: '2026-10-15T15:30', resourceIds: ['R0001', 'R0003']});
  assert.equal(i4.seriesId, undefined);
  assert.deepEqual(i4.before, {start: '2026-10-14T10:00', end: '2026-10-14T11:00', resourceIds: ['R0001']});
  assert.deepEqual(i4.after, i4.before, '未变化项前后一致');

  // 候补原请求与关联保留；候补不被自动处理
  const w1 = store.waitlist.find((w: any) => w.id === 'W0001');
  assert.equal(w1.status, 'fulfilled');
  assert.equal(w1.bookingId, 'B0006', '兑现关联保留');
  assert.equal(w1.start, '2026-10-14T10:00', '候补原请求保留');
  assert.equal(w1.end, '2026-10-14T11:00');
  assert.deepEqual(w1.resourceIds, ['R0001']);
  const w2 = store.waitlist.find((w: any) => w.id === 'W0002');
  assert.equal(w2.status, 'waiting', '批量改期不自动处理候补');
  assert.equal(w2.bookingId, undefined);

  // 由新进程查询保存结果
  const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(dayView.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/);
  assert.match(dayView.stdout, /B0003 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/);
  const seriesView = ok(df, ['list-series'], '新进程系列查询');
  assert.match(seriesView.stdout, /B0004 \[有效\] 2026-10-15T14:00 → 2026-10-15T15:30/);
  const wlView = ok(df, ['list-waitlist'], '新进程候补查询');
  assert.match(wlView.stdout, /W0001 \[已兑现\]/);
  assert.match(wlView.stdout, /W0002 \[等待中\]/);
  const opsView = ok(df, ['list-batch-ops'], '新进程操作记录查询');
  assert.match(opsView.stdout, /O0001 \[未撤销\]/);
  for (const frag of ['第 1 项 B0001', '第 2 项 B0003', '第 3 项 B0004', '第 4 项 B0006']) {
    assert.ok(opsView.stdout.includes(frag), `操作记录应按提交顺序显示：${frag}`);
  }
  assert.ok(opsView.stdout.includes('2026-10-12T09:00 → 2026-10-12T10:00'), '记录含改期前安排');
  assert.ok(opsView.stdout.includes('2026-10-15T14:00 → 2026-10-15T15:30'), '记录含改期后安排');
});

// ---------------------------------------------------------------------------
// 2. 幂等：无变化首次提交与重复提交成功，不写文件、不增记录或计数
// ---------------------------------------------------------------------------

test('批量改期幂等：无变化首次提交与重复提交均成功且不写文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');

  // (a) 无变化首次提交：成功、显示完整安排，但不写文件、不建记录、不推进计数
  const noopManifest = writeManifest(dir, 'noop.json', [
    {bookingId: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
  ]);
  const bytesBefore = readFileSync(df);
  const mtimeBefore = statSync(df).mtimeMs;
  const r1 = ok(df, ['reschedule-batch', noopManifest], '无变化首次提交');
  assert.ok(r1.stdout.includes('B0001'), '显示预约标识');
  assert.ok(r1.stdout.includes('2026-10-12T09:00 → 2026-10-12T10:00'), '显示完整时间安排');
  assert.ok(r1.stdout.includes('R0001'), '显示资源');
  assertFileBytes(df, bytesBefore, '无变化提交不写文件');
  assert.equal(statSync(df).mtimeMs, mtimeBefore, '修改时间不变');
  let store = readStore(df);
  assert.equal(store.batchOps.length, 0, '不增加操作记录');
  assert.equal(store.batchSeq, 0, '操作计数不变');

  // (b) 有变化提交：建立记录 O0001
  const changeManifest = writeManifest(dir, 'change.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', changeManifest], '有变化首次提交');
  store = readStore(df);
  assert.equal(store.batchOps.length, 1);
  assert.equal(store.batchSeq, 1);
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '改期生效');

  // (c) 重复提交同一清单：成功、显示完整安排，仍不写文件、不增记录或计数
  const bytesBefore2 = readFileSync(df);
  const mtimeBefore2 = statSync(df).mtimeMs;
  const r2 = ok(df, ['reschedule-batch', changeManifest], '重复提交');
  assert.ok(r2.stdout.includes('B0001'));
  assert.ok(r2.stdout.includes('2026-10-12T14:00 → 2026-10-12T15:00'));
  assertFileBytes(df, bytesBefore2, '重复提交不写文件');
  assert.equal(statSync(df).mtimeMs, mtimeBefore2, '修改时间不变');
  store = readStore(df);
  assert.equal(store.batchOps.length, 1, '不增加操作记录');
  assert.equal(store.batchSeq, 1, '操作计数不变');
  const opsView = ok(df, ['list-batch-ops'], '新进程查询记录');
  assert.match(opsView.stdout, /共 1 条/);
});

// ---------------------------------------------------------------------------
// 3. 连续操作：撤销身份、状态持久化、重复撤销、重提交分配新标识
// ---------------------------------------------------------------------------

test('撤销身份：改动后恢复一致仍可撤销；重复撤销不影响新安排；重提交分配新标识', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  const m1 = writeManifest(dir, 'op1.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', m1], '批量改期 O0001');
  const m2 = writeManifest(dir, 'op2.json', [
    {bookingId: 'B0002', start: '2026-10-12T16:00', end: '2026-10-12T17:00', resourceIds: ['R0002']},
  ]);
  ok(df, ['reschedule-batch', m2], '批量改期 O0002（较新记录）');

  // 较早记录的涉及预约被改动，再恢复至其改期后安排，仍可撤销
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'], '中间改动');
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '恢复一致');
  ok(df, ['undo-batch-op', 'O0001'], '撤销较早记录 O0001');
  let store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '撤销恢复原时间与资源');
  assertArrangement(store, 'B0002', '2026-10-12T16:00', '2026-10-12T17:00', ['R0002'], '较新记录安排不受影响');
  assert.equal(store.batchOps[0].status, 'undone', 'O0001 已撤销');
  assert.equal(store.batchOps[1].status, 'active', 'O0002 仍未撤销');
  // 操作状态持久化：新进程查询
  const opsView = ok(df, ['list-batch-ops'], '新进程确认撤销状态');
  assert.match(opsView.stdout, /O0001 \[已撤销\]/);
  assert.match(opsView.stdout, /O0002 \[未撤销\]/);

  // 随后再改期，重复撤销旧记录：成功且当前安排与文件均不受影响
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T18:00', '--end', '2026-10-12T19:00'], '撤销后再改期');
  const bytesBefore = readFileSync(df);
  ok(df, ['undo-batch-op', 'O0001'], '重复撤销已撤销记录');
  assertFileBytes(df, bytesBefore, '重复撤销不写文件');
  store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T18:00', '2026-10-12T19:00', ['R0001'], '当前安排不受影响');
  assert.equal(store.batchOps.length, 2, '不新增记录');
  assert.equal(store.batchSeq, 2, '操作计数不变');

  // 撤销后重提交原清单产生变化：分配新操作标识，不复用旧记录
  ok(df, ['reschedule-batch', m1], '撤销后重提交原清单');
  store = readStore(df);
  assert.equal(store.batchOps.length, 3, '生成新记录');
  assert.equal(store.batchSeq, 3);
  assert.deepEqual(store.batchOps.map((o: any) => o.id), ['O0001', 'O0002', 'O0003'], '标识稳定不复用');
  const o3 = store.batchOps[2];
  assert.equal(o3.status, 'active');
  assert.equal(o3.items[0].bookingId, 'B0001');
  assert.deepEqual(o3.items[0].before, {start: '2026-10-12T18:00', end: '2026-10-12T19:00', resourceIds: ['R0001']});
  assert.deepEqual(o3.items[0].after, {start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']});
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '重提交生效');
});

// ---------------------------------------------------------------------------
// 4. 撤销整笔拒绝：涉及预约已取消 + 多项当前安排不一致
// ---------------------------------------------------------------------------

test('撤销整笔拒绝：已取消与多项不一致全部列出，不复活取消项，文件逐字节保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T08:00', '2026-10-12T09:00', 'B0001');
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0002');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0003');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T12:00', end: '2026-10-12T13:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T13:00', end: '2026-10-12T14:00', resourceIds: ['R0001']},
    {bookingId: 'B0003', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '批量改期 O0001');

  ok(df, ['cancel-booking', 'B0002'], '取消涉及预约');
  ok(df, ['reschedule-booking', 'B0003', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '另一涉及预约安排不一致');

  const bytesBefore = readFileSync(df);
  const r = bizFail(df, ['undo-batch-op', 'O0001'], '整笔拒绝');
  assert.ok(r.stderr.includes('B0002'), '列出已取消预约');
  assert.ok(r.stderr.includes('已取消'), '说明取消原因');
  assert.ok(r.stderr.includes('B0003'), '列出安排不一致预约');
  assert.ok(!r.stderr.includes('B0001'), '一致项不应列为不一致');
  assertFileBytes(df, bytesBefore, '校验失败逐字节保留');

  const store = readStore(df);
  assert.equal(bookingOf(store, 'B0002').status, 'cancelled', '不复活已取消预约');
  assertArrangement(store, 'B0001', '2026-10-12T12:00', '2026-10-12T13:00', ['R0001'], '整笔不变');
  assertArrangement(store, 'B0002', '2026-10-12T13:00', '2026-10-12T14:00', ['R0001'], '整笔不变');
  assertArrangement(store, 'B0003', '2026-10-12T16:00', '2026-10-12T17:00', ['R0001'], '整笔不变');
  assert.equal(store.batchOps[0].status, 'active', '记录状态不变');
  assert.equal(store.batchSeq, 1, '操作计数不变');
});

// ---------------------------------------------------------------------------
// 5a. 恢复受阻：有效停用 + 批外预约同时阻挡，解除后恢复成功
// ---------------------------------------------------------------------------

test('撤销恢复受阻：有效停用与批外预约阻挡全部列出，解除阻挡后恢复成功', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  createBooking(df, ['R0001', 'R0002'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001', 'R0002']},
  ]);
  ok(df, ['reschedule-batch', manifest], '批量改期 O0001');

  // 构造阻挡：批外预约占用 R0001 的原时段；R0002 的原时段被有效停用覆盖
  createBooking(df, ['R0001'], '2026-10-12T09:30', '2026-10-12T10:30', '批外预约 B0002');
  ok(df, ['add-closure', '--resource', 'R0002', '--start', '2026-10-12T08:00', '--end', '2026-10-12T12:00'], '有效停用 C0001');

  const bytesBefore = readFileSync(df);
  const r = bizFail(df, ['undo-batch-op', 'O0001'], '恢复受阻');
  assert.ok(r.stderr.includes('B0001'), '列出失败项');
  assert.ok(r.stderr.includes('C0001'), '列出相关停用标识');
  assert.ok(r.stderr.includes('2026-10-12T08:00') && r.stderr.includes('2026-10-12T12:00'), '列出相关停用时间');
  assert.ok(r.stderr.includes('B0002'), '列出冲突预约');
  assert.ok(r.stderr.includes('R0001'), '列出共同资源');
  assertFileBytes(df, bytesBefore, '恢复受阻逐字节保留');
  let store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001', 'R0002'], '整笔不变');
  assert.equal(store.batchOps[0].status, 'active', '记录状态不变');

  // 解除全部阻挡后恢复成功
  ok(df, ['cancel-closure', 'C0001'], '解除停用阻挡');
  ok(df, ['cancel-booking', 'B0002'], '解除批外预约阻挡');
  ok(df, ['undo-batch-op', 'O0001'], '解除后恢复');
  store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001', 'R0002'], '恢复原时间与资源');
  assert.equal(store.batchOps[0].status, 'undone', '记录已撤销');
});

// ---------------------------------------------------------------------------
// 5b. 恢复互换时段及端点相接的安排可行
// ---------------------------------------------------------------------------

test('撤销恢复：互换时段及端点相接的安排可恢复', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  // 端点相接的两项预约
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 互换时段（逐项改期会被对方旧占用阻挡，整批可行）
  const manifest = writeManifest(dir, 'swap.json', [
    {bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '互换时段');
  let store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '互换生效');
  assertArrangement(store, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '互换生效');

  // 恢复互换时段：恢复后仍为端点相接安排，可行
  ok(df, ['undo-batch-op', 'O0001'], '恢复互换时段');
  store = readStore(df);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '恢复原安排');
  assertArrangement(store, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '恢复原安排');
  assert.equal(store.batchOps[0].status, 'undone');
});

// ---------------------------------------------------------------------------
// 6a. 保存失败（批量改期）：退出 1、不报告成功、原文件逐字节保留、标识未消费
// ---------------------------------------------------------------------------

test('保存失败（批量改期）：退出 1 且原数据逐字节保留，同一原数据可重试且标识未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);

  // 同一原数据放到保存必然失败的位置（文件名 255 字节，临时文件名超限）
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['reschedule-batch', manifest], '保存失败批量改期');
  assert.ok(!r.stdout.includes('成功'), '不报告成功');
  assert.ok(!r.stdout.includes('O0001'), '不报告操作标识');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  let store = readStore(longFile);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '没有部分改期');
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assert.equal(store.batchSeq, 0, '标识计数不变');

  // 在可保存的位置用同一原数据重试：成功且标识未被失败尝试消费
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = ok(retryFile, ['reschedule-batch', manifest], '可保存位置重试');
  assert.match(r2.stdout, /O0001/, '标识未被消费，仍为 O0001');
  store = readStore(retryFile);
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '重试生效');
  assert.equal(store.batchOps.length, 1);
  assert.equal(store.batchSeq, 1);
});

// ---------------------------------------------------------------------------
// 6b. 保存失败（撤销）：退出 1、安排与记录状态不变、不提前撤销、可重试
// ---------------------------------------------------------------------------

test('保存失败（撤销）：退出 1 且安排与记录状态不变，同一原数据可重试', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '批量改期 O0001');

  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['undo-batch-op', 'O0001'], '保存失败撤销');
  assert.ok(!r.stdout.includes('已安全撤销'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  let store = readStore(longFile);
  assertArrangement(store, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '安排不变');
  assert.equal(store.batchOps[0].status, 'active', '不提前撤销');
  assert.equal(store.batchSeq, 1, '标识计数不变');

  // 在可保存的位置用同一原数据重试：恢复成功
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  ok(retryFile, ['undo-batch-op', 'O0001'], '可保存位置重试');
  store = readStore(retryFile);
  assertArrangement(store, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '重试恢复原安排');
  assert.equal(store.batchOps[0].status, 'undone', '重试后记录已撤销');
  assert.equal(store.batchSeq, 1, '撤销不推进计数');
});

// ---------------------------------------------------------------------------
// 7. 旧文件兼容：缺少批量操作记录的文件可继续改期/取消，记录与撤销状态不丢失
// ---------------------------------------------------------------------------

test('旧文件兼容：缺少批量操作记录的旧文件可查询与修改，记录和撤销状态不丢失', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // 手工构造旧格式文件：无 series/waitlist/closures/batchOps 及其计数字段
  const legacy = {
    version: 1,
    resourceSeq: 1,
    bookingSeq: 2,
    resources: [
      {id: 'R0001', type: 'venue', name: '旧厅', open: [['2026-01-01T00:00', '2027-01-01T00:00']]},
    ],
    bookings: [
      {id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T09:00', end: '2026-10-12T10:00', status: 'active'},
      {id: 'B0002', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T11:00', status: 'active'},
    ],
  };
  writeFileSync(df, JSON.stringify(legacy, null, 2) + '\n');

  const dayView = ok(df, ['list-bookings', '--date', '2026-10-12'], '旧文件查询');
  assert.match(dayView.stdout, /B0001/);
  assert.match(dayView.stdout, /B0002/);

  // 旧入口改期与取消：不丢失后续产生的批量操作记录
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], '旧文件改期');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0002', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '旧文件批量改期 O0001');
  ok(df, ['cancel-booking', 'B0001'], '旧入口取消');

  // 历史快照与现状不同（B0001 已改期并取消）仍可读取，记录不丢失
  const opsView = ok(df, ['list-batch-ops'], '快照与现状不同仍可读取');
  assert.match(opsView.stdout, /O0001 \[未撤销\]/);
  let store = readStore(df);
  assert.equal(store.batchOps.length, 1, '记录不丢失');
  assert.deepEqual(store.batchOps[0].items[0].before, {
    start: '2026-10-12T10:00',
    end: '2026-10-12T11:00',
    resourceIds: ['R0001'],
  });

  // 撤销状态正常流转并持久化
  ok(df, ['undo-batch-op', 'O0001'], '旧文件撤销');
  store = readStore(df);
  assertArrangement(store, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '恢复原安排');
  assert.equal(bookingOf(store, 'B0001').status, 'cancelled', '取消状态不受撤销影响');
  assert.equal(store.batchOps[0].status, 'undone', '撤销状态不丢失');
  const opsView2 = ok(df, ['list-batch-ops'], '新进程确认撤销状态');
  assert.match(opsView2.stdout, /O0001 \[已撤销\]/);
});

// ---------------------------------------------------------------------------
// 8a. 负例：非法记录引用——查询和修改均退出 1 并保留文件
// ---------------------------------------------------------------------------

test('非法记录引用：查询与修改均退出 1 且文件逐字节保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '建立记录 O0001');

  const store = readStore(df);
  store.batchOps[0].items[0].bookingId = 'B9999'; // 引用不存在的预约
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  const corrupted = readFileSync(df);

  bizFail(df, ['list-batch-ops'], '非法引用-查询记录');
  bizFail(df, ['list-bookings', '--date', '2026-10-12'], '非法引用-按日查询');
  bizFail(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '非法引用-修改');
  bizFail(df, ['undo-batch-op', 'O0001'], '非法引用-撤销');
  assertFileBytes(df, corrupted, '非法引用保留文件');
});

// ---------------------------------------------------------------------------
// 8b. 负例：非法时间快照——查询和修改均退出 1 并保留文件
// ---------------------------------------------------------------------------

test('非法时间快照：查询与修改均退出 1 且文件逐字节保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'op.json', [
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);
  ok(df, ['reschedule-batch', manifest], '建立记录 O0001');

  const store = readStore(df);
  store.batchOps[0].items[0].before.start = '2026-10-32T09:00'; // 非法时间快照
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  const corrupted = readFileSync(df);

  bizFail(df, ['list-batch-ops'], '非法快照-查询记录');
  bizFail(df, ['list-bookings', '--date', '2026-10-12'], '非法快照-按日查询');
  bizFail(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '非法快照-修改');
  bizFail(df, ['undo-batch-op', 'O0001'], '非法快照-撤销');
  assertFileBytes(df, corrupted, '非法快照保留文件');
});
