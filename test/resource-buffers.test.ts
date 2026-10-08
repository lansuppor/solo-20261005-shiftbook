// shiftbook 资源预约前准备/预约后整理时间（缓冲）端到端回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询；
// - 覆盖：
//   1) add-resource 的 --prep/--teardown 解析（省略/0/正整数接受，小数、前导零、
//      负数、超出安全整数拒绝），list-resources 显示设置，读写与重启持久保留；
//   2) 旧数据文件资源缺字段按 0 兼容；持久字段为小数/负数视为损坏（原文件保留）；
//   3) 每资源分别按自身准备/整理扩张（不取最大缓冲统一扩张）：仅缓冲重叠冲突、
//      扩张后端点相接可行、不同资源缓冲互不影响、多资源预约逐资源判定；
//   4) 实际占用越出 0001-9999 年（准备早于公元 1 年、整理晚至 10000 年）拒绝；
//   5) find-slot / 弹性候补：窗口只限制活动起止，准备/整理伸出窗口仍须实际可用，
//      不同缓冲资源影响取舍，等待诊断列出扣除占用与各资源前后预留后的最大共同区间；
//   6) schedule-flex 候选边界按共同资源各自缓冲传播（相接可行）；
//   7) add-closure 按实际占用识别受影响预约（停用自身不扩张），附清单改期成功，
//      undo-batch-op 在停用仍有效时受阻、取消停用后整笔恢复；
//   8) usage-stats 按实际占用计时并跨营业日拆分；
//   9) 无变化改期不写文件；真实保存失败后重试且标识未消费；新进程查询持久结果；
//      查询与预约记录始终只保留活动起止。
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件（<名>.<pid>.tmp）必然超出文件名长度上限，
// 可重复触发真实保存失败。
const LONG_NAME = 'b'.repeat(250) + '.json';

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-buffers-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

interface ResourceOpts {
  open?: Array<[string, string]>;
  prep?: number | string;
  teardown?: number | string;
  type?: string;
}

function addResource(df: string, name: string, opts: ResourceOpts = {}): CliResult {
  const args = ['add-resource', '--type', opts.type ?? 'venue', '--name', name];
  for (const [s, e] of opts.open ?? OPEN_ALL) args.push('--open', `${s}/${e}`);
  if (opts.prep !== undefined) args.push('--prep', String(opts.prep));
  if (opts.teardown !== undefined) args.push('--teardown', String(opts.teardown));
  return ok(df, args, `登记资源 ${name}`);
}

