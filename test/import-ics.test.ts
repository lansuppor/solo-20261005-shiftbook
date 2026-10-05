// shiftbook 本地 iCalendar 导入（import-ics）自动化回归测试
//
// 运行：npm test（等价于 node --test 'test/*.test.ts'）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（或直接读取 JSON）；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件必然超出文件名长度上限，可重复触发真实保存失败。
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

function failCode(df: string, args: string[], code: number, ctx: string): CliResult {
  const r = runCli(df, args);
  assert.equal(
    r.status,
    code,
    `[${ctx}] 期望退出 ${code}，实际 ${r.status}\n命令: ${args.join(' ')}\nstderr:\n${r.stderr}\nstdout:\n${r.stdout}`,
  );
  return r;
}

const bizFail = (df: string, args: string[], ctx: string): CliResult => failCode(df, args, 1, ctx);
const usageFail = (df: string, args: string[], ctx: string): CliResult => failCode(df, args, 2, ctx);

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-ics-test-'));
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

function writeIcs(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// 规范的 CRLF 两事件文件：含描述属性（应忽略）、STATUS:CONFIRMED、折行与 UID 转义
const SAMPLE_CRLF =
  'BEGIN:VCALENDAR\r\n' +
  'VERSION:2.0\r\n' +
  'PRODID:-//shiftbook//test//ZH\r\n' +
  'BEGIN:VEVENT\r\n' +
  'UID:evt-001\r\n' +
  'DTSTAMP:20261001T000000Z\r\n' +
  'DTSTART:20261210T100000\r\n' +
  'DTEND:20261210T110000\r\n' +
  'SUMMARY:事件一\r\n' +
  'DESCRIPTION:描述属性忽略\r\n' +
  'STATUS:CONFIRMED\r\n' +
  'END:VEVENT\r\n' +
  'BEGIN:VEVENT\r\n' +
  // UID 解码后为 evt\,002 —— 演示文本转义
  'UID:evt\\,002\r\n' +
  'DTSTART:20261211T140000\r\n' +
  'DTEND:20261211T1530\r\n 00\r\n' // 标准折行：拼接为 20261211T153000
  + 'END:VEVENT\r\n' +
  'END:VCALENDAR\r\n';

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function bookingOf(store: any, id: string): any {
  const b = store.bookings.find((x: any) => x.id === id);
  assert.ok(b, `预约 ${id} 应存在`);
  return b;
}

// ---------------------------------------------------------------------------
// 1. 成功导入：CRLF、折行、转义、描述属性忽略；生成普通预约与导入身份
// ---------------------------------------------------------------------------

test('import-ics 成功导入：普通预约、导入身份、按文件顺序输出', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  const ics = writeIcs(dir, 'a.ics', SAMPLE_CRLF);

  const r = ok(df, ['import-ics', ics, '--resource', 'R0002', '--resource', 'R0001'], '导入');
  assert.match(r.stdout, /导入成功：共 2 项（新增 2 项，重放 0 项）/);
  assert.match(r.stdout, /第 1 项 UID “evt-001” → 新预约 B0001（新增）/);
  assert.match(r.stdout, /第 2 项 UID “evt\,002” → 新预约 B0002（新增）/);
  assert.ok(r.stdout.includes('2026-12-10T10:00 → 2026-12-10T11:00'), '显示完整安排');
  assert.ok(r.stdout.includes('2026-12-11T14:00 → 2026-12-11T15:30'), '折行时间已拼接');

  const store = readStore(df);
  assert.equal(store.bookingSeq, 2);
  assert.deepEqual(bookingOf(store, 'B0001').resourceIds, ['R0001', 'R0002'], '资源按标识排序存储');
  assert.equal(bookingOf(store, 'B0001').seriesId, undefined, '导入预约不加入系列');
  assert.equal(bookingOf(store, 'B0001').status, 'active');
  assert.deepEqual(
    store.imports.map((x: any) => [x.uid, x.bookingId, x.start, x.end]),
    [
      ['evt-001', 'B0001', '2026-12-10T10:00', '2026-12-10T11:00'],
      ['evt,002', 'B0002', '2026-12-11T14:00', '2026-12-11T15:30'],
    ],
    '导入身份持久保留首次原请求（UID 已反转义）',
  );
  assert.deepEqual(store.imports[0].resourceIds, ['R0001', 'R0002']);

  // 新进程可见，且为普通预约
  const day = ok(df, ['list-bookings', '--date', '2026-12-10'], '新进程按日查询');
  assert.match(day.stdout, /B0001 \[已预约\] 2026-12-10T10:00 → 2026-12-10T11:00/);
});

