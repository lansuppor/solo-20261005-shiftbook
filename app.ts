// shiftbook —— 本地多资源单次预约命令行工具
// 运行环境：Node.js 24（直接执行 TypeScript，无外部运行依赖）
//
// 时间一律使用与机器时区无关的营业地时间：
//   日期时间 YYYY-MM-DDTHH:mm，查询日期 YYYY-MM-DD
// 内部统一换算为“自公元 1 年起的分钟数”做比较，杜绝时区影响。
// 区间左闭右开 [start, end)，允许跨日。

import {readFile, writeFile, rename, unlink} from 'node:fs/promises';

const APP = 'shiftbook';
const DEFAULT_DATA_FILE = 'shiftbook-data.json';

// ---------------------------------------------------------------------------
// 错误类型：UsageError -> 退出码 2；BizError -> 退出码 1
// ---------------------------------------------------------------------------

class UsageError extends Error {}
class BizError extends Error {}

// ---------------------------------------------------------------------------
// 营业地时间（分钟数）
// ---------------------------------------------------------------------------

const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Howard Hinnant 的 civil-from-days 逆算法（对负年同样成立）
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy >= 0 ? yy / 400 : (yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function parseDateTime(value: string, label: string): number {
  if (typeof value !== 'string' || value === '') {
    throw new BizError(`${label}缺失，应为 YYYY-MM-DDTHH:mm`);
  }
  const m = DATE_TIME_RE.exec(value);
  if (!m) {
    throw new BizError(`${label}格式非法: “${value}”，应为 YYYY-MM-DDTHH:mm`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59) {
    throw new BizError(`${label}不是真实有效的时间: “${value}”`);
  }
  return daysFromCivil(year, month, day) * 1440 + hour * 60 + minute;
}

function parseDate(value: string, label = '查询日期'): number {
  if (typeof value !== 'string' || value === '') {
    throw new BizError(`${label}缺失，应为 YYYY-MM-DD`);
  }
  const m = DATE_RE.exec(value);
  if (!m) {
    throw new BizError(`${label}格式非法: “${value}”，应为 YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new BizError(`${label}不是真实有效的日期: “${value}”`);
  }
  return daysFromCivil(year, month, day) * 1440;
}

// 解析 “开始/结束” 形式的开放区间
function parseOpenInterval(value: string): {start: string; end: string; startMin: number; endMin: number} {
  const parts = String(value ?? '').split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new BizError(`开放区间格式非法: “${value}”，应为 开始/结束（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm）`);
  }
  const start = parts[0];
  const end = parts[1];
  const startMin = parseDateTime(start, '开放区间开始时间');
  const endMin = parseDateTime(end, '开放区间结束时间');
  if (endMin <= startMin) {
    throw new BizError(`开放区间结束时间必须晚于开始时间: “${value}”`);
  }
  return {start, end, startMin, endMin};
}

// 重叠或相接（start <= 上一段 end）的区间合并为连续开放
function mergeIntervals(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      if (e > last[1]) last[1] = e;
    } else {
      merged.push([s, e]);
    }
  }
  return merged;
}

// [s, e) 是否被某一段连续开放完整覆盖
function isFullyCovered(segments: Array<[number, number]>, s: number, e: number): boolean {
  return segments.some(([a, b]) => a <= s && e <= b);
}

// ---------------------------------------------------------------------------
// 数据模型与文件存取
// ---------------------------------------------------------------------------

type ResourceType = 'venue' | 'equipment' | 'person';
type BookingStatus = 'active' | 'cancelled';

interface ResourceRec {
  id: string;
  type: ResourceType;
  name: string;
  open: Array<[string, string]>;
}

interface BookingRec {
  id: string;
  resourceIds: string[];
  start: string;
  end: string;
  status: BookingStatus;
}

interface Store {
  version: 1;
  resourceSeq: number;
  bookingSeq: number;
  resources: ResourceRec[];
  bookings: BookingRec[];
}

const RESOURCE_TYPE_LABEL: Record<ResourceType, string> = {
  venue: '场地',
  equipment: '设备',
  person: '人员',
};

const RESOURCE_TYPE_MAP: Record<string, ResourceType> = {
  venue: 'venue',
  equipment: 'equipment',
  person: 'person',
  '场地': 'venue',
  '设备': 'equipment',
  '人员': 'person',
};

function emptyStore(): Store {
  return {version: 1, resourceSeq: 0, bookingSeq: 0, resources: [], bookings: []};
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// 严格校验数据文件结构；非法时抛出 BizError，调用方不得写回文件
function validateStore(raw: unknown, file: string): Store {
  const bad = (reason: string): never => {
    throw new BizError(`数据文件 ${file} 结构非法：${reason}（原文件已保留，未做修改）`);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad('顶层必须是对象');
  const o = raw as Record<string, unknown>;

  if (o.version !== undefined && o.version !== 1) bad(`不支持的版本: ${String(o.version)}`);

  const store = emptyStore();
  if (o.resourceSeq !== undefined) {
    if (!isInt(o.resourceSeq)) bad('resourceSeq 必须是非负整数');
    store.resourceSeq = o.resourceSeq;
  }
  if (o.bookingSeq !== undefined) {
    if (!isInt(o.bookingSeq)) bad('bookingSeq 必须是非负整数');
    store.bookingSeq = o.bookingSeq;
  }

  if (o.resources !== undefined && !Array.isArray(o.resources)) bad('resources 必须是数组');
  if (o.bookings !== undefined && !Array.isArray(o.bookings)) bad('bookings 必须是数组');
  const rawResources = (o.resources ?? []) as unknown[];
  const rawBookings = (o.bookings ?? []) as unknown[];

  const resourceIds = new Set<string>();
  rawResources.forEach((item, idx) => {
    const at = `resources[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !/^R\d{4,}$/.test(r.id)) bad(`${at}.id 非法: ${String(r.id)}`);
    if (resourceIds.has(r.id)) bad(`资源标识重复: ${r.id}`);
    resourceIds.add(r.id);
    if (r.type !== 'venue' && r.type !== 'equipment' && r.type !== 'person') {
      bad(`${at}(${r.id}).type 非法: ${String(r.type)}`);
    }
    if (typeof r.name !== 'string' || r.name.trim() === '') bad(`${at}(${r.id}).name 不能为空`);
    if (!Array.isArray(r.open) || r.open.length === 0) bad(`${at}(${r.id}).open 必须是非空数组`);
    const open: Array<[string, string]> = [];
    r.open.forEach((iv: unknown, j: number) => {
      if (!Array.isArray(iv) || iv.length !== 2 || typeof iv[0] !== 'string' || typeof iv[1] !== 'string') {
        bad(`${at}(${r.id}).open[${j}] 必须是 [开始, 结束]`);
      }
      const s = parseDateTime(iv[0], `${at}(${r.id}).open[${j}] 开始时间`);
      const e = parseDateTime(iv[1], `${at}(${r.id}).open[${j}] 结束时间`);
      if (e <= s) bad(`${at}(${r.id}).open[${j}] 结束必须晚于开始`);
      open.push([iv[0], iv[1]]);
    });
    store.resources.push({id: r.id, type: r.type, name: r.name, open});
    const n = Number(r.id.slice(1));
    if (n > store.resourceSeq) store.resourceSeq = n;
  });

  const bookingIds = new Set<string>();
  rawBookings.forEach((item, idx) => {
    const at = `bookings[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const b = item as Record<string, unknown>;
    if (typeof b.id !== 'string' || !/^B\d{4,}$/.test(b.id)) bad(`${at}.id 非法: ${String(b.id)}`);
    if (bookingIds.has(b.id)) bad(`预约标识重复: ${b.id}`);
    bookingIds.add(b.id);
    if (!Array.isArray(b.resourceIds) || b.resourceIds.length === 0) {
      bad(`${at}(${b.id}).resourceIds 必须是非空数组`);
    }
    const ids = b.resourceIds as unknown[];
    const seen = new Set<string>();
    ids.forEach((rid) => {
      if (typeof rid !== 'string' || !resourceIds.has(rid)) {
        bad(`${at}(${b.id}) 引用了未知资源: ${String(rid)}`);
      }
      if (seen.has(rid)) bad(`${at}(${b.id}) 资源重复: ${rid}`);
      seen.add(rid);
    });
    if (typeof b.start !== 'string' || typeof b.end !== 'string') {
      bad(`${at}(${b.id}) 起止时间必须是字符串`);
    }
    const s = parseDateTime(b.start, `${at}(${b.id}).start`);
    const e = parseDateTime(b.end, `${at}(${b.id}).end`);
    if (e <= s) bad(`${at}(${b.id}) 结束必须晚于开始`);
    if (b.status !== 'active' && b.status !== 'cancelled') {
      bad(`${at}(${b.id}).status 非法: ${String(b.status)}`);
    }
    store.bookings.push({
      id: b.id,
      resourceIds: [...(ids as string[])].sort(),
      start: b.start,
      end: b.end,
      status: b.status,
    });
    const n = Number(b.id.slice(1));
    if (n > store.bookingSeq) store.bookingSeq = n;
  });

  store.resources.sort((a, b) => a.id.localeCompare(b.id));
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  return store;
}

async function loadStore(file: string): Promise<Store> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new BizError(`无法读取数据文件 ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new BizError(
      `数据文件 ${file} 已损坏，不是合法 JSON：${(err as Error).message}（原文件已保留，未当作空数据覆盖）`,
    );
  }
  return validateStore(raw, file);
}

// 先完整写入临时文件，再原子改名；任何失败都不触碰原文件
async function saveStore(file: string, store: Store): Promise<void> {
  let json: string;
  try {
    json = JSON.stringify(store, null, 2) + '\n';
  } catch (err) {
    throw new BizError(`序列化数据失败：${(err as Error).message}（原文件已保留）`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, json, {encoding: 'utf8', flag: 'wx'});
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new BizError(`保存数据文件 ${file} 失败：${(err as Error).message}（原文件已保留）`);
  }
}

// ---------------------------------------------------------------------------
// 业务校验
// ---------------------------------------------------------------------------

function formatResourceIds(store: Store, ids: string[]): string {
  return ids
    .map((id) => {
      const r = store.resources.find((x) => x.id === id);
      return r ? `${id}（${r.name}）` : id;
    })
    .join('、');
}

// 校验请求中的资源标识：去重、检查存在性；返回按标识排序的集合
function resolveResourceIds(store: Store, rawIds: string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const id of rawIds) {
    if (seen.has(id)) {
      if (!dupes.includes(id)) dupes.push(id);
    }
    seen.add(id);
  }
  if (dupes.length > 0) problems.push(`资源重复指定: ${dupes.join('、')}`);

  const unknown = [...seen].filter((id) => !store.resources.some((r) => r.id === id)).sort();
  if (unknown.length > 0) problems.push(`未知资源标识: ${unknown.join('、')}`);

  if (problems.length > 0) throw new BizError(problems.join('\n'));
  return [...seen].sort();
}

function openSegmentsOf(r: ResourceRec): Array<[number, number]> {
  return mergeIntervals(
    r.open.map(
      ([s, e]) =>
        [parseDateTime(s, '开放区间开始时间'), parseDateTime(e, '开放区间结束时间')] as [number, number],
    ),
  );
}

// 校验每个资源的开放区间都能完整覆盖 [startMin, endMin)
function assertOpenCoverage(store: Store, ids: string[], startMin: number, endMin: number): void {
  const failing = ids
    .map((id) => ({id, r: store.resources.find((x) => x.id === id)!}))
    .filter(({r}) => !isFullyCovered(openSegmentsOf(r), startMin, endMin));
  if (failing.length > 0) {
    throw new BizError(
      '开放时间不足，以下资源的开放区间不能完整覆盖预约区间：\n' +
        failing.map(({id, r}) => `- ${id}（${r.name}）`).join('\n'),
    );
  }
}

interface Conflict {
  booking: BookingRec;
  shared: string[];
}

// 与“已预约”记录求冲突：共同资源且时间重叠（左闭右开）；可排除自身
function findConflicts(
  store: Store,
  ids: string[],
  startMin: number,
  endMin: number,
  excludeBookingId?: string,
): Conflict[] {
  const wanted = new Set(ids);
  const conflicts: Conflict[] = [];
  for (const b of store.bookings) {
    if (b.status !== 'active') continue;
    if (excludeBookingId !== undefined && b.id === excludeBookingId) continue;
    const bStart = parseDateTime(b.start, '预约开始时间');
    const bEnd = parseDateTime(b.end, '预约结束时间');
    const overlap = bStart < endMin && startMin < bEnd;
    if (!overlap) continue;
    const shared = b.resourceIds.filter((id) => wanted.has(id)).sort();
    if (shared.length > 0) conflicts.push({booking: b, shared});
  }
  conflicts.sort((a, b) => a.booking.id.localeCompare(b.booking.id));
  return conflicts;
}

function assertNoConflicts(conflicts: Conflict[], store: Store): void {
  if (conflicts.length === 0) return;
  const lines = conflicts.map(
    (c) => `- ${c.booking.id}：共同资源 ${formatResourceIds(store, c.shared)}`,
  );
  throw new BizError(`预约与以下预约冲突（共同资源时间重叠）：\n${lines.join('\n')}`);
}

// ---------------------------------------------------------------------------
// 命令行解析
// ---------------------------------------------------------------------------

interface GlobalArgs {
  dataFile: string;
  help: boolean;
  rest: string[];
}

function splitGlobalArgs(argv: string[]): GlobalArgs {
  const result: GlobalArgs = {dataFile: DEFAULT_DATA_FILE, help: false, rest: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      result.help = true;
    } else if (a === '--data') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('选项 --data 缺少数据文件路径');
      result.dataFile = v;
    } else if (a.startsWith('--data=')) {
      result.dataFile = a.slice('--data='.length);
      if (result.dataFile === '') throw new UsageError('选项 --data 缺少数据文件路径');
    } else {
      result.rest.push(a);
    }
  }
  return result;
}

