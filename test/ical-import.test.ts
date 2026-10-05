// shiftbook iCalendar 导入（import-ical）自动化回归测试
//
// 运行：npm test（等价于 node --test test/，本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询或直接读取数据文件断言；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync} from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-ical-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(df: string, name: string, open: Array<[string, string]> = OPEN_ALL): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function writeIcal(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function event(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function ical(...events: string[]): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${events.join('')}END:VCALENDAR\n`;
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function importOk(df: string, icalFile: string, resources: string[], ctx: string): CliResult {
  const args = ['import-ical', icalFile];
  for (const r of resources) args.push('--resource', r);
  return ok(df, args, ctx);
}

function importBizFail(df: string, icalFile: string, resources: string[], ctx: string): CliResult {
  const args = ['import-ical', icalFile];
  for (const r of resources) args.push('--resource', r);
  return bizFail(df, args, ctx);
}

// ---------------------------------------------------------------------------
// 1. 基本导入：两个事件各生成一项普通预约，导入身份与预约原子落盘
// ---------------------------------------------------------------------------

test('基本导入：新事件生成普通预约并持久关联 UID', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪');

  const f = writeIcal(dir, 'a.ics', ical(
    event('meeting-001@example.com', '20261012T100000', '20261012T110000', 'SUMMARY:周例会\n'),
    event('meeting-002@example.com', '20261012T140000', '20261012T153000', 'DESCRIPTION:忽略我\n'),
  ));
  const r = importOk(df, f, ['R0001', 'R0002'], '首次导入');
  assert.match(r.stdout, /新增 2 项，重放 0 项/);
  assert.match(r.stdout, /meeting-001@example\.com.*B0001/);
  assert.match(r.stdout, /meeting-002@example\.com.*B0002/);
  assert.match(r.stdout, /2026-10-12T10:00 → 2026-10-12T11:00/);

  const store = readStore(df);
  assert.equal(store.bookingSeq, 2);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookings[0].status, 'active');
  assert.equal(store.bookings[0].seriesId, undefined, '导入预约不加入系列');
  assert.deepEqual(store.bookings[0].resourceIds, ['R0001', 'R0002']);
  assert.equal(store.imports.length, 2);
  const imp = store.imports.find((x: any) => x.uid === 'meeting-001@example.com');
  assert.ok(imp, '导入身份已持久化');
  assert.equal(imp.bookingId, 'B0001');
  assert.equal(imp.start, '2026-10-12T10:00');
  assert.equal(imp.end, '2026-10-12T11:00');
  assert.deepEqual(imp.resourceIds, ['R0001', 'R0002']);
});

// ---------------------------------------------------------------------------
// 2. 重放：相同 UID 与相同原请求（资源顺序、折行、转义差异不算变化），
//    全为重放不写文件、不推进计数
// ---------------------------------------------------------------------------

test('重放：资源顺序/折行/转义差异不算变化，全为重放不写文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  addResource(df, '投影仪');

  // CRLF + 折行 + 转义 UID（a\,b）+ 小写属性名
  const f1 = writeIcal(
    dir,
    'first.ics',
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nuid:a\\,b-long-uid-fold\r\n ed@example.com\r\nDtStart:20261012T100000\r\nDTEND:20261012T110000\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
  );
  importOk(df, f1, ['R0001', 'R0002'], '首次导入（CRLF/折行/转义）');
  const before = readFileSync(df);

  // 同一 UID 的另一种写法：LF、不折行、资源顺序颠倒 —— 仍是重放
  const f2 = writeIcal(
    dir,
    'second.ics',
    ical(event('a,b-long-uid-folded@example.com', '20261012T100000', '20261012T110000')),
  );
  const r = importOk(df, f2, ['R0002', 'R0001'], '重放（LF/不同写法/资源顺序颠倒）');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /重放，未做改动/);
  assert.match(r.stdout, /当前状态: 已预约/);
  assert.ok(before.equals(readFileSync(df)), '全为重放时数据文件逐字节不变');
  const store = readStore(df);
  assert.equal(store.bookingSeq, 1, '计数不推进');
  assert.equal(store.bookings.length, 1);
});

