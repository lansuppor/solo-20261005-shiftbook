// shiftbook 候选资源组合最早可行时段查询（find-slot）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询；
// - 覆盖：重叠候选组须回溯调整前组选择、候选不足导致整体无解（各组各自可行
//   但整体不可行）、最早时间优先与同一最早开始的组合字典序取舍、跨日窗口与
//   停用/预约边界（端点相接）、各类占用（普通/系列成员/导入/候补兑现预约占用，
//   未兑现候补与已取消不阻挡）、改期或取消后重新查询、用法与非法请求的退出码、
//   旧数据文件兼容；查询前后数据文件逐字节不变（只读快照，不写文件不推进计数）；
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-find-slot-test-'));
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

function findSlot(df: string, window: string, duration: string, groups: string[], ctx: string): CliResult {
  const args = ['find-slot', '--window', window, '--duration', duration];
  for (const g of groups) args.push('--group', g);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 查询不得改动数据文件（逐字节比对）`);
}

// 断言查询结果：起止时间与按需求组顺序的所选资源标识
function assertSlot(r: CliResult, start: string, end: string, picks: string[], ctx: string): void {
  assert.match(
    r.stdout,
    new RegExp(`最早可行时段: ${start} → ${end}`),
    `[${ctx}] 起止时间\nstdout:\n${r.stdout}`,
  );
  picks.forEach((id, i) => {
    assert.match(
      r.stdout,
      new RegExp(`第 ${i + 1} 组: ${id}（`),
      `[${ctx}] 第 ${i + 1} 组应选 ${id}\nstdout:\n${r.stdout}`,
    );
  });
}

function assertNoSlot(r: CliResult, ctx: string): void {
  assert.match(r.stdout, /无解：窗口 /, `[${ctx}] 应明确提示无解\nstdout:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('最早可行时段'), `[${ctx}] 无解不得给出时段\nstdout:\n${r.stdout}`);
}

// ---------------------------------------------------------------------------
// 1. 重叠候选组须回溯调整前组选择（不能逐组贪小标识），组内输入顺序不影响结果
// ---------------------------------------------------------------------------

test('重叠候选组：前组须让出较小标识，组内候选顺序不影响结果，查询不改文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  const bytesBefore = readFileSync(df);
  // 第 1 组若贪选 R0001，第 2 组（只有 R0001）将无可选：必须回溯让第 1 组改选 R0002
  const r1 = findSlot(
    df,
    '2026-10-12T09:00/2026-10-12T12:00',
    '60',
    ['R0001,R0002', 'R0001'],
    '重叠候选组回溯',
  );
  assertSlot(r1, '2026-10-12T09:00', '2026-10-12T10:00', ['R0002', 'R0001'], '回溯后组合');
  assertFileBytes(df, bytesBefore, '查询后');

  // 组内候选输入顺序不影响结果
  const r2 = findSlot(
    df,
    '2026-10-12T09:00/2026-10-12T12:00',
    '60',
    ['R0002,R0001', 'R0001'],
    '组内乱序候选',
  );
  assertSlot(r2, '2026-10-12T09:00', '2026-10-12T10:00', ['R0002', 'R0001'], '乱序结果一致');
  assertFileBytes(df, bytesBefore, '再次查询后');
});

// ---------------------------------------------------------------------------
// 2. 候选不足导致整体无解（含各组各自可行但整体不可行），退出 0 且明确提示
// ---------------------------------------------------------------------------

test('候选不足：同一资源无法同时满足两组、唯一可用资源被两组争抢，均整体无解', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // (a) 两组都只有 R0001：同一资源可出现在不同组，但所选必须互不重复 -> 无解
  const bytesBefore = readFileSync(df);
  const r1 = findSlot(df, '2026-10-12T09:00/2026-10-12T12:00', '60', ['R0001', 'R0001'], '两组同一资源');
  assertNoSlot(r1, '两组同一资源');
  assertFileBytes(df, bytesBefore, '无解查询后');

  // (b) R0001 在整个窗口被预约占满：第 1 组 [R0001,R0002] 与第 2 组 [R0002]
  //     各自看都有可行候选（都可用 R0002），但整体无法选出互不相同的两项 -> 无解
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T12:00'],
    '占满 R0001 的预约',
  );
  const bytesAfter = readFileSync(df);
  const r2 = findSlot(
    df,
    '2026-10-12T09:00/2026-10-12T12:00',
    '60',
    ['R0001,R0002', 'R0002'],
    '各自可行整体不可行',
  );
  assertNoSlot(r2, '各自可行整体不可行');
  assertFileBytes(df, bytesAfter, '整体无解查询后');
});

// ---------------------------------------------------------------------------
// 3. 最早时间优先于组合字典序；同一最早开始的多个组合取标识序列字典序最小
// ---------------------------------------------------------------------------

