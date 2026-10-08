// shiftbook 停用附弹性改期清单（add-closure --items）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings、
//   list-closures、list-batch-ops、list-series、list-waitlist、import-ical 重放）；
// - 覆盖：不附清单遇有效预约重叠即拒绝（端点相接可行）、附清单换资源与腾挪
//   才成立、漏项列出全部遗漏标识（已取消预约与不同资源预约不要求纳入）、
//   整体无解、撤销被有效停用整笔阻挡与停用解除后恢复（取消停用不自动恢复）、
//   无变化只登记停用不建操作记录、混合身份归属保留、真实保存失败重试且停用
//   与操作标识均未消费、锁竞争退出 1 且原文件不变、用法与非法清单退出码、
//   损坏与旧格式文件；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
const DAY_OPEN: Array<[string, string]> = [['2026-10-12T00:00', '2026-10-13T00:00']];
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

function runCliAsync(dataFile: string, args: string[]): Promise<CliResult> {
  return new Promise((resolveP, reject) => {
    const p = spawn(process.execPath, [APP, '--data', dataFile, ...args], {encoding: 'utf8'});
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (status) => resolveP({status: status ?? -1, stdout, stderr}));
  });
}

function spawnCli(
  dataFile: string,
  args: string[],
  env?: Record<string, string>,
): {child: ChildProcess; result: Promise<CliResult>} {
  const child = spawn(process.execPath, [APP, '--data', dataFile, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env},
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const result = new Promise<CliResult>((resolveP, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolveP({status: status ?? -1, stdout, stderr}));
  });
  return {child, result};
}

async function waitForSyncPoint(path: string, ctx: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待同步点超时: ${ctx}（${path}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-add-closure-flex-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = DAY_OPEN,
  type = 'venue',
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function addBooking(df: string, resources: string[], start: string, end: string, ctx: string): void {
  const args = ['create-booking', '--start', start, '--end', end];
  for (const r of resources) args.push('--resource', r);
  ok(df, args, ctx);
}

function writeManifest(dir: string, name: string, items: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}) + '\n', 'utf8');
  return p;
}

