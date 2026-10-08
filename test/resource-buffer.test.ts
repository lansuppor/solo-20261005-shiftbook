// shiftbook 资源“预约前准备/结束后整理”缓冲时间自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 覆盖：设置持久化与新进程查询、非法值拒绝、旧文件缺字段兼容与持久字段非法
//   损坏、仅缓冲重叠冲突与扩张后端点相接、多资源不取最大缓冲、准备跨窗
//   （find-slot/弹性候补/创建覆盖）、不同缓冲资源取舍、schedule-flex 缓冲间隔
//   与按活动时间的衔接关系、add-closure 按实际占用识别及附清单改期、撤销受阻与
//   解除后恢复、reschedule-flex 无变化不写文件、固定/弹性候补缓冲诊断、导入新项
//   与系列按实际占用校验、年份边界拒绝、usage-stats 跨日按实际占用计时拆日峰值、
//   真实保存失败重试且设置未消费。
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-buffer-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

interface BufferOpts {
  prep?: string;
  teardown?: string;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  buf: BufferOpts = {},
): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  if (buf.prep !== undefined) args.push('--prep-minutes', buf.prep);
  if (buf.teardown !== undefined) args.push('--teardown-minutes', buf.teardown);
  ok(df, args, `登记资源 ${name}`);
}

function create(df: string, resources: string[], start: string, end: string, ctx: string): CliResult {
  const args = ['create-booking', '--start', start, '--end', end];
  for (const id of resources) args.push('--resource', id);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function writeStore(df: string, store: unknown): void {
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf8');
}

function ical(uid: string, start: string, end: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// 1. 设置持久化、显示与新进程查询
// ---------------------------------------------------------------------------

test('缓冲设置：add-resource 持久化，list-resources 显示，新进程查询保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '15'}); // R0001
  addResource(df, '乙'); // R0002 全部省略 -> 0
  addResource(df, '丙', OPEN_ALL, {prep: '0', teardown: '0'}); // R0003 显式 0

  let store = readStore(df);
  assert.deepEqual(
    store.resources.map((r: any) => [r.id, r.prepMinutes, r.teardownMinutes]),
    [
      ['R0001', 30, 15],
      ['R0002', 0, 0],
      ['R0003', 0, 0],
    ],
    '设置随数据文件持久化',
  );
  assert.equal(store.resourceSeq, 3, '资源计数正确');

  // 新进程查询显示设置
  const r = ok(df, ['list-resources'], '列出资源');
  assert.match(r.stdout, /R0001[\s\S]*?预约前准备 30 分钟，结束后整理 15 分钟/);
  assert.match(r.stdout, /R0002[\s\S]*?预约前准备 0 分钟，结束后整理 0 分钟/);
  assert.match(r.stdout, /R0003[\s\S]*?预约前准备 0 分钟，结束后整理 0 分钟/);

  // 再经一次写入（创建预约）后设置仍保留
  create(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', '创建预约');
  store = readStore(df);
  assert.equal(store.resources[0].prepMinutes, 30, '其他写入不丢失设置');
  assert.equal(store.resources[0].teardownMinutes, 15);
});

// ---------------------------------------------------------------------------
// 2. 非法缓冲值拒绝（不创建资源、不推进计数）
// ---------------------------------------------------------------------------

test('缓冲设置：非法值拒绝（小数、文字、前导零、超安全整数、负值）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');

  const before = readFileSync(df);
  const base = ['--type', 'venue', '--name', '坏', '--open', '2026-01-01T00:00/2027-01-01T00:00'];
  // 负数以 '-' 开头被选项解析器判为缺少值 -> 用法错误 2
  usageFail(df, ['add-resource', ...base, '--prep-minutes', '-3'], '负数准备分钟');
  usageFail(df, ['add-resource', ...base, '--teardown-minutes', '-0'], '负零整理分钟');
  usageFail(df, ['add-resource', ...base, '--prep-minutes='], '空值');
  // 小数、文字、前导零、超安全整数 -> 业务错误 1
  for (const v of ['1.5', 'abc', '007', ' 3', '3 ', '9007199254740992', '1e3']) {
    bizFail(df, ['add-resource', ...base, '--prep-minutes', v], `非法准备分钟 ${v}`);
  }
  bizFail(df, ['add-resource', ...base, '--teardown-minutes', '0.1'], '小数整理分钟');
  // 重复指定只允许一次
  usageFail(
    df,
    ['add-resource', ...base, '--prep-minutes', '1', '--prep-minutes', '2'],
    '准备分钟重复指定',
  );

  assert.ok(before.equals(readFileSync(df)), '非法尝试逐字节保留原文件');
  let store = readStore(df);
  assert.equal(store.resources.length, 1, '非法值不创建资源');
  assert.equal(store.resourceSeq, 1, '失败不推进计数');
  assert.equal(store.resources[0].id, 'R0001');

  // 最大安全整数合法
  ok(df, ['add-resource', ...base, '--prep-minutes', '9007199254740991'], '最大安全整数');
  store = readStore(df);
  assert.equal(store.resourceSeq, 2, '成功登记推进计数');
  assert.equal(store.resources.find((r: any) => r.id === 'R0002').prepMinutes, Number.MAX_SAFE_INTEGER);
});

