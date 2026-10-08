// shiftbook 弹性候补“候选需求组（--group）”写法自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询；
// - 覆盖：
//   1) 组合回溯（前组让出较小标识）与候选不足整体无解（登记拒绝、处理受阻）；
//   2) 最早活动开始优先、同一开始按组序资源标识字符串字典序取舍，候选书写顺序无关；
//   3) 固定/旧式弹性/组合弹性混合队列：受阻不阻挡后项，绝不为多兑现重选或移动前项；
//   4) 缓冲（准备/整理）伸出窗口仍须实际可用；
//   5) 兑现预约改期、换到组外资源、取消均合法，候补原请求与关联不变、不恢复等待；
//   6) 登记/处理的真实保存失败与重试（标识未消费、不留部分记录或状态）；
//   7) 新进程持久查询（候选组结构、组序、状态与关联）、旧文件兼容与损坏拒绝。
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存临时文件（<名>.<pid>.tmp）必然超长，可重复触发真实保存失败
const LONG_NAME = 'f'.repeat(250) + '.json';
const WIN = '2026-10-12T08:00/2026-10-12T18:00';

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-waitlist-groups-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  buf: {prep?: string; teardown?: string} = {},
): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  if (buf.prep !== undefined) args.push('--prep-minutes', buf.prep);
  if (buf.teardown !== undefined) args.push('--teardown-minutes', buf.teardown);
  ok(df, args, `登记资源 ${name}`);
}