function addClosureItems(
  df: string,
  resource: string,
  start: string,
  end: string,
  manifest: string,
  ctx: string,
): CliResult {
  return ok(df, ['add-closure', '--resource', resource, '--start', start, '--end', end, '--items', manifest], ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败不得改动数据文件（逐字节比对）`);
}

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

// 断言停用附改期清单的输出：停用标识、各项起止与按组资源、（有变化时）操作标识
interface ExpectedPlacement {
  id: string;
  start: string;
  end: string;
  picks: string[];
}

function assertClosureResult(
  r: CliResult,
  closureId: string,
  opId: string | null,
  expected: ExpectedPlacement[],
  ctx: string,
): void {
  assert.match(r.stdout, new RegExp(`已登记停用 ${closureId}（附弹性改期清单`), `[${ctx}] 停用标识`);
  if (opId !== null) {
    assert.match(r.stdout, new RegExp(`本次改期记录为 ${opId}`), `[${ctx}] 操作标识 ${opId}`);
  } else {
    assert.ok(!r.stdout.includes('本次改期记录为'), `[${ctx}] 无变化不应给出操作标识`);
    assert.match(r.stdout, /未生成改期操作记录/, `[${ctx}] 无变化提示`);
  }
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`- 第 ${i + 1} 项 ${e.id}[（:].*\\n?.*${e.start} → ${e.end}`),
      `[${ctx}] 第 ${i + 1} 项起止\nstdout:\n${r.stdout}`,
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
// 1. 不附清单：遇有效预约重叠即拒绝（旧行为保持）；端点相接仍可登记
// ---------------------------------------------------------------------------

test('不附清单：与有效预约重叠拒绝；端点相接与已取消预约不阻挡', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  // 已取消预约不阻挡
  addBooking(df, ['R0001'], '2026-10-12T14:00', '2026-10-12T15:00', 'B0002');
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');

  const overlap = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:30', '--end', '2026-10-12T12:00'],
    '重叠拒绝',
  );
  assert.match(overlap.stderr, /无法登记停用/, '拒绝原因');
  assert.match(overlap.stderr, /B0001/, '列出受影响预约');
  assert.ok(!overlap.stderr.includes('B0002'), '已取消预约不受影响');

  // 端点相接：停用 11:00-12:00，预约 10:00-11:00，不算重叠
  const touching = ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '端点相接',
  );
  assert.match(touching.stdout, /已登记停用 C0001/, '相接停用登记成功');

  // 与已取消预约重叠也可登记
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    '已取消时段停用',
  );
  const closures = ok(df, ['list-closures'], '查询停用');
  assert.match(closures.stdout, /C0001 \[有效\]/);
  assert.match(closures.stdout, /C0002 \[有效\]/);
});

// ---------------------------------------------------------------------------
// 2. 换资源才能成立：停用 R0001 时段，预约同时间换到 R0002
// ---------------------------------------------------------------------------

test('附清单换资源：同时间换到备选资源，停用 C0001 与操作 O0001 同次保存', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  const m = writeManifest(dir, 'items.json', [
    // 候选倒序书写：结果仍取字典序最小的可行选择（R0001 被停用扣除，落 R0002）
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0002', 'R0001']]},
  ]);
  const r = addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '换资源');
  assertClosureResult(
    r,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '换资源',
  );

  // 落盘核对：预约只改资源；停用有效；记录存在
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '换资源落盘');
  const store = readStore(df);
  assert.equal(store.closureSeq, 1, '停用计数推进');
  assert.equal(store.batchSeq, 1, '操作计数推进');
  assert.deepEqual(
    store.closures.map((c: any) => [c.id, c.resourceId, c.status]),
    [['C0001', 'R0001', 'active']],
    '停用记录',
  );
  assert.equal(store.batchOps[0].items[0].before.resourceIds.join(), 'R0001', '记录保留改期前资源');
  assert.equal(store.batchOps[0].items[0].after.resourceIds.join(), 'R0002', '记录改期后资源');

  // 新进程查询持久结果
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程查询预约');
  assert.match(day.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00[\s\S]*R0002/, '持久安排');
  const closures = ok(df, ['list-closures'], '新进程查询停用');
  assert.match(closures.stdout, /C0001 \[有效\][\s\S]*R0001（甲）/, '持久停用');
});

// ---------------------------------------------------------------------------
// 3. 腾挪才能成立：额外纳入不与停用重叠的预约为必纳项让位
// ---------------------------------------------------------------------------

test('腾挪才成立：额外纳入 B0002 让位，必纳项 B0001 顺移，最少变化取最小方案', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001（必纳）');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0002（腾挪项）');

  // 停用 10:00-11:00 只与 B0001 重叠；B0001 的窗口只允许 11:00 起，
  // 必须把 11:00-12:00 的 B0002 额外纳入并前移到 09:00-10:00 才有解
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T11:00/2026-10-12T12:00', groups: [['R0001']]},
    {bookingId: 'B0002', window: '2026-10-12T09:00/2026-10-12T12:00', groups: [['R0001']]},
  ]);
  const r = addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00', m, '腾挪');
  assert.match(r.stdout, /变化 2 项/, '两项均变化');
  assertClosureResult(
    r,
    'C0001',
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '腾挪',
  );
  assertBooking(df, 'B0001', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001'], 'B0001 顺移');
  assertBooking(df, 'B0002', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], 'B0002 前移');
  // 记录按清单顺序含全部提交项前后安排
  const ops = ok(df, ['list-batch-ops'], '新进程查询记录');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（2 项，按提交顺序）/, '记录 2 项');
  assert.match(ops.stdout, /第 1 项 B0001[\s\S]*改期前: 2026-10-12T10:00 → 2026-10-12T11:00/, 'B0001 改期前');
  assert.match(ops.stdout, /第 2 项 B0002[\s\S]*改期前: 2026-10-12T11:00 → 2026-10-12T12:00/, 'B0002 改期前');
});

// ---------------------------------------------------------------------------
// 4. 漏项：必纳预约缺列时列出全部遗漏标识并拒绝；已取消与不相关预约不要求纳入
// ---------------------------------------------------------------------------

test('漏项：列出全部遗漏标识（含多资源预约）；已取消与不同资源预约不要求纳入', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001 必纳');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', 'B0002 必纳');
  // 多资源预约，与 B0002 端点相接、不冲突；与停用 10:00-13:00 重叠
  addBooking(df, ['R0001', 'R0003'], '2026-10-12T12:00', '2026-10-12T12:30', 'B0003 多资源必纳');
  addBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0004 不同资源不要求');
  addBooking(df, ['R0001'], '2026-10-12T15:00', '2026-10-12T16:00', 'B0005 已取消不要求');
  ok(df, ['cancel-booking', 'B0005'], '取消 B0005');

  // 清单只列 B0001（且可解），遗漏 B0002、B0003；端点相接的预约（若有）不算
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T13:00', '--items', m],
    '漏项拒绝',
  );
  assert.match(r.stderr, /遗漏必须纳入的预约/, '漏项原因');
  assert.match(r.stderr, /B0002/, '列出遗漏 B0002');
  assert.match(r.stderr, /B0003/, '列出遗漏 B0003');
  assert.ok(!r.stderr.includes('B0004'), '不同资源预约不是必纳项');
  assert.ok(!r.stderr.includes('B0005'), '已取消预约不是必纳项');
  assertFileBytes(df, bytesBefore, '漏项拒绝后');

  const store = readStore(df);
  assert.equal(store.closureSeq, 0, '不推进停用计数');
  assert.equal(store.batchSeq, 0, '不推进操作计数');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '原安排不变');
});

// ---------------------------------------------------------------------------
// 5. 整体无解：必纳项全列但停用生效后无可行安排
// ---------------------------------------------------------------------------

test('整体无解：退出 1 且不登记停用、不改预约、不推进任何计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '唯一会议室'); // R0001
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  // 停用覆盖整个窗口，唯一候选资源 R0001 在窗口内完全不可用
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001']]},
  ]);
  const bytesBefore = readFileSync(df);
  const r = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00', '--items', m],
    '整体无解',
  );
  assert.match(r.stderr, /无整体解/, '无解提示');
  assertFileBytes(df, bytesBefore, '无解后');
  const store = readStore(df);
  assert.equal(store.closures.length, 0, '不留停用');
  assert.equal(store.closureSeq, 0, '停用计数不变');
  assert.equal(store.batchOps.length, 0, '不留操作记录');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '原安排不变');

  // 失败后再次成功登记应分配 C0001（失败未消费标识）
  const m2 = writeManifest(dir, 'items2.json', [
    {bookingId: 'B0001', window: '2026-10-12T13:00/2026-10-12T14:00', groups: [['R0001']]},
  ]);
  const r2 = addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m2, '失败后重试');
  assertClosureResult(
    r2,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T13:00', end: '2026-10-12T14:00', picks: ['R0001']}],
    '失败后标识未消费',
  );
});

// ---------------------------------------------------------------------------
// 6. 撤销：安全撤销只恢复改期、不取消停用；原安排被停用阻挡时整笔拒绝；
//    cancel-closure 不自动恢复预约，解除后整笔恢复可行才恢复
// ---------------------------------------------------------------------------

test('撤销受阻与解除后恢复：停用阻挡撤销；取消停用不自动恢复，undo 才恢复', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);
  addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '换资源');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '改期后');

  // 停用仍有效：恢复为 R0001 10:00-11:00 被停用整笔阻挡
  const bytesBefore = readFileSync(df);
  const blocked = bizFail(df, ['undo-batch-op', 'O0001'], '撤销被停用阻挡');
  assert.match(blocked.stderr, /撤销 O0001 失败/, '受阻提示');
  assert.match(blocked.stderr, /C0001/, '列出阻挡停用');
  assertFileBytes(df, bytesBefore, '受阻后文件不变');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '受阻后仍在 R0002');

  // 取消停用不自动恢复预约
  ok(df, ['cancel-closure', 'C0001'], '取消停用');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '取消停用后预约不自动恢复');
  const closures = ok(df, ['list-closures'], '停用记录保留为已取消');
  assert.match(closures.stdout, /C0001 \[已取消\]/);

  // 解除后撤销：仍须预约有效且当前安排与记录后安排一致（此处一致），整笔恢复
  ok(df, ['undo-batch-op', 'O0001'], '停用解除后撤销成功');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '撤销恢复原安排');
  const ops = ok(df, ['list-batch-ops'], '记录已撤销');
  assert.match(ops.stdout, /O0001 \[已撤销\]/, '记录状态为已撤销');
  // 撤销不推进任何计数、不取消停用
  const store = readStore(df);
  assert.equal(store.closureSeq, 1, '停用计数不变');
  assert.equal(store.batchSeq, 1, '操作计数不回收');
  assert.equal(store.closures[0].status, 'cancelled', '停用仍为取消状态（撤销不复活停用）');
});

// ---------------------------------------------------------------------------
// 7. 无变化：停用登记成功、清单项安排全部不变 → 只推进停用计数，不建操作记录
// ---------------------------------------------------------------------------

test('无变化：停用正常登记（文件写入），但不建操作记录、不推进操作计数', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // 停用 R0002 与任何预约都不重叠；清单列 B0001，其现状（R0001 10:00）在窗内可行
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
  ]);
  const r = addClosureItems(df, 'R0002', '2026-10-12T10:00', '2026-10-12T12:00', m, '无变化');
  assertClosureResult(
    r,
    'C0001',
    null,
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']}],
    '无变化',
  );
  const store = readStore(df);
  assert.equal(store.closureSeq, 1, '停用计数推进');
  assert.equal(store.closures.length, 1, '停用已登记');
  assert.equal(store.batchSeq, 0, '操作计数不推进');
  assert.equal(store.batchOps.length, 0, '不建操作记录');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '安排不变');

  // 新进程查询
  const ops = ok(df, ['list-batch-ops'], '新进程查询操作记录');
  assert.match(ops.stdout, /暂无批量改期操作记录/, '无操作记录');
});

// ---------------------------------------------------------------------------
// 8. 混合身份：系列成员、导入预约、候补兑现预约同批改期，归属与关联全部保留
// ---------------------------------------------------------------------------

test('混合身份：系列成员/导入预约/候补兑现预约随停用改期，归属与关联保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL); // R0001
  addResource(df, '乙', OPEN_ALL); // R0002

  // 系列 S0001：B0001（10-12 09:00）、B0002（10-19 09:00）
  ok(
    df,
    ['create-series', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00', '--count', '2'],
    '创建系列',
  );
  // 导入预约 B0003（10-12 10:00）
  const ics = join(dir, 'events.ics');
  writeFileSync(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:closure-mix@example.com',
      'DTSTART:20261012T100000',
      'DTEND:20261012T110000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
    'utf8',
  );
  ok(df, ['import-ical', ics, '--resource', 'R0001'], '导入 B0003');
  // 候补兑现 B0004（10-12 15:00）
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T15:00', '--end', '2026-10-12T16:00'], '候补 W0001');
  ok(df, ['process-waitlist'], '兑现 B0004');

  // 停用 10-12 全天，与 B0001/B0003/B0004 重叠（B0002 在 10-19，非必纳，不列入）
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T20:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0003', window: '2026-10-12T08:00/2026-10-12T20:00', groups: [['R0001', 'R0002']]},
    {bookingId: 'B0004', window: '2026-10-12T08:00/2026-10-12T20:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = addClosureItems(df, 'R0001', '2026-10-12T00:00', '2026-10-13T00:00', m, '混合身份');
  // 同变化数（3 项都换资源）下开始分钟越小越优先：三项紧凑排到 R0002 最早时段
  assertClosureResult(
    r,
    'C0001',
    'O0001',
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
      {id: 'B0003', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
      {id: 'B0004', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']},
    ],
    '混合身份',
  );

  // 归属与关联保留
  const store = readStore(df);
  assert.equal(store.bookings.find((b: any) => b.id === 'B0001').seriesId, 'S0001', '系列归属保留');
  assert.equal(store.bookings.find((b: any) => b.id === 'B0002').seriesId, 'S0001', '未涉及系列成员不变');
  assertBooking(df, 'B0002', '2026-10-19T09:00', '2026-10-19T10:00', ['R0001'], '未涉及成员安排不变');
  assert.equal(store.imports.length, 1, '导入身份保留');
  assert.equal(store.imports[0].bookingId, 'B0003', '导入关联不变');
  assert.equal(store.waitlist[0].status, 'fulfilled', '候补已兑现状态保留');
  assert.equal(store.waitlist[0].bookingId, 'B0004', '候补兑现关联保留');
  assert.equal(store.waitlist[0].start, '2026-10-12T15:00', '候补原请求保留');

  // 记录按清单顺序且标注系列归属
  const ops = ok(df, ['list-batch-ops'], '新进程查询记录');
  assert.match(ops.stdout, /第 1 项 B0001（系列 S0001）/, '记录含系列归属');
  assert.match(ops.stdout, /第 2 项 B0003\n/, '导入项无系列标注');

  // 新进程重放导入：按当前安排返回，不做改动
  const bytesBefore = readFileSync(df);
  const replay = ok(df, ['import-ical', ics, '--resource', 'R0001'], '重放导入');
  assert.match(replay.stdout, /当前安排: 2026-10-12T09:00 → 2026-10-12T10:00/, '重放显示改期后安排');
  assertFileBytes(df, bytesBefore, '重放后');
});

// ---------------------------------------------------------------------------
// 9. 真实保存失败与重试：停用与操作标识均未消费；重试成功
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且原数据逐字节保留，同一原数据重试成功且 C/O 标识均未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);

  // 同一原数据放到保存必然失败的位置（文件名 255 字节，临时文件名超限）
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(
    longFile,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00', '--items', m],
    '保存失败',
  );
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assert.ok(!r.stdout.includes('已登记停用'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  const failed = readStore(longFile);
  assert.equal(failed.closures.length, 0, '不留停用');
  assert.equal(failed.closureSeq, 0, '停用计数未消费');
  assert.equal(failed.batchOps.length, 0, '不留操作记录');
  assert.equal(failed.batchSeq, 0, '操作计数未消费');

  // 可保存位置用同一原数据重试：C0001 与 O0001 均未被失败尝试消费
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = addClosureItems(retryFile, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '重试');
  assertClosureResult(
    r2,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '重试标识未消费',
  );
  assertBooking(retryFile, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '重试生效');

  // 新进程查询持久结果
  const closures = ok(retryFile, ['list-closures'], '新进程查询停用');
  assert.match(closures.stdout, /C0001 \[有效\]/, '持久停用');
  const ops = ok(retryFile, ['list-batch-ops'], '新进程查询记录');
  assert.match(ops.stdout, /- O0001 \[未撤销\]（1 项，按提交顺序）/, '持久记录');
});

// ---------------------------------------------------------------------------
// 10. 锁竞争：持锁期间 add-closure --items 等待 5 秒后退出 1，原文件不变
// ---------------------------------------------------------------------------

test('锁竞争：5 秒未取得保护退出 1，不登记停用或改期；持锁请求正常提交', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);

  // 用真实子进程经同步点持锁（add-resource 在取得保护后停在同步点）
  const syncDir = join(dir, 'sync');
  mkdirSync(syncDir);
  const holder = spawnCli(
    df,
    ['add-resource', '--type', 'venue', '--name', '持锁资源', '--open', '2026-01-01T00:00/2027-01-01T00:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: syncDir},
  );
  t.after(async () => {
    try {
      holder.child.kill('SIGKILL');
      await holder.result;
    } catch {
      // 进程可能已结束
    }
  });
  await waitForSyncPoint(join(syncDir, 'write-lock-acquired.ready'), '持锁进程取得保护');

  const bytesBefore = readFileSync(df);
  const r = await runCliAsync(df, [
    'add-closure',
    '--resource',
    'R0001',
    '--start',
    '2026-10-12T10:00',
    '--end',
    '2026-10-12T12:00',
    '--items',
    m,
  ]);
  assert.equal(r.status, 1, `锁竞争退出 1\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /正被其他进程占用/, '占用原因');
  assertFileBytes(df, bytesBefore, '竞争失败原文件不变');

  // 放行持锁进程并等待其正常提交
  writeFileSync(join(syncDir, 'write-lock-acquired.go'), '\n', 'utf8');
  const hr = await holder.result;
  assert.equal(hr.status, 0, `持锁进程正常成功\nstderr:\n${hr.stderr}`);

  // 持锁请求已提交（R0003），竞争失败的停用/改期仍不存在
  const store = readStore(df);
  assert.equal(store.closureSeq, 0, '不登记停用');
  assert.equal(store.batchSeq, 0, '不建操作记录');
  assert.ok((store.resources as any[]).some((x) => x.name === '持锁资源'), '持锁请求已提交');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '竞争失败不改预约');
});