// ---------------------------------------------------------------------------
// 3. 重放不复活：原预约被改期或取消后，重放返回当前安排与状态且不改动
// ---------------------------------------------------------------------------

test('重放：原预约被改期/取消后不复活、不重建，返回当前安排与状态', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(dir, 'a.ics', ical(event('uid-x', '20261012T100000', '20261012T110000')));
  importOk(df, f, ['R0001'], '首次导入');
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-10-13T15:00', '--end', '2026-10-13T16:00'], '改期');
  ok(df, ['cancel-booking', 'B0001'], '取消');
  const before = readFileSync(df);

  const r = importOk(df, f, ['R0001'], '取消后重放');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /当前状态: 已取消/);
  assert.match(r.stdout, /当前安排: 2026-10-13T15:00 → 2026-10-13T16:00/);
  assert.ok(before.equals(readFileSync(df)), '重放不改动数据文件');
  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '不重建预约');
  assert.equal(store.bookings[0].status, 'cancelled', '不复活已取消预约');
});

// ---------------------------------------------------------------------------
// 4. 相同 UID 时间或资源集合不同：整批拒绝，不覆盖本地安排
// ---------------------------------------------------------------------------

test('相同 UID 时间或资源集合不同：整批拒绝且不覆盖本地安排', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  addResource(df, '投影仪');

  const f = writeIcal(dir, 'a.ics', ical(event('uid-x', '20261012T100000', '20261012T110000')));
  importOk(df, f, ['R0001'], '首次导入');
  const before = readFileSync(df);

  // 时间不同
  const fTime = writeIcal(dir, 't.ics', ical(event('uid-x', '20261012T120000', '20261012T130000')));
  const r1 = importBizFail(df, fTime, ['R0001'], '相同 UID 不同时间');
  assert.match(r1.stderr, /与首次导入不一致/);
  assert.match(r1.stderr, /uid-x/);

  // 资源集合不同
  const r2 = importBizFail(df, f, ['R0001', 'R0002'], '相同 UID 不同资源集合');
  assert.match(r2.stderr, /与首次导入不一致/);

  // 混合文件里只要有一个不一致也整批拒绝（新项也不导入）
  const fMix = writeIcal(dir, 'm.ics', ical(
    event('uid-x', '20261012T120000', '20261012T130000'),
    event('uid-new', '20261012T140000', '20261012T150000'),
  ));
  importBizFail(df, fMix, ['R0001'], '混合文件含不一致 UID');
  assert.ok(before.equals(readFileSync(df)), '整批拒绝后数据文件逐字节不变');
  const store = readStore(df);
  assert.equal(store.bookings.length, 1);
  assert.equal(store.bookingSeq, 1);
});

// ---------------------------------------------------------------------------
// 5. 混合新项与重放项：仅新项校验；重放项关联预约按当前状态参与占用
// ---------------------------------------------------------------------------

test('混合新项与重放项：仅新项校验，重放项按当前安排参与占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f1 = writeIcal(dir, 'a.ics', ical(event('uid-old', '20261012T100000', '20261012T110000')));
  importOk(df, f1, ['R0001'], '首次导入');

  // 混合文件：重放 uid-old + 新项 uid-new（与 uid-old 的当前安排重叠 -> 受阻）
  const fMix = writeIcal(dir, 'mix.ics', ical(
    event('uid-old', '20261012T100000', '20261012T110000'),
    event('uid-new', '20261012T103000', '20261012T113000'),
  ));
  const r = importBizFail(df, fMix, ['R0001'], '新项与重放项关联预约冲突');
  assert.match(r.stderr, /uid-new/);
  assert.match(r.stderr, /B0001/, '重放项关联的旧预约按当前安排参与占用');
  assert.equal(readStore(df).bookings.length, 1, '整批未导入');

  // 不重叠的混合文件成功：一重放一新增
  const fMix2 = writeIcal(dir, 'mix2.ics', ical(
    event('uid-old', '20261012T100000', '20261012T110000'),
    event('uid-new', '20261012T140000', '20261012T150000'),
  ));
  const r2 = importOk(df, fMix2, ['R0001'], '混合导入成功');
  assert.match(r2.stdout, /新增 1 项，重放 1 项/);
  const store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookingSeq, 2);
});