test('取舍：更早开始优先于更小标识组合；同一最早开始取字典序最小序列', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '晚开放场地', [['2026-10-12T10:00', '2026-10-12T20:00']]); // R0001，10:00 起开放
  addResource(df, '早开放场地甲', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002，08:00 起开放
  addResource(df, '早开放场地乙', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0003，08:00 起开放

  // (a) R0001 标识更小但 10:00 才可用；R0002 08:00 即可用：取更早的 08:00（R0002）
  const r1 = findSlot(df, '2026-10-12T08:00/2026-10-12T12:00', '60', ['R0001,R0002'], '更早开始优先');
  assertSlot(r1, '2026-10-12T08:00', '2026-10-12T09:00', ['R0002'], '更早开始优先');

  // (b) 两个需求组候选相同且都在 08:00 可用：同一最早开始有两种组合，
  //     取标识序列字典序最小的 [R0002, R0003]；组内候选倒序输入结果不变
  const r2 = findSlot(
    df,
    '2026-10-12T08:00/2026-10-12T12:00',
    '60',
    ['R0003,R0002', 'R0002,R0003'],
    '同一时间组合取舍',
  );
  assertSlot(r2, '2026-10-12T08:00', '2026-10-12T09:00', ['R0002', 'R0003'], '字典序最小序列');
});

// ---------------------------------------------------------------------------
// 4. 跨日窗口、停用与预约边界：端点相接可行，取消的停用不阻挡
// ---------------------------------------------------------------------------

test('跨日窗口：停用与预约边界端点相接可行，已取消停用不阻挡', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '跨日场地', [['2026-10-12T08:00', '2026-10-13T20:00']]); // R0001
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T21:00', '--end', '2026-10-13T01:00'],
    '跨日有效停用 C0001',
  );
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-13T01:00', '--end', '2026-10-13T02:00'],
    '随后取消的停用 C0002',
  );
  ok(df, ['cancel-closure', 'C0002'], '取消停用 C0002（不再阻挡）');
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-13T04:00', '--end', '2026-10-13T06:00'],
    '次日预约 B0001',
  );

  const bytesBefore = readFileSync(df);
  // 空闲段：[20:00,21:00)（60 分钟，止于停用起点）、[01:00,04:00)（180 分钟，止于预约起点）
  // 时长 180：只能取跨日子夜后的 01:00 → 04:00，结束恰与预约起点相接（左闭右开，可行）
  const r1 = findSlot(df, '2026-10-12T20:00/2026-10-13T12:00', '180', ['R0001'], '跨日 180 分钟');
  assertSlot(r1, '2026-10-13T01:00', '2026-10-13T04:00', ['R0001'], '跨日 180 分钟');

  // 时长 60：取窗口起点 20:00 → 21:00，结束恰与停用起点相接（端点相接可行）
  const r2 = findSlot(df, '2026-10-12T20:00/2026-10-13T12:00', '60', ['R0001'], '贴停用边界 60 分钟');
  assertSlot(r2, '2026-10-12T20:00', '2026-10-12T21:00', ['R0001'], '贴停用边界 60 分钟');

  // 时长 181：超过 [01:00,04:00) 段长，只能取 [06:00,12:00] 段（预约结束点相接）
  const r3 = findSlot(df, '2026-10-12T20:00/2026-10-13T12:00', '181', ['R0001'], '跨日 181 分钟');
  assertSlot(r3, '2026-10-13T06:00', '2026-10-13T09:01', ['R0001'], '跨日 181 分钟');
  assertFileBytes(df, bytesBefore, '三次查询后');
});

// ---------------------------------------------------------------------------
// 5. 各类占用与重新查询：普通/系列成员/导入/候补兑现预约均占用，
//    未兑现候补与已取消不阻挡；改期或取消后重新查询反映最新状态
// ---------------------------------------------------------------------------