function addFlexGroup(
  df: string,
  groups: string[],
  window: string,
  duration: string,
  ctx: string,
): CliResult {
  const args = ['add-flex-waitlist', '--window', window, '--duration', duration];
  for (const g of groups) args.push('--group', g);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

// 断言某条“兑现”输出：实际时间与按需求组顺序的所选资源
function assertFulfillment(
  stdout: string,
  wid: string,
  bid: string,
  start: string,
  end: string,
  picks: string[],
  ctx: string,
): void {
  const block = stdout.slice(stdout.indexOf(`兑现 ${wid}`));
  assert.match(block, new RegExp(`兑现 ${wid}（弹性时段）→ 新预约 ${bid}`), `[${ctx}] 兑现行\n${stdout}`);
  assert.match(block, new RegExp(`实际时间: ${start} → ${end}`), `[${ctx}] 实际时间\n${stdout}`);
  picks.forEach((id, i) => {
    assert.match(block, new RegExp(`第 ${i + 1} 组: ${id}（`), `[${ctx}] 第 ${i + 1} 组应选 ${id}\n${stdout}`);
  });
}

// ---------------------------------------------------------------------------
// 1. 组合回溯：前组必须让出较小标识；候选书写顺序不影响结果
// ---------------------------------------------------------------------------

test('组合回溯：前组让出较小标识；组内候选顺序不影响结果', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 登记忽略预约占用：此时无任何预约也可登记
  addFlexGroup(df, ['R0001,R0002', 'R0001'], WIN, '60', '登记组合候补');
  // 第 1 组贪选 R0001 会使第 2 组（只有 R0001）无互异可选 -> 处理时须回溯为 [R0002,R0001]
  // 先占住 R0002 的更早备选，以验证“最早开始 + 组合”取舍：占 R0002 08:00-10:00
  ok(
    df,
    ['create-booking', '--resource', 'R0002', '--start', '2026-10-12T08:00', '--end', '2026-10-12T10:00'],
    '占住 R0002 08-10',
  );
  // 08:00 时 [R0002,R0001] 不可行（R0002 被占），但 R0001 空闲 -> 回溯也无解于 08:00；
  // 10:00 起 [R0002,R0001] 可行
  const proc = ok(df, ['process-waitlist'], '处理（回溯至 10:00）');
  assertFulfillment(proc.stdout, 'W0001', 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002', 'R0001'], '回溯兑现');

  // 组内候选倒序登记另一条；第一条兑现后占住 R0001/R0002 的 10-11，故本条顺延至 11:00，组合一致
  addFlexGroup(df, ['R0002,R0001', 'R0001'], WIN, '60', '倒序登记');
  const proc2 = ok(df, ['process-waitlist'], '处理倒序项');
  assertFulfillment(proc2.stdout, 'W0002', 'B0003', '2026-10-12T11:00', '2026-10-12T12:00', ['R0002', 'R0001'], '倒序组合一致');

  // 新进程持久查询：记录保留候选组与组序
  const wl = ok(df, ['list-waitlist'], '新进程查询');
  assert.match(wl.stdout, /第 1 组: R0001（[^）]*）、R0002（/);
  assert.match(wl.stdout, /第 2 组: R0001（/);
});

// ---------------------------------------------------------------------------
// 2. 候选不足：登记时拒绝（停用导致无完整组合）；处理受阻提示“无完整可行组合”
// ---------------------------------------------------------------------------

test('候选不足：登记时无完整组合拒绝并诊断；处理受阻继续等待且不推进计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // (a) 两组都只有 R0001：所选必须互异 -> 任何窗口都无完整组合，登记即拒绝
  const r1 = bizFail(df, ['add-flex-waitlist', '--group', 'R0001', '--group', 'R0001', '--window', WIN, '--duration', '60'], '两组同一资源');
  assert.match(r1.stderr, /不存在能同时满足全部 2 个需求组的完整组合/);
  assert.equal(readStore(df).waitlistSeq, 0, '登记拒绝不消费候补标识');

  // (b) 停用 R0001 整个窗口：[R0001,R0002],[R0001] 无完整组合 -> 登记拒绝（忽略预约但不忽略停用）
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T18:00'],
    '窗口内停用 R0001',
  );
  const r2 = bizFail(df, ['add-flex-waitlist', '--group', 'R0001,R0002', '--group', 'R0001', '--window', '2026-10-12T09:00/2026-10-12T12:00', '--duration', '60'], '停用致无完整组合');
  assert.match(r2.stderr, /R0001（一号会议室）/);
  assert.match(r2.stderr, /（空集：窗口内无任何可供活动时间）/);
  assert.equal(readStore(df).waitlistSeq, 0, '停用拒绝不消费候补标识');

  // (c) 登记可行后，预约把窗口占成无完整组合：处理受阻（退出 0），明确提示无完整可行组合
  ok(df, ['cancel-closure', 'C0001'], '取消停用以便登记');
  addFlexGroup(df, ['R0001,R0002', 'R0001'], WIN, '60', '登记 W0001');
  // R0001 全程被占：第 2 组只有 R0001 -> 无完整组合
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T18:00'],
    '占满 R0001',
  );
  const bytesBefore = readFileSync(df);
  const proc = ok(df, ['process-waitlist'], '处理受阻');
  assert.match(proc.stdout, /没有可兑现项/);
  assert.match(proc.stdout, /继续等待 W0001/);
  assert.match(proc.stdout, /窗口内无完整可行组合/);
  // 不写文件、不推进计数
  assert.ok(bytesBefore.equals(readFileSync(df)), '无可兑现项不写数据文件');
  const s = readStore(df);
  assert.equal(s.waitlist[0].status, 'waiting');
  assert.equal(s.bookingSeq, 1, '不推进预约计数');
});

// ---------------------------------------------------------------------------
// 3. 取舍：更早开始优先；同一最早开始按组序取资源标识字典序最小组合
// ---------------------------------------------------------------------------

test('取舍：更早开始优先于小标识；同一最早开始取字典序最小组合', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '晚开放', [['2026-10-12T10:00', '2026-10-12T20:00']]); // R0001 10:00 起
  addResource(df, '早开放甲'); // R0002
  addResource(df, '早开放乙'); // R0003

  // 单组 [R0001,R0002]：R0002 08:00 即可用，早于 R0001 的 10:00 -> 取 R0002@08:00
  addFlexGroup(df, ['R0001,R0002'], WIN, '60', '更早开始优先（登记）');
  let proc = ok(df, ['process-waitlist'], '更早开始优先（处理）');
  assertFulfillment(proc.stdout, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002'], '更早开始优先');

  // 两组同候选且都 08:00 可用：同开始多个组合，取字典序最小 [R0002,R0003]。
  // 上一条已占 R0002 的 08-09，故本条最早开始顺延至 09:00，组合仍为 [R0002,R0003]
  addFlexGroup(df, ['R0003,R0002', 'R0002,R0003'], WIN, '60', '同开始取舍（倒序登记）');
  proc = ok(df, ['process-waitlist'], '同开始取舍（处理）');
  assertFulfillment(proc.stdout, 'W0002', 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0002', 'R0003'], '字典序最小');
});

