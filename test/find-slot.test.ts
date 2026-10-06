// shiftbook 候选资源组合最早可行时段查询（find-slot）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-* / 重新读取文件）；
// - 覆盖：重叠候选组须调整前组选择、候选不足导致整体无解、最早时间与同时间
//   组合取舍（字典序最小、组内输入顺序无关）、跨日及停用和预约边界（端点相接
//   可行）、改期或取消后重新查询、候补占用语义、只读语义（残留写入保护不阻挡、
//   查询前后文件逐字节不变）与非法请求/用法错误退出码；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const DAY: Array<[string, string]> = [['2026-10-12T08:00', '2026-10-12T18:00']];

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
  type: string,
  name: string,
  open: Array<[string, string]> = DAY,
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function createBooking(df: string, resources: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking'];
  for (const r of resources) args.push('--resource', r);
  args.push('--start', start, '--end', end);
  ok(df, args, ctx);
}

function findSlot(df: string, groups: string[], ctx: string, window = '2026-10-12T08:00/2026-10-12T18:00', duration = '60'): CliResult {
  const args = ['find-slot', '--window', window, '--duration', duration];
  for (const g of groups) args.push('--group', g);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 数据文件应逐字节保留`);
}

// 查询前后文件逐字节不变（只读：不写数据文件、不推进计数）
function findSlotReadonly(df: string, groups: string[], ctx: string, window?: string, duration?: string): CliResult {
  const before = readFileSync(df);
  const r = findSlot(df, groups, ctx, window, duration);
  assertFileBytes(df, before, `${ctx}：查询不改动文件`);
  return r;
}

// ---------------------------------------------------------------------------
// 1. 重叠候选组须调整前组选择；最早时间优先于组合字典序
// ---------------------------------------------------------------------------

test('find-slot：重叠候选组须调整前组选择，最早开始优先于字典序', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001
  addResource(df, '人员', '乙'); // R0002
  addResource(df, '设备', '切割机'); // R0003
  createBooking(df, ['R0001'], '2026-10-12T08:00', '2026-10-12T09:00', 'R0001 的 08:00-09:00 预约');

  // 组 2 只能选 R0001；逐组贪小会为组 1 也选 R0001 而误判无解，
  // 必须调整组 1 为 R0002。R0001 在 09:00 起空闲，故最早开始 09:00。
  const r1 = findSlotReadonly(df, ['R0001,R0002', 'R0001'], '重叠候选组调整选择');
  assert.match(r1.stdout, /最早可行时段: 2026-10-12T09:00 → 2026-10-12T10:00/);
  assert.match(r1.stdout, /需求组 1: R0002 \[人员\] 乙/);
  assert.match(r1.stdout, /需求组 2: R0001 \[人员\] 甲/);

  // 组内候选输入顺序不影响结果
  const r2 = findSlotReadonly(df, ['R0002,R0001', 'R0001'], '组内候选顺序无关');
  assert.match(r2.stdout, /需求组 1: R0002 \[人员\] 乙/);
  assert.match(r2.stdout, /需求组 2: R0001 \[人员\] 甲/);

  // 最早时间优先：字典序更小的组合 (R0001,R0003) 要到 09:00 才可行，
  // 08:00 可行的 (R0002,R0003) 胜出
  const r3 = findSlotReadonly(df, ['R0001,R0002', 'R0003'], '最早时间优先于字典序');
  assert.match(r3.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);
  assert.match(r3.stdout, /需求组 1: R0002 \[人员\] 乙/);
  assert.match(r3.stdout, /需求组 2: R0003 \[设备\] 切割机/);
});

// ---------------------------------------------------------------------------
// 2. 候选不足导致整体无解（每组各自可行不等于整体可行），退出码 0
// ---------------------------------------------------------------------------

test('find-slot：候选不足整体无解，明确提示且退出 0，不返回少组方案', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001
  addResource(df, '人员', '乙'); // R0002

  // 同一资源出现在两个组：每组各自可行，但整体无法选出互不重复的组合
  const r1 = findSlotReadonly(df, ['R0001', 'R0001'], '同一资源两组');
  assert.match(r1.stdout, /没有能同时满足全部 2 个需求组的连续 60 分钟时段/);
  assert.match(r1.stdout, /未创建预约、候补或任何记录/);
  assert.ok(!r1.stdout.includes('最早可行时段'), '不返回部分方案');

  // 三个需求组共用两个候选资源：必然无解
  const r2 = findSlotReadonly(df, ['R0001,R0002', 'R0001,R0002', 'R0001,R0002'], '三组两候选');
  assert.match(r2.stdout, /没有能同时满足全部 3 个需求组的连续 60 分钟时段/);

  // 时长超过窗口内任何共同空闲段：R0001 仅 08:00-09:00 空闲
  createBooking(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T18:00', 'R0001 的 09:00-18:00 预约');
  const r3 = findSlot(df, ['R0001'], '空闲不足所需时长', '2026-10-12T08:00/2026-10-12T18:00', '120');
  assert.match(r3.stdout, /没有能同时满足全部 1 个需求组的连续 120 分钟时段/);
  assert.ok(!r3.stdout.includes('最早可行时段'), '不缩短时长凑方案');
});

// ---------------------------------------------------------------------------
// 3. 同一最早开始的多个组合取标识序列字典序最小者
// ---------------------------------------------------------------------------

test('find-slot：同一最早开始的多个组合取字典序最小序列', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001
  addResource(df, '人员', '乙'); // R0002
  addResource(df, '人员', '丙'); // R0003

  // 08:00 起 (R0002,R0001)、(R0003,R0001)、(R0003,R0002) 均可行，
  // 字典序最小序列为 R0002,R0001（组内输入顺序故意倒写）
  const r1 = findSlotReadonly(df, ['R0003,R0002', 'R0002,R0001'], '同时间多组合取舍');
  assert.match(r1.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);
  assert.match(r1.stdout, /需求组 1: R0002 \[人员\] 乙/);
  assert.match(r1.stdout, /需求组 2: R0001 \[人员\] 甲/);

  // 单组多候选：取标识最小者
  const r2 = findSlotReadonly(df, ['R0003,R0001,R0002'], '单组取最小标识');
  assert.match(r2.stdout, /需求组 1: R0001 \[人员\] 甲/);
});

// ---------------------------------------------------------------------------
// 4. 跨日窗口、停用与预约边界（左闭右开，端点相接可行）
// ---------------------------------------------------------------------------

test('find-slot：跨日窗口内扣除停用与预约，端点相接可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '场地', '夜班车间', [['2026-10-12T20:00', '2026-10-13T06:00']]); // R0001
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T22:00', '--end', '2026-10-12T23:00'],
    '停用 C0001（22:00-23:00）',
  );
  createBooking(df, ['R0001'], '2026-10-12T23:00', '2026-10-13T00:00', '跨日预约 23:00-00:00');

  const win = '2026-10-12T21:00/2026-10-13T02:00';
  // 空闲段：21:00-22:00（停用前）、00:00-02:00（预约结束后，端点相接可行）
  const r1 = findSlotReadonly(df, ['R0001'], '跨日 90 分钟', win, '90');
  assert.match(r1.stdout, /最早可行时段: 2026-10-13T00:00 → 2026-10-13T01:30/);

  // 60 分钟：21:00-22:00 恰好容纳（结束与停用开始相接可行）
  const r2 = findSlotReadonly(df, ['R0001'], '停用前恰好的 60 分钟', win, '60');
  assert.match(r2.stdout, /最早可行时段: 2026-10-12T21:00 → 2026-10-12T22:00/);

  // 取消停用与预约后重新查询：占用释放，90 分钟提前到 21:00
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  ok(df, ['cancel-booking', 'B0001'], '取消预约');
  const r3 = findSlotReadonly(df, ['R0001'], '取消后重新查询', win, '90');
  assert.match(r3.stdout, /最早可行时段: 2026-10-12T21:00 → 2026-10-12T22:30/);
});

// ---------------------------------------------------------------------------
// 5. 改期或取消后重新查询：按最新状态计算，方案不保留位置
// ---------------------------------------------------------------------------

test('find-slot：改期或取消后重新查询反映最新占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001
  addResource(df, '人员', '乙'); // R0002
  createBooking(df, ['R0001'], '2026-10-12T08:00', '2026-10-12T10:00', 'B0001');
  createBooking(df, ['R0002'], '2026-10-12T08:00', '2026-10-12T09:00', 'B0002');

  // 共同空闲最早 10:00（R0001 被占到 10:00，R0002 被占到 09:00）
  const r1 = findSlotReadonly(df, ['R0001', 'R0002'], '改期前查询');
  assert.match(r1.stdout, /最早可行时段: 2026-10-12T10:00 → 2026-10-12T11:00/);

  // 改期 B0001 到下午后：共同空闲提前到 09:00
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T16:00'],
    '改期 B0001',
  );
  const r2 = findSlotReadonly(df, ['R0001', 'R0002'], '改期后重新查询');
  assert.match(r2.stdout, /最早可行时段: 2026-10-12T09:00 → 2026-10-12T10:00/);

  // 取消 B0002 后：共同空闲提前到 08:00
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  const r3 = findSlotReadonly(df, ['R0001', 'R0002'], '取消后重新查询');
  assert.match(r3.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);

  // 查询不保留位置：按查询结果直接创建预约仍按最新状态检查并成功
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--resource', 'R0002',
      '--start', '2026-10-12T08:00', '--end', '2026-10-12T09:00'],
    '按查询结果创建预约',
  );
  const store = readStore(df);
  assert.equal(store.bookings.filter((b: any) => b.status === 'active').length, 2, 'B0001 与新预约有效，B0002 已取消');
});

// ---------------------------------------------------------------------------
// 6. 候补语义：未兑现候补不阻挡，兑现预约按当前安排占用
// ---------------------------------------------------------------------------

test('find-slot：未兑现候补不阻挡，候补兑现预约占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001

  // 固定时段候补登记后不占用资源
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T09:00'],
    '登记固定候补 W0001',
  );
  const r1 = findSlotReadonly(df, ['R0001'], '未兑现候补不阻挡');
  assert.match(r1.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);

  // 兑现后产生的普通预约占用资源
  ok(df, ['process-waitlist'], '处理候补队列');
  const r2 = findSlotReadonly(df, ['R0001'], '兑现预约占用');
  assert.match(r2.stdout, /最早可行时段: 2026-10-12T09:00 → 2026-10-12T10:00/);

  // 取消兑现预约后释放（候补保留关联但不恢复等待、不再占用）
  ok(df, ['cancel-booking', 'B0001'], '取消兑现预约');
  const r3 = findSlotReadonly(df, ['R0001'], '取消兑现预约后');
  assert.match(r3.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);
});

// ---------------------------------------------------------------------------
// 7. 只读语义：残留写入保护不阻挡查询，查询不触碰锁与数据文件
// ---------------------------------------------------------------------------

test('find-slot：残留写入保护不阻挡查询，查询不创建或改动任何文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001

  // 手工留下残留锁文件（模拟进程异常退出）：查询不等待、不改动保护
  const lockPath = `${df}.lock`;
  writeFileSync(lockPath, '{"pid":999999,"host":"nowhere","dataFile":"x","acquiredAt":"-"}\n');
  const bytesBefore = readFileSync(df);
  const r = findSlot(df, ['R0001'], '残留保护下查询');
  assert.match(r.stdout, /最早可行时段: 2026-10-12T08:00 → 2026-10-12T09:00/);
  assertFileBytes(df, bytesBefore, '查询不改动数据文件');
  assert.ok(existsSync(lockPath), '查询不删除残留保护');
  assert.equal(readFileSync(lockPath, 'utf8'), '{"pid":999999,"host":"nowhere","dataFile":"x","acquiredAt":"-"}\n', '锁内容不变');

  // 数据文件不存在时按空数据处理：任何候选都未知，退出 1
  const missing = join(dir, 'missing.json');
  const r2 = bizFail(missing, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T18:00', '--duration', '60', '--group', 'R0001'], '空数据未知资源');
  assert.match(r2.stderr, /未知资源标识: R0001/);
});

// ---------------------------------------------------------------------------
// 8. 非法请求退出 1、用法错误退出 2、损坏数据退出 1
// ---------------------------------------------------------------------------

test('find-slot：非法请求、用法错误与损坏数据的退出码', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '人员', '甲'); // R0001
  const base = ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T18:00', '--duration', '60', '--group', 'R0001'];

  // 用法错误（退出 2）
  usageFail(df, ['find-slot', '--duration', '60', '--group', 'R0001'], '缺少 --window');
  usageFail(df, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T18:00', '--group', 'R0001'], '缺少 --duration');
  usageFail(df, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T18:00', '--duration', '60'], '缺少 --group');
  usageFail(df, [...base, '--bogus', 'x'], '未知选项');
  usageFail(df, [...base, 'extra'], '多余位置参数');

  // 非法请求（退出 1）
  let r = bizFail(df, [...base.slice(0, -1), 'R0001,R0001'], '组内重复');
  assert.match(r.stderr, /组内资源重复指定: R0001/);
  r = bizFail(df, [...base.slice(0, -1), 'R0001,R9999'], '未知资源');
  assert.match(r.stderr, /未知资源标识: R9999/);
  r = bizFail(df, [...base.slice(0, -1), ','], '空需求组');
  assert.match(r.stderr, /空的资源标识/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T09:00', '--duration', '61', '--group', 'R0001'], '时长超过窗口');
  assert.match(r.stderr, /超过窗口长度/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T18:00', '--duration', '0', '--group', 'R0001'], '时长为 0');
  assert.match(r.stderr, /时长非法/);
  r = bizFail(df, ['find-slot', '--window', '2026-10-12T08:00/2026-10-12T07:00', '--duration', '60', '--group', 'R0001'], '窗口结束早于开始');
  assert.match(r.stderr, /结束时间必须晚于开始时间/);
  r = bizFail(df, ['find-slot', '--window', '2026-02-30T08:00/2026-10-12T18:00', '--duration', '60', '--group', 'R0001'], '窗口时间不真实');
  assert.match(r.stderr, /不是真实有效的时间/);

  // 非法请求同样不改动文件
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '不产生任何记录');
  assert.equal(store.bookingSeq, 0, '计数不推进');

  // 损坏数据（退出 1，说明原因）
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, '{not json');
  r = bizFail(bad, base.slice(0), '损坏数据文件');
  assert.match(r.stderr, /已损坏/);
});