// ---------------------------------------------------------------------------
// 2. 重放：等价写法（LF、资源顺序、折行/转义差异）不写文件、不推进计数；
//    改期后重放返回当前安排，取消/安全撤销后不复活不重建
// ---------------------------------------------------------------------------

test('import-ics 重放：写法差异归一化；返回当前安排与状态；不修改不复活', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');
  const ics1 = writeIcs(dir, 'a.ics', SAMPLE_CRLF);
  ok(df, ['import-ics', ics1, '--resource', 'R0001', '--resource', 'R0002'], '首次导入');

  // 等价文件：LF 行尾、资源顺序颠倒、SUMMARY 折行位置不同、UID 转义/折行改写，
  // 身份与原请求不应变化
  const equivalent =
    'BEGIN:VCALENDAR\nVERSION:2.0\n' +
    'BEGIN:VEVENT\nUID:evt-001\nDTSTART:20261210T100000\nDTEND:20261210T110000\nEND:VEVENT\n' +
    'BEGIN:VEVENT\nUID:evt\\,\n 002\nDTSTART:20261211T140000\nDTEND:20261211T153000\nEND:VEVENT\n' +
    'END:VCALENDAR\n';
  const ics2 = writeIcs(dir, 'b.ics', equivalent); // 不同文件路径也应识别为同一 UID

  const bytesBefore = readFileSync(df);
  const mtimeBefore = statSync(df).mtimeMs;
  const r = ok(df, ['import-ics', ics2, '--resource', 'R0002', '--resource', 'R0001'], '等价重放');
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /原预约 B0001（重放，未修改；当前状态：有效）/);
  assert.match(r.stdout, /原预约 B0002（重放，未修改；当前状态：有效）/);
  assert.ok(readFileSync(df).equals(bytesBefore), '全为重放不写文件');
  assert.equal(statSync(df).mtimeMs, mtimeBefore, '修改时间不变');
  const store0 = readStore(df);
  assert.equal(store0.bookingSeq, 2, '不推进计数');
  assert.equal(store0.imports.length, 2, '不新增导入身份');

  // 关联预约被改期：重放返回当前安排，导入身份快照仍是首次原请求
  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-12-20T09:00', '--end', '2026-12-20T10:00'], '改期');
  const r2 = ok(df, ['import-ics', ics1, '--resource', 'R0001', '--resource', 'R0002'], '改期后重放');
  assert.ok(r2.stdout.includes('2026-12-20T09:00 → 2026-12-20T10:00'), '重放显示当前安排');
  assert.match(r2.stdout, /当前状态：有效/);
  const store1 = readStore(df);
  const binding1 = store1.imports.find((x: any) => x.uid === 'evt-001');
  assert.equal(binding1.start, '2026-12-10T10:00', '导入身份保留首次时间');
  assert.equal(bookingOf(store1, 'B0001').id, 'B0001', '不重建预约');

  // 经批量改期再安全撤销后重放：仍是同一预约，不重建
  const manifest = join(dir, 'op.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      items: [{bookingId: 'B0002', start: '2026-12-21T09:00', end: '2026-12-21T10:00', resourceIds: ['R0001', 'R0002']}],
    }) + '\n',
  );
  ok(df, ['reschedule-batch', manifest], '批量改期 B0002');
  ok(df, ['undo-batch-op', 'O0001'], '安全撤销');
  const r3 = ok(df, ['import-ics', ics1, '--resource', 'R0001', '--resource', 'R0002'], '撤销后重放');
  assert.match(r3.stdout, /原预约 B0002（重放/);
  assert.equal(readStore(df).bookingSeq, 2, '撤销/重放均不推进预约计数');

  // 取消后重放：不复活、不重建
  ok(df, ['cancel-booking', 'B0001'], '取消 B0001');
  const bytes2 = readFileSync(df);
  const r4 = ok(df, ['import-ics', ics1, '--resource', 'R0001', '--resource', 'R0002'], '取消后重放');
  assert.match(r4.stdout, /原预约 B0001（重放，未修改；当前状态：已取消）/);
  assert.ok(readFileSync(df).equals(bytes2), '取消后重放仍不写文件');
  assert.equal(bookingOf(readStore(df), 'B0001').status, 'cancelled', '不复活已取消预约');
});