// ---------------------------------------------------------------------------
// 4. 混合队列：固定 / 旧式弹性 / 组合弹性共用顺序；受阻不阻挡后项；
//    前项一旦本轮选中即占用，后项看到其占用；绝不为多兑现移动前项
// ---------------------------------------------------------------------------

test('混合队列：受阻继续后项；本轮已选占用阻挡后项；不为多兑现重排前项', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  addResource(df, '三号会议室'); // R0003

  // W0001 固定候补：R0001 10:00-11:00
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '登记固定 W0001');
  // W0002 旧式多资源弹性候补：R0001+R0002，dur 60
  ok(df, ['add-flex-waitlist', '--resource', 'R0001', '--resource', 'R0002', '--window', WIN, '--duration', '60'], '登记旧式弹性 W0002');
  // W0003 组合弹性候补：[R0001,R0002,R0003],[R0001,R0002] dur 60
  addFlexGroup(df, ['R0001,R0002,R0003', 'R0001,R0002'], WIN, '60', '登记组合 W0003');

  // R0001 10:00-11:00 被既有预约占用：W0001 固定受阻；W0002 共同空闲最早只能 11:00（R0001 11 点才空）；
  // W0003 08:00 即可选互异 [R0002,R0001? no R0001 10 点才空]
  //   08:00 时 R0001 被占（既有预约仅 10-11），故 08:00 R0001 空闲：既有预约是 10:00-11:00，
  //   08:00 R0001 空闲 -> W0003 08:00 可选 [R0001,R0002]。
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    '既有预约占 R0001 10-11',
  );

  const proc = ok(df, ['process-waitlist'], '混合处理');
  // W0001 受阻（固定）
  assert.match(proc.stdout, /继续等待 W0001（固定时段）/);
  // W0002 08:00 即兑现（既有预约仅占 10-11；R0001 与 R0002 08 点共同空闲）
  assertFulfillment(proc.stdout, 'W0002', 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', [], 'W0002 旧式兑现 08:00');
  assert.match(proc.stdout, /资源: R0001（一号会议室）、R0002（二号会议室）/);
  // W0003 看到本轮 W0002 的新预约占住 R0001/R0002 的 08-09，顺延至 09:00，组合字典序最小 [R0001,R0002]
  assertFulfillment(proc.stdout, 'W0003', 'B0003', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001', 'R0002'], 'W0003 避开本轮占用 09:00');

  // 展示顺序严格按登记顺序（W0001 的“继续等待”在 W0002 兑现之前）
  assert.ok(
    proc.stdout.indexOf('继续等待 W0001') < proc.stdout.indexOf('兑现 W0002'),
    '结果按登记顺序展示',
  );

  // 再次处理：只剩 W0001，仍受阻则退出 0、不写文件、不推进计数
  const bytesBefore = readFileSync(df);
  const proc2 = ok(df, ['process-waitlist'], '再次处理无兑现');
  assert.match(proc2.stdout, /没有可兑现项/);
  assert.ok(bytesBefore.equals(readFileSync(df)), '无兑现不写文件');
  assert.equal(readStore(df).bookingSeq, 3, '计数不推进');
});

// ---------------------------------------------------------------------------
// 5. 本轮已选占用：先选中项占住资源，后项组合须避开；候选书写顺序不影响
// ---------------------------------------------------------------------------

