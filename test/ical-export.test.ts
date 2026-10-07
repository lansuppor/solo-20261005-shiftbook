// shiftbook 已导入按周系列的本地 iCalendar 导出（export-ical）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 测试内置一个独立于产品代码的最小 iCalendar 解析器：自行折行/转义还原，
//   展开 RRULE、套用 EXDATE 与 RECURRENCE-ID 例外后，逐成员核对数据文件中的
//   当前时间与资源集合（不调用产品的解析/展开代码）；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询或直接读取文件断言；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, spawn} from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  symlinkSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join, dirname, resolve, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
const OPEN_ALL_YEARS: Array<[string, string]> = [['0001-01-01T00:00', '9999-12-31T23:59']];
// 254 字节的输出名：原子写出的临时文件（<名>.<pid>.export-tmp）必然超出文件名
// 长度上限（255 字节），在不调整任何权限的前提下可重复触发真实写出失败。
const LONG_NAME = 'f'.repeat(250) + '.ics';

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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-ical-export-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  type: 'venue' | 'equipment' | 'person' = 'venue',
  open: Array<[string, string]> = OPEN_ALL,
): string {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  const r = ok(df, args, `登记资源 ${name}`);
  const m = /已添加资源 (R\d+)/.exec(r.stdout);
  assert.ok(m, `登记资源 ${name} 未返回标识`);
  return m![1];
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function writeIcal(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function ical(...events: string[]): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${events.join('')}END:VCALENDAR\n`;
}

function event(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function weeklyEvent(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nRRULE:FREQ=WEEKLY;COUNT=3\n${extra}END:VEVENT\n`;
}

function excEvent(uid: string, rid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nRECURRENCE-ID:${rid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function importOk(df: string, icalFile: string, resources: string[], ctx: string): CliResult {
  const args = ['import-ical', icalFile];
  for (const r of resources) args.push('--resource', r);
  return ok(df, args, ctx);
}

function exportOk(df: string, uid: string, outFile: string, ctx: string): CliResult {
  return ok(df, ['export-ical', uid, '--output', outFile], ctx);
}

// ---------------------------------------------------------------------------
// 独立的导出日历解析与展开核对（不调用产品代码）
// ---------------------------------------------------------------------------

interface CalEvent {
  uid: string;
  dtstamp: string;
  dtstart: string;
  dtend: string;
  rrule?: string;
  exdates: string[];
  recurrenceId?: string;
  description: string;
}

interface Calendar {
  prodid: string;
  master: CalEvent;
  exceptions: CalEvent[];
}

// TEXT 反转义：\\ \, \; \n（与产品实现相互独立书写）
function unescapeText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\') {
      const n = value[++i];
      if (n === 'n' || n === 'N') out += '\n';
      else if (n === undefined) throw new Error('DESCRIPTION 以单独反斜杠结尾');
      else out += n;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseExport(text: string, ctx: string): Calendar {
  // CRLF：不允许裸 LF；文件以 CRLF 结尾
  assert.ok(text.endsWith('\r\n'), `[${ctx}] 文件应以 CRLF 结尾`);
  assert.doesNotMatch(text, /[^\r]\n/, `[${ctx}] 存在非 CRLF 行尾`);
  const physical = text.slice(0, -2).split('\r\n');
  for (const [i, l] of physical.entries()) {
    assert.ok(
      Buffer.byteLength(l, 'utf8') <= 75,
      `[${ctx}] 第 ${i + 1} 个物理行超过 75 个 UTF-8 字节：${Buffer.byteLength(l, 'utf8')}（${l}）`,
    );
  }

  // 折行还原（续行以单个空格或制表符开头，前导字符计入物理行长度）
  const logical: string[] = [];
  for (const l of physical) {
    if (l.startsWith(' ') || l.startsWith('\t')) {
      assert.ok(logical.length > 0, `[${ctx}] 文件以折行续行开头`);
      logical[logical.length - 1] += l.slice(1);
    } else {
      logical.push(l);
    }
  }

  const props = (body: string[]): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const line of body) {
      const ci = line.indexOf(':');
      assert.ok(ci >= 0, `[${ctx}] 内容行缺少冒号: ${line}`);
      const name = line.slice(0, ci).toUpperCase();
      const value = line.slice(ci + 1);
      const list = m.get(name) ?? [];
      list.push(value);
      m.set(name, list);
    }
    return m;
  };
  const one = (m: Map<string, string[]>, name: string, where: string): string => {
    const v = m.get(name);
    assert.ok(v !== undefined && v.length === 1, `[${ctx}] ${where} 应恰有一个 ${name}`);
    return v![0];
  };

  assert.equal(logical[0], 'BEGIN:VCALENDAR', `[${ctx}] 首行应为 BEGIN:VCALENDAR`);
  assert.equal(logical[1], 'VERSION:2.0', `[${ctx}] VERSION:2.0`);
  assert.equal(logical[logical.length - 1], 'END:VCALENDAR', `[${ctx}] 末行应为 END:VCALENDAR`);

  const calProps = props(logical.slice(2, logical.length - 1).filter((l) => !l.startsWith('BEGIN:VEVENT')));
  // 取顶层 PRODID（VEVENT 之外）
  let prodid = '';
  {
    const top: string[] = [];
    let inEvent = false;
    for (const l of logical.slice(2, logical.length - 1)) {
      if (l === 'BEGIN:VEVENT') {
        inEvent = true;
      } else if (l === 'END:VEVENT') {
        inEvent = false;
      } else if (!inEvent) {
        top.push(l);
      }
    }
    prodid = one(props(top), 'PRODID', 'VCALENDAR');
    assert.ok(prodid !== '', `[${ctx}] PRODID 不能为空`);
    void calProps;
  }

  const events: CalEvent[] = [];
  for (let i = 0; i < logical.length; i++) {
    if (logical[i] !== 'BEGIN:VEVENT') continue;
    const body: string[] = [];
    let j = i + 1;
    while (j < logical.length && logical[j] !== 'END:VEVENT') {
      body.push(logical[j]);
      j++;
    }
    assert.ok(j < logical.length, `[${ctx}] VEVENT 缺少 END:VEVENT`);
    i = j;
    const m = props(body);
    const ev: CalEvent = {
      uid: unescapeText(one(m, 'UID', 'VEVENT')),
      dtstamp: one(m, 'DTSTAMP', 'VEVENT'),
      dtstart: one(m, 'DTSTART', 'VEVENT'),
      dtend: one(m, 'DTEND', 'VEVENT'),
      exdates: m.get('EXDATE') ?? [],
      description: unescapeText(one(m, 'DESCRIPTION', 'VEVENT')),
    };
    const rrule = m.get('RRULE');
    if (rrule !== undefined) ev.rrule = rrule[0];
    const rid = m.get('RECURRENCE-ID');
    if (rid !== undefined) ev.recurrenceId = rid[0];
    events.push(ev);
  }
  assert.ok(events.length >= 1, `[${ctx}] 至少应有主事件一个 VEVENT`);

  // DTSTAMP：合法 UTC（YYYYMMDDTHHMMSSZ，时间真实）
  const validUtcStamp = (s: string): boolean => {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (!m) return false;
    const [, y, mo, d, h, mi, se] = m.map(Number);
    if (h > 23 || mi > 59 || se > 59 || mo < 1 || mo > 12 || d < 1) return false;
    const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dim[mo - 1];
  };
  for (const ev of events) assert.ok(validUtcStamp(ev.dtstamp), `[${ctx}] DTSTAMP 非合法 UTC: ${ev.dtstamp}`);

  const masters = events.filter((e) => e.recurrenceId === undefined);
  assert.equal(masters.length, 1, `[${ctx}] 应恰有一个主事件`);
  const master = masters[0];
  const exceptions = events.filter((e) => e.recurrenceId !== undefined);
  // 主事件在前；其后各 VEVENT 恰为例外且按原发生（RECURRENCE-ID）排序
  assert.equal(events[0], master, `[${ctx}] 主事件必须位于最前`);
  assert.deepEqual(events.slice(1), exceptions, `[${ctx}] 主事件之后应只含按序排列的例外`);
  for (let k = 1; k < exceptions.length; k++) {
    assert.ok(
      exceptions[k].recurrenceId! > exceptions[k - 1].recurrenceId!,
      `[${ctx}] 例外须按原发生排序且 RECURRENCE-ID 不重复`,
    );
  }
  return {prodid, master, exceptions};
}

// YYYY-MM-DDTHH:mm -> YYYYMMDDTHHmm00（独立写法）
function toIcal(raw: string): string {
  return raw.replace(/[-:]/g, '') + '00';
}

// 加 n 周（独立的公历算术，用 UTC Date，仅用于测试核对）
function plusWeeks(raw: string, weeks: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw)!;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  dt.setUTCDate(dt.getUTCDate() + 7 * weeks);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}T${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}`;
}

// 两个时间文本相差的整周数（原发生相对首项的周序号；独立于产品的分钟换算）
function weekIndex(from: string, to: string): number {
  const parse = (s: string): Date => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s)!;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  };
  const weeks = (parse(to).getTime() - parse(from).getTime()) / (7 * 24 * 3600 * 1000);
  const n = Math.round(weeks);
  if (Math.abs(weeks - n) > 1e-9) throw new Error(`“${from}” 与 “${to}” 不相差整数个周`);
  return n;
}

const TYPE_LABEL: Record<string, string> = {venue: '场地', equipment: '设备', person: '人员'};

// 展开导出日历并与数据文件中的成员当前安排逐项核对；返回日历与计数
function verifyExportAgainstStore(df: string, outFile: string, uid: string, ctx: string): Calendar & {
  activeCount: number;
  excludedCount: number;
  exceptionCount: number;
} {
  const store = readStore(df);
  const imp = store.imports.find((x: any) => x.uid === uid);
  assert.ok(imp, `[${ctx}] 数据文件中找不到 UID ${uid}`);
  const cal = parseExport(readFileSync(outFile, 'utf8'), ctx);

  // 主事件：首次 UID、首项时间、RRULE、首次资源集合
  assert.equal(cal.master.uid, uid, `[${ctx}] 主事件 UID 应为首次 UID`);
  assert.equal(cal.master.dtstart, toIcal(imp.start), `[${ctx}] 主事件 DTSTART 应为首项时间`);
  assert.equal(cal.master.dtend, toIcal(imp.end), `[${ctx}] 主事件 DTEND 应为首项时间`);
  assert.equal(cal.master.rrule, `FREQ=WEEKLY;COUNT=${imp.count}`, `[${ctx}] RRULE`);
  for (const ev of cal.exceptions) assert.equal(ev.uid, uid, `[${ctx}] 例外 UID 与主事件相同`);

  // 浮动时间形状：YYYYMMDDTHHmmss 且秒为 00
  const floating = (s: string): boolean => /^\d{4}\d{2}\d{2}T\d{2}\d{2}00$/.test(s);
  assert.ok(floating(cal.master.dtstart) && floating(cal.master.dtend), `[${ctx}] 主事件浮动时间形状`);
  for (const e of cal.exceptions) {
    assert.ok(floating(e.dtstart) && floating(e.dtend) && floating(e.recurrenceId!), `[${ctx}] 例外浮动时间形状`);
  }

  // DESCRIPTION 与资源集合（按标识排序，列标识、名称、类型）
  const resourceById = new Map(store.resources.map((r: any) => [r.id, r]));
  const expectDesc = (text: string, ids: string[], where: string): void => {
    const sorted = [...ids].sort();
    const lines = text.split('\n');
    assert.equal(lines.length, sorted.length, `[${ctx}] ${where} DESCRIPTION 行数应为资源数`);
    lines.forEach((line, k) => {
      const mm = /^资源 (R\d+) (.+)（(场地|设备|人员)）$/.exec(line);
      assert.ok(mm, `[${ctx}] ${where} DESCRIPTION 行格式非法: ${line}`);
      const [, rid, name, label] = mm!;
      assert.equal(rid, sorted[k], `[${ctx}] ${where} 资源应按标识排序`);
      const r = resourceById.get(rid);
      assert.equal(name, r.name, `[${ctx}] ${where} 资源名称`);
      assert.equal(label, TYPE_LABEL[r.type], `[${ctx}] ${where} 资源类型`);
    });
  };
  expectDesc(cal.master.description, imp.resourceIds, '主事件');

  // EXDATE = 首次排除集合 ∪ 已取消成员原开始（去重、按原发生排序）
  const expectedExdates = new Set<string>(imp.exdates ?? []);
  const bookingById = new Map(store.bookings.map((b: any) => [b.id, b]));
  const cancelled = new Set<string>();
  for (const o of imp.occurrences) {
    if (bookingById.get(o.bookingId).status === 'cancelled') {
      expectedExdates.add(o.start);
      cancelled.add(o.start);
    }
  }
  assert.deepEqual(
    cal.master.exdates,
    [...expectedExdates].sort().map(toIcal),
    `[${ctx}] EXDATE 应为首次排除与取消成员原开始的去重并集（按原发生排序）`,
  );

  // 逐成员展开核对：有效成员当前时间/资源决定例外有无；取消成员无例外
  const exByRid = new Map(cal.exceptions.map((e) => [e.recurrenceId!, e]));
  assert.equal(
    new Set(exByRid.keys()).size,
    cal.exceptions.length,
    `[${ctx}] RECURRENCE-ID 不得重复`,
  );
  let active = 0;
  let changedCount = 0;
  imp.occurrences.forEach((o: any) => {
    const b = bookingById.get(o.bookingId);
    const rid = toIcal(o.start);
    if (b.status === 'cancelled') {
      assert.ok(!exByRid.has(rid), `[${ctx}] 取消成员 ${b.id} 不应输出例外`);
      return;
    }
    active += 1;
    // 原周展开的结束 = 首项结束按该成员“自己的原开始”后移整数周（时刻与跨日长度不变）
    const origEnd = plusWeeks(imp.end, weekIndex(imp.start, o.start));
    const firstIds = [...imp.resourceIds].sort();
    const curIds = [...b.resourceIds].sort();
    const sameResources = curIds.length === firstIds.length && curIds.every((x: string, k: number) => x === firstIds[k]);
    const changed = b.start !== o.start || b.end !== origEnd || !sameResources;
    const ex = exByRid.get(rid);
    if (changed) {
      changedCount += 1;
      assert.ok(ex, `[${ctx}] 已变化成员 ${b.id}（原发生 ${o.start}）应输出例外`);
      assert.equal(ex!.dtstart, toIcal(b.start), `[${ctx}] 例外 DTSTART 取当前值`);
      assert.equal(ex!.dtend, toIcal(b.end), `[${ctx}] 例外 DTEND 取当前值`);
      expectDesc(ex!.description, b.resourceIds, `例外 ${b.id}`);
    } else {
      assert.ok(!ex, `[${ctx}] 无变化成员 ${b.id}（原发生 ${o.start}）不应输出例外`);
    }
  });
  assert.equal(cal.exceptions.length, changedCount, `[${ctx}] 例外数量应等于有变化的有效成员数`);
  for (const c of cancelled) assert.ok(expectedExdates.has(c));
  return {...cal, activeCount: active, excludedCount: expectedExdates.size, exceptionCount: changedCount};
}

function expectReport(
  r: CliResult,
  active: number,
  excluded: number,
  exceptions: number,
  ctx: string,
): void {
  const re = new RegExp(`有效成员 ${active} 项；排除 ${excluded} 项（[^）]*）；输出例外 ${exceptions} 个`);
  assert.match(r.stdout, re, `[${ctx}] 报告数量应为 有效${active}/排除${excluded}/例外${exceptions}\n${r.stdout}`);
}

// 与应用一致的锁文件路径：规范路径（解析相对/./.. 与符号链接）+ .lock
function canonicalPathOf(file: string): string {
  const abs = resolve(file);
  try {
    return realpathSync(abs);
  } catch {
    try {
      return join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

// 用一个真实存活的外部进程占位写入保护（与 write-lock 测试同样手法）
function holdLock(df: string, t: {after: (fn: () => void) => void}): {
  lockPath: string;
  release: () => Promise<void>;
} {
  const lockPath = `${canonicalPathOf(df)}.lock`;
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  writeFileSync(
    lockPath,
    JSON.stringify({pid: child.pid, host: hostname(), dataFile: canonicalPathOf(df), acquiredAt: new Date().toISOString()}) + '\n',
    {flag: 'wx'},
  );
  let released = false;
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    released = true;
    return new Promise((res) => {
      child.once('close', () => res());
      try {
        child.kill('SIGKILL');
      } catch {
        res();
      }
    });
  };
  t.after(() => {
    void release();
    rmSync(lockPath, {force: true});
  });
  return {lockPath, release};
}

// ---------------------------------------------------------------------------
// 1. 基本导出：独立解析并展开核对当前时间与资源；无变化成员不输出例外
// ---------------------------------------------------------------------------

test('基本导出：主事件 + 首次例外 + EXDATE，独立展开核对成员当前安排', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪', 'equipment');

  const f = writeIcal(
    dir,
    'a.ics',
    ical(
      weeklyEvent('weekly-a', '20261005T100000', '20261005T113000', 'EXDATE:20261012T100000\n'),
      excEvent('weekly-a', '20261019T100000', '20261020T140000', '20261020T150000'),
    ),
  );
  importOk(df, f, ['R0001', 'R0002'], '首次导入');
  const before = readFileSync(df);
  const out = join(dir, 'out.ics');
  const r = exportOk(df, 'weekly-a', out, '导出');
  expectReport(r, 2, 1, 1, '基本导出');

  const cal = verifyExportAgainstStore(df, out, 'weekly-a', '基本导出');
  assert.equal(cal.activeCount, 2);
  assert.equal(cal.excludedCount, 1);
  assert.equal(cal.exceptions.length, 1);
  assert.match(cal.prodid, /shiftbook/);
  assert.deepEqual(cal.master.exdates, ['20261012T100000']);
  assert.equal(cal.exceptions[0].recurrenceId, '20261019T100000');
  assert.equal(cal.exceptions[0].dtstart, '20261020T140000');

  // 只读：数据文件逐字节不变，不产生锁文件
  assert.ok(before.equals(readFileSync(df)), '导出前后数据文件逐字节不变');
  assert.ok(!existsSync(`${df}.lock`), '只读导出不应创建写入保护文件');
});

// ---------------------------------------------------------------------------
// 2. 首次导入例外后本地再次改期：例外按当前值输出，不复制首次例外快照；
//    改回原周展开时间后不再输出例外
// ---------------------------------------------------------------------------

test('首次例外再改期：RECURRENCE-ID 固定原开始，目标取当前值；改回原状无例外', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    ical(
      weeklyEvent('weekly-r', '20261005T100000', '20261005T110000'),
      excEvent('weekly-r', '20261012T100000', '20261013T090000', '20261013T100000'),
    ),
  );
  importOk(df, f, ['R0001'], '首次导入（occ2 首次例外至 10-13）');

  // 本地把该成员再次改期到 10-14 下午
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-14T15:00', '--end', '2026-10-14T16:30'], '本地再改期');
  let out = join(dir, 'out1.ics');
  let r = exportOk(df, 'weekly-r', out, '再改期后导出');
  expectReport(r, 3, 0, 1, '再改期后导出');
  let cal = verifyExportAgainstStore(df, out, 'weekly-r', '再改期后导出');
  assert.equal(cal.exceptions[0].recurrenceId, '20261012T100000', 'RECURRENCE-ID 固定为原开始');
  assert.equal(cal.exceptions[0].dtstart, '20261014T150000', '目标为当前值而非首次例外快照');
  assert.equal(cal.exceptions[0].dtend, '20261014T163000');

  // 改回原周展开的时间与资源：不再输出例外
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '改回原状');
  out = join(dir, 'out2.ics');
  r = exportOk(df, 'weekly-r', out, '恢复后导出');
  expectReport(r, 3, 0, 0, '恢复后导出');
  cal = verifyExportAgainstStore(df, out, 'weekly-r', '恢复后导出');
  assert.equal(cal.exceptions.length, 0, '无变化不输出例外（首次例外也不复制）');
});

// ---------------------------------------------------------------------------
// 3. 仅换资源：时间不变也输出例外，DESCRIPTION 为当前完整资源集合；
//    主事件 DESCRIPTION 始终是首次资源集合；换回后无例外
// ---------------------------------------------------------------------------

test('仅换资源：时间不变仍输出例外，DESCRIPTION 用当前完整资源集合', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪', 'equipment');
  addResource(df, '三号楼大厅', 'venue');

  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-res', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001', 'R0002'], '首次导入（两个资源）');

  // B0002 仅整体替换资源集合（时间保持原周展开）
  ok(df, ['reschedule-booking', 'B0002', '--resource', 'R0003'], '仅换资源');
  const out = join(dir, 'out.ics');
  const r = exportOk(df, 'weekly-res', out, '换资源后导出');
  expectReport(r, 3, 0, 1, '换资源后导出');
  const cal = verifyExportAgainstStore(df, out, 'weekly-res', '换资源后导出');
  assert.equal(cal.exceptions[0].recurrenceId, '20261012T100000');
  assert.equal(cal.exceptions[0].dtstart, '20261012T100000', '时间保持原周展开');
  assert.match(cal.exceptions[0].description, /R0003 三号楼大厅（场地）/);
  assert.doesNotMatch(cal.exceptions[0].description, /R0001|R0002/, '例外 DESCRIPTION 为当前完整资源集合');
  assert.match(cal.master.description, /R0001/);
  assert.match(cal.master.description, /R0002/);
  assert.doesNotMatch(cal.master.description, /R0003/, '主事件 DESCRIPTION 保留首次资源集合');

  // 换回首次资源集合：无例外
  ok(df, ['reschedule-booking', 'B0002', '--resource', 'R0002', '--resource', 'R0001'], '换回资源');
  const out2 = join(dir, 'out2.ics');
  exportOk(df, 'weekly-res', out2, '换回后导出');
  assert.equal(verifyExportAgainstStore(df, out2, 'weekly-res', '换回后导出').exceptions.length, 0);
});

// ---------------------------------------------------------------------------
// 4. 取消首项与全部取消：取消成员并入 EXDATE、不输出例外；全部取消仍合法
// ---------------------------------------------------------------------------

test('取消首项与全部取消：EXDATE 并集、取消成员无例外、全取消日历合法', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  // occ2 是首次例外成员；取消它与首项
  const f = writeIcal(
    dir,
    'a.ics',
    ical(
      weeklyEvent('weekly-cancel', '20261005T100000', '20261005T110000', 'EXDATE:20261019T100000\n'),
      excEvent('weekly-cancel', '20261012T100000', '20261013T090000', '20261013T100000'),
    ),
  );
  importOk(df, f, ['R0001'], '首次导入（occ2 例外，occ3 首次排除）');

  // 取消首项 B0001（首次例外成员 B0002 仍有效，其当前时间仍偏离原周展开，故仍输出例外）
  ok(df, ['cancel-booking', 'B0001'], '取消首项');
  let out = join(dir, 'one.ics');
  let r = exportOk(df, 'weekly-cancel', out, '取消首项后导出');
  expectReport(r, 1, 2, 1, '取消首项后导出');
  let cal = verifyExportAgainstStore(df, out, 'weekly-cancel', '取消首项后导出');
  assert.deepEqual(cal.master.exdates, ['20261005T100000', '20261019T100000']);
  assert.equal(cal.exceptions.length, 1, '首次例外成员仍有效，按当前安排输出例外');
  assert.equal(cal.exceptions[0].recurrenceId, '20261012T100000');

  ok(df, ['cancel-booking', 'B0002'], '取消剩余成员（含首次例外成员）');
  out = join(dir, 'all.ics');
  r = exportOk(df, 'weekly-cancel', out, '全部取消后导出');
  expectReport(r, 0, 3, 0, '全部取消后导出');
  cal = parseExport(readFileSync(out, 'utf8'), '全部取消后导出');
  assert.equal(cal.exceptions.length, 0);
  assert.deepEqual(cal.master.exdates, ['20261005T100000', '20261012T100000', '20261019T100000']);
  assert.equal(cal.master.rrule, 'FREQ=WEEKLY;COUNT=3');
  assert.equal(cal.master.dtstamp !== '', true);
});

// ---------------------------------------------------------------------------
// 5. 安全撤销后导出：批量改期产生的当前变化输出例外，撤销恢复后例外消失
// ---------------------------------------------------------------------------

test('安全撤销后导出：撤销恢复原安排后不再输出例外', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-undo', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001'], '首次导入');

  const manifest = join(dir, 'plan.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      items: [{bookingId: 'B0002', start: '2026-10-20T14:00', end: '2026-10-20T15:00', resourceIds: ['R0001']}],
    }) + '\n',
  );
  ok(df, ['reschedule-batch', manifest], '批量改期 O0001');
  let out = join(dir, 'changed.ics');
  let r = exportOk(df, 'weekly-undo', out, '改期后导出');
  expectReport(r, 3, 0, 1, '改期后导出');
  assert.match(r.stdout, /系列 S0001/);
  assert.equal(verifyExportAgainstStore(df, out, 'weekly-undo', '改期后导出').exceptions.length, 1);

  ok(df, ['undo-batch-op', 'O0001'], '安全撤销');
  out = join(dir, 'undone.ics');
  r = exportOk(df, 'weekly-undo', out, '撤销后导出');
  expectReport(r, 3, 0, 0, '撤销后导出');
  const cal = verifyExportAgainstStore(df, out, 'weekly-undo', '撤销后导出');
  assert.equal(cal.exceptions.length, 0, '撤销恢复原安排后无例外');
  const store = readStore(df);
  assert.equal(store.batchOps[0].status, 'undone', '撤销记录保留为已撤销');
});

// ---------------------------------------------------------------------------
// 6. 跨日：主事件与例外的跨日时刻、时长按当前值输出与核对
// ---------------------------------------------------------------------------

test('跨日：主事件跨日长度保持，例外跨日目标正确', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室', 'venue', OPEN_ALL_YEARS);

  const f = writeIcal(
    dir,
    'a.ics',
    ical(
      weeklyEvent('weekly-cross', '20261009T230000', '20261010T010000'),
      excEvent('weekly-cross', '20261016T230000', '20261018T233000', '20261019T010000'),
    ),
  );
  importOk(df, f, ['R0001'], '跨日系列导入（occ2 跨日例外 120 分钟）');
  const out = join(dir, 'cross.ics');
  exportOk(df, 'weekly-cross', out, '跨日导出');
  const cal = verifyExportAgainstStore(df, out, 'weekly-cross', '跨日导出');
  assert.equal(cal.master.dtstart, '20261009T230000');
  assert.equal(cal.master.dtend, '20261010T010000', '主事件首项跨日');
  assert.equal(cal.exceptions[0].recurrenceId, '20261016T230000');
  assert.equal(cal.exceptions[0].dtstart, '20261018T233000');
  assert.equal(cal.exceptions[0].dtend, '20261019T010000', '例外跨日到次日');
});

// ---------------------------------------------------------------------------
// 7. 中文折行：长中文资源名触发折行，物理行 ≤75 字节、不拆 Unicode、
//    续行前导空格计入；折行还原后 DESCRIPTION 完整
// ---------------------------------------------------------------------------

test('中文折行：长中文名按 UTF-8 字节折行，还原后文本完整且不拆字符', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  const longName = '第一会议室（总部大楼三层东侧最大的那间多功能报告厅）'; // 30 字符
  addResource(df, longName);
  addResource(df, '第二会议室（总部大楼三层西侧中型讨论间）');
  addResource(df, '投影设备一组（含激光投影仪与电动幕布）', 'equipment');

  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-fold', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001', 'R0002', 'R0003'], '导入三资源系列');
  const out = join(dir, 'fold.ics');
  exportOk(df, 'weekly-fold', out, '中文折行导出');

  const text = readFileSync(out, 'utf8');
  const physical = text.slice(0, -2).split('\r\n');
  const descLines = physical.filter((l) => l.startsWith('DESCRIPTION') || l.startsWith(' '));
  assert.ok(descLines.length >= 3, '长中文 DESCRIPTION 应被折成多个物理行');
  for (const l of descLines) {
    assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `物理行超 75 字节: ${l}`);
  }
  // 至少存在一条真正续行（以空格开头），且首段 + 续行还原后包含完整中文串
  assert.ok(physical.some((l) => l.startsWith(' ')), '应存在折行续行');
  const cal = verifyExportAgainstStore(df, out, 'weekly-fold', '中文折行导出');
  assert.match(cal.master.description, new RegExp(longName), '折行还原后中文名完整（未拆 Unicode 字符）');
  assert.equal(cal.master.description.split('\n').length, 3);
});

// ---------------------------------------------------------------------------
// 8. 持锁期间导出：只读不等待写入保护，立即成功，锁与业务文件不变
// ---------------------------------------------------------------------------

test('持锁期间导出：不等待保护、立即成功，保护文件与业务数据不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-lock', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001'], '首次导入');
  const before = readFileSync(df);

  const {lockPath} = holdLock(df, t);
  const out = join(dir, 'during-lock.ics');
  const start = Date.now();
  const r = runCli(df, ['export-ical', 'weekly-lock', '--output', out]);
  const elapsed = Date.now() - start;
  assert.equal(r.status, 0, `持锁期间导出应成功（只读不等待）\nstderr:\n${r.stderr}`);
  assert.ok(elapsed < 3000, `持锁期间导出不应等待保护（耗时 ${elapsed}ms）`);
  assert.ok(existsSync(lockPath), '导出不得删除他人的写入保护');
  assert.equal(JSON.parse(readFileSync(lockPath, 'utf8')).host, hostname(), '锁文件内容未被改动');
  assert.ok(before.equals(readFileSync(df)), '持锁导出后业务文件逐字节不变');
  verifyExportAgainstStore(df, out, 'weekly-lock', '持锁期间导出');
});

// ---------------------------------------------------------------------------
// 9. 真实输出失败：目录不存在、文件名超长；原输出保留、无半成品、业务文件不变
// ---------------------------------------------------------------------------

test('真实输出失败：不存在的目录与超长文件名均退出 1，原输出保留且不留半成品', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-fail', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001'], '首次导入');
  const before = readFileSync(df);

  // 不存在的目录：临时文件创建即 ENOENT
  const missing = join(dir, 'no-such-dir', 'out.ics');
  const r1 = bizFail(df, ['export-ical', 'weekly-fail', '--output', missing], '目录不存在');
  assert.match(r1.stderr, /写入导出文件/);
  assert.ok(!existsSync(missing), '不应创建输出文件');
  assert.ok(before.equals(readFileSync(df)), '业务文件不变');

  // 超长文件名（254 字节，临时名超出 255）：预先放入标记内容，失败后原样保留
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, 'KEEP-ME\n', 'utf8');
  const r2 = bizFail(df, ['export-ical', 'weekly-fail', '--output', longFile], '文件名超长');
  assert.match(r2.stderr, /写入导出文件/);
  assert.equal(readFileSync(longFile, 'utf8'), 'KEEP-ME\n', '原输出文件逐字节保留');
  const leftovers = readdirSync(dir).filter((n) => n.includes('export-tmp'));
  assert.deepEqual(leftovers, [], '失败不留半成品临时文件');
  assert.ok(before.equals(readFileSync(df)), '业务文件不变');

  // 同一数据随后在正常路径导出成功（失败不影响后续只读/写出）
  const out = join(dir, 'ok.ics');
  exportOk(df, 'weekly-fail', out, '失败后正常导出');
  verifyExportAgainstStore(df, out, 'weekly-fail', '失败后正常导出');
});

// ---------------------------------------------------------------------------
// 10. 非法请求：未知 UID、独立事件 UID、输出路径与数据/保护/恢复文件等价 -> 退出 1
// ---------------------------------------------------------------------------

test('未知 UID、独立事件、等价输出路径均拒绝', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  const f = writeIcal(
    dir,
    'a.ics',
    ical(
      weeklyEvent('weekly-id', '20261005T100000', '20261005T110000'),
      event('solo-id', '20261006T100000', '20261006T110000'),
    ),
  );
  importOk(df, f, ['R0001'], '导入一个系列与一个独立事件');

  // 未知 UID
  const r1 = bizFail(df, ['export-ical', 'no-such-uid', '--output', join(dir, 'x.ics')], '未知 UID');
  assert.match(r1.stderr, /未找到 UID/);
  assert.ok(!existsSync(join(dir, 'x.ics')), '被拒绝时不应产生输出文件');

  // 大小写不同的 UID 也视为未知（解码后 UID 区分大小写）
  bizFail(df, ['export-ical', 'WEEKLY-ID', '--output', join(dir, 'x.ics')], 'UID 大小写不同');

  // 独立事件
  const r2 = bizFail(df, ['export-ical', 'solo-id', '--output', join(dir, 's.ics')], '独立事件');
  assert.match(r2.stderr, /独立事件/);
  assert.ok(!existsSync(join(dir, 's.ics')));

  // 输出与数据文件等价：直接、含 ./、父目录回绕三种写法
  for (const p of [df, join(dir, '.', 'data.json'), join(dir, 'sub', '..', 'data.json')]) {
    const r = bizFail(df, ['export-ical', 'weekly-id', '--output', p], `等价数据路径 ${p}`);
    assert.match(r.stderr, /等价/);
  }
  // 输出与写入保护 / 恢复协调文件等价
  bizFail(df, ['export-ical', 'weekly-id', '--output', `${df}.lock`], '等价锁路径');
  bizFail(df, ['export-ical', 'weekly-id', '--output', `${df}.lock.recover`], '等价恢复协调路径');

  // 符号链接指向数据文件也视为等价
  mkdirSync(join(dir, 'sub'));
  const link = join(dir, 'sub', 'link.ics');
  symlinkSync(df, link);
  bizFail(df, ['export-ical', 'weekly-id', '--output', link], '符号链接等价数据文件');

  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.ics') && !['a.ics'].includes(n)).length, 0,
    '全部拒绝均未产出日历文件',
  );
});

// ---------------------------------------------------------------------------
// 11. 用法错误 -> 退出 2；损坏数据 -> 退出 1；旧记录无 exceptions 字段仍可导出
// ---------------------------------------------------------------------------

test('用法错误退出 2；损坏数据退出 1；旧记录无例外字段可导出', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-old', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001'], '首次导入');
  const out = join(dir, 'out.ics');

  usageFail(df, ['export-ical'], '缺 UID 与输出');
  usageFail(df, ['export-ical', 'weekly-old'], '缺 --output');
  usageFail(df, ['export-ical', 'weekly-old', '--output', out, 'extra'], '多余位置参数');
  usageFail(df, ['export-ical', 'weekly-old', '--out', out], '未知选项');
  usageFail(df, ['export-ical', 'weekly-old', '--output'], '--output 缺值');
  assert.ok(!existsSync(out), '用法错误不产生输出');

  // 旧记录无 exceptions 字段：仍可导出（按空例外集合处理）
  const good = readFileSync(df);
  const store = JSON.parse(good.toString('utf8'));
  delete store.imports[0].exceptions;
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n');
  const r = exportOk(df, 'weekly-old', out, '旧记录导出');
  expectReport(r, 3, 0, 0, '旧记录导出');
  verifyExportAgainstStore(df, out, 'weekly-old', '旧记录导出');

  // 损坏数据退出 1 且不产出文件
  writeFileSync(df, good);
  rmSync(out, {force: true});
  writeFileSync(df, '{这不是合法 JSON');
  const bad = bizFail(df, ['export-ical', 'weekly-old', '--output', out], '损坏数据');
  assert.match(bad.stderr, /损坏/);
  assert.ok(!existsSync(out), '损坏数据不产出文件');
});

// ---------------------------------------------------------------------------
// 12. 已解码 UID 选择：转义 UID 按解码值选择；重复原子覆盖导出
// ---------------------------------------------------------------------------

test('转义 UID 按解码值选择；安排变化后再次导出原子覆盖', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  // UID 含转义逗号与分号：导入文件中写 a\,b\;c，解码后为 a,b;c
  const f = writeIcal(
    dir,
    'a.ics',
    'BEGIN:VCALENDAR\nVERSION:2.0\n' +
      'BEGIN:VEVENT\nUID:a\\,b\\;c\nDTSTART:20261005T100000\nDTEND:20261005T110000\n' +
      'RRULE:FREQ=WEEKLY;COUNT=2\nEND:VEVENT\nEND:VCALENDAR\n',
  );
  importOk(df, f, ['R0001'], '转义 UID 导入');

  const out = join(dir, 'escaped.ics');
  exportOk(df, 'a,b;c', out, '解码 UID 导出');
  const cal = verifyExportAgainstStore(df, out, 'a,b;c', '解码 UID 导出');
  assert.equal(cal.master.uid, 'a,b;c', '输出 UID 按 iCalendar TEXT 转义逗号分号');
  const raw = readFileSync(out, 'utf8');
  assert.match(raw, /UID:a\\,b\\;c/, '输出 UID 已转义');

  // 改期后再次导出到同一文件：内容原子覆盖，无临时文件残留
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-13T08:00', '--end', '2026-10-13T09:00'], '本地改期');
  const r2 = exportOk(df, 'a,b;c', out, '再次导出覆盖');
  expectReport(r2, 2, 0, 1, '再次导出覆盖');
  verifyExportAgainstStore(df, out, 'a,b;c', '再次导出覆盖');
  assert.deepEqual(
    readdirSync(dir).filter((n) => n.includes('export-tmp')),
    [],
    '原子替换后不留临时文件',
  );
});

// ---------------------------------------------------------------------------
// 13. 文本转义：反斜杠、逗号、分号与换行在 DESCRIPTION/UID 中正确转义
// ---------------------------------------------------------------------------

test('文本转义：资源名中的反斜杠、逗号、分号与换行被正确编码并可还原', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  // 资源名含 , ; \ 以及换行（命令行可直接传这些字符）
  addResource(df, 'A,B;C\\D');
  const f = writeIcal(dir, 'a.ics', ical(weeklyEvent('weekly-esc', '20261005T100000', '20261005T110000')));
  importOk(df, f, ['R0001'], '导入');
  const out = join(dir, 'esc.ics');
  exportOk(df, 'weekly-esc', out, '导出');

  const raw = readFileSync(out, 'utf8');
  assert.match(raw, /R0001 A\\,B\\;C\\\\D（场地）/, '逗号、分号与反斜杠均已转义');
  const cal = parseExport(raw, '转义还原');
  assert.match(cal.master.description, /R0001 A,B;C\\D（场地）/, '折行/转义还原后名称原样');
});