// ---------------------------------------------------------------------------
// 3. 相同 UID 原请求不同（时间或资源集合）整批拒绝，不能覆盖本地安排
// ---------------------------------------------------------------------------

test('import-ics 相同 UID 原请求不同：整批拒绝，逐字节保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');
  const ics = writeIcs(dir, 'a.ics', SAMPLE_CRLF);
  ok(df, ['import-ics', ics, '--resource', 'R0001', '--resource', 'R0002'], '首次导入');
  const bytes = readFileSync(df);

  // 资源集合不同
  const fewer = writeIcs(
    dir,
    'fewer.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n' +
      'UID:evt-001\nDTSTART:20261210T100000\nDTEND:20261210T110000\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  let r = bizFail(df, ['import-ics', fewer, '--resource', 'R0001'], '资源集合不同');
  assert.ok(r.stderr.includes('与首次导入不同，不能覆盖本地安排'));
  assert.ok(r.stderr.includes('evt-001'));
  assert.ok(readFileSync(df).equals(bytes), '整批拒绝逐字节保留');

  // 时间不同
  const moved = writeIcs(
    dir,
    'moved.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n' +
      'UID:evt-001\nDTSTART:20261210T120000\nDTEND:20261210T130000\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  r = bizFail(df, ['import-ics', moved, '--resource', 'R0001', '--resource', 'R0002'], '时间不同');
  assert.ok(r.stderr.includes('2026-12-10T12:00 → 2026-12-10T13:00'));
  assert.equal(readStore(df).bookingSeq, 2, '标识计数不变');
});

// ---------------------------------------------------------------------------
// 4. 受阻：开放不足（含相关停用标识与时间）、既有预约冲突、批内冲突列双方 UID
// ---------------------------------------------------------------------------

test('import-ics 受阻：停用缺口、既有冲突与批内冲突全部按文件顺序报告', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  // 既有预约 B0001 占用 2026-12-10T10:30-11:00
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-12-10T10:30', '--end', '2026-12-10T11:00'], '既有预约');
  // 有效停用 C0001 覆盖 2026-12-12 全天
  ok(df, ['add-closure', '--resource', 'R0001', '--start', '2026-12-12T00:00', '--end', '2026-12-13T00:00'], '停用');

  const ics = writeIcs(
    dir,
    'blocked.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\n' +
      // 第 1 项：与既有 B0001 冲突
      'BEGIN:VEVENT\nUID:b-1\nDTSTART:20261210T100000\nDTEND:20261210T110000\nEND:VEVENT\n' +
      // 第 2、3 项：批内彼此重叠
      'BEGIN:VEVENT\nUID:b-2\nDTSTART:20261211T090000\nDTEND:20261211T100000\nEND:VEVENT\n' +
      'BEGIN:VEVENT\nUID:b-3\nDTSTART:20261211T093000\nDTEND:20261211T103000\nEND:VEVENT\n' +
      // 第 4 项：开放不足（停用）
      'BEGIN:VEVENT\nUID:b-4\nDTSTART:20261212T100000\nDTEND:20261212T110000\nEND:VEVENT\n' +
      'END:VCALENDAR\n',
  );
  const bytes = readFileSync(df);
  const r = bizFail(df, ['import-ics', ics, '--resource', 'R0001'], '整批受阻');
  assert.match(r.stderr, /共 4 项不满足条件/);
  // 文件顺序：b-1（既有冲突）、b-2、b-3（批内双方）、b-4（停用缺口）
  assert.ok(r.stderr.indexOf('UID “b-1”') < r.stderr.indexOf('UID “b-2”'));
  assert.ok(r.stderr.indexOf('UID “b-2”') < r.stderr.indexOf('UID “b-3”'));
  assert.ok(r.stderr.indexOf('UID “b-3”') < r.stderr.indexOf('UID “b-4”'));
  assert.ok(r.stderr.includes('B0001'), '列出既有冲突预约');
  assert.ok(r.stderr.includes('本批 UID “b-3”（第 3 项'), 'b-2 下列出对方 UID');
  assert.ok(r.stderr.includes('本批 UID “b-2”（第 2 项'), 'b-3 下列出对方 UID');
  assert.ok(r.stderr.includes('C0001（2026-12-12T00:00 → 2026-12-13T00:00）'), '列出相关停用标识与时间');
  assert.ok(readFileSync(df).equals(bytes), '受阻逐字节保留');
  const store = readStore(df);
  assert.equal(store.imports.length, 0, '不留导入身份');
  assert.equal(store.bookingSeq, 1, '不推进预约计数');
});