test('本轮已选占用：后项组合避开先选新预约；候选项取最早开始+字典序', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 两条相同的单组候补 [R0001,R0002]：W0001 选字典序最小 R0001@08:00；
  // W0002 看到本轮 R0001 08-09 被占 -> 同开始 08:00 改选 R0002
  addFlexGroup(df, ['R0001,R0002'], WIN, '60', '登记 W0001');
  addFlexGroup(df, ['R0002,R0001'], WIN, '60', '登记 W0002（倒序）');
  const proc = ok(df, ['process-waitlist'], '同轮处理两项');
  assertFulfillment(proc.stdout, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001'], 'W0001 选 R0001');
  assertFulfillment(proc.stdout, 'W0002', 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002'], 'W0002 避开 R0001');
});

// ---------------------------------------------------------------------------
// 6. 缓冲跨窗：准备/整理可伸出窗口但伸出部分仍须实际可用；端点相接可行
// ---------------------------------------------------------------------------

test('缓冲跨窗：整理伸出窗口须实际可用；开放不足时无完整组合', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // R0001 开放到 12:30、整理 30 分钟；R0002 全天开放
  addResource(df, '跨窗房', [['2026-10-12T08:00', '2026-10-12T12:30']], {teardown: '30'}); // R0001
  addResource(df, '全日房'); // R0002

  // 既有预约占 R0001 活动 08:00-10:00（实际占用至 10:30）：R0001 活动空闲自 10:30 起。
  // 窗口 08:00-11:30、dur 60：最早活动 10:30-11:30，活动结束恰为窗口端点，
  // 整理伸出窗口至 12:00——开放到 12:30，伸出部分实际可用 -> 可行
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T10:00'],
    '占 R0001 至整理后 10:30',
  );
  addFlexGroup(df, ['R0001', 'R0002'], '2026-10-12T08:00/2026-10-12T11:30', '60', '登记跨窗组合候补');
  const proc = ok(df, ['process-waitlist'], '缓冲跨窗处理');
  assertFulfillment(proc.stdout, 'W0001', 'B0002', '2026-10-12T10:30', '2026-10-12T11:30', ['R0001', 'R0002'], '缓冲跨窗 10:30');

  // R0003 仅开放到 12:30、整理 30：窗口 11:00-12:30、dur 60 登记可过（活动 11:00-12:00，
  // 整理至 12:30 恰在开放内）；随后新建预约占住 R0003 活动 11:00-12:00（实际占用至
  // 12:30），处理时该组无完整组合
  addResource(df, '早关房', [['2026-10-12T08:00', '2026-10-12T12:30']], {teardown: '30'}); // R0003
  addFlexGroup(df, ['R0003', 'R0002'], '2026-10-12T11:00/2026-10-12T12:30', '60', '登记 W0002');
  ok(
    df,
    ['create-booking', '--resource', 'R0003', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '随后占住 R0003 11-12（占用至 12:30）',
  );
  const proc2 = ok(df, ['process-waitlist'], '预约致无完整组合而受阻');
  assert.match(proc2.stdout, /继续等待 W0002/);
  assert.match(proc2.stdout, /窗口内无完整可行组合/);
  assert.match(proc2.stdout, /R0003（早关房）/);
});

// ---------------------------------------------------------------------------
// 7. 兑现后：改期、换到组外资源、取消均合法；候补原请求与关联不变、不恢复等待；
//    重复处理不再创建；新进程持久查询
// ---------------------------------------------------------------------------

test('兑现后组外改期/取消：候补原请求、候选组与关联保留，不恢复等待，重复处理不重建', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  addResource(df, '三号会议室'); // R0003

  addFlexGroup(df, ['R0001,R0002', 'R0001,R0002'], WIN, '60', '登记组合候补');
  ok(df, ['process-waitlist'], '兑现 -> [R0001,R0002]');
  const bid = `B${String(readStore(df).bookingSeq).padStart(4, '0')}`;
  assert.equal(bid, 'B0001');

  // 换到组外资源（只用 R0003，既非组合也改变了资源数）——合法
  ok(
    df,
    ['reschedule-booking', bid, '--resource', 'R0003', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    '组外改期',
  );
  let wl = ok(df, ['list-waitlist'], '新进程查询（组外改期后）');
  assert.match(wl.stdout, /W0001 \[已兑现\]/);
  assert.match(wl.stdout, /候选需求组/); // 原候选组与组序保留
  assert.match(wl.stdout, new RegExp(`兑现预约: ${bid} \\[有效\\]（当前实际 2026-10-12T14:00 → 2026-10-12T15:00；完整资源: R0003`));

  // 取消预约：候补仍为已兑现，不恢复等待，重复处理不重建
  ok(df, ['cancel-booking', bid], '取消兑现预约');
  wl = ok(df, ['list-waitlist'], '新进程查询（取消后）');
  assert.match(wl.stdout, new RegExp(`兑现预约: ${bid} \\[已取消\\]`));
  assert.match(wl.stdout, /W0001 \[已兑现\]/);
  const before = readStore(df).bookingSeq;
  const proc = ok(df, ['process-waitlist'], '重复处理不重建');
  assert.match(proc.stdout, /没有等待中的候补/);
  assert.equal(readStore(df).bookingSeq, before, '不新建预约');

  // 取消已兑现候补仍失败（规则不变）
  const r = bizFail(df, ['cancel-waitlist', 'W0001'], '取消已兑现候补失败');
  assert.match(r.stderr, /已兑现/);

  // 落盘记录：groups 保留、status=fulfilled、bookingId 关联仍在
  const rec = readStore(df).waitlist.find((w: any) => w.id === 'W0001');
  assert.deepEqual(rec.groups, [['R0001', 'R0002'], ['R0001', 'R0002']], '候选组与组序持久保留');
  assert.equal(rec.bookingId, bid);
});

