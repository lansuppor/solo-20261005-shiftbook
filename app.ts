// shiftbook —— 本地多资源单次预约命令行工具
//
// Node.js 24，无外部运行依赖：node app.ts [选项] <命令> ...
//
// 资源（场地 / 设备 / 人员）登记后可被预约占用；预约为左闭右开区间，
// 必须被所有所选资源的开放区间完整覆盖。所有数据保存在同一个本地 JSON 文件中。

import { open, readFile, rename, unlink } from 'node:fs/promises';

const APP = 'shiftbook';
const DEFAULT_FILE = 'shiftbook-data.json';

const KINDS = ['venue', 'equipment', 'person'] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABEL: Record<Kind, string> = {
  venue: '场地',
  equipment: '设备',
  person: '人员',
};

const KIND_ALIAS: Record<string, Kind> = {
  venue: 'venue',
  equipment: 'equipment',
  person: 'person',
  场地: 'venue',
  设备: 'equipment',
  人员: 'person',
};

// ---------- 错误类型 ----------

/** 参数用法错误：退出码 2。 */
class UsageError extends Error {}
/** 业务规则失败：退出码 1。 */
class DomainError extends Error {}
/** 数据文件损坏 / 结构非法：退出码 1，且绝不覆盖原文件。 */
class DataFileError extends Error {}

// ---------- 数据模型 ----------

interface Interval {
  start: string;
  end: string;
}

interface Resource {
  id: string;
  kind: Kind;
  name: string;
  open: Interval[];
}

type BookingStatus = 'booked' | 'cancelled';

interface Booking {
  id: string;
  resourceIds: string[];
  start: string;
  end: string;
  status: BookingStatus;
}

interface Data {
  version: 1;
  counters: { resource: number; booking: number };
  resources: Resource[];
  bookings: Booking[];
}

function emptyData(): Data {
  return {
    version: 1,
    counters: { resource: 0, booking: 0 },
    resources: [],
    bookings: [],
  };
}

// ---------- 时间（营业地时间，与机器时区无关） ----------

const DT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function validYMD(y: number, m: number, d: number): boolean {
  return (
    Number.isInteger(y) &&
    Number.isInteger(m) &&
    Number.isInteger(d) &&
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= daysInMonth(y, m)
  );
}

/** 把 YYYY-MM-DDTHH:mm 解析为标量分钟数（UTC 日历日，确定性换算，不涉及时区）。 */
function parseDateTime(s: string): number {
  const m = DT_RE.exec(s);
  if (!m) {
    throw new DomainError(
      `时间格式非法："${s}"，需要 YYYY-MM-DDTHH:mm（例如 2026-10-05T09:30），且日期真实有效`,
    );
  }
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  const hh = +m[4];
  const mi = +m[5];
  if (!validYMD(y, mo, d) || hh > 23 || mi > 59) {
    throw new DomainError(`时间不是真实有效的日期时间："${s}"`);
  }
  return Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000) * 1440 + hh * 60 + mi;
}

/** 把 YYYY-MM-DD 解析为该日 00:00 的标量分钟数。 */
function parseDate(s: string): number {
  const m = DATE_RE.exec(s);
  if (!m) {
    throw new DomainError(
      `日期格式非法："${s}"，需要 YYYY-MM-DD（例如 2026-10-05），且日期真实有效`,
    );
  }
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  if (!validYMD(y, mo, d)) {
    throw new DomainError(`日期不是真实有效的日期："${s}"`);
  }
  return Math.floor(Date.UTC(y, mo - 1, d) / 86_400_000) * 1440;
}

// ---------- 标识 ----------

function newResourceId(data: Data): string {
  data.counters.resource += 1;
  return `res_${String(data.counters.resource).padStart(8, '0')}`;
}

function newBookingId(data: Data): string {
  data.counters.booking += 1;
  return `bk_${String(data.counters.booking).padStart(8, '0')}`;
}