// ---------------------------------------------------------------------------
// 11. 用法错误（退出 2）与非法清单/请求（退出 1），均不改动数据文件
// ---------------------------------------------------------------------------

test('用法错误退出 2，非法清单与非法请求退出 1，均不产生停用或记录', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');
  addBooking(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T13:00', 'B0002');
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  const good = writeManifest(dir, 'good.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);
  const bytesBefore = readFileSync(df);
  const closureArgs = ['--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00'];

  // 用法错误（退出 2）
  usageFail(df, ['add-closure', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00'], '缺 resource');
  usageFail(df, ['add-closure', ...closureArgs, '--items', good, '多余'], '多余位置参数');
  usageFail(df, ['add-closure', ...closureArgs, '--bogus', good], '未知选项');

  // 清单不可读 / 损坏（退出 1）
  let r = bizFail(df, ['add-closure', ...closureArgs, '--items', join(dir, 'missing.json')], '清单不存在');
  assert.match(r.stderr, /无法读取改期清单/);
  const badJson = join(dir, 'bad.json');
  writeFileSync(badJson, '{ not json', 'utf8');
  r = bizFail(df, ['add-closure', ...closureArgs, '--items', badJson], '清单损坏');
  assert.match(r.stderr, /已损坏，不是合法 JSON/);

  // 内容非法（退出 1）：与 reschedule-flex 同一套校验
  const writeRaw = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text, 'utf8');
    return p;
  };
  r = bizFail(df, ['add-closure', ...closureArgs, '--items', writeRaw('n1.json', '{"items": []}')], '空清单');
  assert.match(r.stderr, /至少包含一项/);
  r = bizFail(
    df,
    ['add-closure', ...closureArgs, '--items', writeRaw('n2.json', '{"items": [{"bookingId": "B0009", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '未知预约',
  );
  assert.match(r.stderr, /未知预约标识: B0009/);
  r = bizFail(
    df,
    ['add-closure', ...closureArgs, '--items', writeRaw('n3.json', '{"items": [{"bookingId": "B0002", "window": "2026-10-12T10:00/2026-10-12T12:00", "groups": [["R0001"]]}]}')],
    '已取消预约',
  );
  assert.match(r.stderr, /预约 B0002 已取消，不能改期/);
  r = bizFail(
    df,
    ['add-closure', ...closureArgs, '--items', writeRaw('n4.json', '{"items": [{"bookingId": "B0001", "window": "2026-10-12T10:00/2026-10-12T10:30", "groups": [["R0001"]]}]}')],
    '窗口短于时长',
  );
  assert.match(r.stderr, /窗口长度 30 分钟小于预约当前时长 60 分钟/);
  r = bizFail(
    df,
    ['add-closure', '--resource', 'R0009', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00', '--items', good],
    '未知停用资源',
  );
  assert.match(r.stderr, /未知资源标识: R0009/);
  r = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T10:00', '--items', good],
    '停用时间倒置',
  );
  assert.match(r.stderr, /停用结束时间必须晚于开始时间/);

  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.closures.length, 0, '失败请求不留停用');
  assert.equal(store.closureSeq, 0, '停用计数不变');
  assert.equal(store.batchOps.length, 0, '失败请求不留记录');
});

// ---------------------------------------------------------------------------
// 12. 旧格式文件直接可用；损坏数据文件退出 1 并保留原样
// ---------------------------------------------------------------------------

test('旧格式文件可直接附清单登记停用；损坏文件退出 1 且逐字节保留', (t) => {
  const dir = tempDir(t);

  // 旧格式：无 closures、batchOps 等字段
  const old = join(dir, 'old.json');
  writeFileSync(
    old,
    JSON.stringify({
      version: 1,
      resources: [
        {id: 'R0001', type: 'venue', name: '甲', open: [['2026-10-12T00:00', '2026-10-13T00:00']]},
        {id: 'R0002', type: 'venue', name: '乙', open: [['2026-10-12T00:00', '2026-10-13T00:00']]},
      ],
      bookings: [{id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T11:00', status: 'active'}],
      bookingSeq: 1,
      resourceSeq: 2,
    }) + '\n',
    'utf8',
  );
  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = addClosureItems(old, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '旧文件');
  assertClosureResult(
    r,
    'C0001',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '旧文件',
  );
  assertBooking(old, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '旧文件落盘');

  // 损坏文件：退出 1，原样保留
  const bad = join(dir, 'bad-data.json');
  writeFileSync(bad, '{ not json', 'utf8');
  const badBytes = readFileSync(bad);
  const r2 = bizFail(
    bad,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T12:00', '--items', m],
    '损坏数据文件',
  );
  assert.match(r2.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏文件失败后');
});

// ---------------------------------------------------------------------------
// 13. 计数连续：停用与操作标识沿现有序列继续分配；失败不产生缺口
// ---------------------------------------------------------------------------

test('标识连续：新停用与新操作沿现有计数继续；每次成功登记都是新停用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // 先有一条普通停用 C0001（不与任何预约重叠的资源时段）
  ok(
    df,
    ['add-closure', '--resource', 'R0003', '--start', '2026-10-12T08:00', '--end', '2026-10-12T09:00'],
    '既有停用 C0001',
  );

  const m = writeManifest(dir, 'items.json', [
    {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T12:00', groups: [['R0001', 'R0002']]},
  ]);
  const r = addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '附清单停用');
  assertClosureResult(
    r,
    'C0002',
    'O0001',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '计数连续',
  );

  // 撤销 O0001 后（先取消 C0002）再提交：分配新操作 O0002，停用再登记为 C0003
  ok(df, ['cancel-closure', 'C0002'], '解除停用');
  ok(df, ['undo-batch-op', 'O0001'], '撤销改期');
  assertBooking(df, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001'], '恢复原安排');
  const r2 = addClosureItems(df, 'R0001', '2026-10-12T10:00', '2026-10-12T12:00', m, '撤销后重提');
  assertClosureResult(
    r2,
    'C0003',
    'O0002',
    [{id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']}],
    '重提分配新标识',
  );
  const store = readStore(df);
  assert.equal(store.closureSeq, 3, '停用计数只增');
  assert.equal(store.batchSeq, 2, '操作计数只增');
  assert.deepEqual(
    store.closures.map((c: any) => c.status),
    ['active', 'cancelled', 'active'],
    '停用记录按标识齐全（C0002 已取消仍保留）',
  );
});