function addBooking(df: string, resources: string[], start: string, end: string, ctx: string): CliResult {
  const args = ['create-booking'];
  for (const r of resources) args.push('--resource', r);
  args.push('--start', start, '--end', end);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function writeStore(df: string, store: any): void {
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

// 旧版数据文件：资源缺 prepMinutes/teardownMinutes 字段
function oldStyleStore(resources: Array<{id: string; type?: string; name: string}>): any {
  return {
    version: 1,
    resourceSeq: resources.length,
    bookingSeq: 0,
    seriesSeq: 0,
    waitlistSeq: 0,
    closureSeq: 0,
    batchSeq: 0,
    resources: resources.map((r) => ({
      id: r.id,
      type: r.type ?? 'venue',
      name: r.name,
      open: [['2026-01-01T00:00', '2027-01-01T00:00']],
    })),
    bookings: [],
    series: [],
    waitlist: [],
    closures: [],
    batchOps: [],
    imports: [],
  };
}

// ---------------------------------------------------------------------------
// 1. 命令行解析、显示与持久化
// ---------------------------------------------------------------------------

test('add-resource：--prep/--teardown 省略与 0 合法，小数/前导零/负数/超安全整数拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');

  addResource(df, '甲厅', {prep: 30, teardown: 15});
  addResource(df, '乙厅', {prep: 0, teardown: 0});
  addResource(df, '丙厅'); // 全部省略

  const store = readStore(df);
  assert.deepEqual(
    store.resources.map((r: any) => [r.id, r.prepMinutes, r.teardownMinutes]),
    [
      ['R0001', 30, 15],
      ['R0002', 0, 0],
      ['R0003', 0, 0],
    ],
    '缓冲设置持久化（省略与 0 均落盘为 0）',
  );

  const r = ok(df, ['list-resources'], '列出资源');
  assert.match(r.stdout, /- R0001 \[场地\] 甲厅[\s\S]*?预约前准备: 30 分钟；预约后整理: 15 分钟/, '显示非零设置');
  assert.match(r.stdout, /R0002[\s\S]*?预约前准备: 0 分钟；预约后整理: 0 分钟/, '零设置也显示');

  // 非法值：业务错误退出 1
  for (const bad of ['1.5', 'abc', '01', '9007199254740993', '1e3']) {
    bizFail(df, ['add-resource', '--type', 'venue', '--name', `坏${bad}`, '--open', '2026-01-01T00:00/2027-01-01T00:00', '--prep', bad], `prep=${bad}`);
  }
  // 负号参数被选项解析器视为缺少值：用法错误退出 2
  usageFail(df, ['add-resource', '--type', 'venue', '--name', '坏', '--open', '2026-01-01T00:00/2027-01-01T00:00', '--teardown', '-0'], 'teardown=-0 用法错误');
  usageFail(df, ['add-resource', '--type', 'venue', '--name', '坏', '--open', '2026-01-01T00:00/2027-01-01T00:00', '--prep', '-5'], 'prep=-5 用法错误');

  // 全部拒绝都不得消耗资源标识
  assert.equal(readStore(df).resourceSeq, 3, '非法登记不推进资源计数');
});

test('旧数据文件资源缺缓冲字段按 0；设置经新进程持久保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  writeStore(df, oldStyleStore([{id: 'R0001', name: '旧厅'}]));

  const r = ok(df, ['list-resources'], '旧文件可加载');
  assert.match(r.stdout, /R0001[\s\S]*?预约前准备: 0 分钟；预约后整理: 0 分钟/, '缺字段显示为 0');

  // 旧厅无缓冲：端点相接可行
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', '旧厅预约 1');
  addBooking(df, ['R0001'], '2026-10-12T11:00', '2026-10-12T12:00', '旧厅预约端点相接');

  // 新进程中给新资源设置缓冲并预约，再次新进程验证缓冲行为持久
  addResource(df, '新厅', {prep: 30, teardown: 15});
  addBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', '新厅预约');
  const clash = bizFail(df, ['create-booking', '--resource', 'R0002', '--start', '2026-10-12T11:14', '--end', '2026-10-12T12:00'], '重启后仅缓冲重叠仍冲突');
  assert.match(clash.stderr, /本方实际占用 2026-10-12T10:44 → 2026-10-12T12:15/, '诊断给出本方实际占用');
  assert.match(clash.stderr, /对方实际占用 2026-10-12T09:30 → 2026-10-12T11:15/, '诊断给出对方实际占用');
});

test('持久化缓冲字段非法视为数据损坏，原文件保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  for (const bad of [1.5, -5, '30', null]) {
    const store = oldStyleStore([{id: 'R0001', name: '坏厅'}]);
    store.resources[0].prepMinutes = bad;
    writeStore(df, store);
    const bytes = readFileSync(df);
    const r = bizFail(df, ['list-resources'], `prepMinutes=${String(bad)} 损坏`);
    assert.match(r.stderr, /结构非法/, '说明结构非法');
    assert.ok(bytes.equals(readFileSync(df)), '损坏文件逐字节保留');
  }
});

// ---------------------------------------------------------------------------
// 2. 每资源分别扩张：仅缓冲重叠冲突、端点相接可行、不取最大缓冲
// ---------------------------------------------------------------------------

