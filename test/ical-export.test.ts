// shiftbook 已导入按周系列的本地 iCalendar 导出（export-ical）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录；测试内置一个“独立展开器”解析导出的 VCALENDAR，
//   自行按 RRULE/EXDATE/RECURRENCE-ID 展开并与数据文件中成员的当前时间和资源核对
//   （不调用产品代码的解析、展开或区间逻辑）；
// - 覆盖：首次导入例外再本地改期、仅换资源、取消首项与全部取消、安全撤销后导出、
//   跨日、中文折行与文本转义、持锁期间导出、真实输出失败，以及未知/独立 UID、
//   等价输出路径、用法错误、损坏数据与旧记录（无 exceptions 字段）等负例；
// - 任一断言失败即非零退出并标明场景，结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync, spawn, type ChildProcess} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['0001-01-01T00:00', '9999-12-31T23:59']];
// 254 字节输出文件名：写入临时文件（<名>.<pid>.tmp）必然超出 255 字节上限，
// 从而在不调整任何权限的前提下，可重复地触发真实输出失败。
const LONG_OUT_NAME = 'g'.repeat(250) + '.ics';

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
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function ev(uid: string, start: string, end: string, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\n${extra}END:VEVENT\n`;
}

function weeklyEvent(uid: string, start: string, end: string, count: number, extra = ''): string {
  return `BEGIN:VEVENT\nUID:${uid}\nDTSTART:${start}\nDTEND:${end}\nRRULE:FREQ=WEEKLY;COUNT=${count}\n${extra}END:VEVENT\n`;
}

function excEvent(uid: string, rid: string, start: string, end: string): string {
  return `BEGIN:VEVENT\nUID:${uid}\nRECURRENCE-ID:${rid}\nDTSTART:${start}\nDTEND:${end}\nEND:VEVENT\n`;
}

function ical(...events: string[]): string {
  return `BEGIN:VCALENDAR\nVERSION:2.0\n${events.join('')}END:VCALENDAR\n`;
}

function writeAux(dir: string, name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function importIcal(df: string, f: string, resources: string[], ctx: string): CliResult {
  const args = ['import-ical', f];
  for (const r of resources) args.push('--resource', r);
  return ok(df, args, ctx);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

// ---------------------------------------------------------------------------
// 独立的导出日历解析/展开器（测试内自有实现，不依赖产品代码）
// ---------------------------------------------------------------------------

// iCalendar TEXT 转义解码（与产品实现相互独立）
function unescapeText(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === '\\') {
      const n = v[++i];
      if (n === 'n' || n === 'N') out += '\n';
      else if (n === undefined) out += '\\';
      else out += n;
    } else {
      out += ch;
    }
  }
  return out;
}

interface ContentLine {
  name: string;
  value: string;
}

interface RawVevent {
  lines: ContentLine[];
}

interface ParsedVevent {
  uid: string;
  startMs: number;
  endMs: number;
  recurrenceIdMs?: number;
  dtstamp: string;
  resources: string[]; // DESCRIPTION 中按行列出的资源标识
}

interface ParsedExport {
  prodid: string;
  master: ParsedVevent;
  count: number;
  exdateMs: number[];
  exceptions: ParsedVevent[];
}

const DAY_MS = 86400000;

function floatingToMs(s: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(s);
  assert.ok(m, `浮动时间格式非法: ${s}`);
  assert.equal(m![6], '00', `秒必须为 00: ${s}`);
  return Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3]), Number(m![4]), Number(m![5]), 0);
}

// 内部营业地时间 YYYY-MM-DDTHH:mm -> ms
function businessToMs(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  assert.ok(m, `营业地时间格式非法: ${s}`);
  return Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3]), Number(m![4]), Number(m![5]), 0);
}

function msToBusiness(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function getLine(ev: RawVevent, name: string): ContentLine | undefined {
  return ev.lines.find((l) => l.name === name);
}

function parseExport(content: string): ParsedExport {
  // 1) 行尾必须全部为 CRLF（split 后最后一项为空串；其余物理行不含裸 CR/LF）
  assert.match(content, /\r\n$/, '文件须以 CRLF 结束');
  const physical = content.split('\r\n');
  assert.equal(physical[physical.length - 1], '', '末尾 CRLF 后无多余内容');
  physical.slice(0, -1).forEach((l) => {
    assert.doesNotMatch(l, /\r|\n/, '不得混用 LF 或裸 CR');
    const bytes = Buffer.byteLength(l, 'utf8');
    assert.ok(bytes <= 75, `物理行超过 75 个 UTF-8 字节（${bytes}）: ${JSON.stringify(l)}`);
  });

  // 2) 折行（续行以空格或制表符开头，前导空格计入 75 字节）
  const logical: string[] = [];
  for (const l of physical.slice(0, -1)) {
    if (l.startsWith(' ') || l.startsWith('\t')) {
      assert.ok(logical.length > 0, '折行续行缺少被延续行');
      logical[logical.length - 1] += l.slice(1);
    } else {
      logical.push(l);
    }
  }

  const lines: ContentLine[] = logical.map((l) => {
    const colon = l.indexOf(':');
    assert.ok(colon >= 0, `内容行缺少冒号: ${JSON.stringify(l)}`);
    return {name: l.slice(0, colon).split(';')[0], value: l.slice(colon + 1)};
  });

  assert.equal(lines[0].name, 'BEGIN');
  assert.equal(lines[0].value, 'VCALENDAR');
  const version = lines.find((l) => l.name === 'VERSION');
  assert.ok(version && version.value === '2.0', '须有 VERSION:2.0');
  const prodid = lines.find((l) => l.name === 'PRODID');
  assert.ok(prodid && prodid.value.length > 0, '须有非空 PRODID');

  // 3) 切出全部 VEVENT（主事件必须物理排在最前；例外不得带 RRULE/EXDATE）
  const raws: RawVevent[] = [];
  let cur: RawVevent | null = null;
  for (const l of lines) {
    if (l.name === 'BEGIN' && l.value === 'VEVENT') {
      assert.equal(cur, null, 'VEVENT 不得嵌套');
      cur = {lines: []};
    } else if (l.name === 'END' && l.value === 'VEVENT') {
      assert.ok(cur, 'END:VEVENT 无匹配 BEGIN');
      raws.push(cur!);
      cur = null;
    } else if (cur) {
      cur.lines.push(l);
    }
  }
  assert.equal(cur, null, 'VEVENT 未闭合');
  assert.ok(raws.length >= 1, '至少有一个 VEVENT');

  const decode = (ev: RawVevent): ParsedVevent => {
    const uidLine = getLine(ev, 'UID');
    const startLine = getLine(ev, 'DTSTART');
    const endLine = getLine(ev, 'DTEND');
    const stampLine = getLine(ev, 'DTSTAMP');
    const ridLine = getLine(ev, 'RECURRENCE-ID');
    const descLine = getLine(ev, 'DESCRIPTION');
    assert.ok(uidLine && startLine && endLine, 'VEVENT 须有 UID/DTSTART/DTEND');
    assert.ok(stampLine && /^\d{8}T\d{6}Z$/.test(stampLine.value), `DTSTAMP 须为合法 UTC: ${stampLine?.value}`);
    const sm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stampLine!.value)!;
    const stampMs = Date.UTC(
      Number(sm[1]), Number(sm[2]) - 1, Number(sm[3]), Number(sm[4]), Number(sm[5]), Number(sm[6]),
    );
    assert.ok(!Number.isNaN(stampMs), `DTSTAMP 不是真实 UTC 时间: ${stampLine!.value}`);
    assert.ok(descLine, 'VEVENT 须有 DESCRIPTION');
    const descLines = unescapeText(descLine!.value).split('\n');
    assert.match(descLines[0], /shiftbook/, 'DESCRIPTION 首行应为导出标识');
    const resources = descLines.slice(1).map((x) => {
      const m = /^(R\d+)\s+.*（(?:场地|设备|人员)）$/.exec(x);
      assert.ok(m, `DESCRIPTION 资源行格式非法: ${JSON.stringify(x)}`);
      return m![1];
    });
    assert.deepEqual(resources, [...resources].sort(), `DESCRIPTION 资源未按标识排序: ${resources.join(',')}`);
    const out: ParsedVevent = {
      uid: unescapeText(uidLine!.value),
      startMs: floatingToMs(startLine!.value),
      endMs: floatingToMs(endLine!.value),
      dtstamp: stampLine!.value,
      resources,
    };
    assert.ok(out.endMs > out.startMs, 'DTEND 必须晚于 DTSTART');
    if (ridLine) out.recurrenceIdMs = floatingToMs(ridLine.value);
    return out;
  };

  const events = raws.map(decode);
  const master = events[0];
  assert.equal(master.recurrenceIdMs, undefined, '主事件须排在最前且不带 RECURRENCE-ID');
  for (const e of events) assert.equal(e.uid, master.uid, '全部 VEVENT 须同 UID');

  const mRrule = getLine(raws[0], 'RRULE');
  const cm = /^FREQ=WEEKLY;COUNT=(\d+)$/.exec(mRrule?.value ?? '');
  assert.ok(cm, `主事件 RRULE 非法: ${mRrule?.value}`);
  const count = Number(cm![1]);
  const exdateMs: number[] = [];
  for (const l of raws[0].lines.filter((x) => x.name === 'EXDATE')) {
    for (const part of l.value.split(',')) exdateMs.push(floatingToMs(part));
  }
  assert.deepEqual(exdateMs, [...exdateMs].sort((a, b) => a - b), 'EXDATE 值须按原发生升序');
  assert.equal(new Set(exdateMs).size, exdateMs.length, 'EXDATE 须去重');

  for (let i = 1; i < raws.length; i++) {
    assert.ok(getLine(raws[i], 'RECURRENCE-ID'), '非首个 VEVENT 必须是带 RECURRENCE-ID 的例外');
    assert.equal(getLine(raws[i], 'RRULE'), undefined, '例外不得带 RRULE');
    assert.equal(getLine(raws[i], 'EXDATE'), undefined, '例外不得带 EXDATE');
  }
  const exceptions = events.slice(1);
  const rids = exceptions.map((e) => e.recurrenceIdMs!);
  assert.deepEqual(rids, [...rids].sort((a, b) => a - b), '例外须按 RECURRENCE-ID（原发生）升序');
  assert.equal(new Set(rids).size, rids.length, '例外 RECURRENCE-ID 不得重复');

  return {prodid: prodid!.value, master, count, exdateMs, exceptions};
}

// 独立展开：按 RRULE 逐周算术后移，套 EXDATE 与例外，返回“原开始 ms -> 当前安排”
// 与“被排除原开始集合”（测试内自己的算术，不碰产品代码）
function expandExport(p: ParsedExport): {
  members: Map<number, {startMs: number; endMs: number; resources: string[]}>;
  excluded: Set<number>;
} {
  const byRid = new Map(p.exceptions.map((e) => [e.recurrenceIdMs!, e]));
  const members = new Map<number, {startMs: number; endMs: number; resources: string[]}>();
  const excluded = new Set<number>(p.exdateMs);
  for (let i = 0; i < p.count; i++) {
    const origStart = p.master.startMs + i * 7 * DAY_MS;
    if (excluded.has(origStart)) continue;
    const ex = byRid.get(origStart);
    if (ex) {
      members.set(origStart, {startMs: ex.startMs, endMs: ex.endMs, resources: ex.resources});
    } else {
      members.set(origStart, {
        startMs: origStart,
        endMs: p.master.endMs + i * 7 * DAY_MS,
        resources: p.master.resources,
      });
    }
  }
  return {members, excluded};
}

// 以数据文件中成员的当前时间/资源/状态核对独立展开结果
function crossCheck(df: string, uid: string, p: ParsedExport): {active: number; excluded: number; exceptions: number} {
  const store = readStore(df);
  const imp = store.imports.find((x: any) => x.uid === uid);
  assert.ok(imp, '数据文件中应存在该 UID 导入记录');
  assert.ok(imp.seriesId !== undefined, '应为按周系列导入记录');

  const {members, excluded} = expandExport(p);

  // 1) 首次排除集合 ∪ 已取消成员原开始 == 导出的 EXDATE 集合
  const expectedExcluded = new Set<number>((imp.exdates ?? []).map((t: string) => businessToMs(t)));
  const bookingById = new Map(store.bookings.map((b: any) => [b.id, b]));
  for (const occ of imp.occurrences) {
    const b = bookingById.get(occ.bookingId);
    assert.ok(b, `成员 ${occ.bookingId} 应存在`);
    assert.equal(b.seriesId, imp.seriesId, `成员 ${occ.bookingId} 须仍属原系列`);
    if (b.status === 'cancelled') expectedExcluded.add(businessToMs(occ.start));
  }
  assert.deepEqual(
    [...excluded].sort((a, b) => a - b),
    [...expectedExcluded].sort((a, b) => a - b),
    'EXDATE 须为首次排除集合与已取消成员原开始的去重并集',
  );

  // 2) 每个未排除原发生：成员有效，当前时间与资源恰等于展开结果；
  //    相对原周展开无变化的成员不得输出例外，有变化的必须输出
  let active = 0;
  const changedRids = new Set<number>();
  for (const occ of imp.occurrences) {
    const origMs = businessToMs(occ.start);
    const b = bookingById.get(occ.bookingId);
    if (b.status === 'cancelled') {
      assert.ok(!members.has(origMs), `已取消成员 ${occ.bookingId} 不应出现在展开中`);
      continue;
    }
    active += 1;
    const want = members.get(origMs);
    assert.ok(want, `有效成员 ${occ.bookingId} 的原发生应在展开中: ${occ.start}`);
    assert.equal(msToBusiness(want.startMs), b.start, `成员 ${occ.bookingId} 当前开始不一致`);
    assert.equal(msToBusiness(want.endMs), b.end, `成员 ${occ.bookingId} 当前结束不一致`);
    assert.deepEqual(want.resources, b.resourceIds, `成员 ${occ.bookingId} 当前资源集合不一致`);
    const i = Math.round((origMs - p.master.startMs) / (7 * DAY_MS));
    const baseStart = p.master.startMs + i * 7 * DAY_MS;
    const baseEnd = p.master.endMs + i * 7 * DAY_MS;
    const sameTime = want.startMs === baseStart && want.endMs === baseEnd;
    const sameRes =
      want.resources.length === p.master.resources.length &&
      want.resources.every((x, k) => x === p.master.resources[k]);
    const hasException = p.exceptions.some((e) => e.recurrenceIdMs === origMs);
    if (sameTime && sameRes) {
      assert.ok(!hasException, `成员 ${occ.bookingId} 相对原周展开无变化，不应输出例外`);
    } else {
      assert.ok(hasException, `成员 ${occ.bookingId} 相对原周展开有变化，必须输出例外`);
      changedRids.add(origMs);
    }
  }
  // 3) 每个例外都对应一个有变化的有效成员（取消成员不得输出例外，不得有多余例外）
  for (const e of p.exceptions) {
    assert.ok(changedRids.has(e.recurrenceIdMs), '存在多余或针对已取消成员的例外');
  }
  // 4) 主事件 DESCRIPTION 用首次资源集合（均按标识排序）
  assert.deepEqual(p.master.resources, imp.resourceIds, '主事件 DESCRIPTION 须用首次资源集合');

  return {active, excluded: excluded.size, exceptions: p.exceptions.length};
}

function assertReport(r: CliResult, c: {active: number; excluded: number; exceptions: number}, ctx: string): void {
  assert.match(
    r.stdout,
    new RegExp(`有效成员: ${c.active}；排除: ${c.excluded}；例外: ${c.exceptions}`),
    `[${ctx}] 报告数量不正确: ${r.stdout}`,
  );
}

// 用一个真实存活的进程持有写入保护（仅写锁文件，不运行业务命令）
function holdLock(df: string, t: {after: (fn: () => void) => void}): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  const lockPath = `${resolve(df)}.lock`;
  writeFileSync(
    lockPath,
    JSON.stringify({pid: child.pid, host: hostname(), dataFile: resolve(df), acquiredAt: new Date().toISOString()}) + '\n',
    'utf8',
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出
    }
    rmSync(lockPath, {force: true});
  });
  return child;
}

// ---------------------------------------------------------------------------
// 1. 首次导入例外再本地改期：例外必须按当前值比较，不照抄首次例外快照
// ---------------------------------------------------------------------------

test('首次导入例外再改期：导出按当前安排生成例外，取消成员并入 EXDATE', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪', 'equipment');

  const f = writeAux(
    dir,
    'a.ics',
    ical(
      weeklyEvent('exp-rechange@x', '20261005T100000', '20261005T110000', 4),
      excEvent('exp-rechange@x', '20261012T100000', '20261013T140000', '20261013T150000'),
    ),
  );
  importIcal(df, f, ['R0001', 'R0002'], '首次导入（第 2 次发生随例外改到 10-13）');

  // 导入后立即导出：当前安排保留首次例外，与原周展开不同 -> 例外仍应出现
  // （这是按原周展开重新比较的结果，而非照抄首次例外快照）
  const out = join(dir, 'out.ics');
  let r = ok(df, ['export-ical', 'exp-rechange@x', '--output', out], '首次导出');
  let p = parseExport(readFileSync(out, 'utf8'));
  assert.equal(p.count, 4);
  assert.deepEqual(p.exceptions.map((e) => e.recurrenceIdMs), [floatingToMs('20261012T100000')]);
  let c = crossCheck(df, 'exp-rechange@x', p);
  assert.deepEqual(c, {active: 4, excluded: 0, exceptions: 1});
  assertReport(r, c, '首次导出');

  // 本地再改期该成员（同时改时间与时长），并取消另一名成员
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-14T08:00', '--end', '2026-10-14T09:30'], '本地再改期 B0002');
  ok(df, ['cancel-booking', 'B0003'], '取消 B0003（原发生 10-19）');

  r = ok(df, ['export-ical', 'exp-rechange@x', '--output', out], '本地变更后再次导出');
  p = parseExport(readFileSync(out, 'utf8'));
  const ex = p.exceptions[0];
  assert.equal(ex.recurrenceIdMs, floatingToMs('20261012T100000'), 'RECURRENCE-ID 固定为原开始');
  assert.equal(ex.startMs, floatingToMs('20261014T080000'), 'DTSTART 取当前值');
  assert.equal(ex.endMs, floatingToMs('20261014T093000'), 'DTEND 取当前值');
  assert.deepEqual(p.exdateMs, [floatingToMs('20261019T100000')], '已取消成员原开始并入 EXDATE');
  c = crossCheck(df, 'exp-rechange@x', p);
  assert.deepEqual(c, {active: 3, excluded: 1, exceptions: 1});
  assertReport(r, c, '再改期后导出');
});

// 首次导入例外后来被本地改回原周展开时刻：例外必须消失（证明不是复制首次快照）
test('首次导入例外改回原时段：例外消失而非照抄首次例外快照', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪', 'equipment');

  const f = writeAux(
    dir,
    'a.ics',
    ical(
      weeklyEvent('exp-revert@x', '20261005T100000', '20261005T110000', 3),
      excEvent('exp-revert@x', '20261012T100000', '20261013T140000', '20261013T150000'),
    ),
  );
  importIcal(df, f, ['R0001', 'R0002'], '首次导入带 10-12 的例外');

  // 把例外成员改回原周展开的原时段与首次资源：相对原周展开已无变化
  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '时间改回原时段');
  const out = join(dir, 'out.ics');
  const r = ok(df, ['export-ical', 'exp-revert@x', '--output', out], '导出');
  const p = parseExport(readFileSync(out, 'utf8'));
  assert.deepEqual(p.exceptions, [], '已回到原周展开，不得因首次快照存在而复制例外');
  const c = crossCheck(df, 'exp-revert@x', p);
  assert.deepEqual(c, {active: 3, excluded: 0, exceptions: 0});
  assertReport(r, c, '改回原时段');
});

// ---------------------------------------------------------------------------
// 2. 仅换资源：时间不变也须输出例外，DESCRIPTION 用当前完整资源集合
// ---------------------------------------------------------------------------

test('仅换资源：时间不变也输出资源例外，主事件保留首次资源集合', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  addResource(df, '投影仪', 'equipment');

  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-res@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001', 'R0002'], '首次导入两个资源');

  ok(df, ['reschedule-booking', 'B0001', '--resource', 'R0002'], '首项仅换为 R0002');
  const out = join(dir, 'out.ics');
  const r = ok(df, ['export-ical', 'exp-res@x', '--output', out], '导出');
  const p = parseExport(readFileSync(out, 'utf8'));

  assert.equal(p.master.startMs, floatingToMs('20261005T100000'));
  assert.deepEqual(p.master.resources, ['R0001', 'R0002'], '主事件 DESCRIPTION 用首次资源集合');
  assert.equal(p.exceptions.length, 1);
  const ex = p.exceptions[0];
  assert.equal(ex.recurrenceIdMs, floatingToMs('20261005T100000'));
  assert.equal(ex.startMs, floatingToMs('20261005T100000'), '时间不变');
  assert.equal(ex.endMs, floatingToMs('20261005T110000'));
  assert.deepEqual(ex.resources, ['R0002'], '例外 DESCRIPTION 用当前完整资源集合');
  const c = crossCheck(df, 'exp-res@x', p);
  assert.deepEqual(c, {active: 2, excluded: 0, exceptions: 1});
  assertReport(r, c, '仅换资源');
});

// ---------------------------------------------------------------------------
// 3. 取消首项与全部取消：取消成员不输出例外；全部取消仍为合法无有效发生日历
// ---------------------------------------------------------------------------

test('取消首项与全部取消：EXDATE 并集正确，全部取消仍输出合法日历', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  // COUNT=3，自带排除 10-12 与例外（10-19 改到 10-20）；成员 B0001=10-05、
  // B0002=10-19（例外目标）
  const f = writeAux(
    dir,
    'a.ics',
    ical(
      weeklyEvent(
        'exp-cancel@x',
        '20261005T100000',
        '20261005T110000',
        3,
        'EXDATE:20261012T100000\n',
      ),
      excEvent('exp-cancel@x', '20261019T100000', '20261020T090000', '20261020T100000'),
    ),
  );
  importIcal(df, f, ['R0001'], '首次导入 COUNT=3，排除 10-12，例外 10-19');

  // 取消首项
  ok(df, ['cancel-booking', 'B0001'], '取消首项');
  const out1 = join(dir, 'out-1.ics');
  let r = ok(df, ['export-ical', 'exp-cancel@x', '--output', out1], '取消首项后导出');
  let p = parseExport(readFileSync(out1, 'utf8'));
  assert.deepEqual(
    p.exdateMs,
    [floatingToMs('20261005T100000'), floatingToMs('20261012T100000')],
    '首次排除与取消首项去重并集，按时间升序',
  );
  assert.ok(!p.exceptions.some((e) => e.recurrenceIdMs === floatingToMs('20261005T100000')), '取消首项不输出例外');
  assert.equal(p.exceptions.length, 1, '10-19 的成员仍有效且有变化，例外保留');
  let c = crossCheck(df, 'exp-cancel@x', p);
  assert.deepEqual(c, {active: 1, excluded: 2, exceptions: 1});
  assertReport(r, c, '取消首项');

  // 全部取消（整体取消系列）
  ok(df, ['cancel-series', 'S0001'], '整体取消系列');
  const out2 = join(dir, 'out-2.ics');
  r = ok(df, ['export-ical', 'exp-cancel@x', '--output', out2], '全部取消后导出');
  p = parseExport(readFileSync(out2, 'utf8'));
  assert.equal(p.exceptions.length, 0, '全部取消时只有主事件，无例外');
  assert.deepEqual(
    p.exdateMs,
    ['20261005T100000', '20261012T100000', '20261019T100000'].map(floatingToMs),
    '全部原发生均在 EXDATE',
  );
  c = crossCheck(df, 'exp-cancel@x', p);
  assert.deepEqual(c, {active: 0, excluded: 3, exceptions: 0});
  assertReport(r, c, '全部取消');
  assert.match(r.stdout, /无有效发生/);
});

// ---------------------------------------------------------------------------
// 4. 安全撤销后导出：批量改期撤销后成员恢复原周展开，例外消失
// ---------------------------------------------------------------------------

test('安全撤销后导出：恢复原安排后无例外', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-undo@x', '20261005T100000', '20261005T110000', 3)));
  importIcal(df, f, ['R0001'], '首次导入');

  const manifest = join(dir, 'm.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      items: [{bookingId: 'B0002', start: '2026-10-21T16:00', end: '2026-10-21T17:00', resourceIds: ['R0001']}],
    }),
  );
  const changed = ok(df, ['reschedule-batch', manifest], '批量改期 B0002');
  assert.match(changed.stdout, /O0001/);
  const out1 = join(dir, 'out-1.ics');
  ok(df, ['export-ical', 'exp-undo@x', '--output', out1], '改期后导出');
  let p = parseExport(readFileSync(out1, 'utf8'));
  assert.deepEqual(crossCheck(df, 'exp-undo@x', p), {active: 3, excluded: 0, exceptions: 1});

  ok(df, ['undo-batch-op', 'O0001'], '安全撤销');
  const out2 = join(dir, 'out-2.ics');
  const r = ok(df, ['export-ical', 'exp-undo@x', '--output', out2], '撤销后导出');
  p = parseExport(readFileSync(out2, 'utf8'));
  assert.deepEqual(p.exceptions, [], '撤销后回到原周展开，无例外');
  const c = crossCheck(df, 'exp-undo@x', p);
  assert.deepEqual(c, {active: 3, excluded: 0, exceptions: 0});
  assertReport(r, c, '撤销后导出');
});

// ---------------------------------------------------------------------------
// 5. 跨日：首项与当前例外时间均跨午夜，浮动时间原样保留
// ---------------------------------------------------------------------------

test('跨日：首项与改期后时间跨午夜正确导出', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');

  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-cross@x', '20261006T230000', '20261007T013000', 2)));
  importIcal(df, f, ['R0001'], '首次导入跨日系列');

  ok(df, ['reschedule-booking', 'B0002', '--start', '2026-10-14T22:00', '--end', '2026-10-15T01:00'], '第 2 项改到跨日时段');
  const out = join(dir, 'out.ics');
  const r = ok(df, ['export-ical', 'exp-cross@x', '--output', out], '导出');
  const p = parseExport(readFileSync(out, 'utf8'));
  assert.equal(p.master.startMs, floatingToMs('20261006T230000'));
  assert.equal(p.master.endMs, floatingToMs('20261007T013000'), '主事件跨日 DTEND 保留');
  const ex = p.exceptions[0];
  assert.equal(ex.recurrenceIdMs, floatingToMs('20261013T230000'));
  assert.equal(ex.startMs, floatingToMs('20261014T220000'));
  assert.equal(ex.endMs, floatingToMs('20261015T010000'), '例外跨日 DTEND 取当前值');
  const c = crossCheck(df, 'exp-cross@x', p);
  assert.deepEqual(c, {active: 2, excluded: 0, exceptions: 1});
  assertReport(r, c, '跨日');

  // 物理内容抽查浮动时间文本（先展开折行）
  const text = readFileSync(out, 'utf8')
    .split('\r\n')
    .reduce((acc: string[], l) => {
      if (l.startsWith(' ') || l.startsWith('\t')) acc[acc.length - 1] += l.slice(1);
      else acc.push(l);
      return acc;
    }, [])
    .join('\n');
  assert.match(text, /DTSTART:20261006T230000\nDTEND:20261007T013000/);
  assert.match(text, /DTSTART:20261014T220000\nDTEND:20261015T010000/);
});

// ---------------------------------------------------------------------------
// 6. 中文折行与文本转义：物理行 ≤75 UTF-8 字节、不拆 Unicode、转义齐全、
//    折行后的文件可被导入入口解析（无本地变化时身份一致 -> 重放）
// ---------------------------------------------------------------------------

test('中文折行与文本转义：长中文名折行，逗号/分号/反斜杠转义，重放一致', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '很长很长的中文会议室名称用于测试折行边界处理一二三');
  addResource(df, 'X,Y;Z\\W 标点设备', 'equipment');

  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-fold@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001', 'R0002'], '首次导入');

  const out = join(dir, 'out.ics');
  const r = ok(df, ['export-ical', 'exp-fold@x', '--output', out], '导出');
  const content = readFileSync(out, 'utf8');
  const p = parseExport(content); // parseExport 内部已逐行核对 75 字节与 CRLF

  // 确实发生了折行（存在以空格开头的物理行）
  assert.ok(content.split('\r\n').some((l) => l.startsWith(' ')), '长 DESCRIPTION 应被折行');
  // 解码后名称完整（折行没有拆开 Unicode 字符），标点在名称中原样保留
  const unfold = content
    .split('\r\n')
    .reduce((acc: string[], l) => {
      if (l.startsWith(' ') || l.startsWith('\t')) acc[acc.length - 1] += l.slice(1);
      else acc.push(l);
      return acc;
    }, []);
  const masterDesc = unescapeText(unfold.find((l) => l.startsWith('DESCRIPTION:'))!.slice('DESCRIPTION:'.length));
  assert.match(masterDesc, /很长很长的中文会议室名称用于测试折行边界处理一二三/);
  assert.match(masterDesc, /X,Y;Z\\W 标点设备/);
  // 原始（未解码）内容中逗号、分号、反斜杠均被转义
  assert.match(content, /X\\,Y\\;Z\\\\W/);
  assert.deepEqual(p.master.resources, ['R0001', 'R0002']);
  const c = crossCheck(df, 'exp-fold@x', p);
  assert.deepEqual(c, {active: 2, excluded: 0, exceptions: 0});
  assertReport(r, c, '折行');

  // 折行后的导出文件可直接再导入：身份一致 -> 全部重放、不写文件
  const replay = ok(df, ['import-ical', out, '--resource', 'R0001', '--resource', 'R0002'], '导出文件重放');
  assert.match(replay.stdout, /全部为重放/);
});

// ---------------------------------------------------------------------------
// 7. 持锁期间导出：只读不等待写入保护，且不改动业务数据
// ---------------------------------------------------------------------------

test('持锁期间导出：不等待保护、退出 0，数据文件逐字节不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-lock@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001'], '首次导入');

  const before = readFileSync(df);
  const lockHolder = holdLock(df, t);
  try {
    const out = join(dir, 'out.ics');
    const started = Date.now();
    const r = ok(df, ['export-ical', 'exp-lock@x', '--output', out], '锁被持有时导出');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `导出不应等待写入保护（实际 ${elapsed}ms）`);
    const p = parseExport(readFileSync(out, 'utf8'));
    const c = crossCheck(df, 'exp-lock@x', p);
    assert.deepEqual(c, {active: 2, excluded: 0, exceptions: 0});
    assertReport(r, c, '持锁导出');
  } finally {
    lockHolder.kill('SIGKILL');
  }
  assert.ok(before.equals(readFileSync(df)), '导出前后数据文件逐字节不变');
});

// ---------------------------------------------------------------------------
// 8. 真实输出失败：原输出不存在、失败不留半成品，业务文件逐字节不变
// ---------------------------------------------------------------------------

test('真实输出失败：退出 1 并说明原因，无半成品，业务文件不变', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-writefail@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001'], '首次导入');

  const before = readFileSync(df);
  const outPath = join(dir, LONG_OUT_NAME);
  assert.equal(existsSync(outPath), false, '前置：输出文件原本不存在');
  const r = bizFail(df, ['export-ical', 'exp-writefail@x', '--output', outPath], '输出文件名过长');
  assert.match(r.stderr, /写入 iCalendar 输出文件 .* 失败/);
  assert.equal(existsSync(outPath), false, '失败后仍不存在输出文件');
  const leftovers = readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], '失败不得留下临时半成品');
  assert.ok(before.equals(readFileSync(df)), '业务数据文件逐字节不变');

  // 同名问题不影响改到合法路径后成功
  const r2 = ok(df, ['export-ical', 'exp-writefail@x', '--output', join(dir, 'good.ics')], '合法路径重试');
  assert.match(r2.stdout, /有效成员: 2/);
});

// 输出到不可写目录：原有输出文件保持不变
test('真实输出失败：覆盖已有输出失败时原输出逐字节保留', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-keep@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001'], '首次导入');

  const outDir = join(dir, 'readonly');
  mkdirSync(outDir);
  const outPath = join(outDir, 'out.ics');
  writeFileSync(outPath, 'ORIGINAL-CONTENT', 'utf8');
  chmodSync(outDir, 0o555);
  try {
    const r = bizFail(df, ['export-ical', 'exp-keep@x', '--output', outPath], '目录只读导致临时文件写入失败');
    assert.match(r.stderr, /写入 iCalendar 输出文件 .* 失败/);
    assert.equal(readFileSync(outPath, 'utf8'), 'ORIGINAL-CONTENT', '原输出文件逐字节保留');
  } finally {
    // 必须先恢复目录可写，临时目录清理钩子才能递归删除（该钩子在本钩子之前注册）
    chmodSync(outDir, 0o755);
  }
});

// ---------------------------------------------------------------------------
// 9. 未知 UID、独立事件 UID、等价输出路径、用法错误与损坏数据
// ---------------------------------------------------------------------------

test('未知/独立 UID 与等价输出路径一律拒绝（退出 1）', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(
    dir,
    'a.ics',
    ical(
      weeklyEvent('exp-weekly@x', '20261005T100000', '20261005T110000', 2),
      ev('exp-solo@x', '20261102T080000', '20261102T090000'),
    ),
  );
  importIcal(df, f, ['R0001'], '导入一个系列与一个独立事件');

  bizFail(df, ['export-ical', 'no-such-uid', '--output', join(dir, 'x.ics')], '未知 UID');
  const solo = bizFail(df, ['export-ical', 'exp-solo@x', '--output', join(dir, 'x.ics')], '独立事件 UID');
  assert.match(solo.stderr, /独立事件/);

  // 输出与数据文件 / 锁文件 / 恢复协调文件等价（含 ./.. 等价写法）
  bizFail(df, ['export-ical', 'exp-weekly@x', '--output', df], '输出=数据文件');
  bizFail(df, ['export-ical', 'exp-weekly@x', '--output', `${df}.lock`], '输出=锁文件');
  bizFail(df, ['export-ical', 'exp-weekly@x', '--output', `${df}.lock.recover`], '输出=恢复协调文件');
  mkdirSync(join(dir, 'sub'));
  bizFail(df, ['export-ical', 'exp-weekly@x', '--output', join(dir, 'sub', '..', 'data.json')], './.. 等价数据文件');

  // 任一拒绝都不得产生输出
  assert.equal(existsSync(join(dir, 'x.ics')), false);
});

test('用法错误退出 2：缺少 UID/输出、多余参数、未知选项', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  usageFail(df, ['export-ical', 'u', '--output', join(dir, 'x.ics'), 'extra'], '多余位置参数');
  usageFail(df, ['export-ical', 'u'], '缺少 --output');
  usageFail(df, ['export-ical', '--output', join(dir, 'x.ics')], '缺少 UID');
  usageFail(df, ['export-ical'], '什么都没有');
  usageFail(df, ['export-ical', 'u', '--out', join(dir, 'x.ics')], '未知选项');
  usageFail(df, ['export-ical', 'u', '--output'], '--output 缺值');
});

test('损坏数据与旧记录（无 exceptions 字段）处理正确', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(dir, 'a.ics', ical(weeklyEvent('exp-legacy@x', '20261005T100000', '20261005T110000', 2)));
  importIcal(df, f, ['R0001'], '首次导入');

  // 旧记录：删除 exceptions 字段后仍可导出（按空例外集合处理）
  const store = readStore(df);
  const imp = store.imports.find((x: any) => x.uid === 'exp-legacy@x');
  assert.ok('exceptions' in imp, '新数据本应有 exceptions 字段');
  delete imp.exceptions;
  writeFileSync(df, JSON.stringify(store, null, 2) + '\n', 'utf8');
  const r = ok(df, ['export-ical', 'exp-legacy@x', '--output', join(dir, 'legacy.ics')], '旧记录导出');
  const p = parseExport(readFileSync(join(dir, 'legacy.ics'), 'utf8'));
  const c = crossCheck(df, 'exp-legacy@x', p);
  assert.deepEqual(c, {active: 2, excluded: 0, exceptions: 0});
  assertReport(r, c, '旧记录');

  // 损坏 JSON：退出 1
  const corrupted = join(dir, 'bad.json');
  writeFileSync(corrupted, '{ not json', 'utf8');
  bizFail(corrupted, ['export-ical', 'exp-legacy@x', '--output', join(dir, 'z.ics')], '损坏数据');
});

test('只读语义：重复导出内容稳定（DTSTAMP 除外）、计数不变、原子覆盖', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '一号会议室');
  const f = writeAux(
    dir,
    'a.ics',
    ical(
      weeklyEvent('exp-stable@x', '20261005T100000', '20261005T110000', 3),
      excEvent('exp-stable@x', '20261012T100000', '20261013T140000', '20261013T150000'),
    ),
  );
  importIcal(df, f, ['R0001'], '首次导入带例外');
  const before = readFileSync(df);

  const out1 = join(dir, 'a.out.ics');
  const out2 = join(dir, 'b.out.ics');
  ok(df, ['export-ical', 'exp-stable@x', '--output', out1], '第一次导出');
  ok(df, ['export-ical', 'exp-stable@x', `--output=${out2}`], '第二次导出（--output= 形式）');
  const stripStamp = (s: string): string => s.replace(/DTSTAMP:\d{8}T\d{6}Z/g, 'DTSTAMP:X');
  assert.equal(stripStamp(readFileSync(out1, 'utf8')), stripStamp(readFileSync(out2, 'utf8')), '除 DTSTAMP 外内容稳定');
  assert.ok(before.equals(readFileSync(df)), '纯只读：数据文件逐字节不变');

  // 再次导出覆盖已有输出：原子替换旧文件
  const r = ok(df, ['export-ical', 'exp-stable@x', '--output', out1], '覆盖已有输出');
  assert.match(r.stdout, /有效成员: 3/);
  const store = readStore(df);
  assert.equal(store.bookingSeq, 3, '只读不推进标识计数');
  assert.equal(store.seriesSeq, 1);
});