interface ParsedFlags {
  values: Map<string, string[]>;
  positionals: string[];
}

// 子命令选项解析：allowed 中列出的选项均需带值；multi 中的选项可重复
function parseFlags(args: string[], allowed: string[], multi: string[] = []): ParsedFlags {
  const allowedSet = new Set(allowed);
  const multiSet = new Set(multi);
  const values = new Map<string, string[]>();
  const positionals: string[] = [];

  const takeValue = (key: string, inline: string | undefined, index: number): [string, number] => {
    if (inline !== undefined) return [inline, index];
    const v = args[index + 1];
    if (v === undefined || v.startsWith('-')) {
      throw new UsageError(`选项 --${key} 缺少值`);
    }
    return [v, index + 1];
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let key: string;
      let inline: string | undefined;
      const eq = a.indexOf('=');
      if (eq >= 0) {
        key = a.slice(2, eq);
        inline = a.slice(eq + 1);
      } else {
        key = a.slice(2);
      }
      if (!allowedSet.has(key)) throw new UsageError(`未知选项: --${key}`);
      let v: string;
      [v, i] = takeValue(key, inline, i);
      if (v === '') throw new UsageError(`选项 --${key} 的值不能为空`);
      if (!multiSet.has(key) && values.has(key)) {
        throw new UsageError(`选项 --${key} 只能指定一次`);
      }
      const list = values.get(key) ?? [];
      list.push(v);
      values.set(key, list);
    } else if (a.startsWith('-') && a !== '-') {
      throw new UsageError(`未知参数: ${a}`);
    } else {
      positionals.push(a);
    }
  }
  return {values, positionals};
}