test('实际占用按资源各自缓冲扩张：仅缓冲重叠冲突，扩张后端点相接可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 15}); // R0001
  addResource(df, '乙厅'); // R0002，无缓冲
  addResource(df, '丙厅', {prep: 10, teardown: 10}); // R0003

  // B0001：活动 10:00-11:00；R0001 实际占用 09:30-11:15，R0002 实际占用 10:00-11:00
  addBooking(df, ['R0001', 'R0002'], '2026-10-12T10:00', '2026-10-12T11:00', '多资源预约');

  // R0001：新活动 11:15-12:00，准备 10:45 与对方整理（至 11:15）重叠 -> 冲突
  bizFail(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:15', '--end', '2026-10-12T12:00'], 'R0001 仅准备重叠冲突');
  // R0001：活动 11:45-12:00，准备恰自 11:15 起（相接）-> 可行
  addBooking(df, ['R0001'], '2026-10-12T11:45', '2026-10-12T12:00', 'R0001 扩张后端点相接');

  // R0002 无缓冲：11:00 紧接活动开始即可行
  addBooking(df, ['R0002'], '2026-10-12T11:00', '2026-10-12T12:00', 'R0002 活动端点相接');
  // R0002：09:30-10:00 与 B0001 在 R0002 上的占用（10:00 起）相接 -> 可行，
  // 尽管同一预约在 R0001 上的准备自 09:30 起（不能取最大缓冲统一扩张）
  addBooking(df, ['R0002'], '2026-10-12T09:30', '2026-10-12T10:00', 'R0002 不受 R0001 缓冲影响');

  // 但同样的活动若用 R0001（准备 30，自 09:00 占用，与 B0001 的 09:30 准备重叠）-> 冲突
  bizFail(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:30', '--end', '2026-10-12T09:45'], 'R0001 准备区间与共同预约准备重叠');

  // 预约记录与查询始终只保留活动起止
  const store = readStore(df);
  const b2 = store.bookings.find((x: any) => x.id === 'B0002');
  assert.equal(b2.start, '2026-10-12T11:45', '记录只存活动开始');
  assert.equal(b2.end, '2026-10-12T12:00', '记录只存活动结束');
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '按日查询');
  assert.match(list.stdout, /B0002 \[已预约\] 2026-10-12T11:45 → 2026-10-12T12:00/, '日历显示活动起止');
});

test('开放覆盖按实际占用：准备早于开放或整理超出开放即拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '限时厅', {open: [['2026-10-12T10:00', '2026-10-12T12:00']], prep: 30, teardown: 15});

  // 活动 10:00 开始但准备自 09:30，开放不足
  const early = bizFail(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T10:30'], '准备早于开放');
  assert.match(early.stderr, /实际占用（活动时间含准备 30 分钟、整理 15 分钟）: 2026-10-12T09:30 → 2026-10-12T10:45/, '列出实际占用区间');
  // 活动 11:50-12:00，整理至 12:15 超出开放
  bizFail(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:50', '--end', '2026-10-12T12:00'], '整理超出开放');
  // 活动 10:30-11:45：占用 10:00-12:00 恰好完整覆盖
  addBooking(df, ['R0001'], '2026-10-12T10:30', '2026-10-12T11:45', '恰好被开放覆盖');
});

test('实际占用越出 0001-9999 年范围即拒绝（准备侧与整理侧）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '远古厅', {open: [['0001-01-01T00:00', '0002-01-01T00:00']], prep: 10});
  addResource(df, '远末厅', {open: [['9999-12-01T00:00', '9999-12-31T23:59']], teardown: 10});

  const prep = bizFail(df, ['create-booking', '--resource', 'R0001', '--start', '0001-01-01T00:05', '--end', '0001-01-01T00:10'], '准备早于 0001 年');
  assert.match(prep.stderr, /越出四位年份范围/, '说明越界');
  addBooking(df, ['R0001'], '0001-01-01T00:10', '0001-01-01T00:20', '准备恰自元年起点');

  const tear = bizFail(df, ['create-booking', '--resource', 'R0002', '--start', '9999-12-31T23:49', '--end', '9999-12-31T23:59'], '整理晚于 9999 年');
  assert.match(tear.stderr, /越出四位年份范围/, '说明越界');
  addBooking(df, ['R0002'], '9999-12-31T23:40', '9999-12-31T23:49', '整理恰至开放结束（9999 年内）');
});

