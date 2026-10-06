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
  assert.match(r.stderr, /共 4 项新预约不满足条件/);
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
    ['RRULE 缺少 COUNT', ical(event('a', '20261012T100000', '20261012T110000', 'RRULE:FREQ=WEEKLY\n')), /缺少 COUNT/],
    ['RDATE', ical(event('a', '20261012T100000', '20261012T110000', 'RDATE:20261019T100000\n')), /重复相关属性/],
    ['EXRULE', ical(event('a', '20261012T100000', '20261012T110000', 'EXRULE:FREQ=WEEKLY;COUNT=2\n')), /重复相关属性/],
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

// ---------------------------------------------------------------------------
// 13. 按周重复事件：创建系列及全部未排除成员，一次原子落盘
// ---------------------------------------------------------------------------

test('按周重复事件：创建系列及未排除成员（EXDATE 多行/逗号/去重/大小写与顺序无关）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  // 部件大小写与顺序无关；EXDATE 多行 + 逗号列表 + 重复值去重 + 不匹配值不生效
  const f = writeIcal(dir, 'w.ics', ical(
    'BEGIN:VEVENT\n' +
      'UID:weekly-review@example.com\n' +
      'DTSTART:20261013T090000\n' +
      'DTEND:20261013T093000\n' +
      'rrule:count=4;freq=weekly\n' +
      'EXDATE:20261027T090000,20261027T090000\n' +
      'EXDATE:20261225T090000\n' + // 不匹配任何发生，自然不生效
      'SUMMARY:每周评审\n' +
      'END:VEVENT\n',
    event('single@example.com', '20261012T100000', '20261012T110000'),
  ));
  const r = importOk(df, f, ['R0001'], '导入重复与独立混合文件');
  assert.match(r.stdout, /新增 2 项，重放 0 项/);
  assert.match(r.stdout, /weekly-review@example\.com.*新系列 S0001/);
  assert.match(r.stdout, /按周重复共 4 次，排除 2026-10-27T09:00，生成 3 项成员/);
  assert.match(r.stdout, /第 1 次发生 2026-10-13T09:00 → 2026-10-13T09:30 → 预约 B0001/);
  assert.match(r.stdout, /第 2 次发生 2026-10-20T09:00 → 2026-10-20T09:30 → 预约 B0002/);
  assert.match(r.stdout, /第 4 次发生 2026-11-03T09:00 → 2026-11-03T09:30 → 预约 B0003/);

  const store = readStore(df);
  assert.equal(store.seriesSeq, 1);
  assert.equal(store.series.length, 1);
  assert.equal(store.bookingSeq, 4);
  const members = store.bookings.filter((b: any) => b.seriesId === 'S0001');
  assert.equal(members.length, 3, '仅为未排除发生生成成员');
  assert.deepEqual(members.map((b: any) => b.start), [
    '2026-10-13T09:00',
    '2026-10-20T09:00',
    '2026-11-03T09:00',
  ]);
  assert.equal(store.bookings.find((b: any) => b.id === 'B0004').seriesId, undefined, '独立事件不加入系列');
  const imp = store.imports.find((x: any) => x.uid === 'weekly-review@example.com');
  assert.equal(imp.seriesId, 'S0001');
  assert.equal(imp.count, 4);
  assert.deepEqual(imp.excludes, ['2026-10-27T09:00'], '不匹配发生的排除值不进入快照');
  assert.equal(imp.bookingId, undefined);
  assert.deepEqual(
    imp.members.map((m: any) => [m.start, m.end, m.bookingId]),
    [
      ['2026-10-13T09:00', '2026-10-13T09:30', 'B0001'],
      ['2026-10-20T09:00', '2026-10-20T09:30', 'B0002'],
      ['2026-11-03T09:00', '2026-11-03T09:30', 'B0003'],
    ],
  );
  // 系列可通过现有入口查询
  const ls = ok(df, ['list-series'], 'list-series 含导入系列');
  assert.match(ls.stdout, /系列 S0001（3 项，有效 3 项）/);
});

// ---------------------------------------------------------------------------
// 14. 重复事件重放：部件/排除值顺序、重复排除值、资源顺序不算变化；
//     全重放不写文件；显示原系列、原发生时间与当前状态
// ---------------------------------------------------------------------------

