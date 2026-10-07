// shiftbook 弹性批量改期（reschedule-flex）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings、
//   list-batch-ops、list-series、list-waitlist、import-ical 重放等）；
// - 覆盖：非最早原开始保留（无变化不写文件/不建记录/不推进计数）、跨日窗口、
//   最少变化数量及同数量下的取舍（先开始分钟、再按组序资源标识字典序）、
//   旧占用交换、混合身份（普通/系列成员/导入/候补兑现，身份与关联保留）、
//   无变化重提、撤销受阻（恢复冲突与现状不一致）与撤销后重提分配新操作标识、
//   真实保存失败与重试（计数未消费）、整体无解、用法与非法清单退出码、
//   旧格式数据文件；
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-reschedule-flex-test-'));
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

function addBooking(df: string, resource: string, start: string, end: string, ctx: string): void {
  ok(df, ['create-booking', '--resource', resource, '--start', start, '--end', end], ctx);
}

function writeManifest(dir: string, name: string, items: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}) + '\n', 'utf8');
  return p;
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败/无变化/查询不得改动数据文件（逐字节比对）`);
}

// 断言落盘的预约记录：时间、资源集合（按标识排序）、状态与系列归属
function assertBooking(
  df: string,
  id: string,
  start: string,
  end: string,
  resourceIds: string[],
  ctx: string,
  seriesId?: string,
): void {
  const store = readStore(df);
  const b = (store.bookings as any[]).find((x) => x.id === id);
  assert.ok(b, `[${ctx}] 应存在预约 ${id}`);
  assert.equal(b.start, start, `[${ctx}] ${id} 开始时间`);
  assert.equal(b.end, end, `[${ctx}] ${id} 结束时间`);
  assert.deepEqual(b.resourceIds, [...resourceIds].sort(), `[${ctx}] ${id} 资源集合`);
  assert.equal(b.status, 'active', `[${ctx}] ${id} 状态`);
  assert.equal(b.seriesId, seriesId, `[${ctx}] ${id} 系列归属`);
}

interface ExpectedItem {
  id: string;
  start: string;
  end: string;
  picks: string[];
  changed: boolean;
}

// 断言弹性批量改期输出：操作标识、改动数、按清单顺序的各项标识、起止时间与按组资源
function assertPlan(
  r: CliResult,
  opId: string,
  changedCount: number,
  expected: ExpectedItem[],
  ctx: string,
): void {
  assert.match(
    r.stdout,
    new RegExp(`弹性批量改期成功：操作标识 ${opId}，共 ${expected.length} 项（最少改动 ${changedCount} 项`),
    `[${ctx}] 成功提示与操作标识\nstdout:\n${r.stdout}`,
  );
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`第 ${i + 1} 项 ${e.id}（${e.changed ? '已改期' : '保持不变'}）:`),
      `[${ctx}] 第 ${i + 1} 项标识与变化标记\nstdout:\n${r.stdout}`,
    );
    assert.match(
      r.stdout,
      new RegExp(`时间: ${e.start} → ${e.end}`),
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

// ---------------------------------------------------------------------------
// 1. 非最早原开始保留：全部保持现状即可行时，不为了追求更早开始而改动；
//    无变化成功不写文件、不建记录、不推进计数；跨日窗口与跨日预约
// ---------------------------------------------------------------------------

test('非最早原开始保留：无变化成功，不写文件、不建记录、不推进计数（含跨日）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0001（10 点开始，非窗口最早）');
  addBooking(df, 'R0001', '2026-10-12T23:00', '2026-10-13T01:00', 'B0002（跨日 120 分钟）');

  // 两项窗口都远早于当前开始：若按“最早开始”求解会改动，但最少变化优先，应保持现状
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T12:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T20:00/2026-10-13T06:00', groups: [['R0001']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = ok(df, ['reschedule-flex', m], '无变化提交');
  assert.match(r.stdout, /弹性批量改期成功：共 2 项，全部保持当前安排即可行（最少改动 0 项），无业务变化/, '无变化提示');
  assert.ok(!r.stdout.includes('操作标识 O'), '无变化不显示操作标识');
  assert.match(r.stdout, /第 1 项 B0001（保持不变）:[\s\S]*?时间: 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0001 保持非最早开始');
  assert.match(r.stdout, /第 2 项 B0002（保持不变）:[\s\S]*?时间: 2026-10-12T23:00 → 2026-10-13T01:00/, 'B0002 保持跨日安排');
  assertFileBytes(df, bytesBefore, '无变化提交');
  const store = readStore(df);
  assert.equal(store.batchSeq, 0, '操作计数不推进');
  assert.equal(store.batchOps.length, 0, '不建操作记录');

  // 新进程查询：操作记录仍为空
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /暂无批量改期操作记录/, '无记录明确提示');
});

// ---------------------------------------------------------------------------
// 2. 最少变化数量，及同数量下的取舍（先开始分钟、再按组序资源标识字典序）
// ---------------------------------------------------------------------------

test('最少变化优先于更早开始；同数量先比开始分钟、再比资源标识（候选顺序无关）', (t) => {
  const dir = tempDir(t);

  // (a) 第 1 项必须改动时，保持第 2 项不变（1 项变化）胜过两项都动的更早方案
  const df1 = join(dir, 'a.json');
  addResource(df1, '唯一厅'); // R0001
  addBooking(df1, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df1, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');
  const m1 = writeManifest(dir, 'plan-a.json', [
    // B0001 当前开始在窗口之外，必须改动；B0002 可保持 10:00
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T11:00', groups: [['R0001']]},
  ]);
  const r1 = ok(df1, ['reschedule-flex', m1], '最少变化');
  // 两项都动可到 09:00/10:00 或 10:00/11:00 等更早组合，但最少变化只有 1 项：B0001 让到 11:00
  assertPlan(
    r1,
    'O0001',
    1,
    [
      {id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001'], changed: true},
      {id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: false},
    ],
    '最少变化',
  );
  assertBooking(df1, 'B0001', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], '落盘');
  assertBooking(df1, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '落盘');

  // (b) 同数量（1 项必变资源）先比开始分钟：08:00 的 R0002 胜过 09:00 的 R0001
  const df2 = join(dir, 'b.json');
  addResource(df2, '晚开场', [['2026-10-12T09:00', '2026-10-12T20:00']]); // R0001
  addResource(df2, '早开场', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002
  addResource(df2, '原场'); // R0003
  addBooking(df2, 'R0003', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001 在原场');
  const m2 = writeManifest(dir, 'plan-b.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T10:00', groups: [['R0001', 'R0002']]},
  ]);
  const r2 = ok(df2, ['reschedule-flex', m2], '先比开始分钟');
  assertPlan(
    r2,
    'O0001',
    1,
    [{id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002'], changed: true}],
    '先比开始分钟',
  );

  // (c) 同开始再比资源标识字典序：候选倒序书写结果不变，取 R0001
  const df3 = join(dir, 'c.json');
  addResource(df3, '甲'); // R0001
  addResource(df3, '乙'); // R0002
  addResource(df3, '原场'); // R0003
  addBooking(df3, 'R0003', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001 在原场');
  const m3 = writeManifest(dir, 'plan-c.json', [
    {bookingId: 'B0001', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0002', 'R0001']]},
  ]);
  const r3 = ok(df3, ['reschedule-flex', m3], '同开始字典序');
  assertPlan(
    r3,
    'O0001',
    1,
    [{id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001'], changed: true}],
    '同开始字典序',
  );
  assertBooking(df3, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '落盘资源集合');
});

// ---------------------------------------------------------------------------
// 3. 旧占用交换：本批旧占用不计障碍，两项互换时段；新进程查询持久结果
// ---------------------------------------------------------------------------

test('旧占用交换：两项互换时段成功，记录可查询、可整笔撤销', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 各自窗口只容得下对方的当前时段：逐项改期必被旧占用阻挡，整单排除本批旧占用后可行
  const m = writeManifest(dir, 'swap.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0001']]},
  ]);
  const r = ok(df, ['reschedule-flex', m], '旧占用交换');
  assertPlan(
    r,
    'O0001',
    2,
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001'], changed: true},
    ],
    '旧占用交换',
  );

  // 新进程按日查询持久结果
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0001 已交换');
  assert.match(list.stdout, /B0002 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/, 'B0002 已交换');

  // 新进程查询操作记录：前后完整安排、按提交顺序
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /O0001 \[未撤销\]（2 项，按提交顺序）/, '记录状态与项数');
  assert.match(
    ops.stdout,
    /第 1 项 B0001[\s\S]*?改期前: 2026-10-12T09:00 → 2026-10-12T10:00[\s\S]*?改期后: 2026-10-12T10:00 → 2026-10-12T11:00/,
    '第 1 项前后安排',
  );
  assert.match(
    ops.stdout,
    /第 2 项 B0002[\s\S]*?改期前: 2026-10-12T10:00 → 2026-10-12T11:00[\s\S]*?改期后: 2026-10-12T09:00 → 2026-10-12T10:00/,
    '第 2 项前后安排',
  );

  // 整笔撤销：恢复互换前安排
  ok(df, ['undo-batch-op', 'O0001'], '撤销交换');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '撤销后');
  assertBooking(df, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '撤销后');
});

// ---------------------------------------------------------------------------
// 4. 混合身份：普通预约、系列成员、导入预约、候补兑现预约同批改期；
//    标识、状态、系列归属、导入身份与首次请求、候补原请求及兑现关联全部保留
// ---------------------------------------------------------------------------

test('混合身份同批改期：系列归属、导入身份与候补关联保留，不新建预约', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅'); // R0001

  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', '普通预约 B0001');
  // 系列 S0001：B0002（10-12 10:00）、B0003（10-19 10:00，不在本批）
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', '--count', '2'],
    '系列 S0001',
  );
  // 导入预约 B0004（11:00-12:00）
  const ics = join(dir, 'events.ics');
  writeFileSync(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:flex-mixed-001@example.com',
      'DTSTART:20261012T110000',
      'DTEND:20261012T120000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入 B0004');
  // 候补 W0001 兑现为 B0005（12:00-13:00）
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], '候补 W0001');
  ok(df, ['process-waitlist'], '兑现 W0001 -> B0005');

  // 四项各后移一小时（窗口恰容目标时段；本批旧占用不计障碍，端点相接可行）
  const m = writeManifest(dir, 'mixed.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T11:00/2026-10-12T12:00', groups: [['R0001']]},
    {bookingId: 'B0004', window: '2026-10-12T12:00/2026-10-12T13:00', groups: [['R0001']]},
    {bookingId: 'B0005', window: '2026-10-12T13:00/2026-10-12T14:00', groups: [['R0001']]},
  ]);
  const r = ok(df, ['reschedule-flex', m], '混合身份改期');
  assertPlan(
    r,
    'O0001',
    4,
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true},
      {id: 'B0002', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001'], changed: true},
      {id: 'B0004', start: '2026-10-12T12:00', end: '2026-10-12T13:00', picks: ['R0001'], changed: true},
      {id: 'B0005', start: '2026-10-12T13:00', end: '2026-10-12T14:00', picks: ['R0001'], changed: true},
    ],
    '混合身份改期',
  );

  let store = readStore(df);
  assert.equal(store.bookings.length, 5, '不新建预约');
  assert.equal(store.bookingSeq, 5, '预约计数不变');
  assert.equal(store.series.length, 1, '不新建系列');
  assert.equal(store.batchOps.length, 1, '仅一条操作记录');
  assert.equal(store.batchOps[0].items.length, 4, '记录含全部提交项');
  assert.equal(store.batchOps[0].items[1].seriesId, 'S0001', '记录保留提交时系列归属');

  // 系列归属保留：B0002 仍属 S0001，B0003 不受影响
  assertBooking(df, 'B0002', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], '系列成员归属', 'S0001');
  assertBooking(df, 'B0003', '2026-10-19T10:00', '2026-10-19T11:00', ['R0001'], '未提交成员不变', 'S0001');
  const series = ok(df, ['list-series'], '新进程查询系列');
  assert.match(series.stdout, /B0002[\s\S]*?2026-10-12T11:00 → 2026-10-12T12:00/, '系列查询反映成员新安排');

  // 导入身份与首次请求保留：重放同一文件识别为重放，显示当前安排，不做改动
  const replayBytes = readFileSync(df);
  const replay = ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入重放');
  assert.match(replay.stdout, /重放/, '识别为重放');
  assert.match(replay.stdout, /B0004[\s\S]*?2026-10-12T12:00 → 2026-10-12T13:00/, '重放显示当前安排');
  assertFileBytes(df, replayBytes, '全部为重放不写文件');
  store = readStore(df);
  assert.equal(store.imports.length, 1, '导入身份不变');
  assert.equal(store.imports[0].start, '2026-10-12T11:00', '首次请求快照保留');

  // 候补原请求及兑现关联保留：仍已兑现并关联 B0005，不恢复等待
  const waitlist = ok(df, ['list-waitlist'], '新进程查询候补');
  assert.match(waitlist.stdout, /W0001[\s\S]*?已兑现[\s\S]*?B0005/, '候补兑现关联保留');
  store = readStore(df);
  assert.equal(store.waitlist[0].status, 'fulfilled', '候补状态不变');
  assert.equal(store.waitlist[0].bookingId, 'B0005', '兑现关联不变');
  assert.equal(store.waitlist[0].start, '2026-10-12T12:00', '候补原请求保留');

  // 整笔撤销后全部身份仍在，导入重放仍识别
  ok(df, ['undo-batch-op', 'O0001'], '撤销混合改期');
  assertBooking(df, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '撤销后系列成员', 'S0001');
  const replay2 = ok(df, ['import-ical', ics, '--resource', 'R0001'], '撤销后导入重放');
  assert.match(replay2.stdout, /重放/, '撤销后仍识别重放');
});

// ---------------------------------------------------------------------------
// 5. 无变化重提：按当前状态求解，与现状一致时成功但不写文件、不建记录、不推进计数
// ---------------------------------------------------------------------------

test('无变化重提：第二次提交相同清单成功但不写文件、不建新记录、不推进计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
  ]);
  const r1 = ok(df, ['reschedule-flex', m], '首次提交');
  assertPlan(
    r1,
    'O0001',
    1,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true}],
    '首次提交',
  );

  // 相同清单再次提交：按当前状态求解，保持现状即可行
  const bytesBefore = readFileSync(df);
  const r2 = ok(df, ['reschedule-flex', m], '无变化重提');
  assert.match(r2.stdout, /全部保持当前安排即可行（最少改动 0 项），无业务变化/, '无变化提示');
  assert.ok(!r2.stdout.includes('操作标识 O'), '不分配新操作标识');
  assertFileBytes(df, bytesBefore, '无变化重提');
  const store = readStore(df);
  assert.equal(store.batchSeq, 1, '操作计数不推进');
  assert.equal(store.batchOps.length, 1, '不建新记录');
});

// ---------------------------------------------------------------------------
// 6. 撤销受阻：恢复目标被占或与记录不一致均整笔拒绝；排除阻碍后可撤销；
//    重复撤销不碰现状；撤销后重提产生变化分配新操作标识
// ---------------------------------------------------------------------------

test('撤销受阻与恢复：冲突/不一致整笔拒绝，排除后可撤销，重提分配新操作标识', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
  ]);
  ok(df, ['reschedule-flex', m], '改期 B0001 -> O0001');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '改期后');

  // 恢复目标时段被新预约占用：撤销整笔拒绝，现状不变
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0002 占住恢复目标');
  const bytesBefore = readFileSync(df);
  const r1 = bizFail(df, ['undo-batch-op', 'O0001'], '恢复受阻');
  assert.match(r1.stderr, /撤销 O0001 失败/, '恢复受阻提示');
  assert.match(r1.stderr, /B0002/, '列出阻挡预约');
  assertFileBytes(df, bytesBefore, '撤销受阻后');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '受阻后现状不变');
  assert.equal(readStore(df).batchOps[0].status, 'active', '记录仍未撤销');

  // 现状与记录改期后安排不一致：同样整笔拒绝
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '单项再改期');
  const r2 = bizFail(df, ['undo-batch-op', 'O0001'], '现状不一致');
  assert.match(r2.stderr, /撤销 O0001 被拒绝/, '不一致拒绝提示');
  assert.match(r2.stderr, /B0001/, '列出不一致预约');

  // 改回与记录一致、排除阻挡后：撤销成功
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '改回记录安排');
  ok(df, ['cancel-booking', 'B0002'], '取消阻挡预约');
  ok(df, ['undo-batch-op', 'O0001'], '排除阻碍后撤销');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '撤销恢复');

  // 重复撤销：成功且不触碰现状（即使之后又有改期）
  addBooking(df, 'R0001', '2026-10-12T11:00', '2026-10-12T12:00', 'B0003');
  const r3 = ok(df, ['undo-batch-op', 'O0001'], '重复撤销');
  assert.match(r3.stdout, /已是撤销状态，未做任何改动/, '重复撤销无操作');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '重复撤销不碰现状');

  // 撤销后重提相同清单：按当前状态求解，产生变化并分配新操作标识 O0002
  const r4 = ok(df, ['reschedule-flex', m], '撤销后重提');
  assertPlan(
    r4,
    'O0002',
    1,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true}],
    '撤销后重提新标识',
  );
  const store = readStore(df);
  assert.equal(store.batchSeq, 2, '操作计数推进到新标识');
  assert.equal(store.batchOps.length, 2, '旧记录保留');
  assert.equal(store.batchOps[0].status, 'undone', '旧记录保持已撤销');
  assert.equal(store.batchOps[1].status, 'active', '新记录未撤销');
});

// ---------------------------------------------------------------------------
// 7. 真实保存失败与重试：退出 1、原文件逐字节保留、计数未消费；换可写位置重试成功
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且原数据逐字节保留，同一原数据重试成功且操作计数未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
  ]);

  // 同一原数据放到保存必然失败的位置（文件名 255 字节，临时文件名超限）
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['reschedule-flex', m], '保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assert.ok(!r.stdout.includes('弹性批量改期成功'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  let store = readStore(longFile);
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assert.equal(store.batchSeq, 0, '操作计数未消费');
  assertBooking(longFile, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '安排不变');

  // 在可保存的位置用同一原数据重试：成功且操作标识从 O0001 开始
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = ok(retryFile, ['reschedule-flex', m], '可保存位置重试');
  assertPlan(
    r2,
    'O0001',
    1,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true}],
    '重试标识未消费',
  );
  store = readStore(retryFile);
  assert.equal(store.batchSeq, 1, '重试推进一次计数');
  assertBooking(retryFile, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '重试生效');
});

// ---------------------------------------------------------------------------
// 8. 整体无解：明确提示、退出 1、不改动任何预约或计数
// ---------------------------------------------------------------------------

test('整体无解：退出 1 且明确提示，不改动预约、记录或计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 两项窗口都只容得下同一时段同一资源：各自可行、整体不可行
  const m = writeManifest(dir, 'bad.json', [
    {bookingId: 'B0001', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0001']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(df, ['reschedule-flex', m], '整体无解');
  assert.match(r.stderr, /无整体解/, '明确提示无整体解');
  assert.ok(!r.stdout.includes('弹性批量改期成功'), '不报告成功');
  assertFileBytes(df, bytesBefore, '无解后');
  const store = readStore(df);
  assert.equal(store.batchOps.length, 0, '不留记录');
  assert.equal(store.batchSeq, 0, '计数不变');
});

// ---------------------------------------------------------------------------
// 9. 用法错误（退出 2）与非法清单（退出 1），均不改动数据文件
// ---------------------------------------------------------------------------

test('用法错误退出 2，非法清单退出 1，均不产生记录或计数变化', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号厅'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], 'B0002');
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  const bytesBefore = readFileSync(df);

  // 用法错误（退出 2）
  usageFail(df, ['reschedule-flex'], '缺少清单文件');
  usageFail(df, ['reschedule-flex', 'a.json', 'b.json'], '多余位置参数');
  usageFail(df, ['reschedule-flex', '--window', 'x'], '未知选项');

  // 清单不可读 / 损坏（退出 1）
  let r = bizFail(df, ['reschedule-flex', join(dir, 'missing.json')], '清单不存在');
  assert.match(r.stderr, /无法读取改期清单/);
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json', 'utf8');
  r = bizFail(df, ['reschedule-flex', badJson], '清单损坏');
  assert.match(r.stderr, /已损坏，不是合法 JSON/);

  // 结构非法（退出 1）
  const writeRaw = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };
  r = bizFail(df, ['reschedule-flex', writeRaw('n1.json', '[]')], '顶层非对象');
  assert.match(r.stderr, /顶层必须是对象/);
  r = bizFail(df, ['reschedule-flex', writeRaw('n2.json', '{"items": [], "x": 1}')], '未知顶层字段');
  assert.match(r.stderr, /未知字段 “x”/);
  r = bizFail(df, ['reschedule-flex', writeRaw('n3.json', '{"items": []}')], '空清单');
  assert.match(r.stderr, /至少包含一项/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n4.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0001"]], "note": 1}]}')],
    '未知项字段',
  );
  assert.match(r.stderr, /未知字段 “note”/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n5.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00", "groups": [["R0001"]]}]}')],
    '窗口缺结束',
  );
  assert.match(r.stderr, /窗口格式非法/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n6.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T09:00", "groups": [["R0001"]]}]}')],
    '窗口结束早于开始',
  );
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n7.json', '{"items": [{"bookingId": "B0001", "window": "2026-02-30T09:00/2026-10-12T10:00", "groups": [["R0001"]]}]}')],
    '窗口日期不真实',
  );
  assert.match(r.stderr, /不是真实有效的时间/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n8.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T09:30", "groups": [["R0001"]]}]}')],
    '窗口长度小于当前时长',
  );
  assert.match(r.stderr, /窗口长度 30 分钟小于预约当前时长 60 分钟/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n9.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": []}]}')],
    '候选资源组为空',
  );
  assert.match(r.stderr, /至少一个有顺序的候选资源组/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n10.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [[]]}]}')],
    '空候选组',
  );
  assert.match(r.stderr, /必须是非空数组/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n11.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0001", "R0001"]]}]}')],
    '组内重复',
  );
  assert.match(r.stderr, /候选资源重复: R0001/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n12.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0009"]]}]}')],
    '未知资源',
  );
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n13.json', '{"items": [{"bookingId": "B0099", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0001"]]}]}')],
    '未知预约',
  );
  assert.match(r.stderr, /未知预约标识: B0099/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n14.json', '{"items": [{"bookingId": "B0002", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0001"]]}]}')],
    '已取消预约',
  );
  assert.match(r.stderr, /预约 B0002 已取消，不能改期/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n15.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T09:00/2026-10-12T10:00", "groups": [["R0001"]]}, {"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T11:00", "groups": [["R0001"]]}]}')],
    '重复预约',
  );
  assert.match(r.stderr, /预约标识重复/);

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.batchOps.length, 0, '失败请求不产生记录');
  assert.equal(store.batchSeq, 0, '失败请求不消耗计数');
});

// ---------------------------------------------------------------------------
// 10. 旧格式数据文件可直接弹性批量改期；损坏文件退出 1 并保留原样
// ---------------------------------------------------------------------------

test('旧格式文件可直接弹性批量改期；损坏数据文件退出 1 并保留原样', (t) => {
  const dir = tempDir(t);
  const manifest = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
  ]);

  // 旧格式文件（无 series/waitlist/closures/batchOps/imports 字段）：直接可改期
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resourceSeq: 1,
      bookingSeq: 1,
      resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
      bookings: [{id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T09:00', end: '2026-10-12T10:00', status: 'active'}],
    }) + '\n',
    'utf8',
  );
  const r1 = ok(old, ['reschedule-flex', manifest], '旧文件改期');
  assertPlan(
    r1,
    'O0001',
    1,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001'], changed: true}],
    '旧文件改期',
  );
  assertBooking(old, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '旧文件落盘');

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad-data.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r2 = bizFail(bad, ['reschedule-flex', manifest], '损坏数据文件');
  assert.match(r2.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件失败后');
});