// ---------------------------------------------------------------------------
// 3. find-slot：窗口只管活动起止；不同缓冲影响资源取舍
// ---------------------------------------------------------------------------

test('find-slot：准备/整理伸出窗口仍须可用；不同缓冲资源取舍得当', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {open: [['2026-10-12T10:00', '2026-10-12T12:00']], prep: 30, teardown: 15});

  // 窗口 10:00-12:00（与开放一致），60 分钟活动最早只能 10:30 开始（准备 30），
  // 且最晚 10:45 开始（整理 15）；10:30 可行
  let r = ok(df, ['find-slot', '--window', '2026-10-12T10:00/2026-10-12T12:00', '--duration', '60', '--group', 'R0001'], 'find-slot 准备跨窗');
  assert.match(r.stdout, /最早可行时段: 2026-10-12T10:30 → 2026-10-12T11:30/, '最早活动开始受准备限制');
  assert.match(r.stdout, /R0001（甲厅）实际占用: 2026-10-12T10:00 → 2026-10-12T11:45/, '显示实际占用（伸出活动区间）');

  // 120 分钟活动放不进扣除前后预留后的 75 分钟 -> 无解（即使窗口本身有 120 分钟）
  r = ok(df, ['find-slot', '--window', '2026-10-12T10:00/2026-10-12T12:00', '--duration', '120', '--group', 'R0001'], '缓冲后无解');
  assert.match(r.stdout, /无解：窗口/, '无解退出 0');

  // 不同缓冲资源的取舍：R0001（准备30/整理15）10:00-11:00 已有活动，
  // R0002 无缓冲；窗口 10:30-12:00、60 分钟，R0001 被自身缓冲挡满，R0002 可行 -> 选 R0002
  addResource(df, '乙厅');
  addBooking(df, ['R0001'], '2026-10-12T10:30', '2026-10-12T11:30', '甲厅先占（实际占用 10:00-11:45）');
  r = ok(
    df,
    ['find-slot', '--window', '2026-10-12T10:30/2026-10-12T12:00', '--duration', '60', '--group', 'R0001,R0002'],
    '不同缓冲资源取舍',
  );
  assert.match(r.stdout, /最早可行时段: 2026-10-12T10:30 → 2026-10-12T11:30/, '选无缓冲资源的最早窗口开始');
  assert.match(r.stdout, /第 1 组: R0002（乙厅/, '选 R0002 而非被缓冲挡满的 R0001');
});

// ---------------------------------------------------------------------------
// 4. 弹性候补：登记忽略占用但须容纳前后预留；诊断列扣除预留后的最大共同区间
// ---------------------------------------------------------------------------