// ---------------------------------------------------------------------------
// 3. 旧文件缺字段兼容；持久字段非法视为损坏（读写都拒绝，原文件保留）
// ---------------------------------------------------------------------------

test('缓冲设置：旧文件缺字段按 0；字段非法即损坏，拒绝加载且原文件保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '15'});

  // 旧文件：删除两个字段
  const old = readStore(df);
  delete old.resources[0].prepMinutes;
  delete old.resources[0].teardownMinutes;
  writeStore(df, old);
  const list = ok(df, ['list-resources'], '旧文件可查询');
  assert.match(list.stdout, /R0001[\s\S]*?预约前准备 0 分钟，结束后整理 0 分钟/);
  // 旧文件上创建预约成功（按 0 缓冲），保存后回填字段
  create(df, ['R0001'], '2026-10-12T09:00', '2026-10-12T10:00', '旧文件创建预约');
  assert.deepEqual(
    readStore(df).resources.map((r: any) => [r.prepMinutes, r.teardownMinutes]),
    [[0, 0]],
    '保存后规范化为 0',
  );

  // 各种非法持久字段
  const good = readStore(df);
  for (const bad of [-5, 1.5, '30', null, true, 1.1]) {
    const corrupted = JSON.parse(JSON.stringify(good));
    corrupted.resources[0].prepMinutes = bad;
    writeStore(df, corrupted);
    const bytes = readFileSync(df);
    const r1 = runCli(df, ['list-resources']);
    assert.equal(r1.status, 1, `prepMinutes=${JSON.stringify(bad)} 查询应判损坏`);
    assert.match(r1.stderr, /结构非法/);
    assert.match(r1.stderr, /prepMinutes 必须是非负安全整数/);
    const r2 = runCli(df, [
      'create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00',
    ]);
    assert.equal(r2.status, 1, `prepMinutes=${JSON.stringify(bad)} 修改应判损坏`);
    assert.ok(bytes.equals(readFileSync(df)), `prepMinutes=${JSON.stringify(bad)} 原文件保留`);
  }
});

// ---------------------------------------------------------------------------
// 4. 仅缓冲重叠冲突；扩张后端点相接可行；冲突列双方实际占用
// ---------------------------------------------------------------------------

test('实际占用：仅准备/整理重叠也冲突，扩张后端点相接可行，冲突列双方占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '30'});
  create(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001'); // 实际占用 09:30-11:30

  // 活动端点相接（11:00）但准备 30 分钟伸入 B0001 整理段 -> 仅缓冲重叠，冲突
  const clash = bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '活动相接但缓冲重叠',
  );
  assert.match(clash.stderr, /B0001/);
  assert.match(clash.stderr, /R0001（甲）：本预约实际占用 2026-10-12T10:30 → 2026-10-12T12:30/);
  assert.match(clash.stderr, /B0001实际占用 2026-10-12T09:30 → 2026-10-12T11:30/);

  // 活动 11:30 开始：准备到 11:00，与 B0001 占用（至 11:30）仍重叠 30 分钟 -> 冲突
  bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:30', '--end', '2026-10-12T11:45'],
    '缓冲仍重叠',
  );

  // 活动 12:00 开始：实际占用 11:30-12:30，与 B0001 占用 09:30-11:30 端点相接 -> 可行
  create(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T12:30', 'B0002 端点相接');

  // 已取消预约不占用：取消 B0002 后同一时段可再建
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  create(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T12:30', 'B0003 取消后可建');
});

