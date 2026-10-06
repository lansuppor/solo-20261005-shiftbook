// shiftbook 资源使用率与繁忙时段统计（usage-stats）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询；
// - 覆盖：跨日窗口逐日拆分（首尾不足一天只计窗口内部分）、重叠开放合并与有效
//   停用扣除（已取消停用不扣除）、多资源预约分别计时、全部占用类型同口径
//   （普通/系列成员/导入/候补兑现；已取消预约与未兑现候补不计入）、状态变更
//   后的重算（取消预约、改期、批量改期历史快照与导入首次请求快照不计入、
//   停用登记/取消）、零分母显示不适用、合计口径（总占用/总可用，不平均各项
//   百分比）、峰值交接（端点交接不制造瞬时重叠、相接峰值段合并、无占用峰值
//   为零不列区间）、占用与实际可用取交集、同一资源重叠占用合并一分钟只计
//   一次、空名册退出 0、指定资源子集、未知/重复资源与非法窗口退出 1、用法
//   错误退出 2、损坏文件退出 1、旧格式文件兼容；查询前后数据文件逐字节不变
//   （只读快照，不写文件不推进计数）；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');

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
  open: Array<[string, string]>,
  type = 'venue',
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function addBooking(df: string, ids: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking'];
  for (const id of ids) args.push('--resource', id);
  args.push('--start', start, '--end', end);
  ok(df, args, ctx);
}

function usageStats(df: string, window: string, resources: string[], ctx: string): CliResult {
  const args = ['usage-stats', '--window', window];
  for (const id of resources) args.push('--resource', id);
  return ok(df, args, ctx);
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 查询不得改动数据文件（逐字节比对）`);
}

function assertLine(r: CliResult, line: string, ctx: string): void {
  assert.ok(r.stdout.includes(line), `[${ctx}] 应包含行「${line}」\nstdout:\n${r.stdout}`);
}

function assertNoLine(r: CliResult, line: string, ctx: string): void {
  assert.ok(!r.stdout.includes(line), `[${ctx}] 不得包含行「${line}」\nstdout:\n${r.stdout}`);
}

// 峰值区间段（“达到峰值的全部最大连续区间”之后以 “- ” 开头的行）
function peakIntervalLines(r: CliResult): string[] {
  const marker = '达到峰值的全部最大连续区间（按开始时间排序）：\n';
  const idx = r.stdout.indexOf(marker);
  assert.ok(idx >= 0, `应包含峰值区间标题\nstdout:\n${r.stdout}`);
  return r.stdout
    .slice(idx + marker.length)
    .split('\n')
    .filter((l) => l.startsWith('- '));
}

// ---------------------------------------------------------------------------
// 1. 跨日窗口逐日拆分、重叠开放合并、有效停用扣除（已取消不扣除）、零分母
// ---------------------------------------------------------------------------

test('跨日逐日拆分、重叠开放与停用、零可用资源显示不适用，查询不改文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // 开放区间重叠：08:00-18:00 与 17:00-次日02:00 合并为 08:00-次日02:00
  addResource(df, '一号会议室', [['2026-10-12T08:00', '2026-10-12T18:00'], ['2026-10-12T17:00', '2026-10-13T02:00']]); // R0001
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], '有效停用 C0001');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T13:00', '--end', '2026-10-12T14:00'], '随后取消的停用 C0002');
  ok(df, ['cancel-closure', 'C0002'], '取消停用 C0002（不再扣除）');
  // 窗口开始前即结束开放：窗口内零可用
  addResource(df, '投影仪', [['2026-10-12T00:00', '2026-10-12T10:00']], 'equipment'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', '预约 B0001');
  addBooking(df, ['R0001'], '2026-10-12T23:30', '2026-10-13T00:30', '跨午夜预约 B0002');

  const bytesBefore = readFileSync(df);
  const r = usageStats(df, '2026-10-12T10:00/2026-10-13T06:00', [], '跨日统计');

  // R0001 实际可用（裁进窗口）：[10:00,12:00) + [13:00, 次日02:00)
  // 首日（10:00-24:00）：可用 120+660=780，占用 60(B0001)+30(B0002 前半)=90
  assertLine(r, '- 2026-10-12 R0001（一号会议室，场地）：可用 780 分钟，占用 90 分钟，空闲 690 分钟，使用率 11.54%', '首日 R0001');
  // 次日（00:00-06:00）：可用 [00:00,02:00)=120，占用 B0002 后半 30
  assertLine(r, '- 2026-10-13 R0001（一号会议室，场地）：可用 120 分钟，占用 30 分钟，空闲 90 分钟，使用率 25.00%', '次日 R0001');
  // R0002 窗口内零可用：两日均为零且使用率不适用
  assertLine(r, '- 2026-10-12 R0002（投影仪，设备）：可用 0 分钟，占用 0 分钟，空闲 0 分钟，使用率 不适用', '首日 R0002 零可用');
  assertLine(r, '- 2026-10-13 R0002（投影仪，设备）：可用 0 分钟，占用 0 分钟，空闲 0 分钟，使用率 不适用', '次日 R0002 零可用');
  // 整窗汇总与全部所选合计
  assertLine(r, '- R0001（一号会议室，场地）：可用 900 分钟，占用 120 分钟，空闲 780 分钟，使用率 13.33%', '整窗 R0001');
  assertLine(r, '- R0002（投影仪，设备）：可用 0 分钟，占用 0 分钟，空闲 0 分钟，使用率 不适用', '整窗 R0002');
  assertLine(r, '全部所选资源合计：可用 900 资源分钟，占用 120 资源分钟，空闲 780 资源分钟，使用率 13.33%（总占用/总可用，不平均各项百分比）', '合计');
  // 峰值 1，两段区间按开始时间排序
  assertLine(r, '繁忙峰值：窗口内同时被占用的所选资源数量峰值为 1', '峰值');
  assert.deepEqual(
    peakIntervalLines(r),
    ['- 2026-10-12T11:00 → 2026-10-12T12:00（60 分钟）', '- 2026-10-12T23:30 → 2026-10-13T00:30（60 分钟）'],
    `峰值区间\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '查询后');
});

