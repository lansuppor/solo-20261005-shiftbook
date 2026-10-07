// shiftbook iCalendar 导入（import-ical）—— 按周系列单次改期例外回归测试
//
// 运行：随 npm test 一起执行，或
//   node --test test/ical-import-exception.test.ts
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询或直接读取数据文件断言。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
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

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-ical-ex-test-'));
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

function cal(...vevents: string[]): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${vevents.join('')}END:VCALENDAR\n`;
}

// 按周主事件 VEVENT（不含 END 之外的包装）
function master(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

// 单次改期例外 VEVENT
function exception(uid: string, recurrenceId: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nRECURRENCE-ID:${recurrenceId}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function standalone(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function importIcal(df: string, icalFile: string, resources = ['R0001']): CliResult {
  const args = ['import-ical', icalFile];
  for (const r of resources) args.push('--resource', r);
  return runCli(df, args);
}

// ---------------------------------------------------------------------------
// 1. 前置与乱序例外、改期后时间早于前序发生：关联按原发生挂接，标识按原发生顺序
// ---------------------------------------------------------------------------

test('例外：可位于主事件之前/之后且乱序，改期后时间先后不改变关联与标识', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  // COUNT=3：原发生 10-05、10-12、10-19 各 10:00-11:00。
  // 第 2 次发生的例外写在主事件“之前” → 10-13 14:00-15:00；
  // 第 3 次发生的例外写在主事件“之后”，且改到系列开始之前 → 10-01 09:00-10:00。
  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      exception('weekly-a', '20261012T100000', '20261013T140000', '20261013T150000'),
      master('weekly-a', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\n'),
      exception('weekly-a', '20261019T100000', '20261001T090000', '20261001T100000'),
    ),
  );
  const r = importIcal(df, f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /生成 3 个成员，其中 2 个为单次改期例外/);
  // 成员顺序仍按原发生；B0002 是第 2 次发生（改到 10-13），B0003 是第 3 次（改到 10-01）
  assert.match(r.stdout, /第 1 次发生（原发生 2026-10-05T10:00） → B0001: 2026-10-05T10:00 → 2026-10-05T11:00/);
  assert.match(r.stdout, /第 2 次发生（原发生 2026-10-12T10:00） → B0002: 2026-10-13T14:00 → 2026-10-13T15:00/);
  assert.match(
    r.stdout,
    /第 3 次发生（原发生 2026-10-19T10:00） → B0003: 2026-10-01T09:00 → 2026-10-01T10:00[\s\S]*原时段 2026-10-19T10:00 → 2026-10-19T11:00 已替换/,
  );

  const store = readStore(df);
  assert.equal(store.bookingSeq, 3);
  assert.equal(store.seriesSeq, 1);
  // 成员落盘后按标识排序：B0003(10-01)、B0001(10-05)、B0002(10-13)；系列归属不变
  const byId = Object.fromEntries(store.bookings.map((b: any) => [b.id, [b.start, b.end]]));
  assert.deepEqual(byId, {
    B0001: ['2026-10-05T10:00', '2026-10-05T11:00'],
    B0002: ['2026-10-13T14:00', '2026-10-13T15:00'],
    B0003: ['2026-10-01T09:00', '2026-10-01T10:00'],
  });
  assert.ok(store.bookings.every((b: any) => b.seriesId === 'S0001'));
  const imp = store.imports[0];
  // occurrences 按原发生关联（不是按改期后时间排序）
  assert.deepEqual(imp.occurrences.map((o: any) => [o.start, o.bookingId]), [
    ['2026-10-05T10:00', 'B0001'],
    ['2026-10-12T10:00', 'B0002'],
    ['2026-10-19T10:00', 'B0003'],
  ]);
  assert.deepEqual(imp.exceptions, [
    {recurrenceId: '2026-10-12T10:00', start: '2026-10-13T14:00', end: '2026-10-13T15:00'},
    {recurrenceId: '2026-10-19T10:00', start: '2026-10-01T09:00', end: '2026-10-01T10:00'},
  ], '例外集合按原发生排序永久保存');

  // 新进程查询：按日视图中 B0002 在 10-13、B0003 在 10-01，均显示系列归属
  const day1 = ok(df, ['list-bookings', '--date', '2026-10-13'], '新进程查询 10-13');
  assert.match(day1.stdout, /B0002 \[已预约\] 2026-10-13T14:00 → 2026-10-13T15:00[\s\S]*所属系列: S0001/);
  const day2 = ok(df, ['list-bookings', '--date', '2026-10-01'], '新进程查询 10-01');
  assert.match(day2.stdout, /B0003 \[已预约\] 2026-10-01T09:00 → 2026-10-01T10:00/);
  assert.doesNotMatch(day2.stdout, /2026-10-19/);
});

// ---------------------------------------------------------------------------
// 2. 例外重放：例外位置/顺序变化不算身份变化；文件逐字节不变
// ---------------------------------------------------------------------------

test('例外重放：例外重排与位置前后变化仍为重放，显示例外与当前安排', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f1 = writeIcal(
    dir,
    'first.ics',
    cal(
      master('weekly-r', '20261102T100000', '20261102T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261109T100000\n'),
      exception('weekly-r', '20261116T100000', '20261117T080000', '20261117T093000'),
    ),
  );
  const r1 = importIcal(df, f1);
  assert.equal(r1.status, 0, r1.stderr);
  const before = readFileSync(df);

  // 重放文件：两个例外都放到主事件之前、且顺序颠倒；EXDATE 顺序变化
  const f2 = writeIcal(
    dir,
    'second.ics',
    cal(
      exception('weekly-r', '20261116T100000', '20261117T080000', '20261117T093000'),
      master(
        'weekly-r',
        '20261102T100000',
        '20261102T110000',
        'rrule:count=3;freq=WEEKLY\nEXDATE:20261109T100000\n',
      ),
    ),
  );
  const r2 = importIcal(df, f2);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /全部为重放/);
  assert.match(r2.stdout, /其中单次改期例外 1 个/);
  // 重放仍按主事件定位为第 1 项（例外 VEVENT 前置不改变序号）
  assert.match(r2.stdout, /- 第 1 项 UID “weekly-r”/);
  assert.match(
    r2.stdout,
    /原发生 2026-11-16T10:00） → B0002 \[已预约\][\s\S]*单次改期例外（原时段 2026-11-16T10:00 → 2026-11-16T11:00 已替换，不再占用）: 2026-11-17T08:00 → 2026-11-17T09:30[\s\S]*当前安排: 2026-11-17T08:00 → 2026-11-17T09:30/,
  );
  assert.ok(before.equals(readFileSync(df)), '全重放逐字节不变');
});

// ---------------------------------------------------------------------------
// 3. 跨日例外：可改变时长，时刻与跨日长度按例外 DTSTART/DTEND
// ---------------------------------------------------------------------------

test('例外：跨日目标且时长可长于原发生', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-cross', '20261008T230000', '20261009T010000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('weekly-cross', '20261015T230000', '20261016T230000', '20261017T020000'),
    ),
  );
  const r = importIcal(df, f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /原发生 2026-10-15T23:00） → B0002: 2026-10-16T23:00 → 2026-10-17T02:00/);
  const store = readStore(df);
  assert.deepEqual(store.bookings.map((b: any) => [b.start, b.end]), [
    ['2026-10-08T23:00', '2026-10-09T01:00'],
    ['2026-10-16T23:00', '2026-10-17T02:00'],
  ]);
});

// ---------------------------------------------------------------------------
// 4. 被替换原时段释放：可再约；例外新目标占用；原时段不阻挡同批其他目标
// ---------------------------------------------------------------------------

test('例外：被替换原时段释放且可再约，新目标按当前安排占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  // 第 2 次发生 10-12T10-11 改到 10-13T10-11
  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-free', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('weekly-free', '20261012T100000', '20261013T100000', '20261013T110000'),
    ),
  );
  const r = importIcal(df, f);
  assert.equal(r.status, 0, r.stderr);

  // 原时段已释放：新进程可直接在 10-12T10-11 预约
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '原时段再约');

  // 新目标 10-13T10-11 已被例外成员占用
  const blocked = bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-13T10:30', '--end', '2026-10-13T11:30'],
    '例外目标占用',
  );
  assert.match(blocked.stderr, /B0002/);

  // 同批新事件落在被替换原时段上也不冲突：新独立事件 10-12T10-11 成功
  const f2 = writeIcal(dir, 'b.ics', cal(standalone('new-at-old-slot', '20261012T100000', '20261012T110000')));
  // 注意：上一步已在该时段创建 B0003，故这里换成端点相接的时段验证不被 B0002 阻挡
  const f3 = writeIcal(dir, 'c.ics', cal(standalone('new-touch', '20261012T110000', '20261012T120000')));
  const r3 = importIcal(df, f3);
  assert.equal(r3.status, 0, r3.stderr);
  assert.match(r3.stdout, /新预约 B0004/);
  // f2 与 B0003 冲突（证明占用检查仍生效），与例外成员 B0002 无关
  const r2 = importIcal(df, f2);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /B0003/);
  assert.doesNotMatch(r2.stderr, /B0002/);
});

// ---------------------------------------------------------------------------
// 5. 例外目标受阻：外部冲突报告原发生与目标时间；整批不落盘
// ---------------------------------------------------------------------------

test('例外：新目标与既有预约冲突时报告原发生与改期目标，整批失败', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-12-01T12:00', '--end', '2026-12-01T13:00'], '既有预约');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-block', '20261201T100000', '20261201T110000', 'RRULE:FREQ=WEEKLY;COUNT=1\n'),
      exception('weekly-block', '20261201T100000', '20261201T123000', '20261201T133000'),
    ),
  );
  const r = importIcal(df, f);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /weekly-block” 第 1 次发生（原发生 2026-12-01T10:00 → 2026-12-01T11:00；单次改期目标 2026-12-01T12:30 → 2026-12-01T13:30（被替换原时段不占用））[\s\S]*B0001/,
  );
  const store = readStore(df);
  assert.equal(store.seriesSeq, 0, '不创建系列');
  assert.equal(store.bookingSeq, 1, '不创建成员');
  assert.equal((store.imports ?? []).length, 0);
});

// ---------------------------------------------------------------------------
// 6. 批内冲突：例外目标与同文件新事件冲突，双方互列原发生与目标时间
// ---------------------------------------------------------------------------

test('例外：批内冲突双方互列 UID、原发生与改期目标', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-in', '20261207T100000', '20261207T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('weekly-in', '20261207T100000', '20261208T120000', '20261208T130000'),
      standalone('solo-in', '20261208T123000', '20261208T133000'),
    ),
  );
  const r = importIcal(df, f);
  assert.equal(r.status, 1);
  // 例外发生方列出独立事件
  assert.match(
    r.stderr,
    /weekly-in” 第 1 次发生（原发生 2026-12-07T10:00[\s\S]*单次改期目标 2026-12-08T12:00 → 2026-12-08T13:00[\s\S]*solo-in” 第 1 次发生（2026-12-08T12:30 → 2026-12-08T13:30）/,
  );
  // 独立事件方列出例外的原发生与改期目标
  assert.match(
    r.stderr,
    /solo-in” 第 1 次发生（2026-12-08T12:30 → 2026-12-08T13:30）[\s\S]*weekly-in” 第 1 次发生（原发生 2026-12-07T10:00[\s\S]*单次改期目标 2026-12-08T12:00 → 2026-12-08T13:00（被替换原时段不占用））/,
  );
  assert.equal(readStore(df).bookings.length, 0, '整批不落盘');
});

// ---------------------------------------------------------------------------
// 7. 混合重放：例外系列 + 独立事件的重放与新增；重放成员按当前有效安排占用
// ---------------------------------------------------------------------------

test('混合重放：例外系列与独立事件混合，重放成员按例外目标占用', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const fOld = writeIcal(
    dir,
    'old.ics',
    cal(
      standalone('old-solo', '20261102T080000', '20261102T090000'),
      master('old-week', '20261102T100000', '20261102T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('old-week', '20261102T100000', '20261103T140000', '20261103T150000'),
    ),
  );
  assert.equal(importIcal(df, fOld).status, 0);

  // 新事件撞在例外成员 B0002 的当前安排（11-03 14-15）上：被阻挡
  const fBlock = writeIcal(
    dir,
    'block.ics',
    cal(
      // 重放两项（例外前置，验证乱序重放）
      exception('old-week', '20261102T100000', '20261103T140000', '20261103T150000'),
      master('old-week', '20261102T100000', '20261102T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      standalone('old-solo', '20261102T080000', '20261102T090000'),
      standalone('new-conflict', '20261103T143000', '20261103T153000'),
    ),
  );
  const rBlock = importIcal(df, fBlock);
  assert.equal(rBlock.status, 1);
  assert.match(rBlock.stderr, /new-conflict[\s\S]*B0002/);
  assert.equal(readStore(df).bookingSeq, 3, '整批未导入');

  // 不冲突的混合文件：2 重放 + 1 新增
  const fOk = writeIcal(
    dir,
    'ok.ics',
    cal(
      standalone('old-solo', '20261102T080000', '20261102T090000'),
      master('old-week', '20261102T100000', '20261102T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('old-week', '20261102T100000', '20261103T140000', '20261103T150000'),
      standalone('new-solo', '20261103T160000', '20261103T170000'),
    ),
  );
  const rOk = importIcal(df, fOk);
  assert.equal(rOk.status, 0, rOk.stderr);
  assert.match(rOk.stdout, /新增 1 项，重放 2 项/);
  assert.match(rOk.stdout, /新预约 B0004/);
  assert.equal(readStore(df).bookingSeq, 4);
});

// ---------------------------------------------------------------------------
// 8. 身份变化拒绝：增/删/改例外或改变 RECURRENCE-ID 整批拒绝；顺序不同合法
// ---------------------------------------------------------------------------

test('身份：已关联 UID 增删例外或改变例外时间/原发生整批拒绝，顺序无关', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f0 = writeIcal(
    dir,
    'a.ics',
    cal(
      master('uid-ex', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\n'),
      exception('uid-ex', '20261012T100000', '20261013T090000', '20261013T100000'),
      exception('uid-ex', '20261019T100000', '20261020T090000', '20261020T100000'),
    ),
  );
  assert.equal(importIcal(df, f0).status, 0);
  const before = readFileSync(df);

  const m = master('uid-ex', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\n');
  const ex1 = exception('uid-ex', '20261012T100000', '20261013T090000', '20261013T100000');
  const ex2 = exception('uid-ex', '20261019T100000', '20261020T090000', '20261020T100000');

  // 改例外起止时间
  const fChange = writeIcal(dir, 'change.ics', cal(m, exception('uid-ex', '20261012T100000', '20261013T093000', '20261013T103000'), ex2));
  assert.match(importIcal(df, fChange).stderr, /单次改期例外集合不同/);

  // 删一个例外
  const fRemove = writeIcal(dir, 'remove.ics', cal(m, ex1));
  assert.match(importIcal(df, fRemove).stderr, /单次改期例外集合不同/);

  // 增一个例外
  const fAdd = writeIcal(
    dir,
    'add.ics',
    cal(m, ex1, ex2, exception('uid-ex', '20261005T100000', '20261004T090000', '20261004T100000')),
  );
  assert.match(importIcal(df, fAdd).stderr, /单次改期例外集合不同/);

  // 改 RECURRENCE-ID（改期目标时间不变，原发生从 10-12 换成 10-05）
  const fRec = writeIcal(dir, 'rec.ics', cal(m, exception('uid-ex', '20261005T100000', '20261013T090000', '20261013T100000'), ex2));
  assert.match(importIcal(df, fRec).stderr, /单次改期例外集合不同/);

  assert.ok(before.equals(readFileSync(df)), '各种身份拒绝后文件逐字节不变');

  // 仅例外顺序不同：仍是重放
  const fOrder = writeIcal(dir, 'order.ics', cal(m, ex2, ex1));
  const rOrder = importIcal(df, fOrder);
  assert.equal(rOrder.status, 0, rOrder.stderr);
  assert.match(rOrder.stdout, /全部为重放/);
  assert.ok(before.equals(readFileSync(df)), '顺序不同的重放逐字节不变');
});

// ---------------------------------------------------------------------------
// 9. 本地改期/取消例外成员后重放：不覆盖、不复活、不补员
// ---------------------------------------------------------------------------

test('例外成员被本地改期或取消后，重放不覆盖、不复活、不补员', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-loc', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('weekly-loc', '20261012T100000', '20261013T100000', '20261013T110000'),
    ),
  );
  assert.equal(importIcal(df, f).status, 0);
  // B0002 是例外成员，本地再改期并取消
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-14T08:00', '--end', '2026-10-14T09:00'], '本地改期例外成员');
  ok(df, ['cancel-booking', 'B0002'], '本地取消例外成员');
  const before = readFileSync(df);

  const r = importIcal(df, f);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /全部为重放/);
  assert.match(r.stdout, /原发生 2026-10-12T10:00） → B0002 \[已取消\]/);
  assert.match(r.stdout, /当前安排: 2026-10-14T08:00 → 2026-10-14T09:00/);
  assert.match(r.stdout, /不再占用）: 2026-10-13T10:00 → 2026-10-13T11:00/, '仍显示首次导入的例外快照');
  assert.ok(before.equals(readFileSync(df)), '重放不写文件');
  const store = readStore(df);
  assert.equal(store.bookings.length, 2, '不补员、不重建');
  assert.equal(store.bookingSeq, 2, '计数不推进');
});

// ---------------------------------------------------------------------------
// 10. 结构负例：例外 VEVENT 的各种非法写法整批拒绝
// ---------------------------------------------------------------------------

test('结构负例：例外缺主事件/双主事件/挂独立事件/带 RRULE/EXDATE/RANGE/重复/不匹配/全天/时区/秒', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室', [['0001-01-01T00:00', '9999-12-31T23:59']]);

  const m = master('n', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\n');
  let no = 0;
  const w = (content: string): string => writeIcal(dir, `bad-${no++}.ics`, cal(content));

  const cases: Array<[string, string, RegExp]> = [
    ['只有例外没有主事件', exception('n', '20261012T100000', '20261013T100000', '20261013T110000'), /却没有主事件/],
    ['两个主事件', m + m, /只允许一个不带 RECURRENCE-ID 的主事件/],
    ['例外挂在独立事件上',
      standalone('s', '20261005T100000', '20261005T110000') +
        exception('s', '20261005T100000', '20261006T100000', '20261006T110000'),
      /不是按周重复事件/],
    ['例外带 RRULE',
      m + exception('n', '20261012T100000', '20261013T100000', '20261013T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      /不得带 RRULE/],
    ['例外带 EXDATE',
      m + exception('n', '20261012T100000', '20261013T100000', '20261013T110000', 'EXDATE:20261013T100000\n'),
      /不得带 EXDATE/],
    ['RECURRENCE-ID 带 RANGE',
      m + 'BEGIN:VEVENT\nUID:n\nRECURRENCE-ID;RANGE=THISANDFUTURE:20261012T100000\nDTSTART:20261013T100000\nDTEND:20261013T110000\nEND:VEVENT\n',
      /不支持 RANGE 参数/],
    ['同一原发生两个例外',
      m +
        exception('n', '20261012T100000', '20261013T100000', '20261013T110000') +
        exception('n', '20261012T100000', '20261014T100000', '20261014T110000'),
      /多个改期例外/],
    ['RECURRENCE-ID 匹配被排除发生',
      master('n', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261012T100000\n') +
        exception('n', '20261012T100000', '20261013T100000', '20261013T110000'),
      /已被 EXDATE 排除/],
    ['RECURRENCE-ID 不匹配任何原开始',
      m + exception('n', '20261013T100000', '20261014T100000', '20261014T110000'),
      /不匹配任何原开始时间/],
    ['RECURRENCE-ID 秒非 00',
      m + exception('n', '20261012T100001', '20261013T100000', '20261013T110000'),
      /秒必须为 00/],
    ['RECURRENCE-ID 带 TZID',
      m + 'BEGIN:VEVENT\nUID:n\nRECURRENCE-ID;TZID=Asia/Shanghai:20261012T100000\nDTSTART:20261013T100000\nDTEND:20261013T110000\nEND:VEVENT\n',
      /不支持时区时间/],
    ['RECURRENCE-ID 全天',
      m + 'BEGIN:VEVENT\nUID:n\nRECURRENCE-ID;VALUE=DATE:20261012\nDTSTART:20261013T100000\nDTEND:20261013T110000\nEND:VEVENT\n',
      /不支持全天事件/],
    ['RECURRENCE-ID 属性重复',
      m + 'BEGIN:VEVENT\nUID:n\nRECURRENCE-ID:20261012T100000\nRECURRENCE-ID:20261019T100000\nDTSTART:20261013T100000\nDTEND:20261013T110000\nEND:VEVENT\n',
      /RECURRENCE-ID 属性重复/],
    ['例外结束早于开始',
      m + exception('n', '20261012T100000', '20261013T110000', '20261013T100000'),
      /结束时间必须晚于开始/],
    ['例外缺 DTSTART',
      m + 'BEGIN:VEVENT\nUID:n\nRECURRENCE-ID:20261012T100000\nDTEND:20261013T110000\nEND:VEVENT\n',
      /缺少 DTSTART/],
  ];

  for (const [name, content, pattern] of cases) {
    const r = importIcal(df, w(content));
    assert.equal(r.status, 1, `结构负例：${name} 应退出 1`);
    assert.match(r.stderr, pattern, `结构负例：${name}`);
  }
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '全部负例均未产生预约');
  assert.equal(store.seriesSeq, 0);
});

// ---------------------------------------------------------------------------
// 11. 损坏检测：例外快照非法或与原发生映射不自洽即数据损坏
// ---------------------------------------------------------------------------

test('损坏检测：例外集合结构非法或 RECURRENCE-ID 不匹配未排除原发生时拒绝加载', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-c', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261019T100000\n'),
      exception('weekly-c', '20261012T100000', '20261013T100000', '20261013T110000'),
    ),
  );
  assert.equal(importIcal(df, f).status, 0);

  const goodBytes = readFileSync(df);
  const reload = (ctx: string): CliResult => bizFail(df, ['list-bookings', '--date', '2026-10-05'], ctx);
  const corrupt = (mutate: (s: any) => void): void => {
    const s = JSON.parse(goodBytes.toString('utf8'));
    mutate(s);
    writeFileSync(df, JSON.stringify(s));
  };

  corrupt((s) => {
    s.imports[0].exceptions = [
      {recurrenceId: '2026-10-19T10:00', start: '2026-10-20T10:00', end: '2026-10-20T11:00'}, // 已排除的发生
    ];
  });
  assert.match(reload('例外挂在已排除发生').stderr, /不匹配任何未排除原发生/);

  corrupt((s) => {
    s.imports[0].exceptions = [
      {recurrenceId: '2026-10-12T10:00', start: '2026-10-13T10:00', end: '2026-10-13T11:00'},
      {recurrenceId: '2026-10-12T10:00', start: '2026-10-14T10:00', end: '2026-10-14T11:00'},
    ];
  });
  assert.match(reload('例外原发生重复').stderr, /例外原发生时间重复/);

  corrupt((s) => {
    s.imports[0].exceptions = [
      {recurrenceId: '2026-10-12T10:00', start: '2026-10-13T11:00', end: '2026-10-13T10:00'},
    ];
  });
  assert.match(reload('例外结束不晚于开始').stderr, /例外结束必须晚于开始/);

  corrupt((s) => {
    s.imports[0].exceptions = [
      {recurrenceId: '2026-10-12T10:00', start: '2026-10-13T10:00', end: '2026-10-13T11:00', bogus: 1},
    ];
  });
  assert.match(reload('例外存在未知字段').stderr, /存在未知字段/);

  corrupt((s) => {
    s.imports[0].exceptions = {recurrenceId: '2026-10-12T10:00'};
  });
  assert.match(reload('exceptions 非数组').stderr, /exceptions 必须是数组/);

  // 旧重复导入记录无 exceptions 字段：视为空集合，正常加载，且无例外文件重放成功
  corrupt((s) => {
    delete s.imports[0].exceptions;
  });
  const view = ok(df, ['list-series'], '旧记录（无 exceptions）正常加载');
  assert.match(view.stdout, /系列 S0001/);
  const fNoEx = writeIcal(
    dir,
    'noex.ics',
    cal(master('weekly-c', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261019T100000\n')),
  );
  const rReplay = importIcal(df, fNoEx);
  assert.equal(rReplay.status, 0, rReplay.stderr);
  assert.match(rReplay.stdout, /全部为重放/);
  // 旧空集合记录再提交带例外的文件：身份变化，整批拒绝
  const fWithEx = writeIcal(
    dir,
    'withex.ics',
    cal(
      master('weekly-c', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=3\nEXDATE:20261019T100000\n'),
      exception('weekly-c', '20261012T100000', '20261013T100000', '20261013T110000'),
    ),
  );
  assert.match(importIcal(df, fWithEx).stderr, /单次改期例外集合不同/);

  // 完好文件恢复
  writeFileSync(df, goodBytes);
  ok(df, ['list-series'], '完好文件恢复后正常');
});

// ---------------------------------------------------------------------------
// 12. 保存失败与重试：退出 1、原文件逐字节保留、标识未消费；重试成功后新进程查询
// ---------------------------------------------------------------------------

test('保存失败：例外导入失败逐字节保留且不消费标识，可保存位置重试成功', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    cal(
      master('weekly-save', '20261005T100000', '20261005T110000', 'RRULE:FREQ=WEEKLY;COUNT=2\n'),
      exception('weekly-save', '20261012T100000', '20261013T100000', '20261013T110000'),
    ),
  );

  // 文件名 250+f'.json'：临时文件名超限，保存必然失败
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, readFileSync(df));
  const origBytes = readFileSync(longFile);
  const r1 = runCli(longFile, ['import-ical', f, '--resource', 'R0001']);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /保存数据文件 .* 失败/);
  assert.ok(origBytes.equals(readFileSync(longFile)), '保存失败逐字节保留');
  let store = JSON.parse(origBytes.toString('utf8'));
  assert.equal(store.seriesSeq, 0, '系列标识未消费');
  assert.equal(store.bookingSeq, 0, '预约标识未消费');

  // 同内容复制到可保存位置重试：标识仍为 S0001/B0001..
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  const r2 = runCli(retryFile, ['import-ical', f, '--resource', 'R0001']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /新系列 S0001/);
  assert.match(r2.stdout, /B0001/);
  assert.match(r2.stdout, /B0002: 2026-10-13T10:00 → 2026-10-13T11:00/);

  // 新进程查询持久结果与身份
  const view = ok(retryFile, ['list-series'], '新进程查询系列');
  assert.match(view.stdout, /B0002 \[有效\] 2026-10-13T10:00 → 2026-10-13T11:00/);
  store = readStore(retryFile);
  assert.deepEqual(store.imports[0].exceptions, [
    {recurrenceId: '2026-10-12T10:00', start: '2026-10-13T10:00', end: '2026-10-13T11:00'},
  ]);
});