function requireFlag(values: Map<string, string[]>, key: string): string {
  const v = values.get(key)?.[0];
  if (v === undefined) throw new UsageError(`缺少必需选项 --${key}`);
  return v;
}

// ---------------------------------------------------------------------------
// 子命令实现
// ---------------------------------------------------------------------------

async function cmdAddResource(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['type', 'name', 'open'], ['open']);
  if (positionals.length > 0) throw new UsageError(`add-resource 不接受位置参数: ${positionals.join(' ')}`);

  const typeRaw = requireFlag(values, 'type');
  const type = RESOURCE_TYPE_MAP[typeRaw];
  if (!type) {
    throw new BizError(`资源类型非法: “${typeRaw}”，应为 venue（场地）、equipment（设备）或 person（人员）`);
  }
  const name = requireFlag(values, 'name');
  if (name.trim() === '') throw new BizError('资源名称不能为空');

  const openRaw = values.get('open');
  if (!openRaw || openRaw.length === 0) throw new UsageError('至少需要一个 --open 开放区间');
  const open: Array<[string, string]> = openRaw.map((v) => {
    const iv = parseOpenInterval(v);
    return [iv.start, iv.end];
  });

  const file = activeDataFile;
  const store = await loadStore(file);
  // 全部校验通过后才生成标识、改内存、落盘
  store.resourceSeq += 1;
  const id = `R${String(store.resourceSeq).padStart(4, '0')}`;
  store.resources.push({id, type, name, open});
  store.resources.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);
  console.log(`已添加资源 ${id}（${RESOURCE_TYPE_LABEL[type]}｜${name}）`);
}