test('占用类型与重新查询：系列成员、导入、候补兑现均占用；改期/取消后结果更新', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '多功能厅'); // R0001
  const window = '2026-10-12T09:00/2026-10-12T12:00';

  // 系列成员占用 09:00-10:00
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00', '--count', '1'],
    '系列成员 B0001 占用 09:00-10:00',
  );
  const r1 = findSlot(df, window, '60', ['R0001'], '系列成员占用后');
  assertSlot(r1, '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '系列成员占用后');

  // 导入预约占用 10:00-11:00
  const ics = join(dir, 'a.ics');
  writeFileSync(
    ics,
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:uid-x\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\nEND:VCALENDAR\n',
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入预约 B0002 占用 10:00-11:00');
  const r2 = findSlot(df, window, '60', ['R0001'], '导入预约占用后');
  assertSlot(r2, '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], '导入预约占用后');

  // 未兑现候补不阻挡：登记 11:00-12:00 固定候补后查询结果不变
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '未兑现候补 W0001',
  );
  const r3 = findSlot(df, window, '60', ['R0001'], '未兑现候补不阻挡');
  assertSlot(r3, '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], '未兑现候补不阻挡');

  // 候补兑现后其预约占用 11:00-12:00：整个窗口被占满，无解（退出 0）
  ok(df, ['process-waitlist'], '兑现 W0001 -> B0003 占用 11:00-12:00');
  const bytesFull = readFileSync(df);
  const r4 = findSlot(df, window, '60', ['R0001'], '窗口占满无解');
  assertNoSlot(r4, '窗口占满无解');
  assertFileBytes(df, bytesFull, '占满查询后');

  // 改期导入预约 B0002 到下午：10:00-11:00 释放，重新查询反映最新状态
  ok(
    df,
    ['reschedule-booking', 'B0002', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    '改期导入预约 B0002',
  );
  const r5 = findSlot(df, window, '60', ['R0001'], '改期后重新查询');
  assertSlot(r5, '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '改期后重新查询');

  // 取消系列成员 B0001：09:00-10:00 释放
  ok(df, ['cancel-booking', 'B0001'], '取消系列成员 B0001');
  const r6 = findSlot(df, window, '60', ['R0001'], '取消后重新查询');
  assertSlot(r6, '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '取消后重新查询');

  // 方案不保留位置：按查询结果创建预约仍走最新状态校验，成功后下一查询顺延
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'],
    '按查询结果创建预约 B0004',
  );
  const r7 = findSlot(df, window, '60', ['R0001'], '创建后重新查询');
  assertSlot(r7, '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '创建后重新查询');

  // 全部查询均为只读：记录与标识计数只被修改入口推进
  const store = readStore(df);
  assert.equal(store.bookings.length, 4, '查询不创建预约');
  assert.equal(store.waitlist.length, 1, '查询不创建候补');
  assert.equal(store.closures.length, 0, '查询不创建停用');
});

// ---------------------------------------------------------------------------
// 6. 用法错误（退出 2）与非法请求（退出 1）
// ---------------------------------------------------------------------------

test('用法错误退出 2，非法请求退出 1，均不改动数据文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  const bytesBefore = readFileSync(df);

  // 用法错误（退出 2）
  usageFail(df, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60'], '缺少 --group');
  usageFail(df, ['find-slot', '--duration', '60', '--group', 'R0001'], '缺少 --window');
  usageFail(df, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--group', 'R0001'], '缺少 --duration');
  usageFail(
    df,
    ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001', '--bogus', 'x'],
    '未知选项',
  );
  usageFail(
    df,
    ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001', '多余参数'],
    '多余位置参数',
  );

  // 非法请求（退出 1）
  const base = ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60'];
  let r = bizFail(df, [...base, '--group', 'R0001,R0009'], '未知资源');
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(df, [...base, '--group', 'R0001,R0001'], '组内重复');
  assert.match(r.stderr, /候选资源重复: R0001/);
  r = bizFail(df, [...base, '--group', ','], '空需求组');
  assert.match(r.stderr, /为空或含空项/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '0', '--group', 'R0001'], '时长为 0');
  assert.match(r.stderr, /时长非法/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '1.5', '--group', 'R0001'], '时长非整数');
  assert.match(r.stderr, /时长非法/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T10:00', '--duration', '120', '--group', 'R0001'], '时长超过窗口');
  assert.match(r.stderr, /超过窗口长度/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T12:00/2026-10-12T09:00', '--duration', '60', '--group', 'R0001'], '窗口结束早于开始');
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T09:00', '--duration', '60', '--group', 'R0001'], '窗口缺结束');
  assert.match(r.stderr, /查询窗口格式非法/);
  r = bizFail(df, ['find-slot', '--window', '2026-02-30T09:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001'], '窗口日期不真实');
  assert.match(r.stderr, /不是真实有效的时间/);

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '失败请求不产生记录');
});

// ---------------------------------------------------------------------------
// 7. 数据文件损坏退出 1；旧格式数据文件继续可读（查询不补写字段）
// ---------------------------------------------------------------------------

test('损坏文件退出 1 并保留原样；旧格式文件可直接查询且不改动', (t) => {
  const dir = tempDir(t);

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r1 = bizFail(bad, ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001'], '损坏文件');
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
  const r2 = findSlot(old, '2026-10-12T09:00/2026-10-12T12:00', '60', ['R0001'], '旧文件查询');
  assertSlot(r2, '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '旧文件查询');
  assert.match(r2.stdout, /R0001（旧会议室，场地）/, '显示标识、名称与类型');
  assertFileBytes(old, oldBytes, '旧文件查询后');
});