// ---------------------------------------------------------------------------
// 5. 多资源各按各缓冲扩张，不取最大缓冲统一扩张
// ---------------------------------------------------------------------------

test('实际占用：多资源分别扩张，不取最大缓冲', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '慢', OPEN_ALL, {prep: '60'}); // R0001 准备 60
  addResource(df, '快', OPEN_ALL, {}); // R0002 无缓冲
  create(df, ['R0001', 'R0002'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001 同时占用两资源');

  // 仅用 R0002：活动 11:00 开始，R0002 上双方占用 [10,11) 与 [11,11:30) 端点相接 -> 可行。
  // 若错误地取最大准备 60 统一扩张，本会被 R0001 的缓冲阻挡。
  create(df, ['R0002'], '2026-10-12T11:00', '2026-10-12T11:30', 'B0002 只用快资源');

  // 仅用 R0001：活动 11:00 开始其占用 [10:00,11:00) 与 B0001 在 R0001 的占用 [09:00,11:00) 重叠 -> 冲突
  bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30'],
    '慢资源活动相接仍冲突',
  );
  // R0001 活动 12:00（占用 11:00-11:30）与 B0001 占用至 11:00 端点相接 -> 可行
  create(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T12:30', 'B0003 慢资源端点相接');
});

// ---------------------------------------------------------------------------
// 6. 准备/整理跨窗：find-slot、弹性候补、创建覆盖
// ---------------------------------------------------------------------------

test('窗口只限制活动起止：准备跨窗须实际可用（find-slot/弹性候补/创建）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', [['2026-10-12T09:00', '2026-10-12T18:00']], {prep: '30', teardown: '30'});

  // find-slot：窗口 09:00-10:00、时长 30 -> 最早活动 09:30（活动结束恰为窗尾，
  // 占用 09:00-10:30，整理可伸出窗口但落在开放内）
  const slot = ok(
    df,
    ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T10:00', '--duration', '30', '--group', 'R0001'],
    '准备跨窗查询',
  );
  assert.match(slot.stdout, /最早可行时段: 2026-10-12T09:30 → 2026-10-12T10:00/);

  // 窗口只到 09:30、时长 30：最早活动需 09:30，活动结束为 10:00 超出窗尾 -> 无解（退出 0）
  const none = ok(
    df,
    ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T09:30', '--duration', '30', '--group', 'R0001'],
    '窗口装不下含准备活动',
  );
  assert.match(none.stdout, /无解/);

  // 直接创建活动 09:00：准备 08:30 在开放前 -> 拒绝并显示实际占用
  const cover = bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T09:30'],
    '准备在开放前',
  );
  assert.match(cover.stderr, /实际占用: 2026-10-12T08:30 → 2026-10-12T10:00/);

  // 弹性候补登记同样要求扣除前后预留后能容纳；窗口 09:00-09:30 时长 30 拒绝
  const reg = bizFail(
    df,
    ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T09:00/2026-10-12T09:30', '--duration', '30'],
    '弹性候补窗口装不下',
  );
  assert.match(reg.stderr, /不存在长度不少于 30 分钟的连续区间/);
  // 窗口 09:00-10:00 时长 30 可登记；兑现取活动 09:30-10:00（整理伸出窗口到 10:30）
  ok(
    df,
    ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T09:00/2026-10-12T10:00', '--duration', '30'],
    '弹性候补可登记',
  );
  const proc = ok(df, ['process-waitlist'], '兑现弹性候补');
  assert.match(proc.stdout, /实际时间: 2026-10-12T09:30 → 2026-10-12T10:00/);
});

// ---------------------------------------------------------------------------
// 7. 不同缓冲资源在 find-slot / schedule-flex 中的取舍
// ---------------------------------------------------------------------------