// ---------------------------------------------------------------------------
// 5. 混合新项与重放项；重放项关联预约按当前安排参与占用；仅新项接受目标校验
// ---------------------------------------------------------------------------

test('import-ics 混合文件：新项与重放项共存，重放预约当前占用阻挡新项', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  const first = writeIcs(
    dir,
    'first.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n' +
      'UID:mix-old\nDTSTART:20261215T100000\nDTEND:20261215T110000\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  ok(df, ['import-ics', first, '--resource', 'R0001'], '首次导入 B0001');

  // 混合文件：重放 mix-old + 新项 mix-new 与其同时段重叠 → 新项被 B0001 当前安排阻挡
  const blockedMix = writeIcs(
    dir,
    'mix-bad.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\n' +
      'BEGIN:VEVENT\nUID:mix-new\nDTSTART:20261215T103000\nDTEND:20261215T113000\nEND:VEVENT\n' +
      'BEGIN:VEVENT\nUID:mix-old\nDTSTART:20261215T100000\nDTEND:20261215T110000\nEND:VEVENT\n' +
      'END:VCALENDAR\n',
  );
  const r = bizFail(df, ['import-ics', blockedMix, '--resource', 'R0001'], '新项被重放预约阻挡');
  assert.ok(r.stderr.includes('mix-new'));
  assert.ok(r.stderr.includes('B0001'));
  assert.ok(!r.stderr.includes('mix-old：'), '重放项本身不列为失败');

  // 取消关联预约后，其当前安排不再占用：同一混合文件可以成功（重放项不复活）
  ok(df, ['cancel-booking', 'B0001'], '取消重放关联预约');
  const r2 = ok(df, ['import-ics', blockedMix, '--resource', 'R0001'], '取消后混合导入成功');
  assert.match(r2.stdout, /新增 1 项，重放 1 项/);
  assert.match(r2.stdout, /新预约 B0002（新增）/);
  assert.match(r2.stdout, /原预约 B0001（重放，未修改；当前状态：已取消）/);
  const store = readStore(df);
  assert.equal(store.imports.length, 2);
  assert.equal(bookingOf(store, 'B0001').status, 'cancelled', '重放不复活');
});

// ---------------------------------------------------------------------------
// 6. 不自动处理候补；导入预约是普通预约，可用旧入口改期/取消
// ---------------------------------------------------------------------------

test('import-ics 不自动处理候补；导入预约可经旧入口管理', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-12-16T10:00', '--end', '2026-12-16T11:00'], '候补 W0001');
  const ics = writeIcs(
    dir,
    'w.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\n' +
      'UID:w-1\nDTSTART:20261216T100000\nDTEND:20261216T110000\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  ok(df, ['import-ics', ics, '--resource', 'R0001'], '导入占用候补时段');
  const w = readStore(df).waitlist.find((x: any) => x.id === 'W0001');
  assert.equal(w.status, 'waiting', '导入不自动处理候补');

  ok(df, ['reschedule-booking', 'B0001', '--start', '2026-12-17T08:00', '--end', '2026-12-17T09:00'], '旧入口改期');
  assert.equal(bookingOf(readStore(df), 'B0001').start, '2026-12-17T08:00');
  ok(df, ['cancel-booking', 'B0001'], '旧入口取消');
});

