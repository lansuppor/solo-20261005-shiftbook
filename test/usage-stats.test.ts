// shiftbook 资源使用率与繁忙时段统计（usage-stats）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，统计结果由新进程查询；
// - 覆盖：跨日窗口与逐日拆分、重叠/相接开放区间合并与有效/已取消停用扣除、
//   多资源预约分别计时、状态变更（取消/改期/停用/候补兑现）后的重算、
//   同一资源重叠占用合并（一分钟只计一次）、零分母（可用为零显示不适用）、
//   峰值交接（端点相接不制造瞬时重叠、相接峰值段合并、无占用峰值为零）、
//   汇总口径（合计以总占用除总可用）、名册为空提示、用法/非法请求退出码、
//   损坏与旧格式文件；统计前后数据文件逐字节不变（只读快照，不写文件不推进计数）；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-usage-stats-test-'));
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

function usageStats(df: string, window: string, resources: string[], ctx: string): CliResult {
  const args = ['usage-stats', '--window', window];
  for (const id of resources) args.push('--resource', id);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 统计不得改动数据文件（逐字节比对）`);
}

// 断言输出包含某一确切行
function assertLine(r: CliResult, line: string, ctx: string): void {
  assert.ok(r.stdout.includes(line), `[${ctx}] 应包含行: ${line}\nstdout:\n${r.stdout}`);
}

// 峰值区间段（“繁忙峰值”之后以 “  - ” 开头的行）
function peakIntervalLines(r: CliResult): string[] {
  const idx = r.stdout.indexOf('繁忙峰值');
  assert.ok(idx >= 0, `输出应包含繁忙峰值段\nstdout:\n${r.stdout}`);
  return r.stdout
    .slice(idx)
    .split('\n')
    .filter((l) => l.startsWith('  - '));
}

// ---------------------------------------------------------------------------
// 1. 跨日窗口：重叠/相接开放合并、有效停用扣除（已取消停用不扣）、逐日拆分、
//    整窗汇总与合计口径、零可用日记为不适用；统计不改文件
// ---------------------------------------------------------------------------

test('跨日统计：开放合并、停用扣除、逐日拆分、整窗汇总与合计口径', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // R0001：08:00-12:00 与 12:00-次日02:00 相接合并，10:00-14:00 重叠冗余 -> 连续 08:00-26:00
  addResource(df, '一号会议室', [
    ['2026-10-12T08:00', '2026-10-12T12:00'],
    ['2026-10-12T12:00', '2026-10-13T02:00'],
    ['2026-10-12T10:00', '2026-10-12T14:00'],
  ]);
  addResource(df, '投影仪', [['2026-10-12T09:00', '2026-10-12T17:00']], 'equipment'); // R0002
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T11:00'], 'B0001');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T23:00', '--end', '2026-10-13T01:00'], 'B0002 跨日');
  ok(df, ['create-booking', '--resource', 'R0002', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], 'B0003');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T18:00', '--end', '2026-10-12T20:00'], '有效停用 C0001');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T21:00', '--end', '2026-10-12T22:00'], '将取消的停用 C0002');
  ok(df, ['cancel-closure', 'C0002'], '取消停用 C0002（不再扣除）');

  const bytesBefore = readFileSync(df);
  const r = usageStats(df, '2026-10-12T10:00/2026-10-13T12:00', [], '跨日统计');

  // 逐日明细：首日只计窗口内 10:00 起部分；次日只计到 12:00
  // R0001 首日：开放 [10:00,18:00)+[20:00,24:00) = 720；占用 [10:00,11:00)+[23:00,24:00) = 120
  assertLine(r, '  - R0001（一号会议室，场地）: 可用 720 分钟，占用 120 分钟，空闲 600 分钟，使用率 16.67%', 'R0001 首日');
  // R0002 首日：开放 [10:00,17:00) = 420；占用 [12:00,13:00) = 60
  assertLine(r, '  - R0002（投影仪，设备）: 可用 420 分钟，占用 60 分钟，空闲 360 分钟，使用率 14.29%', 'R0002 首日');
  // R0001 次日：开放 [00:00,02:00) = 120；占用 [00:00,01:00) = 60
  assertLine(r, '  - R0001（一号会议室，场地）: 可用 120 分钟，占用 60 分钟，空闲 60 分钟，使用率 50.00%', 'R0001 次日');
  // R0002 次日：零可用、零占用，使用率不适用
  assertLine(r, '  - R0002（投影仪，设备）: 可用 0 分钟，占用 0 分钟，空闲 0 分钟，使用率 不适用', 'R0002 次日零分母');

  // 整窗汇总：R0001 可用 840 占用 180；R0002 可用 420 占用 60
  assertLine(r, '  - R0001（一号会议室，场地）: 可用 840 分钟，占用 180 分钟，空闲 660 分钟，使用率 21.43%', 'R0001 整窗');
  assertLine(r, '  - R0002（投影仪，设备）: 可用 420 分钟，占用 60 分钟，空闲 360 分钟，使用率 14.29%', 'R0002 整窗');
  // 合计以总占用除总可用：240/1260 = 19.05%（不平均各项百分比）
  assertLine(r, '全部所选资源合计: 可用 1260 资源分钟，占用 240 资源分钟，空闲 1020 资源分钟，使用率 19.05%', '合计口径');

  // 峰值 1：三段互不相接的占用区间
  assertLine(r, '繁忙峰值: 同时被占用的所选资源数量峰值为 1，达到峰值的全部最大连续区间（按开始时间排序）:', '峰值标题');
  assert.deepEqual(
    peakIntervalLines(r),
    [
      '  - 2026-10-12T10:00 → 2026-10-12T11:00（60 分钟）',
      '  - 2026-10-12T12:00 → 2026-10-12T13:00（60 分钟）',
      '  - 2026-10-12T23:00 → 2026-10-13T01:00（120 分钟）',
    ],
    `峰值区间\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '跨日统计后');
});