test('弹性候补：窗口只管活动起止；登记忽略占用；等待诊断扣除占用与前后预留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {open: [['2026-10-12T10:00', '2026-10-12T13:00']], prep: 30, teardown: 15});

  // 窗口 10:00-12:00、60 分钟：可供活动区间 10:30-11:45（75 分钟），登记成功
  ok(df, ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T12:00', '--duration', '60'], '登记弹性候补 W0001');

  // 窗口长度 60 分钟，但可供活动区间自 10:30 起（准备 30；整理可伸出窗口，故末端
  // 不收缩），仅 30 分钟：40 分钟候补登记拒绝，30 分钟可登记
  bizFail(df, ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T11:00', '--duration', '40'], '准备预留后不足 40 分钟（仅 30 分钟）');
  ok(df, ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T11:00', '--duration', '30'], '恰好 30 分钟可登记（整理伸出窗口）');

  // 立即兑现：最早活动开始 10:30（准备自 10:00）
  let r = ok(df, ['process-waitlist'], '兑现 W0001');
  assert.match(r.stdout, /W0001.*新预约 B0001/s, '生成 B0001');
  assert.match(r.stdout, /实际时间: 2026-10-12T10:30 → 2026-10-12T11:30/, '活动 10:30 开始');
  assert.match(r.stdout, /R0001（甲厅）实际占用: 2026-10-12T10:00 → 2026-10-12T11:45/, '实际占用含准备整理');

  // 登记忽略预约占用：已有 B0001（实际占用至 11:45），仍可再登记窗口 10:00-13:00、30 分钟候补
  ok(df, ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T13:00', '--duration', '30'], '占用中仍可登记 W0002');
  // 但无法兑现：B0001 活动 10:30-11:30 在活动坐标阻挡 10:15-12:30（buf=45），
  // 可供活动区间 10:30-12:45 被扣光 -> 空集，继续等待
  r = ok(df, ['process-waitlist'], 'W0002 受阻');
  assert.match(r.stdout, /继续等待 W0002/, '受阻项继续等待');
  assert.match(r.stdout, /空集：窗口内全部资源没有任何共同空闲区间/, '空集明确提示');

  // 取消阻挡预约后按登记顺序兑现
  ok(df, ['cancel-booking', 'B0001'], '取消阻挡预约');
  r = ok(df, ['process-waitlist'], '取消后兑现 W0002');
  assert.match(r.stdout, /实际时间: 2026-10-12T10:30 → 2026-10-12T11:00/, '最早活动开始仍为 10:30');

  // 非空诊断：新厅 10:00-13:00（准备30/整理15），活动 11:00-11:30 的预约把
  // 活动坐标 10:15-12:15 挡住；窗口 10:00-12:30、30 分钟候补的共同空闲只剩
  // [12:15,12:30)（15 分钟，新活动整理可伸出窗口至 12:45）-> 受阻并列区间
  const df2 = join(dir, 'data2.json');
  addResource(df2, '诊断厅', {open: [['2026-10-12T10:00', '2026-10-12T13:00']], prep: 30, teardown: 15});
  addBooking(df2, ['R0001'], '2026-10-12T11:00', '2026-10-12T11:30', '阻挡预约');
  ok(df2, ['add-flex-waitlist', '--resource', 'R0001', '--window', '2026-10-12T10:00/2026-10-12T12:30', '--duration', '30'], '登记 W0001（诊断场景）');
  r = ok(df2, ['process-waitlist'], '受阻诊断');
  assert.match(r.stdout, /2026-10-12T12:15 → 2026-10-12T12:30（15 分钟）/, '列出扣除占用与前后预留后的最大共同区间');
});

test('固定候补：仅缓冲重叠也阻挡兑现，相接可行', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 15});
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', '先占活动');

  // 候补活动 11:15-12:00：准备自 10:45，与先占整理（至 11:15）重叠 -> 登记可以，兑现受阻
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:15', '--end', '2026-10-12T12:00'], '登记固定候补');
  let r = ok(df, ['process-waitlist'], '缓冲重叠 -> 受阻');
  assert.match(r.stdout, /继续等待 W0001/, '继续等待');
  assert.match(r.stdout, /冲突预约/, '列出阻挡预约');

  // 改候补为活动 11:45-12:00（准备恰自 11:15，相接）：取消旧候补、登记新候补后兑现
  ok(df, ['cancel-waitlist', 'W0001'], '取消受阻候补');
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T11:45', '--end', '2026-10-12T12:00'], '登记相接候补 W0002');
  r = ok(df, ['process-waitlist'], '相接 -> 兑现');
  assert.match(r.stdout, /W0002.*新预约 B0002/s, '兑现生成预约（B0001 为先占活动）');
});