// ---------------------------------------------------------------------------
// 6. 新项校验：开放不足（含相关停用）、既有冲突、批内冲突（列双方 UID）
// ---------------------------------------------------------------------------

test('新项校验：开放不足、相关停用、既有冲突与批内冲突', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00'], '既有预约');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-13T09:00', '--end', '2026-10-13T12:00'], '停用');

  const f = writeIcal(dir, 'a.ics', ical(
    event('uid-gap', '20261013T100000', '20261013T110000'), // 落在停用区间
    event('uid-conflict', '20261012T143000', '20261012T153000'), // 与既有 B0001 冲突
    event('uid-batch-a', '20261012T160000', '20261012T170000'), // 批内互相冲突
    event('uid-batch-b', '20261012T163000', '20261012T173000'),
  ));
  const r = importBizFail(df, f, ['R0001'], '四类失败同时报告');
  assert.match(r.stderr, /共 4 项新事件不满足条件/);
  assert.match(r.stderr, /uid-gap[\s\S]*相关有效停用: C0001（2026-10-13T09:00 → 2026-10-13T12:00）/);
  assert.match(r.stderr, /uid-conflict[\s\S]*B0001/);
  assert.match(r.stderr, /uid-batch-a[\s\S]*uid-batch-b/, '批内冲突列出对方 UID');
  assert.match(r.stderr, /uid-batch-b[\s\S]*uid-batch-a/, '批内冲突双方互列');
  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '整批未导入');
  assert.equal(store.imports.length, 0);
});

// ---------------------------------------------------------------------------
// 7. 文件结构错误与非法属性：整批失败（参数化负例）
// ---------------------------------------------------------------------------