function idNumber(id: string): number {
  const m = /(?:^res_|^bk_)(\d+)$/.exec(id);
  return m ? +m[1] : 0;
}

function compareId(a: string, b: string): number {
  return idNumber(a) - idNumber(b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------- 文件读写与严格校验 ----------

async function loadData(file: string): Promise<Data> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e: unknown) {
    if (e != null && typeof e === 'object' && 'code' in e && (e as { code?: string }).code === 'ENOENT') {
      return emptyData(); // 文件不存在按空数据处理
    }
    throw new DataFileError(`无法读取数据文件 ${file}：${(e as Error).message}；原文件已保留，未作任何修改`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DataFileError(
      `数据文件 ${file} 已损坏，不是合法 JSON（${(e as Error).message}）；原文件已保留，未作任何修改，也不会按空数据覆盖`,
    );
  }
  return validateData(raw, file);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 严格校验数据结构；任何不符都视为损坏，拒绝继续，避免覆盖原文件。 */
function validateData(raw: unknown, file: string): Data {
  const bomb = (msg: string): never => {
    throw new DataFileError(
      `数据文件 ${file} 结构非法：${msg}；原文件已保留，未作任何修改，也不会按空数据覆盖`,
    );
  };
  // 使用 asserts 谓词，使不通过的分支在类型层面终结。
  function asObj(v: unknown, msg: string): asserts v is Record<string, unknown> {
    if (!isPlainObject(v)) bomb(msg);
  }
  function asArr(v: unknown, msg: string): asserts v is unknown[] {
    if (!Array.isArray(v)) bomb(msg);
  }
  function asStr(v: unknown, msg: string): asserts v is string {
    if (typeof v !== 'string') bomb(msg);
  }
  function dt(v: string, msg: string): number {
    try {
      return parseDateTime(v);
    } catch (e) {
      return bomb(`${msg}${(e as Error).message}`);
    }
  }

  asObj(raw, '顶层必须是 JSON 对象');
  if (raw.version !== 1) bomb('version 必须为 1');
  asObj(raw.counters, 'counters 必须是对象');
  if (!Number.isInteger(raw.counters.resource) || (raw.counters.resource as number) < 0) {
    bomb('counters.resource 必须是非负整数');
  }
  if (!Number.isInteger(raw.counters.booking) || (raw.counters.booking as number) < 0) {
    bomb('counters.booking 必须是非负整数');
  }
  asArr(raw.resources, 'resources 必须是数组');
  asArr(raw.bookings, 'bookings 必须是数组');

  const data = emptyData();
  data.counters = {
    resource: raw.counters.resource as number,
    booking: raw.counters.booking as number,
  };

  const resourceIds = new Set<string>();
  for (const [i, item] of raw.resources.entries()) {
    const where = `resources[${i}]`;
    asObj(item, `${where} 必须是对象`);
    asStr(item.id, `${where}.id 必须是字符串标识：`);
    const id = item.id;
    if (!/^res_\d+$/.test(id)) bomb(`${where}.id 非法：${JSON.stringify(item.id)}`);
    if (resourceIds.has(id)) bomb(`资源标识重复：${id}`);
    asStr(item.kind, `${where}（${id}）.kind 必须是字符串：`);
    if (!(KINDS as readonly string[]).includes(item.kind)) {
      bomb(`${where}.kind 非法：${JSON.stringify(item.kind)}`);
    }
    const kind = item.kind as Kind;
    asStr(item.name, `${where}（${id}）.name 必须是字符串：`);
    if (item.name.trim() === '') bomb(`${where}（${id}）.name 不能为空`);
    const name = item.name;
    asArr(item.open, `${where}（${id}）.open 必须是数组：`);
    if (item.open.length === 0) bomb(`${where}（${id}）必须至少有一个开放区间`);
    const open: Interval[] = [];
    for (const [j, rawIv] of item.open.entries()) {
      asObj(rawIv, `${where}.open[${j}] 必须是对象`);
      asStr(rawIv.start, `${where}.open[${j}].start 必须是字符串：`);
      asStr(rawIv.end, `${where}.open[${j}].end 必须是字符串：`);
      const start = rawIv.start;
      const end = rawIv.end;
      const s = dt(start, `${where}.open[${j}] `);
      const e = dt(end, `${where}.open[${j}] `);
      if (s >= e) bomb(`${where}.open[${j}] 结束必须晚于开始（${start} ~ ${end}）`);
      open.push({ start, end });
    }
    resourceIds.add(id);
    data.resources.push({ id, kind, name, open });
    data.counters.resource = Math.max(data.counters.resource, idNumber(id));
  }

  const bookingIds = new Set<string>();
  for (const [i, item] of raw.bookings.entries()) {
    const where = `bookings[${i}]`;
    asObj(item, `${where} 必须是对象`);
    asStr(item.id, `${where}.id 必须是字符串标识：`);
    const id = item.id;
    if (!/^bk_\d+$/.test(id)) bomb(`${where}.id 非法：${JSON.stringify(item.id)}`);
    if (bookingIds.has(id)) bomb(`预约标识重复：${id}`);
    asArr(item.resourceIds, `${where}（${id}）.resourceIds 必须是数组：`);
    if (item.resourceIds.length === 0) bomb(`${where}（${id}）必须至少指定一个资源`);
    const resourceIdsOut: string[] = [];
    const seen = new Set<string>();
    for (const rid of item.resourceIds) {
      asStr(rid, `${where}（${id}）.resourceIds 必须全部是字符串：`);
      if (!resourceIds.has(rid)) bomb(`${where}（${id}）引用了不存在的资源：${rid}`);
      if (seen.has(rid)) bomb(`${where}（${id}）资源重复：${rid}`);
      seen.add(rid);
      resourceIdsOut.push(rid);
    }
    asStr(item.start, `${where}（${id}）.start 必须是字符串：`);
    asStr(item.end, `${where}（${id}）.end 必须是字符串：`);
    const start = item.start;
    const end = item.end;
    const s = dt(start, `${where}（${id}） `);
    const e = dt(end, `${where}（${id}） `);
    if (s >= e) bomb(`${where}（${id}）结束必须晚于开始（${start} ~ ${end}）`);
    asStr(item.status, `${where}（${id}）.status 必须是字符串：`);
    const status: BookingStatus =
      item.status === 'booked' || item.status === 'cancelled'
        ? item.status
        : bomb(`${where}（${id}）status 非法：${JSON.stringify(item.status)}`);
    resourceIdsOut.sort(compareId);
    bookingIds.add(id);
    data.bookings.push({ id, resourceIds: resourceIdsOut, start, end, status });
    data.counters.booking = Math.max(data.counters.booking, idNumber(id));
  }

  return data;
}

/** 先写临时文件并 fsync，再原子改名；改名前任何失败都不动原文件。 */
async function saveData(file: string, data: Data): Promise<void> {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = `${file}.tmp-${process.pid}`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(json, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw new DataFileError(`保存数据文件 ${file} 失败：${(e as Error).message}；原有数据与全部预约保持不变`);
  }
}

// ---------- 业务校验 ----------

function resourceMap(data: Data): Map<string, Resource> {
  return new Map(data.resources.map((r) => [r.id, r]));
}

/** 解析命令行给出的资源列表（可重复 --resource，也可逗号分隔），要求已登记且不重复。 */
function resolveResourceIds(data: Data, values: string[]): string[] {
  if (values.length === 0) {
    throw new UsageError('必须通过 --resource 指定至少一个资源');
  }
  const ids = values.flatMap((v) => v.split(',').map((x) => x.trim()));
  const byId = resourceMap(data);
  for (const id of ids) {
    if (id === '') {
      throw new DomainError('资源标识不能为空：请使用 resource-list 查看已登记资源的标识');
    }
    if (!byId.has(id)) {
      throw new DomainError(`未知资源标识："${id}"，请先使用 resource-add 登记，或用 resource-list 查看`);
    }
  }
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new DomainError(`资源重复："${id}"，同一次预约中每个资源只能出现一次`);
    }
    seen.add(id);
  }
  return ids.sort(compareId);
}