// ---------------------------------------------------------------------------
// 2. 多资源预约分别计时；峰值端点交接不制造瞬时重叠、相接峰值段合并；
//    无占用时峰值为零且不列区间
// ---------------------------------------------------------------------------

test('峰值交接：端点相接不叠加、相接峰值段合并、多资源预约分别计时、零占用峰值', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲场地'); // R0001
  addResource(df, '乙设备', OPEN_ALL, 'equipment'); // R0002
  // 三段首尾相接的单资源占用：R1 [10,11) -> R2 [11,12) -> R1 [12,13)
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], 'B0001');
  ok(df, ['create-booking', '--resource', 'R0002', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'], 'B0002');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], 'B0003');
  // 多资源预约：R0001 与 R0002 各计 60 分钟
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--resource', 'R0002', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    'B0004 多资源',
  );

  const bytesBefore = readFileSync(df);

  // 窗口 10:00-13:00：交接处不叠加，峰值 1，三段相接合并为一段 [10:00,13:00)
  const r1 = usageStats(df, '2026-10-12T10:00/2026-10-12T13:00', [], '交接窗口');
  assertLine(r1, '  - R0001（甲场地，场地）: 可用 180 分钟，占用 120 分钟，空闲 60 分钟，使用率 66.67%', 'R0001 交接窗口');
  assertLine(r1, '  - R0002（乙设备，设备）: 可用 180 分钟，占用 60 分钟，空闲 120 分钟，使用率 33.33%', 'R0002 交接窗口');
  assertLine(r1, '繁忙峰值: 同时被占用的所选资源数量峰值为 1，达到峰值的全部最大连续区间（按开始时间排序）:', '交接峰值标题');
  assert.deepEqual(
    peakIntervalLines(r1),
    ['  - 2026-10-12T10:00 → 2026-10-12T13:00（180 分钟）'],
    `相接峰值段应合并为一段\nstdout:\n${r1.stdout}`,
  );

  // 窗口 10:00-15:00：多资源预约使两资源同时被占用，峰值 2，区间 [14:00,15:00)
  const r2 = usageStats(df, '2026-10-12T10:00/2026-10-12T15:00', [], '多资源窗口');
  assertLine(r2, '  - R0001（甲场地，场地）: 可用 300 分钟，占用 180 分钟，空闲 120 分钟，使用率 60.00%', 'R0001 多资源计时');
  assertLine(r2, '  - R0002（乙设备，设备）: 可用 300 分钟，占用 120 分钟，空闲 180 分钟，使用率 40.00%', 'R0002 多资源计时');
  assertLine(r2, '全部所选资源合计: 可用 600 资源分钟，占用 300 资源分钟，空闲 300 资源分钟，使用率 50.00%', '多资源合计');
  assertLine(r2, '繁忙峰值: 同时被占用的所选资源数量峰值为 2，达到峰值的全部最大连续区间（按开始时间排序）:', '峰值 2 标题');
  assert.deepEqual(
    peakIntervalLines(r2),
    ['  - 2026-10-12T14:00 → 2026-10-12T15:00（60 分钟）'],
    `峰值 2 区间\nstdout:\n${r2.stdout}`,
  );

  // 无占用窗口：峰值为零且不列区间
  const r3 = usageStats(df, '2026-10-20T00:00/2026-10-21T00:00', [], '无占用窗口');
  assertLine(r3, '  - R0001（甲场地，场地）: 可用 1440 分钟，占用 0 分钟，空闲 1440 分钟，使用率 0.00%', '零占用资源行');
  assertLine(r3, '繁忙峰值: 0（窗口内没有所选资源被占用，无峰值区间）', '零占用峰值');
  assert.deepEqual(peakIntervalLines(r3), [], '零占用不列峰值区间');

  assertFileBytes(df, bytesBefore, '三次统计后');
});