// ---------------------------------------------------------------------------
// 5. schedule-flex：共同资源边界按各自缓冲传播
// ---------------------------------------------------------------------------

test('schedule-flex：同资源两项按准备+整理相接，候选开始边界正确', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 30});
  const manifest = join(dir, 'plan.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      items: [
        {window: '2026-10-12T10:00/2026-10-12T14:00', duration: 60, groups: [['R0001']]},
        {window: '2026-10-12T10:00/2026-10-12T14:00', duration: 60, groups: [['R0001']]},
      ],
    }) + '\n',
    'utf8',
  );
  const r = ok(df, ['schedule-flex', manifest], '联合排程成功');
  // 第一项活动 10:00-11:00（占用 09:30-11:30）；第二项准备须自 ≥11:30 -> 活动 12:00 起
  assert.match(r.stdout, /第 1 项 -> B0001: 2026-10-12T10:00 → 2026-10-12T11:00/, '第 1 项活动 10:00');
  assert.match(r.stdout, /第 2 项 -> B0002: 2026-10-12T12:00 → 2026-10-12T13:00/, '第 2 项活动 12:00（相接，非 11:00）');
  const store = readStore(df);
  assert.equal(store.bookings.length, 2, '创建两项预约');
});

// ---------------------------------------------------------------------------
// 6. add-closure：按实际占用识别受影响预约；附清单改期；撤销受阻/解除后恢复
// ---------------------------------------------------------------------------

test('add-closure：按实际占用识别；停用自身不扩张；附清单改期；撤销受阻与恢复', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 15}); // R0001
  addResource(df, '乙厅'); // R0002 无缓冲
  // B0001 活动 10:00-11:00；R0001 实际占用 09:30-11:15
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', '甲厅活动');

  // 停用 11:10-11:20 只与整理缓冲重叠 -> 拒绝并列 B0001
  let r = bizFail(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:10', '--end', '2026-10-12T11:20'], '缓冲重叠停用拒绝');
  assert.match(r.stderr, /B0001（2026-10-12T10:00 → 2026-10-12T11:00）/, '列出受影响预约');

  // 停用与整理端点相接 11:15-11:30 -> 可登记（停用自身不扩张）
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:15', '--end', '2026-10-12T11:30'], '相接停用 C0001');
  // 停用与准备缓冲重叠 09:15-09:31 -> 拒绝；09:00-09:30 恰相接 -> 可登记
  bizFail(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T09:15', '--end', '2026-10-12T09:31'], '准备重叠停用拒绝');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T09:30'], '相接停用 C0002');

  // 附清单登记 11:10-11:20 停用：B0001 必须改期。R0001 被拟停用与 C0001（相接合并为
  // 11:10-11:30 扣除）挡住原安排；同时间换到 R0002（10:00 开始）比延后用 R0001 更早
  const manifest = join(dir, 'moves.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      items: [
        {bookingId: 'B0001', window: '2026-10-12T10:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]},
      ],
    }) + '\n',
    'utf8',
  );
  r = ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T11:10', '--end', '2026-10-12T11:20', manifest], '停用同次改期');
  assert.match(r.stdout, /已登记停用 C0003/, '新建停用 C0003');
  assert.match(r.stdout, /改期操作标识: O0001/, '改期生成 O0001');
  assert.match(r.stdout, /第 1 组: R0002（乙厅/, '同时间换到无缓冲的 R0002');
  assert.match(r.stdout, /2026-10-12T10:00 → 2026-10-12T11:00/, '活动时间保持 10:00-11:00');

  // 安全撤销只恢复预约、不取消停用：恢复到 R0001 10:00-11:00 仍被 C0003（11:10-11:20
  // 与整理至 11:15 的实际占用重叠）阻挡 -> 整笔拒绝
  r = bizFail(df, ['undo-batch-op', 'O0001'], '停用仍有效，撤销受阻');
  assert.match(r.stderr, /撤销 O0001 失败/, '整笔拒绝');
  assert.match(r.stderr, /C0003/, '列出阻挡停用');

  // 取消阻挡停用 C0003 后整笔恢复成功（C0001 自 11:15 起与实际占用端点相接，不阻挡）
  ok(df, ['cancel-closure', 'C0003'], '取消拟停用');
  r = ok(df, ['undo-batch-op', 'O0001'], '解除阻挡后整笔恢复');
  assert.match(r.stdout, /已安全撤销 O0001/, '撤销成功');
  const store = readStore(df);
  const b = store.bookings.find((x: any) => x.id === 'B0001');
  assert.deepEqual(b.resourceIds, ['R0001'], '恢复为原资源');
  assert.equal(b.start, '2026-10-12T10:00', '恢复为原活动开始');
  const c3 = store.closures.find((x: any) => x.id === 'C0003');
  assert.equal(c3.status, 'cancelled', '撤销不复活停用（C0003 仍取消）');
});