/** 开放区间重叠或相接视为连续；判断 [s, e) 是否被某资源的开放区间完整覆盖。 */
function isCovered(open: Interval[], s: number, e: number): boolean {
  const ivs = open
    .map((iv) => ({ s: parseDateTime(iv.start), e: parseDateTime(iv.end) }))
    .sort((a, b) => a.s - b.s || a.e - b.e);
  let cursor = s;
  for (const iv of ivs) {
    if (iv.s > cursor) return false; // 中间存在空档
    if (iv.e > cursor) cursor = iv.e;
    if (cursor >= e) return true;
  }
  return cursor >= e;
}

interface Conflict {
  bookingId: string;
  shared: string[];
}

function findConflicts(
  data: Data,
  ids: string[],
  s: number,
  e: number,
  excludeBookingId?: string,
): Conflict[] {
  const wanted = new Set(ids);
  const out: Conflict[] = [];
  for (const b of data.bookings) {
    if (b.status !== 'booked' || b.id === excludeBookingId) continue;
    const bs = parseDateTime(b.start);
    const be = parseDateTime(b.end);
    if (e <= bs || be <= s) continue; // 左闭右开：端点相等不算重叠
    const shared = b.resourceIds.filter((id) => wanted.has(id)).sort(compareId);
    if (shared.length > 0) out.push({ bookingId: b.id, shared });
  }
  return out.sort((a, b) => compareId(a.bookingId, b.bookingId));
}