test('不同缓冲资源取舍：最早活动优先，缓冲小的资源更早可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  const dayOpen: Array<[string, string]> = [['2026-10-12T09:00', '2026-10-12T18:00']];
  addResource(df, '慢', dayOpen, {prep: '60'}); // R0001 开放 09:00 起，最早活动 10:00
  addResource(df, '快', dayOpen, {}); // R0002 无缓冲，最早活动 09:00

  // 窗口 09:00-18:00 时长 30：慢资源最早活动 10:00，快资源 09:00 -> 取快资源 09:00
  const slot = ok(
    df,
    ['find-slot', '--window', '2026-10-12T09:00/2026-10-12T18:00', '--duration', '30', '--group', 'R0001,R0002'],
    'find-slot 取低缓冲资源',
  );
  assert.match(slot.stdout, /最早可行时段: 2026-10-12T09:00 → 2026-10-12T09:30/);
  assert.match(slot.stdout, /第 1 组: R0002/);

  // schedule-flex：两项同用慢资源（准备 60），第二项活动最早 10:00
  // （B 活动 09:00 会与 A 的实际占用 [08:00,10:00) 重叠）
  const manifest = join(dir, 'flex.json');
  writeFile(
    manifest,
    JSON.stringify({
      items: [
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
      ],
    }),
  );
  const plan = ok(df, ['schedule-flex', manifest], '联合排程含缓冲间隔');
  assert.match(plan.stdout, /第 1 项 -> B0001: 2026-10-12T10:00 → 2026-10-12T11:00/);
  assert.match(plan.stdout, /第 2 项 -> B0002: 2026-10-12T12:00 → 2026-10-12T13:00/);

  // 衔接关系按活动时间：minGap=maxGap=0 要求活动紧接，但实际占用需 60 分钟间隔 -> 无整体解
  const tight = join(dir, 'tight.json');
  writeFile(
    tight,
    JSON.stringify({
      items: [
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
      ],
      relations: [{predecessor: 1, successor: 2, minGap: 0, maxGap: 0}],
    }),
  );
  bizFail(df, ['schedule-flex', tight], '零活动间隔与缓冲冲突 -> 无解');

  // minGap=60 恰等于所需准备间隔 -> 有解，第二项活动 09:00+60=10:00
  const gap60 = join(dir, 'gap60.json');
  writeFile(
    gap60,
    JSON.stringify({
      items: [
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0002', 'R0001']]},
        {window: '2026-10-12T08:00/2026-10-12T18:00', duration: 60, groups: [['R0001']]},
      ],
      relations: [{predecessor: 1, successor: 2, minGap: 60, maxGap: 60}],
    }),
  );
  // 先撤销前次排程的占用，避免干扰
  ok(df, ['cancel-booking', 'B0001'], '取消 B0001');
  ok(df, ['cancel-booking', 'B0002'], '取消 B0002');
  const plan2 = ok(df, ['schedule-flex', gap60], '关系按活动时间且满足缓冲');
  // 项1 只能取 R0002 活动 09:00-10:00（R0001 最早活动 10:00），关系 +60 -> 项2 活动 11:00
  assert.match(plan2.stdout, /第 1 项 -> B0003: 2026-10-12T09:00 → 2026-10-12T10:00/);
  assert.match(plan2.stdout, /第 2 项 -> B0004: 2026-10-12T11:00 → 2026-10-12T12:00/);
});

// ---------------------------------------------------------------------------
// 8. add-closure 按实际占用识别受影响预约；附清单改期；撤销受阻与解除后恢复
// ---------------------------------------------------------------------------

test('停用：按实际占用识别，附清单改期，停用有效时撤销受阻、取消后恢复', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '30'});
  create(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // 停用 11:00-11:30：活动本身不重叠，但整理占用到 11:30 -> 无清单拒绝并列全
  const reject = bizFail(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30'],
    '整理段重叠识别受影响预约',
  );
  assert.match(reject.stderr, /B0001（2026-10-12T10:00 → 2026-10-12T11:00）/);

  // 停用 11:30-12:00：与整理占用（至 11:30）端点相接 -> 直接登记成功
  ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:30', '--end', '2026-10-12T12:00'],
    '端点相接可停用',
  );
  ok(df, ['cancel-closure', 'C0001'], '取消停用备用');

  // 附清单一次提交：拟停用计入求解，B0001 改到活动 08:00（占用 07:30-09:00）
  const manifest = join(dir, 'moves.json');
  writeFile(
    manifest,
    JSON.stringify({
      items: [
        {bookingId: 'B0001', window: '2026-10-12T06:00/2026-10-12T18:00', groups: [['R0001']]},
      ],
    }),
  );
  const commit = ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30', manifest],
    '停用同次改期',
  );
  assert.match(commit.stdout, /已登记停用 C0002/);
  assert.match(commit.stdout, /改期操作标识: O0001/);
  assert.match(commit.stdout, /B0001: 2026-10-12T06:00 → 2026-10-12T07:00/);
  // 停用每次新建；此处是第二条停用
  assert.equal(readStore(df).closureSeq, 2);

  // 停用仍有效：恢复为 10:00 活动（占用 09:30-11:30）被停用 [11:00,11:30) 阻挡 -> 整笔拒绝
  const blocked = bizFail(df, ['undo-batch-op', 'O0001'], '撤销被停用阻挡');
  assert.match(blocked.stderr, /相关有效停用: C0002/);
  assert.match(blocked.stderr, /实际占用: 2026-10-12T09:30 → 2026-10-12T11:30/);
  // 安全撤销只恢复预约，不取消停用
  const storeMid = readStore(df);
  assert.equal(storeMid.closures.find((c: any) => c.id === 'C0002').status, 'active');
  assert.equal(storeMid.bookings.find((b: any) => b.id === 'B0001').start, '2026-10-12T06:00');

  // 取消停用后整笔恢复成功
  ok(df, ['cancel-closure', 'C0002'], '取消停用');
  ok(df, ['undo-batch-op', 'O0001'], '解除后撤销成功');
  const b = readStore(df).bookings.find((x: any) => x.id === 'B0001');
  assert.equal(b.start, '2026-10-12T10:00');
  assert.equal(b.end, '2026-10-12T11:00');
});