// ---------------------------------------------------------------------------
// 7. usage-stats：按实际占用计时并跨营业日拆分
// ---------------------------------------------------------------------------

test('usage-stats：准备/整理计入占用分钟，跨营业日按午夜拆分', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 20, teardown: 20});
  // 活动 23:50-00:10（跨日 20 分钟）；实际占用 23:30-00:30（各日 30 分钟）
  addBooking(df, ['R0001'], '2026-10-12T23:50', '2026-10-13T00:10', '跨日活动');

  const r = ok(df, ['usage-stats', '--window', '2026-10-12T00:00/2026-10-14T00:00'], '跨日统计');
  assert.match(r.stdout, /2026-10-12:[\s\S]*?占用 30 分钟/, '12 日计准备 20 + 活动 10');
  assert.match(r.stdout, /2026-10-13:[\s\S]*?占用 30 分钟/, '13 日计活动 10 + 整理 20');
  assert.match(r.stdout, /整窗汇总[\s\S]*?占用 60 分钟/, '整窗合计 60 分钟实际占用（活动仅 20 分钟）');
});

// ---------------------------------------------------------------------------
// 8. 无变化改期不写文件；真实保存失败重试；缓冲随 reschedule-flex 生效
// ---------------------------------------------------------------------------

test('无变化（批量/弹性）改期不写文件、不建记录；真实保存失败后重试且标识未消费', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 15});
  addResource(df, '乙厅');
  addBooking(df, ['R0001'], '2026-10-12T10:00', '2026-10-12T11:00', 'B0001');

  // reschedule-batch 无变化：不写文件
  const m1 = join(dir, 'same.json');
  writeFileSync(
    m1,
    JSON.stringify({items: [{bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']}]}) + '\n',
    'utf8',
  );
  const before = readFileSync(df);
  const beforeMtime = statSync(df).mtimeMs;
  const r = ok(df, ['reschedule-batch', m1], '无变化批量改期');
  assert.match(r.stdout, /无业务变化/, '明确无变化');
  assert.ok(before.equals(readFileSync(df)), '无变化不写文件');
  assert.equal(statSync(df).mtimeMs, beforeMtime, '文件修改时间不变');
  assert.equal(readStore(df).batchSeq, 0, '不推进操作计数');

  // reschedule-flex 无变化同样不写文件
  const m2 = join(dir, 'flex-same.json');
  writeFileSync(
    m2,
    JSON.stringify({items: [{bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]}]}) + '\n',
    'utf8',
  );
  ok(df, ['reschedule-flex', m2], '弹性无变化成功');
  assert.ok(before.equals(readFileSync(df)), '弹性无变化不写文件');

  // reschedule-flex 有缓冲时的取舍：停用 R0001 09:30-11:15（恰好覆盖其实际占用，
  // 等价于原安排不可行），清单允许换到 R0002 -> 同时间换资源，变化 1 项
  const m3 = join(dir, 'flex-move.json');
  writeFileSync(
    m3,
    JSON.stringify({items: [{bookingId: 'B0001', window: '2026-10-12T08:00/2026-10-12T18:00', groups: [['R0001', 'R0002']]}]}) + '\n',
    'utf8',
  );
  // 先在 R0001 上登记与实际占用完全重合的停用，迫使求解换到 R0002
  const blockedDirect = bizFail(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-12T09:30', '--end', '2026-10-12T11:15'], '无清单时实际占用重叠拒绝');
  assert.match(blockedDirect.stderr, /B0001/, '识别受影响预约');

  // 真实保存失败：255 字节数据文件名使临时文件超限，含缓冲的登记失败退出 1
  const longDf = join(dir, LONG_NAME);
  const fr = runCli(longDf, ['add-resource', '--type', 'venue', '--name', '失败厅', '--open', '2026-01-01T00:00/2027-01-01T00:00', '--prep', '5']);
  assert.equal(fr.status, 1, '保存失败退出 1');
  assert.match(fr.stderr, /保存数据文件/, '报告保存失败');
  assert.ok(!existsSync(longDf), '失败不留下数据文件');
  // 同目录短文件名重试成功，标识从 R0001 起（未消费）
  const retryDf = join(dir, 'retry.json');
  ok(retryDf, ['add-resource', '--type', 'venue', '--name', '成功厅', '--open', '2026-01-01T00:00/2027-01-01T00:00', '--prep', '5'], '失败后重试成功');
  assert.equal(readStore(retryDf).resources[0].id, 'R0001', '资源标识未被失败消费');
  assert.equal(readStore(retryDf).resources[0].prepMinutes, 5, '缓冲随重试落盘');
});

test('改期到带缓冲资源：新资源的准备/整理立即参与覆盖与冲突', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲厅', {prep: 30, teardown: 15});
  addResource(df, '乙厅');
  addBooking(df, ['R0002'], '2026-10-12T10:00', '2026-10-12T11:00', '乙厅活动 B0001');
  addBooking(df, ['R0001'], '2026-10-12T12:00', '2026-10-12T13:00', '甲厅活动 B0002');

  // 把 B0001 改到甲厅 11:45-12:00：其整理至 12:15，与 B0002 在甲厅的准备（11:30 起）
  // 及活动重叠 -> 冲突
  bizFail(
    df,
    ['reschedule-booking', 'B0001', '--resource', 'R0001', '--start', '2026-10-12T11:45', '--end', '2026-10-12T12:00'],
    '改入带缓冲资源后冲突',
  );
  // 改到甲厅 11:15-11:30：实际占用 10:45-11:45，与 B0002 准备（11:30 起）重叠 -> 冲突
  bizFail(
    df,
    ['reschedule-booking', 'B0001', '--resource', 'R0001', '--start', '2026-10-12T11:15', '--end', '2026-10-12T11:30'],
    '仅准备重叠冲突',
  );
  // 改到甲厅 11:00-11:30：占用 10:30-11:45 仍与 11:30 起的准备重叠
  bizFail(
    df,
    ['reschedule-booking', 'B0001', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T11:30'],
    '整理碰对方准备',
  );
  // 10:45-11:00：占用 10:15-11:15 与 B0002 准备（11:30 起）不相碰 -> 可行
  ok(
    df,
    ['reschedule-booking', 'B0001', '--resource', 'R0001', '--start', '2026-10-12T10:45', '--end', '2026-10-12T11:00'],
    '改期相接可行',
  );
  const store = readStore(df);
  const b1 = store.bookings.find((x: any) => x.id === 'B0001');
  assert.deepEqual(b1.resourceIds, ['R0001'], '资源已改到 R0001');
  assert.equal(b1.start, '2026-10-12T10:45', '活动时间为改期值（非实际占用）');
});