function describeResource(r: Resource): string {
  return `${r.name}(${r.id})`;
}

/** 开放时间覆盖 + 冲突的完整校验；失败时收集全部原因，且不产生任何修改。 */
function assertBookable(
  data: Data,
  ids: string[],
  s: number,
  e: number,
  excludeBookingId?: string,
): void {
  if (e <= s) {
    throw new DomainError('结束时间必须晚于开始时间');
  }
  const byId = resourceMap(data);
  const insufficient: Resource[] = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (r && !isCovered(r.open, s, e)) insufficient.push(r);
  }
  if (insufficient.length > 0) {
    const lines = insufficient
      .sort((a, b) => compareId(a.id, b.id))
      .map((r) => `  - ${describeResource(r)} 的开放区间不能完整覆盖该时段`);
    throw new DomainError(`开放时间不足，以下资源无法在整段时间内使用：\n${lines.join('\n')}`);
  }
  const conflicts = findConflicts(data, ids, s, e, excludeBookingId);
  if (conflicts.length > 0) {
    const lines = conflicts.map((c) => {
      const names = c.shared
        .map((id) => {
          const r = byId.get(id);
          return r ? describeResource(r) : id;
        })
        .join('、');
      return `  - ${c.bookingId}，共同资源：${names}`;
    });
    throw new DomainError(`资源冲突，存在时间重叠且占用共同资源的预约：\n${lines.join('\n')}`);
  }
}

// ---------- 命令行解析 ----------

interface ParsedArgs {
  positionals: string[];
  options: Map<string, string[]>;
}

function parseArgs(tokens: string[], knownOptions: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const key = eq === -1 ? tok : tok.slice(0, eq);
      if (!knownOptions.has(key)) throw new UsageError(`未知选项：${key}`);
      let value: string;
      if (eq !== -1) {
        value = tok.slice(eq + 1);
      } else {
        if (i + 1 >= tokens.length) throw new UsageError(`选项 ${key} 缺少参数`);
        value = tokens[++i];
      }
      const list = options.get(key);
      if (list) list.push(value);
      else options.set(key, [value]);
    } else if (tok.startsWith('-') && tok !== '-') {
      throw new UsageError(`未知选项：${tok}`);
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, options };
}