async function cmdListResources(): Promise<void> {
  const store = await loadStore(activeDataFile);
  if (store.resources.length === 0) {
    console.log('暂无资源。可使用 add-resource 登记场地、设备或人员。');
    return;
  }
  console.log(`资源（共 ${store.resources.length} 个）：`);
  for (const r of store.resources) {
    console.log(`- ${r.id} [${RESOURCE_TYPE_LABEL[r.type]}] ${r.name}`);
    for (const [s, e] of r.open) {
      console.log(`    开放: ${s} → ${e}`);
    }
  }
}

async function cmdCreateBooking(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource', 'start', 'end'], ['resource']);
  if (positionals.length > 0) throw new UsageError(`create-booking 不接受位置参数: ${positionals.join(' ')}`);

  const resourceArgs = values.get('resource');
  if (!resourceArgs || resourceArgs.length === 0) throw new UsageError('至少需要一个 --resource');
  const startRaw = requireFlag(values, 'start');
  const endRaw = requireFlag(values, 'end');

  const file = activeDataFile;
  const store = await loadStore(activeDataFile);

  const ids = resolveResourceIds(store, resourceArgs);
  const startMin = parseDateTime(startRaw, '预约开始时间');
  const endMin = parseDateTime(endRaw, '预约结束时间');
  if (endMin <= startMin) {
    throw new BizError(`预约结束时间必须晚于开始时间（开始: ${startRaw}，结束: ${endRaw}），允许跨日`);
  }
  assertOpenCoverage(store, ids, startMin, endMin);
  assertNoConflicts(findConflicts(store, ids, startMin, endMin), store);

  // 校验全部通过，一次性占用全部资源并落盘
  store.bookingSeq += 1;
  const id = `B${String(store.bookingSeq).padStart(4, '0')}`;
  store.bookings.push({id, resourceIds: ids, start: startRaw, end: endRaw, status: 'active'});
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);
  console.log(`已创建预约 ${id}`);
  console.log(`  时间: ${startRaw} → ${endRaw}`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
}