// ---------------------------------------------------------------------------
// 9. reschedule-flex 无变化不写文件；缓冲阻挡下求解
// ---------------------------------------------------------------------------

test('弹性批量改期：无变化不写文件不建记录；缓冲占用纳入求解', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '30'});
  create(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // 保持现状可行 -> 无变化成功，不写文件、不建记录、不推进计数
  const manifest = join(dir, 'keep.json');
  writeFile(
    manifest,
    JSON.stringify({
      items: [
        {bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001']]},
      ],
    }),
  );
  const before = readFileSync(df);
  const noChange = ok(df, ['reschedule-flex', manifest], '无变化成功');
  assert.match(noChange.stdout, /无业务变化/);
  assert.ok(before.equals(readFileSync(df)), '无变化不写文件');
  assert.equal(readStore(df).batchSeq, 0, '不推进操作计数');

  // 新增停用 11:00-11:30 附同格式清单：求解须避开缓冲，改到最早活动 08:00
  const moves = join(dir, 'moves.json');
  writeFile(
    moves,
    JSON.stringify({
      items: [
        {bookingId: 'B0001', window: '2026-10-12T06:00/2026-10-12T18:00', groups: [['R0001']]},
      ],
    }),
  );
  const changed = ok(
    df,
    ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30', moves],
    '停用同次弹性改期',
  );
  assert.match(changed.stdout, /O0001/);
  assert.equal(readStore(df).bookings.find((b: any) => b.id === 'B0001').start, '2026-10-12T06:00');
});

// ---------------------------------------------------------------------------
// 10. 固定/弹性候补按实际占用判定与诊断
// ---------------------------------------------------------------------------

test('候补：固定项按实际占用受阻；弹性诊断显示扣除占用与前后预留后的最大共同区间', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {teardown: '30'}); // 仅整理 30
  create(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001'); // 占用至 11:30

  // 固定候补活动 11:00-12:00：登记允许（不查冲突），处理时因整理缓冲重叠受阻
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00'],
    '登记固定候补',
  );
  // 弹性候补窗口 11:00-12:00 时长 60：占用域 [11:00,12:30) 扣 B0001 占用至 11:30、
  // 再收缩整理 30 -> 活动空闲仅 [11:30,12:00) 30 分钟，登记可过（忽略预约占用），
  // 但处理时放不下 60 分钟
  ok(
    df,
    ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T11:00/2026-10-12T12:00', '--duration', '60'],
    '登记弹性候补',
  );
  const proc = ok(df, ['process-waitlist'], '两项均受阻');
  assert.match(proc.stdout, /没有可兑现项/);
  // 固定项诊断：列双方实际占用
  assert.match(proc.stdout, /本候补实际占用 2026-10-12T11:00 → 2026-10-12T12:30/);
  assert.match(proc.stdout, /B0001实际占用 2026-10-12T10:00 → 2026-10-12T11:30/);
  // 弹性项诊断：扣除占用及整理预留后的最大共同区间 11:30-12:00（30 分钟）
  assert.match(proc.stdout, /2026-10-12T11:30 → 2026-10-12T12:00（30 分钟）/);
  // 未兑现不占用：随后新建活动 11:00 仍只受 B0001 阻挡，与候补无关
  const store = readStore(df);
  assert.equal(store.bookingSeq, 1, '受阻不创建预约');
  assert.deepEqual(store.waitlist.map((w: any) => w.status), ['waiting', 'waiting']);
});