function requirePositional(parsed: ParsedArgs, what: string): string {
  const v = parsed.positionals.shift();
  if (v === undefined) throw new UsageError(`缺少${what}`);
  return v;
}

function requireOption(parsed: ParsedArgs, key: string, label: string): string {
  const v = parsed.options.get(key)?.[0];
  if (v === undefined || v === '') throw new UsageError(`必须指定 ${label}`);
  return v;
}

function parseIntervalToken(token: string): Interval {
  const parts = token.split('~');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) {
    throw new DomainError(`开放区间格式非法："${token}"，需要 起始~结束（例如 2026-10-05T08:00~2026-10-05T22:00）`);
  }
  const start = parts[0].trim();
  const end = parts[1].trim();
  const s = parseDateTime(start);
  const e = parseDateTime(end);
  if (s >= e) throw new DomainError(`开放区间结束必须晚于开始：${start} ~ ${end}`);
  return { start, end };
}

// ---------- 输出 ----------

function statusLabel(status: BookingStatus): string {
  return status === 'booked' ? '已预约' : '已取消';
}

function formatBookingLine(data: Data, b: Booking): string {
  const byId = resourceMap(data);
  const resources = b.resourceIds
    .map((id) => {
      const r = byId.get(id);
      return r ? describeResource(r) : id;
    })
    .join('、');
  return `${b.id}  [${statusLabel(b.status)}]  ${b.start} ~ ${b.end}  资源：${resources}`;
}

// ---------- 命令实现 ----------

async function cmdResourceAdd(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set(['--open']));
  const kindRaw = requirePositional(parsed, '资源类型');
  const nameRaw = requirePositional(parsed, '资源名称');
  if (parsed.positionals.length > 0) {
    throw new UsageError(`多余的参数：${parsed.positionals.join(' ')}`);
  }
  const kind = KIND_ALIAS[kindRaw.trim()];
  if (!kind) {
    throw new DomainError(
      `资源类型非法："${kindRaw}"，可选 venue（场地）、equipment（设备）、person（人员）`,
    );
  }
  const name = nameRaw.trim();
  if (name === '') throw new DomainError('资源名称不能为空');
  const openTokens = parsed.options.get('--open') ?? [];
  if (openTokens.length === 0) throw new UsageError('必须通过 --open 指定至少一个开放区间（起始~结束）');
  const open = openTokens.map(parseIntervalToken);

  const data = await loadData(file);
  const id = newResourceId(data);
  data.resources.push({ id, kind, name, open });
  await saveData(file, data);
  console.log(`已新增资源 ${id}（${KIND_LABEL[kind]}：${name}，${open.length} 个开放区间）`);
}

async function cmdResourceList(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set());
  if (parsed.positionals.length > 0) {
    throw new UsageError(`resource-list 不接受参数：${parsed.positionals.join(' ')}`);
  }
  const data = await loadData(file);
  console.log(`资源列表（共 ${data.resources.length} 个，数据文件：${file}）`);
  if (data.resources.length === 0) {
    console.log('暂无资源。使用 resource-add <类型> <名称> --open <起始~结束> 新增。');
    return;
  }
  for (const r of data.resources.slice().sort((a, b) => compareId(a.id, b.id))) {
    console.log(`${r.id}  [${KIND_LABEL[r.kind]}]  ${r.name}`);
    const ivs = r.open.slice().sort((a, b) => parseDateTime(a.start) - parseDateTime(b.start));
    for (const iv of ivs) {
      console.log(`    开放 ${iv.start} ~ ${iv.end}`);
    }
  }
}