test('重复事件重放：顺序与重复排除值不算变化，全重放不写文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  addResource(df, '投影仪');

  const f1 = writeIcal(dir, 'w1.ics', ical(
    'BEGIN:VEVENT\n' +
      'UID:w@example.com\n' +
      'DTSTART:20261013T090000\n' +
      'DTEND:20261013T093000\n' +
      'RRULE:FREQ=WEEKLY;COUNT=4\n' +
      'EXDATE:20261027T090000,20261103T090000\n' +
      'END:VEVENT\n',
  ));
  importOk(df, f1, ['R0001', 'R0002'], '首次导入');
  const before = readFileSync(df);

  // 部件顺序颠倒、排除值顺序颠倒且重复、资源顺序颠倒 —— 仍是重放
  const f2 = writeIcal(dir, 'w2.ics', ical(
    'BEGIN:VEVENT\n' +
      'UID:w@example.com\n' +
      'DTSTART:20261013T090000\n' +
      'DTEND:20261013T093000\n' +
      'RRULE:COUNT=4;FREQ=WEEKLY\n' +
      'EXDATE:20261103T090000\n' +
      'EXDATE:20261027T090000,20261103T090000\n' +
      'END:VEVENT\n',
  ));
  const r = importOk(df, f2, ['R0002', 'R0001'], '重放（顺序与重复值差异）');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /系列 S0001（重放，未做改动）/);
  assert.match(r.stdout, /原发生 2026-10-13T09:00 → 2026-10-13T09:30 → 预约 B0001 \[已预约\] 当前 2026-10-13T09:00 → 2026-10-13T09:30/);
  assert.match(r.stdout, /原发生 2026-10-20T09:00 → 2026-10-20T09:30 → 预约 B0002 \[已预约\]/);
  assert.ok(before.equals(readFileSync(df)), '全为重放时数据文件逐字节不变');
  const store = readStore(df);
  assert.equal(store.bookingSeq, 2, '计数不推进');
  assert.equal(store.seriesSeq, 1);
});

// ---------------------------------------------------------------------------
// 15. 重复身份不一致：COUNT、排除集合、重复与否、首项时间变化均整批拒绝
// ---------------------------------------------------------------------------

test('重复身份不一致：COUNT/排除集合/重复与否/首项时间变化均整批拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const base = (extra: string, start = '20261013T090000', end = '20261013T093000') =>
    ical(
      'BEGIN:VEVENT\n' +
        `UID:w@example.com\nDTSTART:${start}\nDTEND:${end}\n${extra}` +
        'END:VEVENT\n',
    );
  const f = writeIcal(dir, 'w.ics', base('RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261027T090000\n'));
  importOk(df, f, ['R0001'], '首次导入');
  const before = readFileSync(df);

  const cases: Array<[string, string]> = [
    ['COUNT 变化', base('RRULE:FREQ=WEEKLY;COUNT=4\nEXDATE:20261027T090000\n')],
    ['排除集合变化', base('RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261020T090000\n')],
    ['去掉排除', base('RRULE:FREQ=WEEKLY;COUNT=3\n')],
    ['重复变独立', base('')],
    ['首项时间变化', base('RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261027T100000\n', '20261013T100000', '20261013T103000')],
  ];
  for (const [name, content] of cases) {
    const fc = writeIcal(dir, 'c.ics', content);
    const r = importBizFail(df, fc, ['R0001'], `身份不一致：${name}`);
    assert.match(r.stderr, /与首次导入不一致/, `身份不一致：${name}`);
    assert.match(r.stderr, /w@example\.com/, `身份不一致：${name}`);
  }
  assert.ok(before.equals(readFileSync(df)), '整批拒绝后数据文件逐字节不变');

  // 独立变重复同样拒绝
  const fSingle = writeIcal(dir, 's.ics', ical(event('s@example.com', '20261012T100000', '20261012T110000')));
  importOk(df, fSingle, ['R0001'], '导入独立事件');
  const before2 = readFileSync(df);
  const fToRec = writeIcal(dir, 's2.ics', ical(
    'BEGIN:VEVENT\n' +
      'UID:s@example.com\nDTSTART:20261012T100000\nDTEND:20261012T110000\n' +
      'RRULE:FREQ=WEEKLY;COUNT=2\nEND:VEVENT\n',
  ));
  const r2 = importBizFail(df, fToRec, ['R0001'], '独立变重复');
  assert.match(r2.stderr, /与首次导入不一致/);
  assert.ok(before2.equals(readFileSync(df)), '独立变重复拒绝后数据文件逐字节不变');
});

// ---------------------------------------------------------------------------
// 16. 重复事件成员支持现有单项及系列操作；重放不复活、不重建
// ---------------------------------------------------------------------------