test('结构错误、关键属性重复、非法时间等一律整批失败', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const cases: Array<[string, string, RegExp]> = [
    ['空文件', '', /文件为空/],
    ['非 VCALENDAR 顶层', 'BEGIN:VTODO\nEND:VTODO\n', /VCALENDAR/],
    ['缺少 VERSION', 'BEGIN:VCALENDAR\n' + event('a', '20261012T100000', '20261012T110000') + 'END:VCALENDAR\n', /VERSION/],
    ['VERSION 非 2.0', ical(event('a', '20261012T100000', '20261012T110000')).replace('2.0', '1.0'), /VERSION:2.0/],
    ['无 VEVENT', 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n', /没有任何 VEVENT/],
    ['缺 UID', ical('BEGIN:VEVENT\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\n'), /缺少 UID/],
    ['空 UID', ical(event('', '20261012T100000', '20261012T110000')), /UID 不能为空/],
    ['缺 DTSTART', ical('BEGIN:VEVENT\nUID:a\nDTEND:20261012T110000\nEND:VEVENT\n'), /缺少 DTSTART/],
    ['缺 DTEND', ical('BEGIN:VEVENT\nUID:a\nDTSTART:20261012T100000\nEND:VEVENT\n'), /缺少 DTEND/],
    ['UID 重复属性', ical('BEGIN:VEVENT\nUID:a\nUID:b\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\n'), /UID 属性重复/],
    ['DTSTART 重复', ical('BEGIN:VEVENT\nUID:a\nDTSTART:20261012T100000\nDTSTART:20261012T110000\nDTEND:20261012T120000\nEND:VEVENT\n'), /DTSTART 属性重复/],
    ['文件内 UID 重复', ical(event('a', '20261012T100000', '20261012T110000'), event('a', '20261012T120000', '20261012T130000')), /UID 重复/],
    ['全天事件', ical('BEGIN:VEVENT\nUID:a\nDTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261013\nEND:VEVENT\n'), /全天/],
    ['时区时间', ical('BEGIN:VEVENT\nUID:a\nDTSTART;TZID=Asia/Shanghai:20261012T100000\nDTEND:20261012T110000\nEND:VEVENT\n'), /时区/],
    ['UTC 写法', ical(event('a', '20261012T100000Z', '20261012T110000Z')), /格式非法/],
    ['秒非 00', ical(event('a', '20261012T100001', '20261012T110000')), /秒必须为 00/],
    ['不存在的日期', ical(event('a', '20260230T100000', '20260230T110000')), /真实有效/],
    ['结束早于开始', ical(event('a', '20261012T110000', '20261012T100000')), /晚于开始/],
    ['RRULE', ical(event('a', '20261012T100000', '20261012T110000', 'RRULE:FREQ=WEEKLY\n')), /重复相关属性/],
    ['RECURRENCE-ID', ical(event('a', '20261012T100000', '20261012T110000', 'RECURRENCE-ID:20261012T100000\n')), /重复相关属性/],
    ['STATUS:CANCELLED', ical(event('a', '20261012T100000', '20261012T110000', 'STATUS:CANCELLED\n')), /取消事件/],
    ['METHOD:CANCEL', 'BEGIN:VCALENDAR\nVERSION:2.0\nMETHOD:CANCEL\n' + event('a', '20261012T100000', '20261012T110000') + 'END:VCALENDAR\n', /取消事件/],
    ['嵌套 VALARM', ical(event('a', '20261012T100000', '20261012T110000', 'BEGIN:VALARM\nEND:VALARM\n')), /嵌套组件/],
    ['VEVENT 未闭合', 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nDTSTART:20261012T100000\nDTEND:20261012T110000\nEND:VCALENDAR\n', /不匹配|缺少/],
    ['VCALENDAR 未闭合', 'BEGIN:VCALENDAR\nVERSION:2.0\n' + event('a', '20261012T100000', '20261012T110000'), /缺少对应的 END:VCALENDAR/],
    ['年份 0000', ical(event('a', '00001012T100000', '00001012T110000')), /真实有效/],
  ];

  for (const [name, content, pattern] of cases) {
    const f = writeIcal(dir, 'bad.ics', content);
    const r = importBizFail(df, f, ['R0001'], `结构负例：${name}`);
    assert.match(r.stderr, pattern, `结构负例：${name} 的错误信息`);
  }
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '全部负例均未产生预约');
  assert.equal(store.bookingSeq, 0, '计数未推进');
});

// ---------------------------------------------------------------------------
// 8. 跨日事件与年份边界；结果不随机器时区变化
// ---------------------------------------------------------------------------

test('跨日事件与年份边界（0001/9999）合法', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室', [['0001-01-01T00:00', '9999-12-31T23:59']]);

  const f = writeIcal(dir, 'a.ics', ical(
    event('uid-cross', '20261012T230000', '20261013T010000'), // 跨日
    event('uid-min', '00010101T000000', '00010101T010000'), // 最早
    event('uid-max', '99991231T230000', '99991231T235900'), // 最晚
  ));
  const r = importOk(df, f, ['R0001'], '跨日与年份边界');
  assert.match(r.stdout, /2026-10-12T23:00 → 2026-10-13T01:00/);
  assert.match(r.stdout, /0001-01-01T00:00 → 0001-01-01T01:00/);
  assert.match(r.stdout, /9999-12-31T23:00 → 9999-12-31T23:59/);
  assert.equal(readStore(df).bookings.length, 3);
});

// ---------------------------------------------------------------------------
// 9. 用法错误：缺少 --resource、多余位置参数、未知选项 -> 退出码 2
// ---------------------------------------------------------------------------

test('用法错误：缺少资源、多余位置参数、未知选项均退出 2', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  const f = writeIcal(dir, 'a.ics', ical(event('a', '20261012T100000', '20261012T110000')));

  usageFail(df, ['import-ical', f], '缺少 --resource');
  usageFail(df, ['import-ical', f, f, '--resource', 'R0001'], '多余位置参数');
  usageFail(df, ['import-ical', f, '--resource', 'R0001', '--start', 'x'], '未知选项');
  usageFail(df, ['import-ical'], '缺少文件参数');
  assert.equal(readStore(df).bookings.length, 0, '用法错误不产生任何记录');
});