async function cmdBook(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set(['--start', '--end', '--resource', '--resources']));
  if (parsed.positionals.length > 0) {
    throw new UsageError(`多余的参数：${parsed.positionals.join(' ')}`);
  }
  const startStr = requireOption(parsed, '--start', '--start <起始时间>');
  const endStr = requireOption(parsed, '--end', '--end <结束时间>');
  const resourceValues = parsed.options.get('--resource') ?? parsed.options.get('--resources');
  const data = await loadData(file);
  const ids = resolveResourceIds(data, resourceValues ?? []);
  const s = parseDateTime(startStr);
  const e = parseDateTime(endStr);
  assertBookable(data, ids, s, e);
  const id = newBookingId(data);
  data.bookings.push({ id, resourceIds: ids, start: startStr, end: endStr, status: 'booked' });
  await saveData(file, data);
  console.log(`已创建预约 ${id}（${startStr} ~ ${endStr}，${ids.length} 个资源）`);
}

async function cmdReschedule(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set(['--start', '--end', '--resource', '--resources']));
  const bookingId = requirePositional(parsed, '预约标识');
  if (parsed.positionals.length > 0) {
    throw new UsageError(`多余的参数：${parsed.positionals.join(' ')}`);
  }
  const data = await loadData(file);
  const booking = data.bookings.find((b) => b.id === bookingId);
  if (!booking) throw new DomainError(`未知预约标识："${bookingId}"`);
  if (booking.status === 'cancelled') {
    throw new DomainError(`预约 ${booking.id} 已取消，不能改期`);
  }

  const startStr = parsed.options.get('--start')?.[0] ?? booking.start;
  const endStr = parsed.options.get('--end')?.[0] ?? booking.end;
  let ids = booking.resourceIds;
  const newResources = parsed.options.get('--resource') ?? parsed.options.get('--resources');
  if (newResources) ids = resolveResourceIds(data, newResources);

  const s = parseDateTime(startStr);
  const e = parseDateTime(endStr);
  assertBookable(data, ids, s, e, booking.id);

  booking.resourceIds = ids;
  booking.start = startStr;
  booking.end = endStr;
  await saveData(file, data);
  console.log(`已改期预约 ${booking.id}（${startStr} ~ ${endStr}，${ids.length} 个资源）`);
}

async function cmdCancel(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set());
  const bookingId = requirePositional(parsed, '预约标识');
  if (parsed.positionals.length > 0) {
    throw new UsageError(`多余的参数：${parsed.positionals.join(' ')}`);
  }
  const data = await loadData(file);
  const booking = data.bookings.find((b) => b.id === bookingId);
  if (!booking) throw new DomainError(`未知预约标识："${bookingId}"`);
  if (booking.status === 'cancelled') {
    console.log(`预约 ${booking.id} 已是取消状态，未作改动；其资源均不被占用。`);
    return;
  }
  booking.status = 'cancelled';
  await saveData(file, data);
  console.log(`已取消预约 ${booking.id}，全部 ${booking.resourceIds.length} 个资源已释放；取消记录保留。`);
}

async function cmdQuery(tokens: string[], file: string): Promise<void> {
  const parsed = parseArgs(tokens, new Set());
  const dayStr = requirePositional(parsed, '查询日期');
  if (parsed.positionals.length > 0) {
    throw new UsageError(`多余的参数：${parsed.positionals.join(' ')}`);
  }
  const dayStart = parseDate(dayStr);
  const dayEnd = dayStart + 1440;
  const data = await loadData(file);
  const hits = data.bookings
    .filter((b) => parseDateTime(b.end) > dayStart && parseDateTime(b.start) < dayEnd)
    .sort(
      (a, b) =>
        parseDateTime(a.start) - parseDateTime(b.start) || compareId(a.id, b.id),
    );
  console.log(`${dayStr} 的预约（共 ${hits.length} 个，含跨日与已取消，数据文件：${file}）`);
  if (hits.length === 0) {
    console.log(`${dayStr} 没有预约。`);
    return;
  }
  for (const b of hits) console.log(formatBookingLine(data, b));
}

// ---------- 帮助与入口 ----------