// ---------------------------------------------------------------------------
// 3. 状态变更后的重算：普通/系列成员/导入/候补兑现预约同口径计入；
//    未兑现候补、已取消预约、已取消停用不计；改期后按当前时间重算
// ---------------------------------------------------------------------------

test('状态变更重算：各类预约同口径，取消与未兑现不计，改期后按当前安排', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅'); // R0001，全年开放
  const window = '2026-10-12T08:00/2026-10-12T18:00'; // 可用 600 分钟
  const stat = (ctx: string): CliResult => usageStats(df, window, [], ctx);
  const line = (occ: number, avail = 600): string =>
    `  - R0001（多功能厅，场地）: 可用 ${avail} 分钟，占用 ${occ} 分钟，空闲 ${avail - occ} 分钟，使用率`;

  // 系列成员占用 09:00-10:00
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00', '--count', '1'],
    '系列成员 B0001',
  );
  assertLine(stat('系列成员计入'), `${line(60)} 10.00%`, '系列成员计入');

  // 导入预约占用 10:00-11:00
  const ics = join(dir, 'a.ics');
  writeFileSync(
    ics,
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uid-s\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\nEND:VCALENDAR\n',
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入预约 B0002');
  assertLine(stat('导入预约计入'), `${line(120)} 20.00%`, '导入预约计入');

  // 未兑现候补不增加占用
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'], '候补 W0001');
  assertLine(stat('未兑现候补不计'), `${line(120)} 20.00%`, '未兑现候补不计');

  // 候补兑现预约同口径计入；三段相接占用合并为一段峰值区间
  ok(df, ['process-waitlist'], '兑现 W0001 -> B0003');
  const r4 = stat('候补兑现计入');
  assertLine(r4, `${line(180)} 30.00%`, '候补兑现计入');
  assert.deepEqual(
    peakIntervalLines(r4),
    ['  - 2026-10-12T09:00 → 2026-10-12T12:00（180 分钟）'],
    `三段相接占用合并\nstdout:\n${r4.stdout}`,
  );

  // 改期导入预约到 14:00-15:00：占用总量不变，峰值区间按当前时间重算
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '改期 B0002');
  const r5 = stat('改期后重算');
  assertLine(r5, `${line(180)} 30.00%`, '改期后占用总量');
  assert.deepEqual(
    peakIntervalLines(r5),
    [
      '  - 2026-10-12T09:00 → 2026-10-12T10:00（60 分钟）',
      '  - 2026-10-12T11:00 → 2026-10-12T12:00（60 分钟）',
      '  - 2026-10-12T14:00 → 2026-10-12T15:00（60 分钟）',
    ],
    `改期后峰值区间重算\nstdout:\n${r5.stdout}`,
  );

  // 取消系列成员：不再计入占用
  ok(df, ['cancel-booking', 'B0001'], '取消系列成员 B0001');
  assertLine(stat('取消后重算'), `${line(120)} 20.00%`, '已取消预约不计');

  // 新增有效停用 16:00-17:00：可用减少 60；取消停用后恢复
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '停用 C0001');
  assertLine(stat('有效停用扣除'), `${line(120, 540)} 22.22%`, '有效停用扣除');
  ok(df, ['cancel-closure', 'C0001'], '取消停用 C0001');
  assertLine(stat('取消停用恢复'), `${line(120)} 20.00%`, '取消停用恢复可用');

  // 统计本身不产生任何记录
  const store = readStore(df);
  assert.equal(store.bookings.length, 3, '统计不创建预约');
  assert.equal(store.waitlist.length, 1, '统计不创建候补');
  assert.equal(store.closures.length, 1, '统计不创建停用');
});

