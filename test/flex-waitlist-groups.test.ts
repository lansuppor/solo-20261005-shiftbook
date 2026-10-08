// shiftbook 弹性候补需求组（add-flex-waitlist --group）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，每条命令都是新进程，保存结果由新进程查询；
// - 覆盖：
//   组合回溯（前组须让出较小标识）与候选不足整体无解（各组各自可行但整体不行）、
//   登记忽略预约占用但扣除有效停用、最早开始优先与同一开始按组序资源标识字典序取舍、
//   候选书写顺序不影响结果、固定/旧式 --resource/--group 混合队列（受阻继续后项、
//   本轮后项新预约阻挡前项、端点相接可行）、缓冲跨窗（准备/整理伸出窗口仍须可用、
//   跨日）、兑现后改期到组外资源/取消均合法且原请求与关联保留、重复处理不重建、
//   后续停用只影响兑现不删候补、真实保存失败重试且标识未消费、新进程持久化与记录结构、
//   损坏候选组/状态/关联拒绝加载、旧文件（弹性候补无 groups）无需迁移、
//   用法错误退出 2；
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
const LONG_NAME = 'g'.repeat(250) + '.json';
const WIN = '2026-10-12T08:00/2026-10-12T18:00';

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-waitlist-groups-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  buffers: {prep?: string; teardown?: string} = {},
): void {
  const args = ['add-resource', '--type', '场地', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  if (buffers.prep !== undefined) args.push('--prep-minutes', buffers.prep);
  if (buffers.teardown !== undefined) args.push('--teardown-minutes', buffers.teardown);
  ok(df, args, `登记资源 ${name}`);
}

function addFlexGroup(df: string, groups: string[], window: string, duration: string, ctx: string): CliResult {
  const args = ['add-flex-waitlist', '--window', window, '--duration', duration];
  for (const g of groups) args.push('--group', g);
  return ok(df, args, ctx);
}

function booking(df: string, resources: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking', '--start', start, '--end', end];
  for (const id of resources) args.push('--resource', id);
  ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function writeStore(df: string, store: any): void {
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败不得改动数据文件（逐字节比对）`);
}

// 断言兑现输出：候补/预约两种标识、实际时间、按需求组顺序的所选资源
function assertFulfilled(
  r: CliResult,
  wId: string,
  bId: string,
  start: string,
  end: string,
  picks: string[],
  ctx: string,
  flat = false,
): void {
  assert.match(r.stdout, new RegExp(`兑现 ${wId}（弹性时段）→ 新预约 ${bId}`), `[${ctx}] 两种标识\n${r.stdout}`);
  assert.match(r.stdout, new RegExp(`实际时间: ${start} → ${end}`), `[${ctx}] 实际时间 ${start} → ${end}\n${r.stdout}`);
  if (flat) {
    // 全部单候选组（--resource 或 --group 仅给单候选组）：沿用平铺“资源:”写法
    const block = r.stdout.slice(r.stdout.indexOf(`兑现 ${wId}`));
    assert.match(block, new RegExp(`资源: ${picks.map(escapeRegExp).join('、')}`), `[${ctx}] 平铺资源行\n${block}`);
    assert.ok(!/第 1 需求组/.test(block), `[${ctx}] 单候选组不显示需求组行\n${block}`);
    return;
  }
  picks.forEach((id, i) => {
    assert.match(
      r.stdout,
      new RegExp(`第 ${i + 1} 需求组: ${id}（`),
      `[${ctx}] 第 ${i + 1} 组应选 ${id}\n${r.stdout}`,
    );
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 手工塞入一条候补记录（损坏数据/旧格式测试用）
function pushWaitlist(df: string, rec: Record<string, unknown>): void {
  const store = readStore(df);
  store.waitlistSeq = Math.max(store.waitlistSeq ?? 0, 1);
  store.waitlist.push(rec);
  writeStore(df, store);
}

const baseWaiting = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'W0001',
  kind: 'flexible',
  resourceIds: ['R0001'],
  start: '2026-10-12T08:00',
  end: '2026-10-12T18:00',
  durationMinutes: 60,
  status: 'waiting',
  seq: 1,
  ...over,
});

// ---------------------------------------------------------------------------
// 1. 组合回溯：登记忽略预约占用；处理时前组必须让出较小标识，端点相接可行；
//    组内候选书写顺序不影响结果
// ---------------------------------------------------------------------------

test('回溯：处理时前组让出小标识改选备选；登记忽略预约；端点相接可行；组内乱序结果一致', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // R0001 08:00-12:00 被既有预约占用
  booking(df, ['R0001'], '2026-10-12T08:00', '2026-10-12T12:00', 'B0001 占用 R0001 上午');

  // 第 2 组只有 R0001，第 1 组 [R0001,R0002]：登记忽略预约占用，
  // 存在组合（R0002,R0001）即放行（若按当前预约贪判会误拒）
  const reg = addFlexGroup(df, ['R0001,R0002', 'R0001'], WIN, '60', '登记 W0001');
  assert.match(reg.stdout, /已登记弹性时段候补 W0001/);

  // 组内候选倒序登记同内容（仍是独立一项候补 W0002）
  addFlexGroup(df, ['R0002,R0001', 'R0001'], WIN, '60', '乱序登记 W0002');

  // 处理：W0001 最早只能 12:00（R0001 预约 12:00 结束，左闭右开端点相接可行），
  // 必须第 1 组选 R0002、第 2 组选 R0001；逐组贪选 R0001 会让第 2 组无解
  const r1 = ok(df, ['process-waitlist'], '处理两项弹性组候补');
  assertFulfilled(r1, 'W0001', 'B0002', '2026-10-12T12:00', '2026-10-12T13:00', ['R0002', 'R0001'], 'W0001 回溯');
  // W0002 组内乱序不影响所选；R0001 12:00 空出但 R0002 已被 W0001 占到 13:00，
  // 故 W0002 最早 13:00，组合仍为 [R0002,R0001]
  assertFulfilled(r1, 'W0002', 'B0003', '2026-10-12T13:00', '2026-10-12T14:00', ['R0002', 'R0001'], 'W0002 乱序一致');

  const store = readStore(df);
  const b2 = store.bookings.find((x: any) => x.id === 'B0002');
  assert.deepEqual(b2.resourceIds, ['R0001', 'R0002'], '兑现预约资源为按组互异资源的并集（排序存储）');
  const w1 = store.waitlist.find((x: any) => x.id === 'W0001');
  assert.deepEqual(w1.groups, [['R0001', 'R0002'], ['R0001']], '候选组结构与组序持久化（组内排序）');
  assert.deepEqual(w1.resourceIds, ['R0001', 'R0002'], '资源并集持久化');
});

// ---------------------------------------------------------------------------
// 2. 候选不足整体无解（登记即拒绝，退出 1）：
//    同一资源无法满足两组、各组各自可行但整体选不出互异组合
// ---------------------------------------------------------------------------

test('候选不足：单资源两组必拒；各资源错峰开放使各组各自可行但整体无互异组合，登记拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // (a) 两组都只有 R0001：所选互异要求无法满足
  let r = bizFail(df, ['add-flex-waitlist', '--window', WIN, '--duration', '60', '--group', 'R0001', '--group', 'R0001'], '两组同一资源');
  assert.match(r.stderr, /不存在.*每个需求组恰选一个候选/);

  // (b) 停用把 R0002 整窗封闭：第 2 组 [R0002] 无候选可用
  ok(df, ['add-closure', '--resource', 'R0002', '--start', '2026-10-12T00:00', '--end', '2026-10-13T00:00'], '封闭 R0002');
  r = bizFail(
    df,
    ['add-flex-waitlist', '--window', WIN, '--duration', '60', '--group', 'R0001,R0002', '--group', 'R0002'],
    '第 2 组整组不可用',
  );
  assert.match(r.stderr, /第 2 需求组/);
  assert.match(r.stderr, /R0002[\s\S]*（无）/, '列出无可用区间的候选');
  ok(df, ['cancel-closure', 'C0001'], '解除 R0002 封闭');

  // (c) 错峰停用：任意时刻只有一个资源空闲（各 60 分钟段交替），单组各自可行，
  //     两组却选不出互不相同且同时连续 60 分钟的组合
  // R0001 可用 [08,09),[10,11)：停用 [09,10) [11,12)
  for (const [s, e] of [
    ['2026-10-12T09:00', '2026-10-12T10:00'],
    ['2026-10-12T11:00', '2026-10-12T12:00'],
  ] as Array<[string, string]>) {
    ok(df, ['add-closure', '--resource', 'R0001', '--start', s, '--end', e], `R0001 错峰停用 ${s}`);
  }
  // R0002 可用 [09,10),[11,12)：停用 [08,09) [10,11)
  for (const [s, e] of [
    ['2026-10-12T08:00', '2026-10-12T09:00'],
    ['2026-10-12T10:00', '2026-10-12T11:00'],
  ] as Array<[string, string]>) {
    ok(df, ['add-closure', '--resource', 'R0002', '--start', s, '--end', e], `R0002 错峰停用 ${s}`);
  }
  r = bizFail(
    df,
    ['add-flex-waitlist', '--window', '2026-10-12T08:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001,R0002', '--group', 'R0001,R0002'],
    '错峰：整体无互异组合',
  );
  assert.match(r.stderr, /不存在.*每个需求组恰选一个候选/);
  // 两个候选组各自在某些时段可行，诊断逐组逐资源列出可供区间
  assert.match(r.stderr, /第 1 需求组[\s\S]*R0001[\s\S]*R0002/);
  assert.match(r.stderr, /第 2 需求组[\s\S]*R0001[\s\S]*R0002/);

  const store = readStore(df);
  assert.equal(store.waitlist.length, 0, '登记失败不留候补');
});

// ---------------------------------------------------------------------------
// 3. 取舍：最早开始优先；同一最早开始按组序取资源标识字典序最小
// ---------------------------------------------------------------------------

test('取舍：更早开始优先；同一最早开始按组序取字典序最小序列', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '晚开放', [['2026-10-12T10:00', '2026-10-12T20:00']]); // R0001
  addResource(df, '早开放乙', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002
  addResource(df, '早开放丙', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0003

  // (a) 单组：R0001 标识小但 10:00 才可用，取 08:00 的 R0002
  addFlexGroup(df, ['R0001,R0002'], '2026-10-12T08:00/2026-10-12T12:00', '60', 'W0001 登记');
  // (b) 两组同候选：同一 08:00 两组合 [R2,R3]/[R3,R2]，取字典序 [R2,R3]
  addFlexGroup(df, ['R0003,R0002', 'R0002,R0003'], '2026-10-12T08:00/2026-10-12T12:00', '60', 'W0002 乱序登记');

  const r = ok(df, ['process-waitlist'], '按序兑现两项');
  assertFulfilled(r, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002'], '更早开始优先');
  // W0002 候选与 W0001 仅 R0002 相交：W0001 占 R0002 08-09，
  // W0002 08:00 仍可取 [R0003,R0003]? 不允许互异 -> [R0003,R0002] 要求 R0002 08 可用被占；
  // [R0002,R0003] 同理。故顺延到 09:00 取字典序最小 [R0002,R0003]
  assertFulfilled(r, 'W0002', 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0002', 'R0003'], '同开始字典序最小');
});

// ---------------------------------------------------------------------------
// 4. 混合队列：固定项 / 旧式 --resource 弹性项 / --group 弹性项共用登记顺序；
//    受阻继续后项，本轮后项的新预约阻挡前项，先选项不为后项重选或移动
// ---------------------------------------------------------------------------

test('混合队列：受阻继续后项；本轮新预约列入前项阻挡；固定与两种弹性按登记顺序处理与展示', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // 既有预约占用 R0001 10:00-11:00
  booking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // W0001 固定候补：R0001+R0002 活动 10:30-11:30（被 B0001 挡，且将被本轮 W0002 的新预约挡 R0002）
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--resource', 'R0002', '--start', '2026-10-12T10:30', '--end', '2026-10-12T11:30'],
    'W0001 固定候补',
  );
  // W0002 --group：第 1 组 [R0001,R0002]，窗口 10:00-12:00 60 分钟 -> 08? 窗口 10 起，
  // R0001 10-11 被占，R0002 空闲 -> 最早 10:00 选 R0002
  addFlexGroup(df, ['R0001,R0002'], '2026-10-12T10:00/2026-10-12T12:00', '60', 'W0002 组候补');
  // W0003 旧式 --resource 弹性候补：R0001 窗口 10-12 60 -> 11:00 可兑现
  ok(
    df,
    ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T12:00', '--duration', '60'],
    'W0003 旧式弹性候补',
  );

  const before = readStore(df);
  assert.deepEqual(before.waitlist.map((w: any) => w.seq), [1, 2, 3], '共用登记顺序');

  const r = ok(df, ['process-waitlist'], '处理混合队列');
  assert.match(r.stdout, /本轮兑现 2 项，\s*\n?1 项继续等待/);
  // 展示严格按队列顺序：W0001 受阻、W0002 兑现、W0003 兑现
  const i1 = r.stdout.indexOf('继续等待 W0001');
  const i2 = r.stdout.indexOf('兑现 W0002');
  const i3 = r.stdout.indexOf('兑现 W0003');
  assert.ok(i1 >= 0 && i1 < i2 && i2 < i3, '结果按登记顺序展示');
  assertFulfilled(r, 'W0002', 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], 'W0002 选 R0002');
  assert.match(r.stdout, /兑现 W0003（弹性时段）→ 新预约 B0003/);
  assert.match(r.stdout, /实际时间: 2026-10-12T11:00 → 2026-10-12T12:00/);
  // 旧式 --resource 兑现沿用平铺“资源:”，不显示需求组行
  const w3Block = r.stdout.slice(r.stdout.indexOf('兑现 W0003'));
  assert.match(w3Block, /资源: R0001（甲）/);
  assert.ok(!/第 1 需求组/.test(w3Block), '旧式兑现不显示需求组行');

  // 受阻固定项诊断：既有预约 B0001 与本轮新预约 B0002（兑现自 W0002）都列出
  const w1Block = r.stdout.slice(i1, i2);
  assert.match(w1Block, /B0001/, '列既有阻挡预约');
  assert.match(w1Block, /B0002（本轮新预约，兑现自候补 W0002）/, '列本轮后项产生的预约');

  // W0001 仍等待，W0002/W0003 已兑现且关联
  const store = readStore(df);
  const w1 = store.waitlist.find((x: any) => x.id === 'W0001');
  assert.equal(w1.status, 'waiting');
  assert.equal(w1.bookingId, undefined);
  assert.equal(store.waitlist.find((x: any) => x.id === 'W0002').bookingId, 'B0002');
  assert.equal(store.waitlist.find((x: any) => x.id === 'W0003').bookingId, 'B0003');

  // 再次处理：无可兑现项退出 0、不写文件、不推进计数
  const bytes = readFileSync(df);
  const r2 = ok(df, ['process-waitlist'], '重复处理无等待可兑现');
  assert.match(r2.stdout, /没有可兑现项|没有等待中的候补/);
  assertFileBytes(df, bytes, '无兑现不写文件');
});

// ---------------------------------------------------------------------------
// 5. 缓冲跨窗：准备/整理可伸出窗口但须实际可用；跨日；不足拒绝登记
// ---------------------------------------------------------------------------

test('缓冲跨窗：最早活动含前后预留、整理伸出窗口、跨日；伸出部分不可用拒绝登记', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // R0001：09:00 开放、准备 30、整理 30
  addResource(df, '甲', [['2026-10-12T09:00', '2026-10-13T18:00']], {prep: '30', teardown: '30'});

  // 窗口 09:00-10:00 时长 30：最早活动 09:30（准备 30），结束 10:00 整理伸到 10:30（开放内）
  addFlexGroup(df, ['R0001'], '2026-10-12T09:00/2026-10-12T10:00', '30', 'W0001 缓冲跨窗');
  const r1 = ok(df, ['process-waitlist'], 'W0001 兑现');
  assertFulfilled(r1, 'W0001', 'B0001', '2026-10-12T09:30', '2026-10-12T10:00', ['R0001'], '准备顶推开始', true);

  // 跨日窗口：活动 23:30-00:00，整理伸到次日 00:30（在开放内）；准备 23:00 同在开放内
  addFlexGroup(df, ['R0001'], '2026-10-12T23:30/2026-10-13T00:30', '30', 'W0002 跨日');
  const r2 = ok(df, ['process-waitlist'], 'W0002 跨日兑现');
  assertFulfilled(r2, 'W0002', 'B0002', '2026-10-12T23:30', '2026-10-13T00:00', ['R0001'], '跨日活动', true);

  // R0002 仅 09:00-09:30 开放、整理 30：窗口 09:00-10:00 时长 30，
  // 活动结束即便 09:30，整理需到 10:00 而开放 09:30 结束 -> 伸出部分不可用 -> 拒绝登记
  addResource(df, '短开放', [['2026-10-12T09:00', '2026-10-12T09:30']], {teardown: '30'});
  const r3 = bizFail(
    df,
    ['add-flex-waitlist', '--window', '2026-10-12T09:00/2026-10-12T10:00', '--duration', '30', '--group', 'R0002'],
    '整理伸出窗口但无可用时间',
  );
  assert.match(r3.stderr, /不存在.*每个需求组恰选一个候选/);
  assert.match(r3.stderr, /R0002[\s\S]*（无）/);
});

// ---------------------------------------------------------------------------
// 6. 兑现后改期到候选组外资源、取消均合法；原请求/候选组/关联保留，
//    list-waitlist 显示关联预约当前时间、状态、完整资源；重复处理不重建
// ---------------------------------------------------------------------------

test('兑现后组外改期与取消：原请求不改、不恢复等待；list-waitlist 显示当前状态；重复处理不重建', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003（候选组之外）

  addFlexGroup(df, ['R0001,R0002'], WIN, '60', 'W0001');
  const r1 = ok(df, ['process-waitlist'], '兑现 B0001=R0001');
  assertFulfilled(r1, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001'], '兑现');

  // 改期到组外资源 R0003 且改时间：合法
  ok(
    df,
    ['reschedule-booking', 'B0001', '--resource', 'R0003', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'],
    '改期到组外资源',
  );
  const list1 = ok(df, ['list-waitlist'], '查询：显示当前时间/状态/资源');
  assert.match(list1.stdout, /W0001 \[已兑现\]/);
  assert.match(list1.stdout, /兑现预约: B0001 \[有效\]（实际 2026-10-12T15:00 → 2026-10-12T16:00）/);
  assert.match(list1.stdout, /兑现预约当前资源: R0003（丙）/);
  // 原请求与候选组保持不变
  assert.match(list1.stdout, /弹性窗口 2026-10-12T08:00 → 2026-10-12T18:00（所需连续时长 60 分钟）/);
  assert.match(list1.stdout, /第 1 需求组: R0001（甲）、R0002（乙）/);

  // 重复处理不重建预约
  const bytes = readFileSync(df);
  const proc = ok(df, ['process-waitlist'], '重复处理无等待项');
  assert.match(proc.stdout, /没有等待中的候补/);
  assertFileBytes(df, bytes, '重复处理不写文件');
  const store1 = readStore(df);
  assert.equal(store1.bookings.length, 1, '不重复创建预约');

  // 取消关联预约合法；候补仍已兑现、不恢复等待
  ok(df, ['cancel-booking', 'B0001'], '取消兑现预约');
  const list2 = ok(df, ['list-waitlist'], '查询：关联预约已取消');
  assert.match(list2.stdout, /兑现预约: B0001 \[已取消\]（实际 2026-10-12T15:00 → 2026-10-12T16:00）/);
  assert.match(list2.stdout, /兑现预约当前资源: R0003（丙）/);
  // 已兑现候补不能取消（即使关联预约已取消）
  const rc = bizFail(df, ['cancel-waitlist', 'W0001'], '已兑现候补不可取消');
  assert.match(rc.stderr, /已兑现/);
  // 再次处理仍不重建
  ok(df, ['process-waitlist'], '取消预约后处理仍不重建');
  const store2 = readStore(df);
  assert.equal(store2.bookings.filter((b: any) => b.status === 'active').length, 0, '不补建预约');
  assert.equal(store2.waitlist[0].status, 'fulfilled', '候补不恢复等待');
  assert.equal(store2.waitlist[0].bookingId, 'B0001', '关联保留');
  assert.deepEqual(store2.waitlist[0].groups, [['R0001', 'R0002']], '候选组保留');
});

// ---------------------------------------------------------------------------
// 7. 后续停用只影响兑现：登记后停用致无完整组合 -> 受阻但不删候补/不判损坏；
//    取消停用后再次处理兑现
// ---------------------------------------------------------------------------

test('后续停用：受阻提示无完整可行组合且候补保留；取消停用后处理兑现', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // 两组都只有同一对候选：登记时可行（[R1,R2]）
  addFlexGroup(df, ['R0001,R0002', 'R0001,R0002'], WIN, '60', 'W0001');
  // 停用封死 R0001 整窗：任意时刻两组只能都选 R0002 -> 不互异 -> 无组合
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T00:00', '--end', '2026-10-13T00:00'], '封闭 R0001');

  const r1 = ok(df, ['process-waitlist'], '本轮无可兑现项，退出 0');
  assert.match(r1.stdout, /没有可兑现项/);
  assert.match(r1.stdout, /继续等待 W0001/);
  assert.match(r1.stdout, /无完整可行组合/);
  const store1 = readStore(df);
  assert.equal(store1.waitlist[0].status, 'waiting', '候补保留等待');
  assert.equal(store1.bookings.length, 0, '不创建预约');

  // 取消停用后处理即兑现
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  const r2 = ok(df, ['process-waitlist'], '停用解除后兑现');
  assertFulfilled(r2, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001', 'R0002'], '停用解除兑现');
});

// ---------------------------------------------------------------------------
// 8. 真实保存失败与重试：登记/处理失败不留部分记录、状态或计数，标识未消费；
//    换可写位置重试成功（新进程查询持久结果）
// ---------------------------------------------------------------------------

test('真实保存失败：登记与处理失败逐字节保留且标识未消费，重试成功', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // 登记阶段保存失败（255 字节文件名，临时文件名超限）
  const origBytes = readFileSync(df);
  const longReg = join(dir, LONG_NAME);
  writeFileSync(longReg, origBytes);
  const args = ['add-flex-waitlist', '--window', WIN, '--duration', '60', '--group', 'R0001,R0002', '--group', 'R0001'];
  let r = bizFail(longReg, args, '登记保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/);
  assertFileBytes(longReg, origBytes, '登记失败逐字节保留');
  let store = readStore(longReg);
  assert.equal(store.waitlistSeq ?? 0, 0, '候补计数未消费');

  // 可写位置重试登记：分配 W0001（失败尝试未消费序号）
  const regFile = join(dir, 'reg.json');
  writeFileSync(regFile, origBytes);
  const reg = ok(regFile, args, '可写位置重试登记');
  assert.match(reg.stdout, /W0001/, '重试仍分配 W0001');

  // 处理阶段保存失败：预约与候补状态原子保存，二者都不变
  const regBytes = readFileSync(regFile);
  const longProc = join(dir, 'h'.repeat(249) + '.json');
  writeFileSync(longProc, regBytes);
  r = bizFail(longProc, ['process-waitlist'], '处理保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/);
  assertFileBytes(longProc, regBytes, '处理失败逐字节保留');
  store = readStore(longProc);
  assert.equal(store.bookings.length, 0, '不留部分预约');
  assert.equal(store.bookingSeq, 0, '预约计数未消费');
  assert.equal(store.waitlist[0].status, 'waiting', '候补状态不变');
  assert.equal(store.waitlist[0].bookingId, undefined, '不写关联');

  // 新进程、可写位置重试处理：兑现 B0001（标识未消费），持久结果可查
  const procFile = join(dir, 'proc.json');
  writeFileSync(procFile, regBytes);
  const proc = ok(procFile, ['process-waitlist'], '可写位置重试处理');
  assertFulfilled(proc, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002', 'R0001'], '重试兑现');
  const finalStore = readStore(procFile);
  assert.equal(finalStore.bookings[0].id, 'B0001', '预约标识未被失败尝试消费');
  assert.equal(finalStoreWaitlist(finalStore), 'fulfilled');
});
function finalStoreWaitlist(s: any): string {
  return s.waitlist[0].status;
}

// ---------------------------------------------------------------------------
// 9. 损坏数据拒绝加载：候选组结构/状态/关联非法；旧文件（弹性候补无 groups）兼容
// ---------------------------------------------------------------------------

test('损坏候选组/状态/关联拒绝加载且保留原文件；旧格式弹性候补无需迁移', (t) => {
  const dir = tempDir(t);

  const corruptCases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['groups 不是数组', baseWaiting({groups: 'R0001'}), /groups 必须是非空数组/],
    ['groups 为空', baseWaiting({groups: []}), /groups 必须是非空数组/],
    ['组内重复', baseWaiting({resourceIds: ['R0001'], groups: [['R0001', 'R0001']]}), /候选资源重复/],
    ['组内未知资源', baseWaiting({resourceIds: ['R0001', 'R0002'], groups: [['R0001', 'R0009']]}), /引用了未知资源/],
    ['并集与 resourceIds 不一致', baseWaiting({resourceIds: ['R0001', 'R0002'], groups: [['R0001']]}), /并集与 resourceIds 不一致/],
    ['固定候补携带 groups', baseWaiting({kind: 'fixed', groups: [['R0001']], durationMinutes: undefined}), /固定时段候补不应携带 groups/],
    ['状态非法', baseWaiting({status: 'done'}), /status 非法/],
    ['已兑现缺关联', baseWaiting({status: 'fulfilled'}), /已兑现但缺少关联预约标识/],
  ];

  for (const [name, rec, re] of corruptCases) {
    const df = join(dir, `bad-${encodeURIComponent(name)}.json`);
    writeFileSync(df, JSON.stringify({
      version: 1,
      resources: [
        {id: 'R0001', type: 'venue', name: '甲', open: [['2026-01-01T00:00', '2027-01-01T00:00']]},
        {id: 'R0002', type: 'venue', name: '乙', open: [['2026-01-01T00:00', '2027-01-01T00:00']]},
      ],
      bookings: [],
      waitlist: [],
    }) + '\n', 'utf8');
    pushWaitlist(df, rec);
    const bytes = readFileSync(df);
    const r = bizFail(df, ['list-waitlist'], `损坏数据：${name}`);
    assert.match(r.stderr, re, `[${name}] 损坏原因\n${r.stderr}`);
    assertFileBytes(df, bytes, `[${name}] 原文件保留`);
  }

  // 旧格式：弹性候补无 groups 字段 -> 按旧式 --resource（全部资源同时可用）处理，不补造字段
  const old = join(dir, 'old.json');
  writeFileSync(old, JSON.stringify({
    version: 1,
    resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
    bookings: [],
    waitlist: [],
  }) + '\n', 'utf8');
  pushWaitlist(old, baseWaiting()); // 不含 groups
  const oldBytes = readFileSync(old);
  const list = ok(old, ['list-waitlist'], '旧文件可列（平铺资源行）');
  assert.match(list.stdout, /资源: R0001（旧会议室）/);
  assertFileBytes(old, oldBytes, '查询不改旧文件');
  const proc = ok(old, ['process-waitlist'], '旧文件候补可兑现');
  assert.match(proc.stdout, /兑现 W0001（弹性时段）→ 新预约 B0001/);
  assert.match(proc.stdout, /资源: R0001（旧会议室）/);
});

// ---------------------------------------------------------------------------
// 10. 用法错误退出 2；同内容重复登记为独立项；查询入口持久化由新进程读取
// ---------------------------------------------------------------------------

test('用法错误退出 2；重复登记独立排队；新进程持久读取候选组与资源并集', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  usageFail(df, ['add-flex-waitlist', '--window', WIN, '--duration', '60'], '资源与组均缺');
  usageFail(
    df,
    ['add-flex-waitlist', '--resource', 'R0001', '--group', 'R0001', '--window', WIN, '--duration', '60'],
    '--resource 与 --group 互斥',
  );
  usageFail(
    df,
    ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '60', '多余'],
    '多余位置参数',
  );
  usageFail(
    df,
    ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '60', '--bogus', 'x'],
    '未知选项',
  );
});

// 需要 R0002 才能登记成功：在独立测试内补登记资源并重复上面的正常流程
test('用法与持久化：组内乱序重复登记为独立项，记录排序落盘，新进程读取一致', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  addFlexGroup(df, ['R0002,R0001', 'R0001'], WIN, '60', 'W0001 乱序');
  addFlexGroup(df, ['R0001,R0002', 'R0001'], WIN, '60', 'W0002 顺序');
  const list = ok(df, ['list-waitlist'], '新进程查询两条独立候补');
  assert.match(list.stdout, /W0001 \[等待中\][\s\S]*W0002 \[等待中\]/);

  const store = readStore(df);
  assert.equal(store.waitlist.length, 2, '重复内容是独立项');
  for (const w of store.waitlist) {
    assert.deepEqual(w.groups, [['R0001', 'R0002'], ['R0001']], '组内排序、组序持久');
    assert.deepEqual(w.resourceIds, ['R0001', 'R0002'], '资源并集排序持久');
  }
  assert.equal(store.waitlistSeq, 2);

  // 登记成功输出按组展示候选（单组多候选）
  const reg = addFlexGroup(df, ['R0001,R0002'], WIN, '60', 'W0003 单组多候选');
  assert.match(reg.stdout, /第 1 需求组: R0001（甲）、R0002（乙）/);
  // 持久化：单组多候选是一个需求组
  const store2 = readStore(df);
  assert.deepEqual(store2.waitlist[2].groups, [['R0001', 'R0002']], '单组多候选结构持久');
});