test('重复事件成员支持单项/系列操作；重放不复活不重建', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(dir, 'w.ics', ical(
    'BEGIN:VEVENT\n' +
      'UID:w@example.com\nDTSTART:20261013T090000\nDTEND:20261013T093000\n' +
      'RRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\n',
  ));
  importOk(df, f, ['R0001'], '首次导入');

  // 单项改期、单项取消
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-20T10:00', '--end', '2026-10-20T10:30'], '成员改期');
  ok(df, ['cancel-booking', 'B0003'], '成员取消');
  let r = importOk(df, f, ['R0001'], '重放（成员被改期/取消后）');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /原发生 2026-10-20T09:00 → 2026-10-20T09:30 → 预约 B0002 \[已预约\] 当前 2026-10-20T10:00 → 2026-10-20T10:30/);
  assert.match(r.stdout, /预约 B0003 \[已取消\]/);
  let store = readStore(df);
  assert.equal(store.bookings.length, 3, '不重建预约');
  assert.equal(store.bookings.find((b: any) => b.id === 'B0003').status, 'cancelled', '不复活已取消成员');

  // 整体取消系列后重放仍不复活
  ok(df, ['cancel-series', 'S0001'], '整体取消系列');
  r = importOk(df, f, ['R0001'], '重放（系列整体取消后）');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /预约 B0001 \[已取消\]/);
  store = readStore(df);
  assert.equal(store.bookings.length, 3);
  assert.ok(store.bookings.every((b: any) => b.status === 'cancelled'));
  assert.equal(store.bookingSeq, 3, '计数不推进');
});

// ---------------------------------------------------------------------------
// 17. RRULE/EXDATE 结构负例：整批失败
// ---------------------------------------------------------------------------

test('RRULE/EXDATE 结构负例一律整批失败', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室', [['0001-01-01T00:00', '9999-12-31T23:59']]);

  const ev = (extra: string, start = '20261013T090000', end = '20261013T093000') =>
    ical(`BEGIN:VEVENT\nUID:a\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`);
  const cases: Array<[string, string, RegExp]> = [
    ['无 RRULE 却有 EXDATE', ev('EXDATE:20261013T090000\n'), /EXDATE 但没有 RRULE/],
    ['全部排除', ev('RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE:20261013T090000,20261020T090000\n'), /均被 EXDATE 排除/],
    ['RRULE 重复', ev('RRULE:FREQ=WEEKLY;COUNT=2\nRRULE:FREQ=WEEKLY;COUNT=3\n'), /RRULE 属性重复/],
    ['部件重复', ev('RRULE:FREQ=WEEKLY;COUNT=2;count=3\n'), /部件重复/],
    ['未知部件', ev('RRULE:FREQ=WEEKLY;COUNT=2;BYDAY=TU\n'), /不支持的部件/],
    ['INTERVAL 部件', ev('RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=2\n'), /不支持的部件/],
    ['非按周重复', ev('RRULE:FREQ=DAILY;COUNT=2\n'), /FREQ=WEEKLY/],
    ['COUNT 为 0', ev('RRULE:FREQ=WEEKLY;COUNT=0\n'), /COUNT 非法/],
    ['COUNT 前导零', ev('RRULE:FREQ=WEEKLY;COUNT=03\n'), /COUNT 非法/],
    ['COUNT 超上限', ev('RRULE:FREQ=WEEKLY;COUNT=100001\n'), /COUNT 过大/],
    ['缺少 FREQ', ev('RRULE:COUNT=2\n'), /缺少 FREQ/],
    ['部件缺值', ev('RRULE:FREQ=WEEKLY;COUNT=\n'), /部件非法/],
    ['空部件', ev('RRULE:FREQ=WEEKLY;;COUNT=2\n'), /部件非法/],
    ['RRULE 带参数', ev('RRULE;X=1:FREQ=WEEKLY;COUNT=2\n'), /不支持的参数/],
    ['EXDATE 全天', ev('RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE;VALUE=DATE:20261013\n'), /全天/],
    ['EXDATE 时区', ev('RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE;TZID=Asia/Shanghai:20261013T090000\n'), /时区/],
    ['EXDATE 秒非 00', ev('RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE:20261013T090001\n'), /秒必须为 00/],
    ['EXDATE 空值', ev('RRULE:FREQ=WEEKLY;COUNT=2\nEXDATE:20261013T090000,\n'), /空的排除值/],
    ['展开越出年份', ev('RRULE:FREQ=WEEKLY;COUNT=100000\n', '99990101T090000', '99990101T093000'), /越出 1-9999 年/],
  ];
  for (const [name, content, pattern] of cases) {
    const f = writeIcal(dir, 'bad.ics', content);
    const r = importBizFail(df, f, ['R0001'], `重复结构负例：${name}`);
    assert.match(r.stderr, pattern, `重复结构负例：${name} 的错误信息`);
  }
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '全部负例均未产生预约');
  assert.equal(store.seriesSeq, 0, '未产生系列');
  assert.equal(store.bookingSeq, 0, '计数未推进');
});