// ---------------------------------------------------------------------------
// 11. iCalendar 导入新项与系列按实际占用校验
// ---------------------------------------------------------------------------

test('导入新项与系列：按实际占用判覆盖与冲突；系列成员互不冲突', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30'});
  create(df, ['R0001'], '2026-10-12T09:30', '2026-10-12T10:30', 'B0001'); // 占用 09:00-10:30

  // 新事件活动 10:00-11:00：占用 09:30-11:00 与 B0001 重叠 -> 整批拒绝
  const clashIcs = join(dir, 'clash.ics');
  writeFile(clashIcs, ical('uid-clash', '20261012T100000', '20261012T110000'));
  const clash = bizFail(df, ['import-ical', clashIcs, '--resource', 'R0001'], '导入缓冲冲突');
  assert.match(clash.stderr, /本次发生实际占用 2026-10-12T09:30 → 2026-10-12T11:00/);

  // 新事件活动 11:00-12:00：占用 10:30-12:00 与 B0001 占用（至 10:30）端点相接 -> 成功
  const okIcs = join(dir, 'ok.ics');
  writeFile(okIcs, ical('uid-ok', '20261012T110000', '20261012T120000'));
  const imported = ok(df, ['import-ical', okIcs, '--resource', 'R0001'], '导入端点相接');
  assert.match(imported.stdout, /新预约 B0002/);

  // 按周系列 count=2：周间隔远大于缓冲，成员互不冲突；与既有预约按实际占用冲突则整批失败
  const seriesIcs = join(dir, 'series.ics');
  writeFile(
    seriesIcs,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:uid-series',
      'DTSTART:20261019T100000',
      'DTEND:20261019T110000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );
  const series = ok(df, ['import-ical', seriesIcs, '--resource', 'R0001'], '导入按周系列');
  assert.match(series.stdout, /新系列 S0001/);
  assert.match(series.stdout, /生成 2 个成员/);

  // 年份边界：0001 年活动带准备越界 -> 整批拒绝
  const ancient = join(dir, 'ancient.ics');
  writeFile(ancient, ical('uid-ancient', '00010101T000000', '00010101T010000'));
  bizFail(df, ['import-ical', ancient, '--resource', 'R0001'], '准备越出年份下界');
});

// ---------------------------------------------------------------------------
// 12. 年份边界：准备/整理使占用越出 0001-9999 即拒绝；活动自身在界内
// ---------------------------------------------------------------------------

test('年份边界：实际占用越界拒绝，端点贴边可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '古', [['0001-01-01T00:00', '9999-12-31T23:59']], {prep: '10'});
  bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '0001-01-01T00:00', '--end', '0001-01-01T01:00'],
    '准备越下界',
  );
  create(df, ['R0001'], '0001-01-01T00:10', '0001-01-01T01:00', '贴下界成功');

  const df2 = join(dir, 'd2.json');
  addResource2(df2, '远', [['0001-01-01T00:00', '9999-12-31T23:59']], {teardown: '5'});
  bizFail(
    df2,
    ['create-booking', '--resource', 'R0001', '--start', '9999-12-31T23:55', '--end', '9999-12-31T23:59'],
    '整理越上界',
  );
  create(df2, ['R0001'], '9999-12-31T23:50', '9999-12-31T23:54', '贴上界成功');

  // 系列首项贴下界但准备越界 -> 整批失败，不分配标识
  const df3 = join(dir, 'd3.json');
  addResource2(df3, '古系列', [['0001-01-01T00:00', '9999-12-31T23:59']], {prep: '10'});
  bizFail(
    df3,
    ['create-series', '--resource', 'R0001', '--start', '0001-01-01T00:00', '--end', '0001-01-01T01:00', '--count', '1'],
    '系列准备越界',
  );
  assert.equal(readStore(df3).bookingSeq, 0, '失败不分配标识');
});