async function cmdRescheduleBooking(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['start', 'end', 'resource'], ['resource']);
  if (positionals.length !== 1) {
    throw new UsageError('用法: reschedule-booking <预约标识> [--start ...] [--end ...] [--resource ...]');
  }
  const id = positionals[0];

  const file = activeDataFile;
  const store = await loadStore(file);
  const booking = store.bookings.find((b) => b.id === id);
  if (!booking) throw new BizError(`未知预约标识: ${id}`);
  if (booking.status === 'cancelled') {
    throw new BizError(`预约 ${id} 已取消，不能改期`);
  }

  const hasTime = values.has('start') || values.has('end');
  const hasResource = values.has('resource');
  if (!hasTime && !hasResource) {
    throw new BizError('未指定任何改动：请提供 --start/--end 修改时间，或 --resource 替换资源（可同时提供）');
  }

  const startRaw = values.get('start')?.[0] ?? booking.start;
  const endRaw = values.get('end')?.[0] ?? booking.end;
  const startMin = parseDateTime(startRaw, '预约开始时间');
  const endMin = parseDateTime(endRaw, '预约结束时间');
  if (endMin <= startMin) {
    throw new BizError(`预约结束时间必须晚于开始时间（开始: ${startRaw}，结束: ${endRaw}），允许跨日`);
  }

  let ids: string[] = booking.resourceIds;
  if (hasResource) {
    const resourceArgs = values.get('resource')!;
    ids = resolveResourceIds(store, resourceArgs);
  }

  assertOpenCoverage(store, ids, startMin, endMin);
  // 改期检查排除自身
  assertNoConflicts(findConflicts(store, ids, startMin, endMin, id), store);

  // 全部可用后整体替换旧安排并落盘；失败则本进程内存与磁盘上的原安排都不变
  booking.start = startRaw;
  booking.end = endRaw;
  booking.resourceIds = ids;
  await saveStore(file, store);
  console.log(`已改期预约 ${id}（标识保持不变）`);
  console.log(`  时间: ${startRaw} → ${endRaw}`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
}

