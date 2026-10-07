// shiftbook 弹性批量改期（reschedule-flex）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings、
//   list-batch-ops、list-series、list-waitlist、import-ical 重放等）；
// - 覆盖：非最早原开始保留（无变化不写文件、不建记录、不推进计数）、最少变化
//   数量及同数量下的取舍（先比开始分钟、再按组序比资源标识，候选书写顺序不影响）、
//   旧占用交换、混合身份（系列成员 / 导入预约 / 候补兑现预约，身份与关联保留）、
//   无变化重提、撤销受阻与撤销后重提分配新操作标识、真实保存失败与重试
//   （计数未消费）、整体无解与非法清单/用法错误退出码；
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

function rescheduleFlex(df: string, manifest: string, ctx: string): CliResult {
  return ok(df, ['reschedule-flex', manifest], ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败/无变化/查询不得改动数据文件（逐字节比对）`);
}

interface ExpectedItem {
  id: string;
  start: string;
  end: string;
  picks: string[];
}

// 断言弹性批量改期输出：按清单顺序的各项预约标识、起止时间与按组对应的资源
function assertPlan(r: CliResult, opId: string, expected: ExpectedItem[], ctx: string): void {
  assert.match(
    r.stdout,
    new RegExp(`弹性批量改期成功：操作标识 ${opId}，共 ${expected.length} 项`),
    `[${ctx}] 成功提示与操作标识\nstdout:\n${r.stdout}`,
  );
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`- 第 ${i + 1} 项 ${e.id}[（:].*\\n?.*${e.start} → ${e.end}`),
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

// 断言落盘的预约记录：时间、资源集合（按标识排序）、有效状态
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

// ---------------------------------------------------------------------------
// 1. 非最早原开始保留：最少变化优先，现状可行即不动（无变化不写文件/不建记录）
// ---------------------------------------------------------------------------

test('非最早原开始保留：现状可行即零变化成功，不写文件、不建记录、不推进计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  // 当前 10:00-11:00，远非窗口内最早可行开始（08:00）
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = rescheduleFlex(df, m, '非最早原开始保留');
  assert.match(r.stdout, /安排均与现状一致，无业务变化/, '零变化提示');
  assert.ok(!r.stdout.includes('操作标识'), '无变化不显示操作标识');
  assert.match(r.stdout, /- 第 1 项 B0001: 2026-10-12T10:00 → 2026-10-12T11:00（60 分钟）/, '保留原开始');
  assertFileBytes(df, bytesBefore, '无变化提交后');

  // 新进程查询：无操作记录、计数未推进、安排不变
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /暂无批量改期操作记录/, '无变化不建记录');
  const store = readStore(df);
  assert.equal(store.batchSeq, 0, '操作计数未推进');
  assert.equal(store.bookings.length, 1, '不新建预约');
  assert.equal(store.bookingSeq, 1, '预约计数未推进');

  // 无变化重提：再次提交同一清单仍成功且无变化
  const r2 = rescheduleFlex(df, m, '无变化重提');
  assert.match(r2.stdout, /安排均与现状一致，无业务变化/);
  assertFileBytes(df, bytesBefore, '无变化重提后');
});

// ---------------------------------------------------------------------------
// 2. 最少变化数量：能不动就不动；必须动的项数取最小
// ---------------------------------------------------------------------------

test('最少变化：只动必须动的预约，未涉及的旧占用保持原位', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 第 2 项窗口恰为 09:00-10:00（B0001 的旧占用），第 1 项窗口宽：
  // B0002 必须让位到 09:00-10:00，B0001 必须让出原位；最少变化为 2，
  // B0001 取字典序最小的 10:00-11:00（而非 11:00-12:00）
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T09:00/2026-10-12T12:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0001']]},
  ]);
  const r = rescheduleFlex(df, m, '最少变化');
  assert.match(r.stdout, /变化 2 项/, '两项均须变化');
  assertPlan(
    r,
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '最少变化',
  );
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '落盘');

  // 新进程按日查询反映新安排
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(list.stdout, /B0002 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/, 'B0002 新时段');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0001 新时段');
});

// ---------------------------------------------------------------------------
// 3. 同数量取舍：先比开始分钟，再按组序比资源标识字典序；候选书写顺序不影响
// ---------------------------------------------------------------------------

test('同数量取舍：更早开始优先于更小标识；同开始取字典序最小资源序列', (t) => {
  const dir = tempDir(t);

  // (a) 必须移动：R0001 在 11:00-12:00 被占用，R0002 全程空闲；
  //     11:00 的 R0002 胜过 12:00 的 R0001（先比开始分钟）
  const df1 = join(dir, 'a.json');
  addResource(df1, '甲'); // R0001
  addResource(df1, '乙'); // R0002
  addBooking(df1, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0001（待改期）');
  addBooking(df1, 'R0001', '2026-10-12T11:00', '2026-10-12T12:00', 'B0002（外部占用）');
  const m1 = writeManifest(dir, 'plan-a.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T13:00', groups: [['R0001', 'R0002']]},
  ]);
  const r1 = rescheduleFlex(df1, m1, '先比开始分钟');
  assertPlan(r1, 'O0001', [{id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0002']}], '先比开始分钟');

  // (b) 同一最早开始有两个候选：取标识字典序最小者；候选倒序书写结果不变
  const df2 = join(dir, 'b.json');
  addResource(df2, '甲'); // R0001
  addResource(df2, '乙'); // R0002
  addBooking(df2, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0001（待改期）');
  const m2 = writeManifest(dir, 'plan-b.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T13:00', groups: [['R0002', 'R0001']]},
  ]);
  const r2 = rescheduleFlex(df2, m2, '同开始字典序（候选倒序书写）');
  assertPlan(r2, 'O0001', [{id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']}], '同开始字典序');

  // (c) 按清单顺序逐项比较：第 1 项取最小开始后，第 2 项才取其次小开始
  const df3 = join(dir, 'c.json');
  addResource(df3, '唯一会议室'); // R0001
  addBooking(df3, 'R0001', '2026-10-12T08:00', '2026-10-12T09:00', 'B0001');
  addBooking(df3, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0002');
  const m3 = writeManifest(dir, 'plan-c.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T14:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T10:00/2026-10-12T14:00', groups: [['R0001']]},
  ]);
  const r3 = rescheduleFlex(df3, m3, '逐项比较');
  assertPlan(
    r3,
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']},
    ],
    '逐项比较',
  );
});

// ---------------------------------------------------------------------------
// 4. 旧占用交换：排除本批旧占用，两项互换时段整单成功；撤销恢复原安排
// ---------------------------------------------------------------------------

test('旧占用交换：两项互换时段成功并记录 O0001，撤销后恢复原安排', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');

  // 各自窗口恰为对方的当前时段：只有排除本批旧占用才能整单成功
  const m = writeManifest(dir, 'swap.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T11:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T10:00', groups: [['R0001']]},
  ]);
  const r = rescheduleFlex(df, m, '旧占用交换');
  assertPlan(
    r,
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '旧占用交换',
  );

  // 新进程查询操作记录：全部提交项的前后完整安排
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（2 项，按提交顺序）/, '记录未撤销');
  assert.match(ops.stdout, /改期前: 2026-10-12T09:00 → 2026-10-12T10:00/, 'B0001 改期前');
  assert.match(ops.stdout, /改期后: 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0001 改期后');

  // 整笔撤销：恢复原安排
  ok(df, ['undo-batch-op', 'O0001'], '撤销交换');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '撤销后');
  assertBooking(df, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '撤销后');
  const ops2 = ok(df, ['list-batch-ops'], '撤销后查询记录');
  assert.match(ops2.stdout, /- O0001 \[已撤销\]/, '记录已撤销');

  // 重复撤销：成功且不触碰当前安排
  const again = ok(df, ['undo-batch-op', 'O0001'], '重复撤销');
  assert.match(again.stdout, /已是撤销状态，未做任何改动/, '重复撤销无变化');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '重复撤销后');

  // 撤销后重提同一清单：再次产生变化，分配新的操作标识（不复用 O0001）
  const r2 = rescheduleFlex(df, m, '撤销后重提');
  assertPlan(
    r2,
    'O0002',
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '撤销后重提分配新标识',
  );
  const store = readStore(df);
  assert.equal(store.batchSeq, 2, '操作计数只增不减');
  assert.deepEqual(
    (store.batchOps as any[]).map((o) => [o.id, o.status]),
    [
      ['O0001', 'undone'],
      ['O0002', 'active'],
    ],
    '旧记录保留，新记录追加',
  );
});

// ---------------------------------------------------------------------------
// 5. 混合身份：系列成员、导入预约、候补兑现预约同批改期，身份与关联全部保留
// ---------------------------------------------------------------------------

test('混合身份：系列成员/导入预约/候补兑现预约同批改期，归属与关联保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 系列成员：S0001 = B0001（10-12）、B0002（10-19）
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00', '--count', '2'],
    '创建系列 S0001',
  );
  // 导入预约：B0003
  const ics = join(dir, 'events.ics');
  writeFileSync(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:mix-001@example.com',
      'DTSTART:20261012T140000',
      'DTEND:20261012T150000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入独立事件 B0003');
  // 候补兑现预约：W0001 -> B0004
  ok(df, ['add-waitlist', '--resource', 'R0002', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '登记候补 W0001');
  ok(df, ['process-waitlist'], '处理候补兑现 B0004');

  // 同批改期三种身份：系列成员 B0001、导入预约 B0003、兑现预约 B0004
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T13:00', groups: [['R0001']]},
    {bookingId: 'B0003', window: '2026-10-12T15:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0004', window: '2026-10-12T17:00/2026-10-12T19:00', groups: [['R0002']]},
  ]);
  const r = rescheduleFlex(df, m, '混合身份改期');
  assert.match(r.stdout, /- 第 1 项 B0001（系列 S0001，归属不变）: 2026-10-12T11:00 → 2026-10-12T12:00/, '系列成员改期');
  assertPlan(
    r,
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']},
      {id: 'B0003', start: '2026-10-12T15:00', end: '2026-10-12T16:00', picks: ['R0001']},
      {id: 'B0004', start: '2026-10-12T17:00', end: '2026-10-12T18:00', picks: ['R0002']},
    ],
    '混合身份改期',
  );

  // 身份与关联保留
  const store = readStore(df);
  assert.equal(store.bookings.find((b: any) => b.id === 'B0001').seriesId, 'S0001', '系列归属保留');
  assert.equal(store.series.length, 1, '不新建系列');
  assert.equal(store.imports.length, 1, '导入身份保留');
  assert.equal(store.imports[0].uid, 'mix-001@example.com', '导入 UID 关联保留');
  assert.equal(store.imports[0].bookingId, 'B0003', '导入关联预约不变');
  assert.equal(store.imports[0].start, '2026-10-12T14:00', '导入首次请求快照不变');
  assert.equal(store.waitlist.length, 1, '不新建候补');
  assert.equal(store.waitlist[0].status, 'fulfilled', '候补兑现状态保留');
  assert.equal(store.waitlist[0].bookingId, 'B0004', '候补兑现关联保留');
  assert.equal(store.waitlist[0].start, '2026-10-12T16:00', '候补原请求保留');

  // 新进程查询系列：成员显示新时间且仍属原系列
  const series = ok(df, ['list-series'], '新进程查询系列');
  assert.match(series.stdout, /B0001[\s\S]*2026-10-12T11:00 → 2026-10-12T12:00/, '系列成员新时间');

  // 新进程重放导入：返回 B0003 当前安排，不做任何改动
  const bytesBefore = readFileSync(df);
  const replay = ok(df, ['import-ical', ics, '--resource', 'R0001'], '重放导入');
  assert.match(replay.stdout, /全部为重放/, '重放提示');
  assert.match(replay.stdout, /当前安排: 2026-10-12T15:00 → 2026-10-12T16:00/, '重放显示当前安排');
  assertFileBytes(df, bytesBefore, '重放后');

  // 新进程查询候补：仍为已兑现且关联 B0004
  const waitlist = ok(df, ['list-waitlist'], '新进程查询候补');
  assert.match(waitlist.stdout, /W0001[\s\S]*已兑现[\s\S]*B0004/, '候补关联保留');

  // 操作记录含系列归属
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /第 1 项 B0001（系列 S0001）/, '记录含系列归属');
});

// ---------------------------------------------------------------------------
// 6. 撤销受阻：恢复被新占用阻挡或与记录不一致时整笔拒绝，现状不变
// ---------------------------------------------------------------------------

test('撤销受阻：恢复目标被新预约占用时整笔拒绝；涉及预约已取消同样拒绝', (t) => {
  const dir = tempDir(t);

  // (a) 恢复受阻：O0001 把 B0001 从 09:00 移到 14:00 后，原时段被 B0002 占用
  const df = join(dir, 'a.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T14:00/2026-10-12T16:00', groups: [['R0001']]},
  ]);
  rescheduleFlex(df, m, '产生 O0001');
  assertBooking(df, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '改期后');
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0002 占用原时段');

  const bytesBefore = readFileSync(df);
  const blocked = bizFail(df, ['undo-batch-op', 'O0001'], '撤销受阻');
  assert.match(blocked.stderr, /撤销 O0001 失败/, '受阻提示');
  assert.match(blocked.stderr, /B0002/, '列出冲突预约');
  assertFileBytes(df, bytesBefore, '撤销受阻后');
  assertBooking(df, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '受阻后安排不变');
  let store = readStore(df);
  assert.equal(store.batchOps[0].status, 'active', '记录仍未撤销');

  // 阻挡解除后撤销成功
  ok(df, ['cancel-booking', 'B0002'], '取消阻挡预约');
  ok(df, ['undo-batch-op', 'O0001'], '阻挡解除后撤销');
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '撤销恢复');

  // (b) 涉及预约已取消：撤销不能复活已取消预约
  const df2 = join(dir, 'b.json');
  addResource(df2, '唯一会议室'); // R0001
  addBooking(df2, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  rescheduleFlex(df2, m, '产生 O0001');
  ok(df2, ['cancel-booking', 'B0001'], '取消涉及预约');
  const bytes2 = readFileSync(df2);
  const rejected = bizFail(df2, ['undo-batch-op', 'O0001'], '涉及预约已取消');
  assert.match(rejected.stderr, /撤销 O0001 被拒绝/, '拒绝提示');
  assert.match(rejected.stderr, /已取消，撤销不能复活已取消预约/, '说明原因');
  assertFileBytes(df2, bytes2, '拒绝撤销后');
  store = readStore(df2);
  assert.equal(store.batchOps[0].status, 'active', '记录仍未撤销');
  assert.equal(store.bookings[0].status, 'cancelled', '取消状态不变');
});

// ---------------------------------------------------------------------------
// 7. 真实保存失败与重试：退出 1、原文件逐字节保留、计数未消费；重试成功
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且原数据逐字节保留，同一原数据重试成功且操作标识未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const manifest = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T14:00/2026-10-12T16:00', groups: [['R0001']]},
  ]);

  // 同一原数据放到保存必然失败的位置（文件名 255 字节，临时文件名超限）
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['reschedule-flex', manifest], '保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assert.ok(!r.stdout.includes('弹性批量改期成功'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  const store = readStore(longFile);
  assert.equal(store.batchOps.length, 0, '不产生操作记录');
  assert.equal(store.batchSeq, 0, '操作计数未消费');
  assert.equal(store.bookings[0].start, '2026-10-12T09:00', '原安排不变');

  // 在可保存的位置用同一原数据重试：成功且操作标识未被失败尝试消费
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = rescheduleFlex(retryFile, manifest, '可保存位置重试');
  assertPlan(r2, 'O0001', [{id: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', picks: ['R0001']}], '重试标识未消费');
  assertBooking(retryFile, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '重试生效');

  // 新进程查询持久结果
  const list = ok(retryFile, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  assert.match(list.stdout, /B0001 \[已预约\] 2026-10-12T14:00 → 2026-10-12T15:00/, '持久安排可查');
  const ops = ok(retryFile, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（1 项，按提交顺序）/, '持久记录可查');
});

// ---------------------------------------------------------------------------
// 8. 整体无解：明确提示、退出 1、不改动任何预约、不推进计数
// ---------------------------------------------------------------------------

test('整体无解：退出 1 且明确提示，原有安排、记录与计数全部不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T09:00', '2026-10-12T10:00', 'B0001（待改期）');
  // 窗口被外部预约占满：10:00-12:00 无连续 60 分钟空闲
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0002（外部占用）');
  addBooking(df, 'R0001', '2026-10-12T11:00', '2026-10-12T12:00', 'B0003（外部占用）');

  const m = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(df, ['reschedule-flex', m], '整体无解');
  assert.match(r.stderr, /无整体解/, '明确提示无整体解');
  assert.ok(!r.stdout.includes('弹性批量改期成功'), '不报告成功');
  assertFileBytes(df, bytesBefore, '无解后');
  const store = readStore(df);
  assert.equal(store.batchOps.length, 0, '不产生操作记录');
  assert.equal(store.batchSeq, 0, '操作计数不变');
  assert.equal(store.bookings.length, 3, '不新建预约');
});

// ---------------------------------------------------------------------------
// 9. 用法错误（退出 2）与非法清单（退出 1），均不改动数据文件
// ---------------------------------------------------------------------------

test('用法错误退出 2，非法清单退出 1，均不产生记录或计数变化', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addBooking(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], 'B0002');
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
    ['reschedule-flex', writeRaw('n4.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]], "note": 1}]}')],
    '未知项字段',
  );
  assert.match(r.stderr, /未知字段 “note”/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n5.json', '{"items": [{"window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '缺 bookingId',
  );
  assert.match(r.stderr, /bookingId 必须是非空字符串/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n6.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00", "groups": [["R0001"]]}]}')],
    '窗口缺结束',
  );
  assert.match(r.stderr, /窗口格式非法/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n7.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T12:00/2026-10-12T10:00", "groups": [["R0001"]]}]}')],
    '窗口结束早于开始',
  );
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n8.json', '{"items": [{"bookingId": "B0001", "window": "2026-02-30T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '窗口日期不真实',
  );
  assert.match(r.stderr, /不是真实有效的时间/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n9.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T10:30", "groups": [["R0001"]]}]}')],
    '窗口短于当前时长',
  );
  assert.match(r.stderr, /窗口长度 30 分钟小于预约当前时长 60 分钟/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n10.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": []}]}')],
    '候选资源组为空',
  );
  assert.match(r.stderr, /至少一个有顺序的候选资源组/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n11.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [[]]}]}')],
    '空候选资源组',
  );
  assert.match(r.stderr, /必须是非空数组/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n12.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001", "R0001"]]}]}')],
    '组内重复',
  );
  assert.match(r.stderr, /候选资源重复: R0001/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n13.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0009"]]}]}')],
    '未知资源',
  );
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n14.json', '{"items": [{"bookingId": "B0009", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '未知预约',
  );
  assert.match(r.stderr, /未知预约标识: B0009/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n15.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}, {"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '重复预约',
  );
  assert.match(r.stderr, /预约标识重复/);
  r = bizFail(
    df,
    ['reschedule-flex', writeRaw('n16.json', '{"items": [{"bookingId": "B0002", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '已取消预约',
  );
  assert.match(r.stderr, /预约 B0002 已取消，不能改期/);

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.batchOps.length, 0, '失败请求不产生记录');
  assert.equal(store.batchSeq, 0, '失败请求不消耗操作计数');
});

// ---------------------------------------------------------------------------
// 10. 损坏数据文件退出 1 并保留原样；旧格式文件可直接弹性批量改期
// ---------------------------------------------------------------------------

test('损坏数据文件退出 1 并保留原样；旧格式文件可直接弹性批量改期', (t) => {
  const dir = tempDir(t);

  // 旧格式文件（只有 version 与 resources 及一条预约，无后续版本字段）
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
      bookings: [{id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T09:00', end: '2026-10-12T10:00', status: 'active'}],
      bookingSeq: 1,
      resourceSeq: 1,
    }) + '\n',
    'utf8',
  );
  const manifest = writeManifest(dir, 'plan.json', [
    {bookingId: 'B0001', window: '2026-10-12T14:00/2026-10-12T16:00', groups: [['R0001']]},
  ]);
  const r = rescheduleFlex(old, manifest, '旧文件弹性批量改期');
  assertPlan(r, 'O0001', [{id: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', picks: ['R0001']}], '旧文件改期');
  assertBooking(old, 'B0001', '2026-10-12T14:00', '2026-10-12T15:00', ['R0001'], '旧文件落盘');

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad-data.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r2 = bizFail(bad, ['reschedule-flex', manifest], '损坏数据文件');
  assert.match(r2.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件失败后');
});