// ---------------------------------------------------------------------------
// 10. 输入文件不可读、未知资源：业务失败且数据不变
// ---------------------------------------------------------------------------

test('输入文件不可读与未知资源：业务失败且数据不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  const before = readFileSync(df);

  const r1 = bizFail(df, ['import-ical', join(dir, 'missing.ics'), '--resource', 'R0001'], '文件不可读');
  assert.match(r1.stderr, /无法读取 iCalendar 文件/);
  const f = writeIcal(dir, 'a.ics', ical(event('a', '20261012T100000', '20261012T110000')));
  const r2 = bizFail(df, ['import-ical', f, '--resource', 'R9999'], '未知资源');
  assert.match(r2.stderr, /未知资源标识/);
  const r3 = bizFail(df, ['import-ical', f, '--resource', 'R0001', '--resource', 'R0001'], '重复资源');
  assert.match(r3.stderr, /资源重复指定/);
  assert.ok(before.equals(readFileSync(df)), '失败后数据文件逐字节不变');
});

// ---------------------------------------------------------------------------
// 11. 旧数据兼容与损坏检测：无 imports 字段的旧文件直接可用；
//     重复 UID、重复预约关联、非法快照视为损坏
// ---------------------------------------------------------------------------

test('旧文件无需迁移；导入记录损坏（重复 UID/重复关联/非法快照）拒绝加载', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '既有预约');

  // 旧文件（无 imports 字段）直接导入可用，且原有记录保留
  const f = writeIcal(dir, 'a.ics', ical(event('uid-new', '20261012T140000', '20261012T150000')));
  importOk(df, f, ['R0001'], '旧文件直接导入');
  let store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.imports.length, 1);

  // 损坏 1：UID 重复
  store.imports.push({uid: 'uid-new', bookingId: 'B0002', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']});
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  let r = bizFail(df, ['list-bookings', '--date', '2026-10-12'], '重复 UID 损坏');
  assert.match(r.stderr, /UID 重复/);

  // 损坏 2：重复预约关联
  store.imports[1] = {uid: 'uid-other', bookingId: 'B0002', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']};
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-bookings', '--date', '2026-10-12'], '重复预约关联损坏');
  assert.match(r.stderr, /已被另一条导入记录关联/);

  // 损坏 3：非法快照（结束不晚于开始）
  store.imports[1] = {uid: 'uid-other', bookingId: 'B0001', start: '2026-10-12T15:00', end: '2026-10-12T14:00', resourceIds: ['R0001']};
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-bookings', '--date', '2026-10-12'], '非法快照损坏');
  assert.match(r.stderr, /快照结束必须晚于开始/);

  // 快照与现状不同合法：改期后重放仍按首次导入快照比对
  store.imports.pop();
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-12T16:00', '--end', '2026-10-12T17:00'], '改期导入预约');
  const r2 = importOk(df, f, ['R0001'], '快照与现状不同仍为重放');
  assert.match(r2.stdout, /全部为重放/);
  assert.match(r2.stdout, /当前安排: 2026-10-12T16:00 → 2026-10-12T17:00/);
});

// ---------------------------------------------------------------------------
// 12. 身份不依赖路径：同一 UID 从不同文件路径导入仍是重放
// ---------------------------------------------------------------------------

test('身份不依赖文件路径：同一 UID 从不同路径导入仍为重放', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const content = ical(event('uid-path', '20261012T100000', '20261012T110000'));
  const f1 = writeIcal(dir, 'one.ics', content);
  const sub = join(dir, 'sub');
  mkdirSync(sub, {recursive: true});
  const f2 = join(sub, 'two.ics');
  writeFileSync(f2, content, 'utf8');

  importOk(df, f1, ['R0001'], '首次导入');
  const r = importOk(df, f2, ['R0001'], '另一路径同一 UID');
  assert.match(r.stdout, /全部为重放/);
  assert.equal(readStore(df).bookings.length, 1);
});