// 独立数据文件的资源登记助手（同目录多文件场景）
function addResource2(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  buf: BufferOpts = {},
): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  if (buf.prep !== undefined) args.push('--prep-minutes', buf.prep);
  if (buf.teardown !== undefined) args.push('--teardown-minutes', buf.teardown);
  ok(df, args, `登记资源 ${name}`);
}

// ---------------------------------------------------------------------------
// 13. usage-stats 按实际占用计时、跨日拆日与峰值
// ---------------------------------------------------------------------------

test('usage-stats：实际占用计时、跨日拆日、峰值按实际占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', OPEN_ALL, {prep: '30', teardown: '30'}); // R0001
  addResource(df, '乙', OPEN_ALL, {}); // R0002 无缓冲
  create(df, ['R0001', 'R0002'], '2026-10-12T23:00', '2026-10-13T01:00', '跨日预约');

  const stats = ok(
    df,
    ['usage-stats', '--window', '2026-10-12T00:00/2026-10-14T00:00', '--resource', 'R0001', '--resource', 'R0002'],
    '跨日统计',
  );
  // R0001 实际占用 22:30-次日01:30：首日 90 分钟、次日 90 分钟；R0002 活动本体各 60 分钟
  assert.match(stats.stdout, /2026-10-12:[\s\S]*?R0001（甲[^）]*）: 可用 1440 分钟，占用 90 分钟/);
  assert.match(stats.stdout, /2026-10-12:[\s\S]*?R0002（乙[^）]*）: 可用 1440 分钟，占用 60 分钟/);
  assert.match(stats.stdout, /2026-10-13:[\s\S]*?R0001（甲[^）]*）: 可用 1440 分钟，占用 90 分钟/);
  assert.match(stats.stdout, /2026-10-13:[\s\S]*?R0002（乙[^）]*）: 可用 1440 分钟，占用 60 分钟/);
  assert.match(stats.stdout, /R0001（甲[^）]*）: 可用 2880 分钟，占用 180 分钟/);
  assert.match(stats.stdout, /R0002（乙[^）]*）: 可用 2880 分钟，占用 120 分钟/);
  // 峰值：两资源同时被占的区间为活动本体 23:00-01:00（R0001 的缓冲段仅 1 个资源）
  assert.match(stats.stdout, /繁忙峰值: 同时被占用的所选资源数量峰值为 2/);
  assert.match(stats.stdout, /2026-10-12T23:00 → 2026-10-13T01:00（120 分钟）/);
});

// ---------------------------------------------------------------------------
// 14. 真实保存失败：设置不消费、原文件保留、可重试
// ---------------------------------------------------------------------------

test('真实保存失败：缓冲登记失败逐字节保留，重试仍失败且计数不变', (t) => {
  const dir = tempDir(t);
  const good = join(dir, 'data.json');
  addResource(good, '甲');
  const longFile = join(dir, LONG_NAME);
  copyFileSync(good, longFile);
  const orig = readFileSync(longFile);

  const args = [
    'add-resource', '--type', 'venue', '--name', '坏',
    '--open', '2026-01-01T00:00/2027-01-01T00:00',
    '--prep-minutes', '20', '--teardown-minutes', '10',
  ];
  const r1 = runCli(longFile, args);
  assert.equal(r1.status, 1, '保存失败退出 1');
  assert.match(r1.stderr, /保存数据文件/);
  assert.ok(orig.equals(readFileSync(longFile)), '原文件逐字节保留');
  const r2 = runCli(longFile, args);
  assert.equal(r2.status, 1, '重试仍失败（失败于保存而非锁占用）');
  assert.match(r2.stderr, /保存数据文件/);
  assert.ok(orig.equals(readFileSync(longFile)), '重试后原文件仍保留');
  const store = JSON.parse(orig.toString('utf8'));
  assert.equal(store.resourceSeq, 1, '失败不消费资源标识');
  assert.equal(store.resources.length, 1);

  // 同一设置在正常文件上可成功（新进程持久结果）
  ok(
    good,
    [
      'add-resource', '--type', 'venue', '--name', '好',
      '--open', '2026-01-01T00:00/2027-01-01T00:00',
      '--prep-minutes', '20', '--teardown-minutes', '10',
    ],
    '正常文件保存成功',
  );
  const saved = readStore(good).resources.find((r: any) => r.id === 'R0002');
  assert.equal(saved.prepMinutes, 20);
  assert.equal(saved.teardownMinutes, 10);
});