const HELP = `${APP} —— 本地多资源单次预约（场地 / 设备 / 人员）

用法：
  node app.ts [全局选项] <命令> [命令选项]

全局选项：
  -f, --file <路径>      本地 JSON 数据文件（默认 ./${DEFAULT_FILE}）
                         文件不存在时按空数据处理；损坏或结构非法时拒绝运行且保留原文件
  -h, --help             显示本帮助（无参数时同样显示）

命令：
  resource-add <类型> <名称> --open <起始~结束> [--open ...]
                         登记资源；类型为 venue(场地) / equipment(设备) / person(人员)
  resource-list          列出全部资源的标识、类型、名称与开放区间
  book --start <起始> --end <结束> --resource <标识> [--resource <标识> ...]
                         创建预约；--resource 可重复，也可在一个值中用逗号分隔多个标识
  reschedule <预约标识> [--start <起始>] [--end <结束>] [--resource <标识> ...]
                         改期 / 更换资源（给出的 --resource 整体替换原资源）；标识保持不变
  cancel <预约标识>       取消预约（释放全部资源并保留记录；重复取消成功且不变）
  query <日期>           列出与该日相交的全部预约（含跨日、已取消）

时间规则：
  日期时间格式 YYYY-MM-DDTHH:mm（例如 2026-10-05T09:30），查询日期为 YYYY-MM-DD
  时间为与机器时区无关的营业地时间，日期必须真实有效，结束必须晚于开始，允许跨日
  区间左闭右开：一个预约的结束等于另一个的开始，不算冲突
  开放区间重叠或首尾相接视为连续开放；预约时段必须被每个所选资源的开放区间完整覆盖
  仅当存在共同资源且时间重叠时才冲突；冲突会列出全部冲突预约标识及共同资源

退出码：0 成功；1 业务失败（原因输出到 stderr）；2 参数用法错误（含未知参数）

示例：
  node app.ts -f shop.json resource-add venue 网球场 --open 2026-10-05T08:00~2026-10-05T22:00
  node app.ts -f shop.json resource-add equipment 投影仪 --open 2026-10-05T08:00~2026-10-05T22:00
  node app.ts -f shop.json resource-list
  node app.ts -f shop.json book --start 2026-10-05T09:00 --end 2026-10-05T10:30 \\
      --resource res_00000001 --resource res_00000002
  node app.ts -f shop.json reschedule bk_00000001 --start 2026-10-05T11:00 --end 2026-10-05T12:00
  node app.ts -f shop.json cancel bk_00000001
  node app.ts -f shop.json query 2026-10-05
`;

function printHelp(): void {
  console.log(HELP.trimEnd());
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printHelp();
    return;
  }

  // 全局选项可出现在任意位置；-h/--help 在任何位置都显示帮助。
  let file = DEFAULT_FILE;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      printHelp();
      return;
    }
    if (a === '-f' || a === '--file') {
      if (i + 1 >= argv.length) throw new UsageError(`选项 ${a} 缺少文件路径参数`);
      file = argv[++i];
    } else if (a.startsWith('--file=')) {
      file = a.slice('--file='.length);
    } else {
      rest.push(a);
    }
  }

  const command = rest.shift();
  if (command === undefined) throw new UsageError('缺少命令；使用 --help 查看用法');

  const handlers: Record<string, (tokens: string[], file: string) => Promise<void>> = {
    'resource-add': cmdResourceAdd,
    'resource-list': cmdResourceList,
    book: cmdBook,
    reschedule: cmdReschedule,
    cancel: cmdCancel,
    query: cmdQuery,
    help: async () => printHelp(),
  };
  const handler = handlers[command];
  if (!handler) throw new UsageError(`未知命令或参数："${command}"；使用 --help 查看用法`);
  await handler(rest, file);
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`${APP}: ${e.message}`);
    process.exitCode = 2;
  } else {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${APP}: ${msg}`);
    process.exitCode = 1;
  }
});