// ---------------------------------------------------------------------------
// 7. 解析与用法负例
// ---------------------------------------------------------------------------

function minimalIcs(body: string, calendarBody = ''): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${calendarBody}BEGIN:VEVENT\n${body}\nEND:VEVENT\nEND:VCALENDAR\n`;
}

test('import-ics 解析负例：结构、时间、重复、嵌套、转义等整批拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  const bytes0 = readFileSync(df);

  const cases: Array<[string, string, string?]> = [
    ['缺 VERSION', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nEND:VCALENDAR\n', 'VERSION:2.0'],
    ['VERSION 非 2.0', 'BEGIN:VCALENDAR\nVERSION:1.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nEND:VCALENDAR\n', '仅支持 VERSION:2.0'],
    ['VERSION 重复', 'BEGIN:VCALENDAR\nVERSION:2.0\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nEND:VCALENDAR\n', 'VERSION 重复'],
    ['无 VEVENT', 'BEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n', '至少需要一个独立 VEVENT'],
    ['缺少 END:VCALENDAR', 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\n', '结构不完整'],
    ['VEVENT 内错配 END', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VCALENDAR'), '结构不完整'],
    ['第二个 VCALENDAR', 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nEND:VCALENDAR\nBEGIN:VCALENDAR\nVERSION:2.0\nEND:VCALENDAR\n', '多余内容'],
    ['VTIMEZONE 组件', minimalIcs('', 'BEGIN:VTIMEZONE\nTZID:X\nEND:VTIMEZONE\n'), 'VTIMEZONE'],
    ['VALARM 嵌套', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nBEGIN:VALARM\nEND:VALARM'), '事件内嵌套组件'],
    ['缺 UID', minimalIcs('DTSTART:20261201T100000\nDTEND:20261201T110000'), 'UID'],
    ['空 UID', minimalIcs('UID:\nDTSTART:20261201T100000\nDTEND:20261201T110000'), 'UID 不能为空'],
    ['UID 重复', minimalIcs('UID:x\nUID:y\nDTSTART:20261201T100000\nDTEND:20261201T110000'), 'UID 在同一事件中重复'],
    ['UID 带参数', minimalIcs('UID;X-FOO=1:x\nDTSTART:20261201T100000\nDTEND:20261201T110000'), 'UID 属性不允许参数'],
    ['UID 非法转义', minimalIcs('UID:a\\qb\nDTSTART:20261201T100000\nDTEND:20261201T110000'), '文本转义非法'],
    ['UID 单独反斜杠', minimalIcs('UID:a\\\nDTSTART:20261201T100000\nDTEND:20261201T110000'), '转义非法'],
    ['缺 DTSTART', minimalIcs('UID:x\nDTEND:20261201T110000'), 'DTSTART'],
    ['缺 DTEND', minimalIcs('UID:x\nDTSTART:20261201T100000'), 'DTEND'],
    ['DTSTART 重复', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTSTART:20261201T100000\nDTEND:20261201T110000'), 'DTSTART 在同一事件中重复'],
    ['Z 结尾时间', minimalIcs('UID:x\nDTSTART:20261201T100000Z\nDTEND:20261201T110000Z'), 'YYYYMMDDTHHmmss'],
    ['秒非 00', minimalIcs('UID:x\nDTSTART:20261201T100030\nDTEND:20261201T110000'), '秒数必须为 00'],
    ['全天 VALUE=DATE', minimalIcs('UID:x\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261202'), '全天'],
    ['TZID 时区', minimalIcs('UID:x\nDTSTART;TZID=Asia/Shanghai:20261201T100000\nDTEND:20261201T110000'), '时区'],
    ['非法日期 02-30', minimalIcs('UID:x\nDTSTART:20260230T100000\nDTEND:20260230T110000'), '真实有效'],
    ['结束早于开始', minimalIcs('UID:x\nDTSTART:20261201T110000\nDTEND:20261201T100000'), '结束必须晚于开始'],
    ['结束等于开始', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T100000'), '结束必须晚于开始'],
    ['RRULE', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nRRULE:FREQ=WEEKLY'), 'RRULE'],
    ['RDATE', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nRDATE:20261208T100000'), 'RDATE'],
    ['EXDATE', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEXDATE:20261208T100000'), 'EXDATE'],
    ['RECURRENCE-ID', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nRECURRENCE-ID:20261124T100000'), 'RECURRENCE-ID'],
    ['DURATION', minimalIcs('UID:x\nDTSTART:20261201T100000\nDURATION:PT1H'), 'DURATION'],
    ['STATUS:CANCELLED', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nSTATUS:CANCELLED'), 'CANCELLED'],
    ['未知事件属性', minimalIcs('UID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nX-WAT:x\nFOOBAR:baz'), '不支持的事件属性: FOOBAR'],
    ['属性格式错误', minimalIcs('UID:x\nGARBULAX\nDTSTART:20261201T100000\nDTEND:20261201T110000'), '属性格式非法'],
    ['文件内 UID 重复', 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nBEGIN:VEVENT\nUID:x\nDTSTART:20261202T100000\nDTEND:20261202T110000\nEND:VEVENT\nEND:VCALENDAR\n', '文件内 UID 重复'],
    ['空文件', '', '内容为空'],
  ];

  for (const [name, content, expect] of cases) {
    const p = writeIcs(dir, 'neg.ics', content);
    const r = bizFail(df, ['import-ics', p, '--resource', 'R0001'], name);
    assert.ok(expect === undefined || r.stderr.includes(expect), `[${name}] 错误信息应含 “${expect}”，实际：${r.stderr.split('\n')[0]}`);
    assert.ok(readFileSync(df).equals(bytes0), `[${name}] 数据文件应逐字节保留`);
  }

  // 裸 CR（非 CRLF）拒绝
  const cr = writeIcs(dir, 'cr.ics', 'BEGIN:VCALENDAR\rVERSION:2.0\nBEGIN:VEVENT\nUID:x\nDTSTART:20261201T100000\nDTEND:20261201T110000\nEND:VEVENT\nEND:VCALENDAR\n');
  const rCr = bizFail(df, ['import-ics', cr, '--resource', 'R0001'], '裸 CR');
  assert.ok(rCr.stderr.includes('裸回车'));

  // 边界年份解析合法（是否开放覆盖取决于数据，此处 0001 年无开放 → 业务失败但非解析失败）
  for (const [y, parseOk] of [['0001', false], ['9999', false], ['10000', true]] as Array<[string, boolean]>) {
    const p = writeIcs(
      dir,
      'y.ics',
      `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:y${y}\nDTSTART:${y}0101T000000\nDTEND:${y}0101T010000\nEND:VEVENT\nEND:VCALENDAR\n`,
    );
    const r = bizFail(df, ['import-ics', p, '--resource', 'R0001'], `年份 ${y}`);
    if (parseOk) assert.ok(r.stderr.includes('格式非法'), `年份 ${y} 应解析失败`);
    else assert.ok(!r.stderr.includes('格式非法'), `年份 ${y} 应能解析`);
  }

  // 文件不可读
  const rMissing = bizFail(df, ['import-ics', join(dir, 'nope.ics'), '--resource', 'R0001'], '文件不存在');
  assert.ok(rMissing.stderr.includes('无法读取预约文件'));

  // 用法错误退出 2
  usageFail(df, ['import-ics'], '缺少文件与资源');
  usageFail(df, ['import-ics', join(dir, 'neg.ics')], '缺少 --resource');
  usageFail(df, ['import-ics', join(dir, 'neg.ics'), '--resource', 'R0001', '多余'], '多余位置参数');
  usageFail(df, ['import-ics', join(dir, 'neg.ics'), '--bogus', 'R0001'], '未知选项');
  // 未知资源为业务失败 1
  bizFail(df, ['import-ics', writeIcs(dir, 'ok.ics', minimalIcs('UID:z\nDTSTART:20261201T100000\nDTEND:20261201T110000')), '--resource', 'R9999'], '未知资源');
});

// ---------------------------------------------------------------------------
// 8. 保存失败：退出 1、原数据保留、标识未消费，可重试成功
// ---------------------------------------------------------------------------

test('import-ics 保存失败：原数据逐字节保留且标识未消费，重试成功', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  const ics = writeIcs(
    dir,
    'a.ics',
    minimalIcs('UID:save-1\nDTSTART:20261201T100000\nDTEND:20261201T110000'),
  );

  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const r = bizFail(longFile, ['import-ics', ics, '--resource', 'R0001'], '保存失败');
  assert.ok(!r.stdout.includes('导入成功'), '不报告成功');
  assert.ok(readFileSync(longFile).equals(origBytes), '保存失败逐字节保留');
  assert.equal(readStore(longFile).bookingSeq, 0, '标识未消费');

  const retry = join(dir, 'retry.json');
  writeFileSync(retry, origBytes);
  const r2 = ok(retry, ['import-ics', ics, '--resource', 'R0001'], '可保存位置重试');
  assert.match(r2.stdout, /新预约 B0001（新增）/, '重试仍分配 B0001');
});

// ---------------------------------------------------------------------------
// 9. 旧文件兼容与导入身份损坏
// ---------------------------------------------------------------------------

test('import-ics 旧文件无 imports 字段可导入；损坏身份记录被拒绝并保留文件', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // 手工构造旧格式文件（无 series/waitlist/closures/batchOps/imports）
  writeFileSync(
    df,
    JSON.stringify({
      version: 1,
      resourceSeq: 1,
      bookingSeq: 0,
      resources: [{id: 'R0001', type: 'venue', name: '旧厅', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
      bookings: [],
    }, null, 2) + '\n',
  );
  const ics = writeIcs(dir, 'a.ics', minimalIcs('UID:legacy-1\nDTSTART:20261201T100000\nDTEND:20261201T110000'));
  ok(df, ['import-ics', ics, '--resource', 'R0001'], '旧文件导入');
  const store = readStore(df);
  assert.equal(store.imports.length, 1);
  assert.equal(store.bookings[0].id, 'B0001');
  ok(df, ['list-resources'], '旧入口正常');

  // 各类导入身份损坏：任何加载都失败且文件逐字节保留
  const corruptCases: Array<[string, (s: any) => void, string]> = [
    ['UID 重复', (s) => s.imports.push({...s.imports[0]}), '导入 UID 重复'],
    ['关联未知预约', (s) => (s.imports[0].bookingId = 'B9999'), '关联了未知预约'],
    ['一预约两身份', (s) => s.imports.push({uid: 'legacy-2', start: '2026-12-02T10:00', end: '2026-12-02T11:00', resourceIds: ['R0001'], bookingId: 'B0001'}), '已被另一导入身份关联'],
    ['非法快照时间', (s) => (s.imports[0].start = '2026-13-01T10:00'), '不是真实有效的时间'],
    ['快照引用未知资源', (s) => (s.imports[0].resourceIds = ['R9999']), '未知资源'],
  ];
  for (const [name, mutate, expect] of corruptCases) {
    const good = readFileSync(df);
    const s = readStore(df);
    mutate(s);
    writeFileSync(df, JSON.stringify(s, null, 2) + '\n');
    const badBytes = readFileSync(df);
    const r1 = bizFail(df, ['list-resources'], `${name}-查询`);
    assert.ok(r1.stderr.includes(expect), `[${name}] 应提示 ${expect}，实际：${r1.stderr.split('\n')[0]}`);
    bizFail(df, ['import-ics', ics, '--resource', 'R0001'], `${name}-导入`);
    assert.ok(readFileSync(df).equals(badBytes), `[${name}] 损坏文件原样保留（不覆盖）`);
    writeFileSync(df, good); // 恢复后下一案例继续
  }
});
