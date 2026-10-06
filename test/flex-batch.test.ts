// shiftbook 多项弹性预约联合排程与原子创建（create-flex-bookings）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings / 重新读取文件）；
// - 覆盖：前项须换资源或延后才有解的联合回溯（不能逐项固定最早选择）、整体无解
//   退出 1 且不保存部分方案、方案取舍（更早开始优先、同一开始组合字典序、清单
//   顺序逐项比较、候选书写顺序不影响结果）、跨日窗口与停用/预约端点相接、取消
//   记录与未兑现候补不阻挡、持久化后由新进程查询并独立改期/取消、重复提交不去重、
//   真实保存失败与可保存位置重试（标识不被失败消费）、用法与非法请求退出码、
//   损坏数据文件、并发提交在写入保护下串行且都成功；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, spawn} from 'node:child_process';
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-batch-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function writeManifest(dir: string, name: string, items: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({items}, null, 2) + '\n', 'utf8');
  return p;
}

function flex(df: string, manifest: string, ctx: string): CliResult {
  return ok(df, ['create-flex-bookings', manifest], ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 数据文件应逐字节不变`);
}

interface Planned {
  item: number; // 清单项序号（1 基）
  id: string;
  start: string;
  end: string;
  picks: string[]; // 按需求组顺序
}

// 从 create-flex-bookings 输出解析排程结果
function parsePlan(r: CliResult): Planned[] {
  const blocks = r.stdout.split(/\n(?=第 \d+ 项 B\d+:)/).filter((s) => /^第 \d+ 项 B\d+:/.test(s));
  return blocks.map((block) => {
    const head = /^第 (\d+) 项 (B\d+):/.exec(block)!;
    const time = /时间: (\S+) → (\S+)/.exec(block)!;
    const picks = [...block.matchAll(/第 \d+ 组: (R\d+)（/g)].map((m) => m[1]);
    return {item: Number(head[1]), id: head[2], start: time[1], end: time[2], picks};
  });
}

function assertPlan(r: CliResult, expected: Array<[number, string, string, string, string[]]>, ctx: string): void {
  const plan = parsePlan(r);
  assert.equal(plan.length, expected.length, `[${ctx}] 排程项数\nstdout:\n${r.stdout}`);
  expected.forEach((exp, i) => {
    const [item, id, start, end, picks] = exp;
    const p = plan[i];
    assert.deepEqual(
      [p.item, p.id, p.start, p.end, p.picks],
      [item, id, start, end, picks],
      `[${ctx}] 第 ${i + 1} 个排程块不符\n实际: ${JSON.stringify(p)}\nstdout:\n${r.stdout}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 1. 联合回溯：前项贪取最小标识/最早时间会漏解，必须换资源或延后前项
// ---------------------------------------------------------------------------

test('联合排程：前项须让出较小标识、前项须延后，整份方案才成立', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003

  // R0001 在 09:00-12:00 被既有预约占用；第 2 项窗口只有 08:00 一个可行开始且必须用 R0001
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T12:00'],
    '既有预约 B0001 占用 R0001 09:00-12:00',
  );
  // R0003 在 09:30-10:30 被占用
  ok(
    df,
    ['create-booking', '--resource', 'R0003', '--start', '2026-10-12T09:30', '--end', '2026-10-12T10:30'],
    '既有预约 B0002 占用 R0003 09:30-10:30',
  );

  const manifest = writeManifest(dir, 'plan.json', [
    // (a) 第 1 项若在 08:00 贪选 R0001，第 2 项（只能 08:00 开始、只用 R0001）即无解；
    //     联合排程须让第 1 项改选 R0002（结束 09:00 恰与既有预约相接）
    {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001']]},
    // (b) 第 3 项若固定最早 08:00，第 4 项窗口（08:30-10:30，只能用 R0003）无容身之处；
    //     联合排程须把第 3 项延后到 10:30（既有预约结束点相接），第 4 项取 08:30→09:30
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0003']]},
    {window: '2026-10-12T08:30/2026-10-12T10:30', duration: 60, groups: [['R0003']]},
  ]);
  const r = flex(df, manifest, '联合回溯');
  assertPlan(
    r,
    [
      [1, 'B0003', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002']],
      [2, 'B0004', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001']],
      [3, 'B0005', '2026-10-12T10:30', '2026-10-12T11:30', ['R0003']],
      [4, 'B0006', '2026-10-12T08:30', '2026-10-12T09:30', ['R0003']],
    ],
    '联合回溯',
  );

  // 新进程查询持久安排
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '重启后按日查询');
  for (const [, id, start, end] of [
    ['', 'B0003', '2026-10-12T08:00', '2026-10-12T09:00'],
    ['', 'B0004', '2026-10-12T08:00', '2026-10-12T09:00'],
    ['', 'B0005', '2026-10-12T10:30', '2026-10-12T11:30'],
    ['', 'B0006', '2026-10-12T08:30', '2026-10-12T09:30'],
  ]) {
    assert.match(day.stdout, new RegExp(`${id} \\[已预约\\] ${start} → ${end}`), `新进程查到 ${id}`);
  }
});

// ---------------------------------------------------------------------------
// 2. 整体无解：退出 1，不保存部分方案、不消费标识
// ---------------------------------------------------------------------------

test('整体无解退出 1：项内选不出互不相同资源 / 项数超过容量，文件原样保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // (a) 一项两组都只有 R0001：所选资源必须互不相同 -> 无解
  const m1 = writeManifest(dir, 'a.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001'], ['R0001']]},
  ]);
  const bytes0 = readFileSync(df);
  let r = bizFail(df, ['create-flex-bookings', m1], '项内资源冲突无解');
  assert.match(r.stderr, /无整体可行方案/);
  assertFileBytes(df, bytes0, '无解后文件不变');

  // (b) 同一小时槽位只有 2 个资源却排 3 项：各自可行但整份清单无解
  const m2 = writeManifest(dir, 'b.json', [
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  r = bizFail(df, ['create-flex-bookings', m2], '容量不足整体无解');
  assert.match(r.stderr, /无整体可行方案/);
  assertFileBytes(df, bytes0, '整体无解后文件不变');

  // 标识未被无解尝试消费：随后有解清单的第一项仍是 B0001
  const m3 = writeManifest(dir, 'c.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  r = flex(df, m3, '无解后再有解');
  assertPlan(r, [[1, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001']]], '标识从 B0001 开始');
});

// ---------------------------------------------------------------------------
// 3. 方案取舍：更早开始优先；同一开始组合字典序；清单顺序逐项比较；
//    候选书写顺序不影响结果
// ---------------------------------------------------------------------------

test('取舍：开始分钟优先于资源标识；同开始取字典序；按清单顺序逐项比较', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '晚开放甲', [['2026-10-12T10:00', '2026-10-12T20:00']]); // R0001
  addResource(df, '早开放乙', [['2026-10-12T08:00', '2026-10-12T20:00']]); // R0002

  // (a) R0001 标识更小但 10:00 才可用：更早的 08:00 + R0002 优先
  const m1 = writeManifest(dir, 'a.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  let r = flex(df, m1, '更早开始优先');
  assertPlan(r, [[1, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002']]], '更早开始优先');

  // (b) 两项同候选、同时刻可行：第 1 项取 R0001（10:00 起），第 2 项取 R0002
  const m2 = writeManifest(dir, 'b.json', [
    {window: '2026-10-12T10:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T10:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  r = flex(df, m2, '同一开始字典序');
  assertPlan(
    r,
    [
      [1, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001']],
      [2, 'B0003', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002']],
    ],
    '同一开始字典序',
  );

  // (c) 清单顺序逐项比较：第 1 项选 R0001@10:00 会迫使第 2 项延后到 11:00，
  //     另一解第 1 项选 R0002@10:00、第 2 项 R0001@10:00 看似更整齐，但第一处
  //     差异在第 1 项的资源标识（同一开始，R0001 < R0002），故取前者。
  //     使用全新数据文件，避免前两个子场景的已存预约占用 10:00 时段
  const df3 = join(dir, 'data3.json');
  addResource(df3, '晚开放甲', [['2026-10-12T10:00', '2026-10-12T20:00']]);
  addResource(df3, '早开放乙', [['2026-10-12T08:00', '2026-10-12T20:00']]);
  const m3 = writeManifest(dir, 'c.json', [
    {window: '2026-10-12T10:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T10:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ]);
  r = flex(df3, m3, '逐项字典序');
  assertPlan(
    r,
    [
      [1, 'B0001', '2026-10-12T10:00', '2026-10-12T11:00', ['R0001']],
      [2, 'B0002', '2026-10-12T11:00', '2026-10-12T12:00', ['R0001']],
    ],
    '逐项字典序',
  );

  // (d) 候选书写顺序不影响结果：倒序候选在全新数据文件上给出相同方案
  const df2 = join(dir, 'data2.json');
  addResource(df2, '晚开放甲', [['2026-10-12T10:00', '2026-10-12T20:00']]);
  addResource(df2, '早开放乙', [['2026-10-12T08:00', '2026-10-12T20:00']]);
  const m4 = writeManifest(dir, 'd.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002', 'R0001']]},
  ]);
  r = flex(df2, m4, '候选乱序');
  assertPlan(r, [[1, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002']]], '候选乱序结果一致');
});

// ---------------------------------------------------------------------------
// 4. 跨日窗口、停用与预约端点相接；取消的停用/预约与未兑现候补不阻挡
// ---------------------------------------------------------------------------

test('跨日与端点：停用相接、预约相接可行；取消记录与未兑现候补不阻挡', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '跨日场地', [['2026-10-12T08:00', '2026-10-13T20:00']]); // R0001

  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T21:00', '--end', '2026-10-13T01:00'],
    '有效停用 C0001（21:00→01:00）',
  );
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-13T02:00', '--end', '2026-10-13T03:00'],
    '随后取消的停用 C0002',
  );
  ok(df, ['cancel-closure', 'C0002'], '取消 C0002（不再阻挡）');
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-13T04:00', '--end', '2026-10-13T06:00'],
    '既有预约 B0001（04:00→06:00）',
  );
  // 已取消预约不阻挡
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-13T06:00', '--end', '2026-10-13T07:00'],
    '稍后取消的预约 B0002',
  );
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  // 未兑现候补不阻挡
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-13T07:00', '--end', '2026-10-13T08:00'],
    '未兑现候补 W0001',
  );

  const window = '2026-10-12T20:00/2026-10-13T12:00';
  const manifest = writeManifest(dir, 'cross.json', [
    // 空闲段：[20:00,21:00)=60、[01:00,04:00)=180（C0002 已取消）、[06:00,12:00)
    {window, duration: 180, groups: [['R0001']]}, // 01:00→04:00，结束恰接既有预约
    {window, duration: 60, groups: [['R0001']]}, // 20:00→21:00，结束恰接停用
    {window, duration: 60, groups: [['R0001']]}, // 06:00→07:00，开始恰接既有预约
  ]);
  const r = flex(df, manifest, '跨日端点');
  assertPlan(
    r,
    [
      [1, 'B0003', '2026-10-13T01:00', '2026-10-13T04:00', ['R0001']],
      [2, 'B0004', '2026-10-12T20:00', '2026-10-12T21:00', ['R0001']],
      [3, 'B0005', '2026-10-13T06:00', '2026-10-13T07:00', ['R0001']],
    ],
    '跨日端点',
  );

  // 第 3 项落在 06:00→07:00 证明已取消预约 B0002 与未兑现候补 W0001 均不阻挡；
  // 若它们阻挡，该项只能退到 08:00→09:00
  const store = readStore(df);
  const b5 = store.bookings.find((x: any) => x.id === 'B0005');
  assert.equal(b5.start, '2026-10-13T06:00');
});

// ---------------------------------------------------------------------------
// 5. 持久化后可独立改期/取消；每次提交都是新的创建请求，不按路径或内容去重
// ---------------------------------------------------------------------------

test('持久安排可独立改期与取消；同一清单重复提交创建新预约（不去重）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  const manifest = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001', 'R0002']]},
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001']]},
  ]);
  const r1 = flex(df, manifest, '首次提交');
  assertPlan(
    r1,
    [
      [1, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002']],
      [2, 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001']],
    ],
    '首次提交',
  );

  // 独立改期 B0001、独立取消 B0002：均为普通预约入口，标识不变/记录保留
  ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'],
    '独立改期 B0001',
  );
  ok(df, ['cancel-booking', 'B0002'], '独立取消 B0002');
  let store = readStore(df);
  let b1 = store.bookings.find((x: any) => x.id === 'B0001');
  assert.equal(b1.start, '2026-10-12T14:00', 'B0001 改期生效');
  let b2 = store.bookings.find((x: any) => x.id === 'B0002');
  assert.equal(b2.status, 'cancelled', 'B0002 已取消');
  assert.deepEqual(store.series ?? [], [], '不创建系列');

  // 同一清单再次提交：是新的创建请求，分配新标识 B0003/B0004，不复用、不去重
  const r2 = flex(df, manifest, '重复提交不去重');
  assertPlan(
    r2,
    [
      [1, 'B0003', '2026-10-12T08:00', '2026-10-12T09:00', ['R0002']],
      [2, 'B0004', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001']],
    ],
    '重复提交分配新标识',
  );
  store = readStore(df);
  assert.equal(store.bookings.length, 4, '两次提交共 4 条预约记录（取消记录保留）');
  b1 = store.bookings.find((x: any) => x.id === 'B0001');
  b2 = store.bookings.find((x: any) => x.id === 'B0002');
  assert.equal(b1.start, '2026-10-12T14:00', '既有预约 B0001 不被第二次提交改变');
  assert.equal(b2.status, 'cancelled', '既有预约 B0002 不被第二次提交复活');
  assert.equal(store.waitlist?.length ?? 0, 0, '不产生候补记录');
});

// ---------------------------------------------------------------------------
// 6. 真实保存失败与重试：退出 1、原文件逐字节保留、标识未消费，可保存位置重试成功
// ---------------------------------------------------------------------------

test('保存失败：退出 1 且数据逐字节保留、不消费标识；换可保存位置重试成功', (t) => {
  const dir = tempDir(t);
  const good = join(dir, 'data.json');
  addResource(good, '甲'); // R0001
  ok(
    good,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'],
    '既有预约 B0001',
  );

  const manifest = writeManifest(dir, 'plan.json', [
    {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
  ]);
  const origBytes = readFileSync(good);

  // 文件名 255 字节：临时文件名超限，保存必然失败
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r1 = bizFail(longFile, ['create-flex-bookings', manifest], '保存失败');
  assert.match(r1.stderr, /保存数据文件/);
  assert.ok(!r1.stdout.includes('成功'), '不报告成功');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  let store = readStore(longFile);
  assert.equal(store.bookings.length, 1, '不新增预约');
  assert.equal(store.bookingSeq, 1, '失败不消费预约标识');

  // 同一原数据复制到可保存位置重试：成功且新预约仍是 B0002（未被失败尝试消费），
  // 由新进程查询持久安排
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = flex(retryFile, manifest, '可保存位置重试');
  assertPlan(r2, [[1, 'B0002', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001']]], '重试得到 B0002');
  const day = ok(retryFile, ['list-bookings', '--date', '2026-10-12'], '新进程查询重试结果');
  assert.match(day.stdout, /B0002 \[已预约\] 2026-10-12T08:00 → 2026-10-12T09:00/);
  store = readStore(retryFile);
  assert.equal(store.bookingSeq, 2);
});

// ---------------------------------------------------------------------------
// 7. 并发提交：写入保护串行化，两个竞争同一资源的请求都成功（后到者按最新占用排）
// ---------------------------------------------------------------------------

test('并发提交受写入保护串行化：共同资源竞争时两者都成功且不重叠', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const m1 = writeManifest(dir, 'a.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ]);
  const m2 = writeManifest(dir, 'b.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ]);

  const run = (manifest: string) =>
    new Promise<CliResult>((resolve) => {
      const child = spawn(process.execPath, [APP, '--data', df, 'create-flex-bookings', manifest], {encoding: 'utf8'});
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('exit', (status) => resolve({status: status ?? -1, stdout, stderr}));
    });

  const [r1, r2] = await Promise.all([run(m1), run(m2)]);
  assert.equal(r1.status, 0, `并发请求一应成功\nstderr:\n${r1.stderr}`);
  assert.equal(r2.status, 0, `并发请求二应成功（等待保护后按最新占用排程）\nstderr:\n${r2.stderr}`);

  const store = readStore(df);
  assert.equal(store.bookings.length, 2, '两个请求各创建一个预约');
  const starts = store.bookings.map((b: any) => b.start).sort();
  assert.deepEqual(starts, ['2026-10-12T08:00', '2026-10-12T09:00'], '端点相接、互不重叠');
});

// ---------------------------------------------------------------------------
// 8. 用法错误（退出 2）与非法请求（退出 1，不产生记录）
// ---------------------------------------------------------------------------

test('用法错误退出 2；非法清单/损坏数据退出 1 且不改动数据', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const bytesBefore = readFileSync(df);
  const base = '2026-10-12T08:00/2026-10-12T12:00';

  // 用法错误（退出 2）
  usageFail(df, ['create-flex-bookings'], '缺少清单位置参数');
  usageFail(df, ['create-flex-bookings', 'a.json', 'b.json'], '多余位置参数');
  usageFail(df, ['create-flex-bookings', 'a.json', '--bogus', 'x'], '未知选项');

  // 清单文件错误（退出 1）
  bizFail(df, ['create-flex-bookings', join(dir, 'no-such-file.json')], '清单不存在');
  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{ not json', 'utf8');
  let r = bizFail(df, ['create-flex-bookings', broken], '清单 JSON 损坏');
  assert.match(r.stderr, /已损坏，不是合法 JSON/);

  const expectBiz = (items: unknown, pattern: RegExp, ctx: string): void => {
    const p = writeManifest(dir, `bad-${ctx.replace(/\W/g, '')}.json`, items);
    r = bizFail(df, ['create-flex-bookings', p], ctx);
    assert.match(r.stderr, pattern, `[${ctx}] stderr:\n${r.stderr}`);
  };

  // 顶层与结构
  const topFile = join(dir, 'top.json');
  writeFileSync(topFile, JSON.stringify([{window: base, duration: 60, groups: [['R0001']]}]), 'utf8');
  r = bizFail(df, ['create-flex-bookings', topFile], '顶层为数组');
  assert.match(r.stderr, /顶层必须是对象/);
  const unknownField = join(dir, 'unknown.json');
  writeFileSync(unknownField, JSON.stringify({items: [{window: base, duration: 60, groups: [['R0001']], x: 1}]}), 'utf8');
  r = bizFail(df, ['create-flex-bookings', unknownField], '未知字段');
  assert.match(r.stderr, /未知字段/);
  const emptyItems = join(dir, 'empty.json');
  writeFileSync(emptyItems, JSON.stringify({items: []}), 'utf8');
  r = bizFail(df, ['create-flex-bookings', emptyItems], '空清单');
  assert.match(r.stderr, /至少包含一项/);

  // 各项字段错误
  expectBiz([{window: base, duration: 60}], /groups 必须是非空数组/, '缺少 groups');
  expectBiz([{window: base, duration: 60, groups: []}], /至少一个需求组/, 'groups 为空');
  expectBiz([{window: base, duration: 60, groups: [[]]}], /必须是非空数组/, '需求组为空');
  expectBiz([{window: base, duration: 60, groups: [['R0001', 'R0001']]}], /候选资源重复: R0001/, '组内重复');
  expectBiz([{window: base, duration: 60, groups: [['R0009']]}], /未知资源标识: R0009/, '未知资源');
  expectBiz([{window: base, duration: 60, groups: [['']]}], /必须是非空资源标识字符串/, '空资源标识');
  expectBiz([{window: base, duration: 60, groups: ['R0001']}], /必须是非空数组/, '组不是数组');
  expectBiz([{window: 8, duration: 60, groups: [['R0001']]}], /window 必须是/, 'window 不是字符串');
  expectBiz([{window: '2026-10-12T12:00/2026-10-12T08:00', duration: 60, groups: [['R0001']]}], /结束时间必须晚于开始时间/, '窗口结束早于开始');
  expectBiz([{window: '2026-02-30T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]}], /不是真实有效的时间/, '窗口日期不真实');
  expectBiz([{window: base, duration: 0, groups: [['R0001']]}], /正整数分钟/, '时长为 0');
  expectBiz([{window: base, duration: 1.5, groups: [['R0001']]}], /正整数分钟/, '时长为小数');
  expectBiz([{window: base, duration: '60', groups: [['R0001']]}], /正整数分钟/, '时长为字符串');
  expectBiz([{window: '2026-10-12T08:00/2026-10-12T09:00', duration: 61, groups: [['R0001']]}], /超过窗口长度/, '时长超过窗口');
  expectBiz([{window: base, duration: 60, groups: [['R0001']], extra: 1}], /未知字段/, '项内未知字段');

  // 多问题一次性按清单顺序报告
  const multi = writeManifest(dir, 'multi.json', [
    {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 120, groups: [['R0001']]},
    {window: base, duration: 60, groups: [['R0001', 'R0001']]},
  ]);
  r = bizFail(df, ['create-flex-bookings', multi], '多项非法一次报告');
  assert.match(r.stderr, /第 1 项/);
  assert.match(r.stderr, /超过窗口长度/);
  assert.match(r.stderr, /第 2 项/);
  assert.match(r.stderr, /候选资源重复/);

  // 损坏数据文件：退出 1，原文件保留
  const bad = join(dir, 'bad-data.json');
  writeFileSync(bad, '{ corrupt', 'utf8');
  const badBytes = readFileSync(bad);
  const goodManifest = writeManifest(dir, 'ok.json', [
    {window: base, duration: 60, groups: [['R0001']]},
  ]);
  r = bizFail(bad, ['create-flex-bookings', goodManifest], '数据文件损坏');
  assert.match(r.stderr, /已损坏/);
  assertFileBytes(bad, badBytes, '损坏数据文件原样保留');

  // 全部失败后原数据文件逐字节不变、无新增记录
  assertFileBytes(df, bytesBefore, '全部失败请求后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '失败不产生预约');
  assert.equal(store.bookingSeq, 0, '失败不推进计数');
});