// ---------------------------------------------------------------------------
// 18. 重复事件校验失败：按文件及原发生顺序报告，批内冲突互列 UID 与原发生时间
// ---------------------------------------------------------------------------

test('重复事件校验失败：按文件及原发生顺序报告全部失败与批内冲突', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-10-20T00:00', '--end', '2026-10-21T00:00'], '停用');

  // w1 第 2 次发生落在停用区间；w1 与 w2 各次发生互相冲突
  const f = writeIcal(dir, 'w.ics', ical(
    'BEGIN:VEVENT\nUID:w1\nDTSTART:20261013T100000\nDTEND:20261013T110000\nRRULE:FREQ=WEEKLY;COUNT=3\nEND:VEVENT\n',
    'BEGIN:VEVENT\nUID:w2\nDTSTART:20261013T103000\nDTEND:20261013T113000\nRRULE:FREQ=WEEKLY;COUNT=2\nEND:VEVENT\n',
  ));
  const r = importBizFail(df, f, ['R0001'], '重复事件校验失败');
  assert.match(r.stderr, /共 4 项新预约不满足条件（按文件及原发生顺序）/);
  assert.match(r.stderr, /UID “w1” 第 2 次发生（2026-10-20T10:00 → 2026-10-20T11:00）：\n  开放不足资源:[\s\S]*相关有效停用: C0001（2026-10-20T00:00 → 2026-10-21T00:00）/);
  assert.match(r.stderr, /UID “w1” 第 1 次发生[\s\S]*UID “w2” 第 1 次发生（2026-10-13T10:30 → 2026-10-13T11:30）/, '批内冲突列出对方 UID 与原发生时间');
  assert.match(r.stderr, /UID “w2” 第 2 次发生[\s\S]*UID “w1” 第 2 次发生/, '批内冲突双方互列');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '整批未导入');
  assert.equal(store.seriesSeq, 0, '未产生系列');
  assert.equal(store.imports.length, 0);
});

// ---------------------------------------------------------------------------
// 19. 重复导入记录损坏检测：系列/预约引用非法、映射缺漏或重复均拒绝加载
// ---------------------------------------------------------------------------

test('重复导入记录损坏（引用非法、映射缺漏或重复）拒绝加载', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(dir, 'w.ics', ical(
    'BEGIN:VEVENT\nUID:w\nDTSTART:20261013T090000\nDTEND:20261013T093000\n' +
      'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261027T090000\nEND:VEVENT\n',
  ));
  importOk(df, f, ['R0001'], '首次导入');
  const good = readStore(df);
  const restore = () => writeFileSync(df, JSON.stringify(good, null, 2) + '\n');

  // 未知系列引用
  let store = readStore(df);
  store.imports[0].seriesId = 'S9999';
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  let r = bizFail(df, ['list-series'], '未知系列引用');
  assert.match(r.stderr, /关联了未知系列/);
  restore();

  // 成员预约不属于该系列
  store = readStore(df);
  store.bookings.push({id: 'B0003', resourceIds: ['R0001'], start: '2026-10-14T09:00', end: '2026-10-14T09:30', status: 'active'});
  store.bookingSeq = 3;
  store.imports[0].members[1].bookingId = 'B0003';
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-series'], '成员预约不属系列');
  assert.match(r.stderr, /不属于系列 S0001/);
  restore();

  // 成员映射重复（同一预约被两个成员关联）
  store = readStore(df);
  store.imports[0].members[1].bookingId = 'B0001';
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-series'], '成员映射重复');
  assert.match(r.stderr, /已被另一条导入记录关联/);
  restore();

  // 成员映射缺漏（members 数量与 COUNT 减去排除不符）
  store = readStore(df);
  store.imports[0].members.pop();
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-series'], '成员映射缺漏');
  assert.match(r.stderr, /应有 2 项/);
  restore();

  // 排除值不匹配任何原发生
  store = readStore(df);
  store.imports[0].excludes = ['2026-10-14T09:00'];
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  r = bizFail(df, ['list-series'], '排除值不匹配');
  assert.match(r.stderr, /不匹配任何原发生开始时间/);
  restore();

  // 修复后可正常重放
  const r2 = importOk(df, f, ['R0001'], '修复后重放');
  assert.match(r2.stdout, /全部为重放/);
});