// ---------------------------------------------------------------------------
// 8. 后续停用只影响兑现，不删除候补、不判损坏
// ---------------------------------------------------------------------------

test('后续停用：等待项受阻但记录完好；取消停用后再处理可兑现', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002

  // 登记后先用预约占住使本轮无组合，随后新增停用进一步收窄
  addFlexGroup(df, ['R0001', 'R0002'], WIN, '60', '登记');
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T08:00', '--end', '2026-10-12T18:00'],
    '占满 R0001',
  );
  ok(
    df,
    ['add-closure', '--resource', 'R0002', '--start', '2026-10-12T08:00', '--end', '2026-10-12T12:00'],
    '后续停用 R0002 上午',
  );
  const proc = ok(df, ['process-waitlist'], '停用后受阻');
  assert.match(proc.stdout, /继续等待 W0001/);
  assert.match(proc.stdout, /无完整可行组合/);

  // 取消停用：R0002 上午恢复，但 R0001 整天被占（单组候补各需 R0001 与 R0002）仍无解；
  // 改测：取消预约 + 取消停用后应可兑现
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  ok(df, ['cancel-booking', 'B0001'], '取消占房预约');
  const proc2 = ok(df, ['process-waitlist'], '解除阻挡后兑现');
  assertFulfillment(proc2.stdout, 'W0001', 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001', 'R0002'], '解除后兑现');
});

// ---------------------------------------------------------------------------
// 9. 用法错误（退出 2）、非法请求（退出 1）
// ---------------------------------------------------------------------------

test('用法与非法输入：互斥/缺失/未知/组内重复/空组的退出码', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室'); // R0001
  addResource(df, '二号会议室'); // R0002
  const bytesBefore = readFileSync(df);

  usageFail(df, ['add-flex-waitlist', '--resource', 'R0001', '--group', 'R0002', '--window', WIN, '--duration', '60'], '--resource 与 --group 互斥');
  usageFail(df, ['add-flex-waitlist', '--window', WIN, '--duration', '60'], '两种写法都缺');
  usageFail(df, ['add-flex-waitlist', '--group', 'R0001', '--duration', '60'], '缺 --window');
  usageFail(df, ['add-flex-waitlist', '--group', 'R0001', '--window', WIN], '缺 --duration');
  usageFail(df, ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '60', '--bogus'], '未知选项');
  usageFail(df, ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '60', '多余'], '多余位置参数');

  bizFail(df, ['add-flex-waitlist', '--group', 'R0001,R0009', '--window', WIN, '--duration', '60'], '未知资源');
  let r = bizFail(df, ['add-flex-waitlist', '--group', 'R0001,R0001', '--group', 'R0002', '--window', WIN, '--duration', '60'], '组内重复');
  assert.match(r.stderr, /候选资源重复: R0001/);
  usageFail(df, ['add-flex-waitlist', '--group', '', '--window', WIN, '--duration', '60'], '空值为用法错误');
  r = bizFail(df, ['add-flex-waitlist', '--group', ',', '--window', WIN, '--duration', '60'], '空需求组项');
  assert.match(r.stderr, /为空或含空项/);
  r = bizFail(df, ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '601'], '时长超窗');
  assert.match(r.stderr, /超过窗口长度/);
  r = bizFail(df, ['add-flex-waitlist', '--group', 'R0001', '--window', WIN, '--duration', '0'], '时长为 0');
  assert.match(r.stderr, /时长非法/);

  assert.ok(bytesBefore.equals(readFileSync(df)), '失败请求不改数据文件');
  assert.equal(readStore(df).waitlistSeq, 0, '失败不消费候补标识');
});