// ---------------------------------------------------------------------------
// 2. 多资源预约分别计时、全部占用类型同口径、合计不平均各项百分比
// ---------------------------------------------------------------------------

test('多资源分别计时、各占用类型同口径、合计按总占用/总可用而非平均百分比', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '小会议室', [['2026-10-12T08:00', '2026-10-12T10:00']]); // R0001，可用 120
  addResource(df, '大会议室', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002，可用 720
  addResource(df, '讲解员', [['2026-10-12T08:00', '2026-10-12T20:00']], 'person'); // R0003，可用 720

  addBooking(df, ['R0001', 'R0002'], '2026-10-12T09:00', '2026-10-12T10:00', '多资源预约 B0001');
  ok(df, ['create-series', '--resource', 'R0002', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00', '--count', '1'], '系列成员 B0002');
  const ics = join(dir, 'a.ics');
  writeFileSync(
    ics,
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uid-1\nDTSTART:20261012T110000\nDTEND:20261012T120000\nEND:VEVENT\nEND:VCALENDAR\n',
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0002'], '导入预约 B0003');
  ok(df, ['add-waitlist', '--resource', 'R0003', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'], '候补 W0001');
  ok(df, ['process-waitlist'], '兑现 W0001 -> B0004');
  addBooking(df, ['R0003'], '2026-10-12T13:00', '2026-10-12T14:00', '普通预约 B0005');
  addBooking(df, ['R0002'], '2026-10-12T14:00', '2026-10-12T15:00', '随后取消的预约 B0006');
  ok(df, ['cancel-booking', 'B0006'], '取消 B0006（不计占用）');
  ok(df, ['add-waitlist', '--resource', 'R0002', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'], '未兑现候补 W0002（不计占用）');

  const bytesBefore = readFileSync(df);
  const r = usageStats(df, '2026-10-12T08:00/2026-10-12T20:00', [], '全类型占用统计');

  // R0001：可用 120，占用 60（B0001 多资源预约在本资源计时）-> 50.00%
  assertLine(r, '- 2026-10-12 R0001（小会议室，场地）：可用 120 分钟，占用 60 分钟，空闲 60 分钟，使用率 50.00%', 'R0001 日明细');
  // R0002：可用 720，占用 B0001+B0002+B0003=180（已取消 B0006 与未兑现 W0002 不计）-> 25.00%
  assertLine(r, '- 2026-10-12 R0002（大会议室，场地）：可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%', 'R0002 日明细');
  // R0003：可用 720，占用 B0004（候补兑现）+B0005=120 -> 16.67%
  assertLine(r, '- 2026-10-12 R0003（讲解员，人员）：可用 720 分钟，占用 120 分钟，空闲 600 分钟，使用率 16.67%', 'R0003 日明细');
  // 合计：可用 1560，占用 360 -> 360/1560 = 23.08%（平均各项百分比会得到 30.56%，口径不同）
  assertLine(r, '全部所选资源合计：可用 1560 资源分钟，占用 360 资源分钟，空闲 1200 资源分钟，使用率 23.08%（总占用/总可用，不平均各项百分比）', '合计口径');
  assertNoLine(r, '30.56%', '不得按平均百分比汇总');
  // 峰值 2（09:00-10:00 R0001 与 R0002 同时被占），区间仅一段
  assertLine(r, '繁忙峰值：窗口内同时被占用的所选资源数量峰值为 2', '峰值 2');
  assert.deepEqual(peakIntervalLines(r), ['- 2026-10-12T09:00 → 2026-10-12T10:00（60 分钟）'], `峰值区间\nstdout:\n${r.stdout}`);
  assertFileBytes(df, bytesBefore, '查询后');
});

// ---------------------------------------------------------------------------
// 3. 峰值：端点交接不制造瞬时重叠、相接峰值段合并、无占用峰值为零不列区间
// ---------------------------------------------------------------------------

test('峰值交接不重叠、相接峰值段合并为一段、无占用时峰值为零且无区间', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001
  addResource(df, '乙场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002
  addBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002 与 B0001 端点相接');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0003 与 B0002 端点相接');

  const bytesBefore = readFileSync(df);
  const r = usageStats(df, '2026-10-12T08:00/2026-10-12T20:00', [], '峰值交接');
  // 任意时刻至多 1 个资源被占（端点交接不算瞬时重叠）；三段相接的峰值段合并为一段
  assertLine(r, '繁忙峰值：窗口内同时被占用的所选资源数量峰值为 1', '峰值为 1');
  assert.deepEqual(peakIntervalLines(r), ['- 2026-10-12T09:00 → 2026-10-12T12:00（180 分钟）'], `相接峰值段合并\nstdout:\n${r.stdout}`);

  // 无占用窗口：峰值为零且不列区间
  const r2 = usageStats(df, '2026-10-13T08:00/2026-10-13T20:00', [], '无占用窗口');
  assertLine(r2, '繁忙峰值：窗口内所选资源没有任何占用（峰值为 0，无峰值区间）。', '零占用峰值');
  assertNoLine(r2, '达到峰值的全部最大连续区间', '零占用不列峰值区间');
  assertFileBytes(df, bytesBefore, '两次查询后');
});

// ---------------------------------------------------------------------------
// 4. 状态变更后的重算：取消预约、改期、批量改期历史快照与导入首次请求
//    快照不计入、停用登记/取消；每次统计按最新状态重算
// ---------------------------------------------------------------------------

test('状态变更后重算：取消、改期、批量改期与导入快照不计入、停用登记与取消', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001，可用 720
  addBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0002');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0003');
  const ics = join(dir, 'a.ics');
  writeFileSync(
    ics,
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uid-1\nDTSTART:20261012T130000\nDTEND:20261012T140000\nEND:VEVENT\nEND:VCALENDAR\n',
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入预约 B0004（首次请求 13:00-14:00）');

  const window = '2026-10-12T08:00/2026-10-12T20:00';
  const row = '- 2026-10-12 R0001（多功能厅，场地）：';

  // 初始：占用 240，相接的三段合并为一个峰值区间，另有一段导入占用
  let bytesBefore = readFileSync(df);
  let r = usageStats(df, window, [], '初始统计');
  assertLine(r, `${row}可用 720 分钟，占用 240 分钟，空闲 480 分钟，使用率 33.33%`, '初始占用');
  assert.deepEqual(
    peakIntervalLines(r),
    ['- 2026-10-12T09:00 → 2026-10-12T12:00（180 分钟）', '- 2026-10-12T13:00 → 2026-10-12T14:00（60 分钟）'],
    `初始峰值区间\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '初始查询后');

  // 取消 B0002：占用降为 180，10:00-11:00 不再计入
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  bytesBefore = readFileSync(df);
  r = usageStats(df, window, [], '取消后统计');
  assertLine(r, `${row}可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%`, '取消后占用');
  assert.deepEqual(
    peakIntervalLines(r),
    [
      '- 2026-10-12T09:00 → 2026-10-12T10:00（60 分钟）',
      '- 2026-10-12T11:00 → 2026-10-12T12:00（60 分钟）',
      '- 2026-10-12T13:00 → 2026-10-12T14:00（60 分钟）',
    ],
    `取消后峰值区间\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '取消后查询');

  // 改期导入预约 B0004 到 16:00-17:00：按当前时间计入，导入首次请求快照（13:00-14:00）不计入
  ok(df, ['reschedule-booking', 'B0004', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '改期导入预约 B0004');
  bytesBefore = readFileSync(df);
  r = usageStats(df, window, [], '导入预约改期后统计');
  assertLine(r, `${row}可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%`, '改期后占用不变');
  assertLine(r, '- 2026-10-12T16:00 → 2026-10-12T17:00（60 分钟）', '按改期后时间计入');
  assertNoLine(r, '2026-10-12T13:00 → 2026-10-12T14:00（60 分钟）', '导入首次请求快照不计入');
  assertFileBytes(df, bytesBefore, '改期后查询');

  // 批量改期 B0003 到 14:00-15:00（生成操作记录 O0001）：按新安排计入，
  // 改期历史快照（11:00-12:00）不计入
  const manifest = join(dir, 'reschedule.json');
  writeFileSync(
    manifest,
    JSON.stringify({items: [{bookingId: 'B0003', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']}]}) + '\n',
    'utf8',
  );
  ok(df, ['reschedule-batch', manifest], '批量改期 B0003 -> 14:00-15:00');
  bytesBefore = readFileSync(df);
  r = usageStats(df, window, [], '批量改期后统计');
  assertLine(r, `${row}可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%`, '批量改期后占用不变');
  assert.deepEqual(
    peakIntervalLines(r),
    [
      '- 2026-10-12T09:00 → 2026-10-12T10:00（60 分钟）',
      '- 2026-10-12T14:00 → 2026-10-12T15:00（60 分钟）',
      '- 2026-10-12T16:00 → 2026-10-12T17:00（60 分钟）',
    ],
    `批量改期后峰值区间（历史快照不计入）\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '批量改期后查询');

  // 登记停用 15:00-16:00：可用降为 660，占用不变
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'], '登记停用 C0001');
  bytesBefore = readFileSync(df);
  r = usageStats(df, window, [], '停用后统计');
  assertLine(r, `${row}可用 660 分钟，占用 180 分钟，空闲 480 分钟，使用率 27.27%`, '停用后可用减少');
  assertFileBytes(df, bytesBefore, '停用后查询');

  // 取消停用：可用恢复 720
  ok(df, ['cancel-closure', 'C0001'], '取消停用 C0001');
  bytesBefore = readFileSync(df);
  r = usageStats(df, window, [], '取消停用后统计');
  assertLine(r, `${row}可用 720 分钟，占用 180 分钟，空闲 540 分钟，使用率 25.00%`, '取消停用后恢复');
  assertFileBytes(df, bytesBefore, '取消停用后查询');
});

// ---------------------------------------------------------------------------
// 5. 占用与实际可用取交集、同一资源重叠占用合并（一分钟只计一次）
// ---------------------------------------------------------------------------

test('超出开放的占用只计交集部分，同一资源重叠占用合并后一分钟只计一次', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // 手工构造数据文件：开放 08:00-20:00；
  // B0001 与 B0002 重叠（合并为 10:00-13:00 = 180，而非 240）；
  // B0003 超出开放（19:00-23:00，只计与实际可用的交集 19:00-20:00 = 60）
  writeFileSync(
    df,
    JSON.stringify(
      {
        version: 1,
        resourceSeq: 1,
        bookingSeq: 3,
        resources: [{id: 'R0001', type: 'venue', name: '会议室', open: [['2026-10-12T08:00', '2026-10-12T20:00']]}],
        bookings: [
          {id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T12:00', status: 'active'},
          {id: 'B0002', resourceIds: ['R0001'], start: '2026-10-12T11:00', end: '2026-10-12T13:00', status: 'active'},
          {id: 'B0003', resourceIds: ['R0001'], start: '2026-10-12T19:00', end: '2026-10-12T23:00', status: 'active'},
        ],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const bytesBefore = readFileSync(df);
  const r = usageStats(df, '2026-10-12T08:00/2026-10-12T20:00', [], '交集与重叠合并');
  assertLine(r, '- 2026-10-12 R0001（会议室，场地）：可用 720 分钟，占用 240 分钟，空闲 480 分钟，使用率 33.33%', '重叠合并且超出开放只计交集');
  assert.deepEqual(
    peakIntervalLines(r),
    ['- 2026-10-12T10:00 → 2026-10-12T13:00（180 分钟）', '- 2026-10-12T19:00 → 2026-10-12T20:00（60 分钟）'],
    `峰值区间（重叠占用合并）\nstdout:\n${r.stdout}`,
  );
  assertFileBytes(df, bytesBefore, '查询后');
});

// ---------------------------------------------------------------------------
// 6. 空名册退出 0、指定资源子集、未知/重复资源与非法窗口退出 1、
//    用法错误退出 2、损坏文件退出 1、旧格式文件兼容
// ---------------------------------------------------------------------------

test('空名册明确提示退出 0 且不建文件；指定子集只统计所选资源', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');

  // 名册为空且未指定资源：明确提示、退出 0、不创建数据文件
  const r1 = ok(df, ['usage-stats', '--window', '2026-10-12T08:00/2026-10-12T20:00'], '空名册统计');
  assertLine(r1, '当前没有任何已登记资源，无可统计对象。可使用 add-resource 登记场地、设备或人员。', '空名册提示');
  assert.ok(!existsSync(df), '空名册查询不得创建数据文件');

  // 指定子集：只统计所选资源
  addResource(df, '甲场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001
  addResource(df, '乙场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002
  addBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', 'B0001');
  const bytesBefore = readFileSync(df);
  const r2 = usageStats(df, '2026-10-12T08:00/2026-10-12T20:00', ['R0002'], '指定子集');
  assertLine(r2, '资源使用率与繁忙时段统计（窗口 2026-10-12T08:00 → 2026-10-12T20:00，共 1 个所选资源）：', '子集标题');
  assertLine(r2, '- 2026-10-12 R0002（乙场地，场地）：可用 720 分钟，占用 0 分钟，空闲 720 分钟，使用率 0.00%', '子集只含 R0002');
  assertNoLine(r2, 'R0001（甲场地', '子集不含未选资源');
  assertFileBytes(df, bytesBefore, '子集查询后');
});

test('未知/重复资源与非法窗口退出 1，用法错误退出 2，均不改动数据文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲场地', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0001
  const bytesBefore = readFileSync(df);
  const window = '2026-10-12T08:00/2026-10-12T20:00';

  // 非法请求（退出 1）
  let r = bizFail(df, ['usage-stats', '--window', window, '--resource', 'R0009'], '未知资源');
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(df, ['usage-stats', '--window', window, '--resource', 'R0001', '--resource', 'R0001'], '重复资源');
  assert.match(r.stderr, /资源重复指定: R0001/);
  r = bizFail(df, ['usage-stats', '--window', '2026-10-12T20:00/2026-10-12T08:00'], '窗口结束早于开始');
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(df, ['usage-stats', '--window', '2026-10-12T08:00'], '窗口缺结束');
  assert.match(r.stderr, /统计窗口格式非法/);
  r = bizFail(df, ['usage-stats', '--window', '2026-02-30T08:00/2026-10-12T20:00'], '窗口日期不真实');
  assert.match(r.stderr, /不是真实有效的时间/);
  r = bizFail(df, ['usage-stats', '--window', '2026-10-12T08:00/2026-10-12T08:00'], '窗口零长度');
  assert.match(r.stderr, /结束时间必须晚于开始时间/);

  // 用法错误（退出 2）
  usageFail(df, ['usage-stats'], '缺少 --window');
  usageFail(df, ['usage-stats', '--window', window, '多余参数'], '多余位置参数');
  usageFail(df, ['usage-stats', '--window', window, '--bogus', 'x'], '未知选项');

  assertFileBytes(df, bytesBefore, '全部失败请求后');
});

test('损坏文件退出 1 并保留原样；旧格式文件可直接统计且不改动', (t) => {
  const dir = tempDir(t);

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r1 = bizFail(bad, ['usage-stats', '--window', '2026-10-12T08:00/2026-10-12T20:00'], '损坏文件');
  assert.match(r1.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件查询失败后');

  // 旧格式文件（只有 version 与 resources，无后续版本字段）：直接可查，查询不补写
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
    }) + '\n',
    'utf8',
  );
  const oldBytes = readFileSync(old);
  const r2 = usageStats(old, '2026-10-12T08:00/2026-10-12T10:00', [], '旧文件统计');
  assertLine(r2, '- 2026-10-12 R0001（旧会议室，场地）：可用 120 分钟，占用 0 分钟，空闲 120 分钟，使用率 0.00%', '旧文件统计');
  assertLine(r2, '繁忙峰值：窗口内所选资源没有任何占用（峰值为 0，无峰值区间）。', '旧文件零占用');
  assertFileBytes(old, oldBytes, '旧文件查询后');
});