// ---------------------------------------------------------------------------
// 4. 同一资源的重叠占用合并、一分钟只计一次（手工构造数据文件）
// ---------------------------------------------------------------------------

test('重叠占用合并：同一资源重叠预约一分钟只计一次，已取消不计', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  writeFileSync(
    df,
    JSON.stringify({
      version: 1,
      resourceSeq: 1,
      bookingSeq: 3,
      resources: [{id: 'R0001', type: 'venue', name: '手工会议室', open: [['2026-10-12T08:00', '2026-10-12T20:00']]}],
      bookings: [
        {id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T12:00', status: 'active'},
        {id: 'B0002', resourceIds: ['R0001'], start: '2026-10-12T11:00', end: '2026-10-12T13:00', status: 'active'},
        {id: 'B0003', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T12:00', status: 'cancelled'},
      ],
    }) + '\n',
    'utf8',
  );
  const bytesBefore = readFileSync(df);
  // 重叠的 [10:00,12:00) 与 [11:00,13:00) 合并为 [10:00,13:00) = 180 分钟（不是 240）
  const r = usageStats(df, '2026-10-12T00:00/2026-10-13T00:00', [], '重叠占用合并');
  assertLine(r, '  - R0001（手工会议室，场地）: 可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%', '重叠合并分钟数');
  assert.deepEqual(
    peakIntervalLines(r),
    ['  - 2026-10-12T10:00 → 2026-10-12T13:00（180 分钟）'],
    `重叠占用合并为一段峰值\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '手工文件统计后');
});

// ---------------------------------------------------------------------------
// 5. 名册为空明确提示并退出 0（不创建数据文件）；零可用资源与全零合计
// ---------------------------------------------------------------------------

test('名册为空退出 0 且不建文件；零可用资源与全零合计显示不适用', (t) => {
  const dir = tempDir(t);

  // 名册为空且未指定资源：明确提示，退出 0，不创建数据文件
  const df = join(dir, 'empty.json');
  const r1 = usageStats(df, '2026-10-12T00:00/2026-10-13T00:00', [], '名册为空');
  assert.match(r1.stdout, /名册为空/, `名册为空提示\nstdout:\n${r1.stdout}`);
  assert.ok(!existsSync(df), '名册为空统计不得创建数据文件');

  // 窗口内零可用：资源行与合计均显示不适用，峰值为零
  const df2 = join(dir, 'zero.json');
  addResource(df2, '夜间场地', [['2026-10-13T08:00', '2026-10-13T17:00']]); // R0001，开放在窗口外
  const bytesBefore = readFileSync(df2);
  const r2 = usageStats(df2, '2026-10-12T00:00/2026-10-13T00:00', [], '零可用窗口');
  assertLine(r2, '  - R0001（夜间场地，场地）: 可用 0 分钟，占用 0 分钟，空闲 0 分钟，使用率 不适用', '零可用资源行');
  assertLine(r2, '全部所选资源合计: 可用 0 资源分钟，占用 0 资源分钟，空闲 0 资源分钟，使用率 不适用', '全零合计');
  assertLine(r2, '繁忙峰值: 0（窗口内没有所选资源被占用，无峰值区间）', '零可用峰值');
  assertFileBytes(df2, bytesBefore, '零可用统计后');
});

// ---------------------------------------------------------------------------
// 6. 指定资源子集、未知/重复资源拒绝；用法错误退出 2；损坏与旧格式文件
// ---------------------------------------------------------------------------

test('资源子集与非法请求：未知/重复资源退出 1，用法错误退出 2，均不改文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], 'B0001');
  const bytesBefore = readFileSync(df);
  const window = '2026-10-12T00:00/2026-10-13T00:00';

  // 只统计所选子集：未选的 R0002 不出现在输出中
  const r1 = usageStats(df, window, ['R0002'], '资源子集');
  assertLine(r1, '统计窗口: 2026-10-12T00:00 → 2026-10-13T00:00（所选资源 1 个，区间左闭右开）', '子集标题');
  assert.ok(!r1.stdout.includes('R0001'), `未选资源不出现\nstdout:\n${r1.stdout}`);
  assertLine(r1, '  - R0002（二号会议室，场地）: 可用 1440 分钟，占用 0 分钟，空闲 1440 分钟，使用率 0.00%', '子集资源行');

  // 非法请求（退出 1）
  let r = bizFail(df, ['usage-stats', '--window', window, '--resource', 'R0009'], '未知资源');
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(df, ['usage-stats', '--window', window, '--resource', 'R0001', '--resource', 'R0001'], '重复资源');
  assert.match(r.stderr, /资源重复指定: R0001/);
  r = bizFail(df, ['usage-stats', '--window', '2026-10-12T12:00/2026-10-12T08:00'], '窗口结束早于开始');
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(df, ['usage-stats', '--window', '2026-02-30T08:00/2026-10-12T12:00'], '窗口日期不真实');
  assert.match(r.stderr, /不是真实有效的时间/);
  r = bizFail(df, ['usage-stats', '--window', '2026-10-12T08:00'], '窗口缺结束');
  assert.match(r.stderr, /统计窗口格式非法/);

  // 用法错误（退出 2）
  usageFail(df, ['usage-stats'], '缺少 --window');
  usageFail(df, ['usage-stats', '--window', window, '--bogus', 'x'], '未知选项');
  usageFail(df, ['usage-stats', '--window', window, '多余参数'], '多余位置参数');
  usageFail(df, ['usage-stats', '--window', window, '--window', window], '重复 --window');

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '失败请求不产生记录');
});

// ---------------------------------------------------------------------------
// 7. 损坏文件退出 1 并保留原样；旧格式文件可直接统计且不改动
// ---------------------------------------------------------------------------

test('损坏文件退出 1 并保留原样；旧格式文件可直接统计且不改动', (t) => {
  const dir = tempDir(t);

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r1 = bizFail(bad, ['usage-stats', '--window', '2026-10-12T00:00/2026-10-13T00:00'], '损坏文件');
  assert.match(r1.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件统计失败后');

  // 旧格式文件（只有 version 与 resources，无后续版本字段）：直接可统计，统计不补写
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resources: [
        {id: 'R0001', type: 'person', name: '旧员工', open: [['2026-01-01T00:00', '2027-01-01T00:00']]},
      ],
      bookings: [
        {id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T11:00', status: 'active'},
      ],
    }) + '\n',
    'utf8',
  );
  const oldBytes = readFileSync(old);
  const r2 = usageStats(old, '2026-10-12T00:00/2026-10-13T00:00', [], '旧文件统计');
  assertLine(r2, '  - R0001（旧员工，人员）: 可用 1440 分钟，占用 60 分钟，空闲 1380 分钟，使用率 4.17%', '旧文件资源行');
  assertFileBytes(old, oldBytes, '旧文件统计后');
});