// ---------------------------------------------------------------------------
// 10. 真实保存失败与重试：登记与处理均不留部分记录/状态/计数，正常文件可成功
// ---------------------------------------------------------------------------

test('真实保存失败：登记与处理失败后可重试，标识未消费、不留部分状态', (t) => {
  const dir = tempDir(t);
  const good = join(dir, 'data.json');
  const longFile = join(dir, LONG_NAME);
  addResource(good, '一号会议室'); // R0001
  addResource(good, '二号会议室'); // R0002
  copyFileSync(good, longFile);
  const orig = readFileSync(longFile);

  // 登记保存失败（两次）：W 标识未消费
  const regArgs = ['add-flex-waitlist', '--group', 'R0001', '--group', 'R0002', '--window', WIN, '--duration', '60'];
  let r = runCli(longFile, regArgs);
  assert.equal(r.status, 1, '登记保存失败退出 1');
  assert.match(r.stderr, /保存数据文件/);
  r = runCli(longFile, regArgs);
  assert.equal(r.status, 1, '重试仍失败');
  assert.match(r.stderr, /保存数据文件/);
  assert.ok(orig.equals(readFileSync(longFile)), '原文件逐字节保留');
  assert.equal(JSON.parse(orig.toString('utf8')).waitlistSeq, 0, '失败不消费候补标识');

  // 正常文件登记 + 处理时制造保存失败：候补仍 waiting、无新预约、计数不变
  ok(good, regArgs, '正常文件登记 W0001');
  copyFileSync(good, longFile);
  const longBefore = readFileSync(longFile);
  r = runCli(longFile, ['process-waitlist']);
  assert.equal(r.status, 1, '处理保存失败退出 1');
  assert.match(r.stderr, /保存数据文件/);
  const afterFail = readStore(longFile);
  assert.ok(longBefore.equals(readFileSync(longFile)), '处理失败原文件逐字节保留');
  assert.equal(afterFail.waitlist[0].status, 'waiting', '处理失败候补仍等待');
  assert.equal(afterFail.waitlist[0].bookingId, undefined, '无关联预约');
  assert.equal(afterFail.bookingSeq, 0, '不消费预约标识');
  assert.equal(afterFail.bookings.length, 0, '不留部分预约');

  // 正常文件处理成功（新进程持久结果）
  const proc = ok(good, ['process-waitlist'], '正常文件处理成功');
  assertFulfillment(proc.stdout, 'W0001', 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001', 'R0002'], '持久兑现');
  const persisted = readStore(good);
  assert.equal(persisted.waitlist[0].status, 'fulfilled');
  assert.deepEqual(persisted.waitlist[0].groups, [['R0001'], ['R0002']]);
  assert.equal(persisted.bookings[0].id, 'B0001');
});

// ---------------------------------------------------------------------------
// 11. 旧文件兼容与损坏拒绝
// ---------------------------------------------------------------------------

test('旧文件（无 groups）按旧式弹性候补处理；候选组结构非法拒绝加载', (t) => {
  const dir = tempDir(t);
  const old = join(dir, 'old.json');
  // 手工构造含旧式弹性候补（无 groups）的文件
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resourceSeq: 2,
      bookingSeq: 0,
      seriesSeq: 0,
      waitlistSeq: 1,
      closureSeq: 0,
      batchSeq: 0,
      resources: [
        {id: 'R0001', type: 'venue', name: '甲', open: [['2026-01-01T00:00', '2027-01-01T00:00']], prepMinutes: 0, teardownMinutes: 0},
        {id: 'R0002', type: 'venue', name: '乙', open: [['2026-01-01T00:00', '2027-01-01T00:00']], prepMinutes: 0, teardownMinutes: 0},
      ],
      bookings: [],
      series: [],
      waitlist: [
        {id: 'W0001', kind: 'flexible', resourceIds: ['R0001', 'R0002'], start: '2026-10-12T08:00', end: '2026-10-12T18:00', durationMinutes: 60, status: 'waiting', seq: 1},
      ],
      closures: [],
      batchOps: [],
      imports: [],
    }) + '\n',
    'utf8',
  );
  const oldBytes = readFileSync(old);
  const proc = ok(old, ['process-waitlist'], '旧文件旧式弹性候补可兑现');
  assert.match(proc.stdout, /兑现 W0001（弹性时段）/);
  assert.match(proc.stdout, /资源: R0001（甲）、R0002（乙）/);

  // 候选组结构非法：空组 / 组内重复 / 未知资源 / 固定项携带 groups / 并集不一致 —— 均拒绝加载
  const base = () =>
    JSON.parse(
      JSON.stringify({
        version: 1,
        resourceSeq: 1,
        bookingSeq: 0,
        seriesSeq: 0,
        waitlistSeq: 1,
        closureSeq: 0,
        batchSeq: 0,
        resources: [
          {id: 'R0001', type: 'venue', name: '甲', open: [['2026-01-01T00:00', '2027-01-01T00:00']], prepMinutes: 0, teardownMinutes: 0},
        ],
        bookings: [],
        series: [],
        waitlist: [
          {id: 'W0001', kind: 'flexible', resourceIds: ['R0001'], start: '2026-10-12T08:00', end: '2026-10-12T18:00', durationMinutes: 60, groups: [['R0001']], status: 'waiting', seq: 1},
        ],
        closures: [],
        batchOps: [],
        imports: [],
      }),
    );
  const cases: Array<[string, (s: any) => void, RegExp]> = [
    ['空需求组', (s) => (s.waitlist[0].groups = [[]]), /必须是非空数组/],
    ['组内重复', (s) => (s.waitlist[0].groups = [['R0001', 'R0001']]), /组内候选资源重复/],
    ['未知资源', (s) => (s.waitlist[0].groups = [['R0009']]), /未知资源/],
    ['未排序', (s) => {
      s.resourceSeq = 2;
      s.resources.push({id: 'R0002', type: 'venue', name: '乙', open: [['2026-01-01T00:00', '2027-01-01T00:00']], prepMinutes: 0, teardownMinutes: 0});
      s.waitlist[0].resourceIds = ['R0001', 'R0002'];
      s.waitlist[0].groups = [['R0002', 'R0001']];
    }, /未按标识排序/],
    ['并集不一致', (s) => {
      s.resourceSeq = 2;
      s.resources.push({id: 'R0002', type: 'venue', name: '乙', open: [['2026-01-01T00:00', '2027-01-01T00:00']], prepMinutes: 0, teardownMinutes: 0});
      s.waitlist[0].groups = [['R0001']];
      s.waitlist[0].resourceIds = ['R0001', 'R0002'];
    }, /不一致/],
  ];
  for (const [name, mutate, re] of cases) {
    const df2 = join(dir, `bad-${name}.json`);
    const s = base();
    mutate(s);
    writeFileSync(df2, JSON.stringify(s) + '\n', 'utf8');
    const before = readFileSync(df2);
    const rr = bizFail(df2, ['list-waitlist'], `损坏拒绝：${name}`);
    assert.match(rr.stderr, re, `损坏原因：${name}`);
    assert.ok(before.equals(readFileSync(df2)), `损坏文件原样保留：${name}`);
  }

  // 旧文件被处理后正常落盘（状态变更），但 groups 缺省不补造
  const oldAfter = readStore(old);
  assert.equal(oldAfter.waitlist[0].groups, undefined, '不补造 groups 字段');
  assert.equal(oldAfter.waitlist[0].status, 'fulfilled', '旧式候补已兑现落盘');
  assert.ok(!oldBytes.equals(readFileSync(old)), '旧文件兑现后正常落盘（状态变更）');
});