async function cmdCancelBooking(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`cancel-booking 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length !== 1) throw new UsageError('用法: cancel-booking <预约标识>');
  const id = positionals[0];

  const file = activeDataFile;
  const store = await loadStore(file);
  const booking = store.bookings.find((b) => b.id === id);
  if (!booking) throw new BizError(`未知预约标识: ${id}`);
  if (booking.status === 'cancelled') {
    // 幂等：再次取消成功且不做任何改动
    console.log(`预约 ${id} 已是取消状态，未做改动。`);
    return;
  }
  booking.status = 'cancelled'; // 已取消记录保留，但不再参与冲突检查
  await saveStore(file, store);
  console.log(`已取消预约 ${id}，其全部资源已释放。`);
}

async function cmdListBookings(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['date']);
  if (positionals.length > 0) throw new UsageError(`list-bookings 不接受位置参数: ${positionals.join(' ')}`);
  const dateRaw = requireFlag(values, 'date');
  const dayStart = parseDate(dateRaw);
  const dayEnd = dayStart + 1440;

  const store = await loadStore(activeDataFile);
  // 与该日 [00:00, 次日00:00) 相交即包含：跨日预约、已取消记录均在内
  const hits = store.bookings
    .filter((b) => {
      const s = parseDateTime(b.start, '预约开始时间');
      const e = parseDateTime(b.end, '预约结束时间');
      return s < dayEnd && e > dayStart;
    })
    .map((b) => ({b, startMin: parseDateTime(b.start, '预约开始时间')}))
    .sort((x, y) => x.startMin - y.startMin || x.b.id.localeCompare(y.b.id));

  if (hits.length === 0) {
    console.log(`${dateRaw} 当天没有预约（含跨日与已取消记录）。`);
    return;
  }
  console.log(`${dateRaw} 当天的预约（共 ${hits.length} 条，含跨日与已取消）：`);
  for (const {b} of hits) {
    const status = b.status === 'active' ? '已预约' : '已取消';
    console.log(`- ${b.id} [${status}] ${b.start} → ${b.end}`);
    console.log(`    资源: ${formatResourceIds(store, b.resourceIds)}`);
  }
}

// ---------------------------------------------------------------------------
// 帮助与入口
// ---------------------------------------------------------------------------

const HELP_TEXT = `shiftbook —— 本地多资源单次预约

用法:
  node app.ts [--data <数据文件>] <命令> [选项]

全局选项:
  --data <文件>   本地 JSON 数据文件（默认: ${DEFAULT_DATA_FILE}）
                  文件不存在时按空数据处理；文件损坏或结构非法时报错并保留原文件
  -h, --help      显示本帮助

资源命令:
  add-resource --type <venue|equipment|person> --name <名称> \\
      --open <YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm> [--open ...]
      登记场地/设备/人员（类型也可写 场地、设备、人员），返回稳定标识，如 R0001
  list-resources
      列出全部资源的标识、类型、名称与开放区间

预约命令:
  create-booking --resource <标识> [--resource <标识> ...] \\
      --start <YYYY-MM-DDTHH:mm> --end <YYYY-MM-DDTHH:mm>
      一次占用全部所选资源，返回稳定标识，如 B0001
  reschedule-booking <预约标识> [--start <时间>] [--end <时间>] \\
      [--resource <标识> ...]
      修改时间和/或资源（出现 --resource 即整体替换资源集合），标识保持不变
  cancel-booking <预约标识>
      取消预约并释放全部资源；对已取消记录再次取消成功且无变化
  list-bookings --date <YYYY-MM-DD>
      列出与该日相交的预约（含跨日、已取消），按开始时间再按标识排序

时间规则:
  日期时间格式 YYYY-MM-DDTHH:mm，查询日期 YYYY-MM-DD；
  为与机器时区无关的营业地时间，日期必须真实有效，结束晚于开始，允许跨日；
  区间左闭右开：一个预约的结束恰为另一预约的开始不算冲突；
  开放区间重叠或相接视为连续开放，预约须被每个所选资源的开放区间完整覆盖；
  仅当存在共同资源且时间重叠时预约才冲突。

退出码:
  0  成功
  1  业务失败（名称为空、未知/重复资源、时间非法、开放不足、冲突、数据文件损坏等）
  2  用法错误（未知参数、缺少必需选项等）

示例:
  node app.ts add-resource --type 场地 --name 一号会议室 \\
      --open 2026-10-05T09:00/2026-10-05T18:00
  node app.ts create-booking --resource R0001 \\
      --start 2026-10-05T10:00 --end 2026-10-05T11:00
  node app.ts reschedule-booking B0001 --start 2026-10-05T14:00 --end 2026-10-05T15:00
  node app.ts list-bookings --date 2026-10-05
  node app.ts cancel-booking B0001
`;

let activeDataFile = DEFAULT_DATA_FILE;

async function main(): Promise<void> {
  const globalArgs = splitGlobalArgs(process.argv.slice(2));
  activeDataFile = globalArgs.dataFile;

  if (globalArgs.help || globalArgs.rest.length === 0) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const [command, ...commandArgs] = globalArgs.rest;
  switch (command) {
    case 'add-resource':
      await cmdAddResource(commandArgs);
      break;
    case 'list-resources':
      await cmdListResources();
      break;
    case 'create-booking':
      await cmdCreateBooking(commandArgs);
      break;
    case 'reschedule-booking':
      await cmdRescheduleBooking(commandArgs);
      break;
    case 'cancel-booking':
      await cmdCancelBooking(commandArgs);
      break;
    case 'list-bookings':
      await cmdListBookings(commandArgs);
      break;
    default:
      throw new UsageError(`未知命令: ${command}`);
  }
}

main().catch((err: unknown) => {
  if (err instanceof UsageError) {
    process.stderr.write(`${APP}: ${err.message}\n使用 --help 查看用法。\n`);
    process.exit(2);
  }
  const message = err instanceof BizError ? err.message : (err as Error).stack ?? String(err);
  process.stderr.write(`${APP}: ${message}\n`);
  process.exit(1);
});
