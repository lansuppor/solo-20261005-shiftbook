// shiftbook —— 本地多资源预约命令行工具
// 运行环境：Node.js 24（直接执行 TypeScript，无外部运行依赖）
//
// 时间一律使用与机器时区无关的营业地时间：
//   日期时间 YYYY-MM-DDTHH:mm，查询日期 YYYY-MM-DD
// 内部统一换算为“自公元 1 年起的分钟数”做比较，杜绝时区影响。
// 区间左闭右开 [start, end)，允许跨日。
//
// 预约系列：create-series 按周（每 7 个营业地日历日）生成多项预约，
// 全部成员使用相同资源；成员记录与普通预约同表，带 seriesId 归属。
//
// 候补队列：add-waitlist 登记“固定时段 + 多资源”的候补，
// add-flex-waitlist 登记“弹性窗口 + 所需连续时长 + 多资源”的候补（不占用资源，
// 登记时窗口内共同实际可用时间能容纳完整时长即可，忽略预约占用）；两种候补共用
// 同一条登记顺序，process-waitlist 按登记顺序手动处理整个队列（弹性项取窗口内
// 最早可行开始），为可兑现项各创建一项普通预约，受阻项继续等待且不影响后续项。
//
// iCalendar 导入：import-ical 读取本地 UTF-8 的 VCALENDAR（VERSION:2.0），
// 为每个新 VEVENT 创建一项普通预约（统一使用命令行给定的资源集合，不加入系列、
// 不自动处理候补）；UID 永久关联首次生成的预约，相同 UID 且时间、资源集合一致
// 为重放（不改动原预约），不一致则整批拒绝。
//
// 多项预约目标（系列成员、批量改期目标、撤销恢复安排、导入新事件）的可行性
// 校验统一由 validateBatchTargets 完成（无写入副作用），各入口只负责展开
// 目标、给出需排除的当前占用，并按各自业务定位与顺序渲染诊断。

import {readFile, writeFile, rename, unlink} from 'node:fs/promises';

const APP = 'shiftbook';
const DEFAULT_DATA_FILE = 'shiftbook-data.json';

// 四位年份范围（与输入格式 YYYY 一致）；系列推算出的时间落在此范围外即拒绝
const MIN_YEAR = 1;
const MAX_YEAR = 9999;
// 系列最大次数：首项 + 每周一次，杜绝荒谬输入导致的长循环
const MAX_OCCURRENCES = 100000;

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

// Howard Hinnant 的 civil-from-days 算法（对负年同样成立）
function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0);
  const era = Math.floor(yy >= 0 ? yy / 400 : (yy - 399) / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// civil-from-days 逆算法：分钟数还原为营业地（年, 月, 日, 时, 分）
function civilFromDays(z: number): {y: number; m: number; d: number} {
  const zz = z + 719468;
  const era = Math.floor(zz >= 0 ? Math.floor(zz / 146097) : Math.floor((zz - 146096) / 146097));
  const doe = zz - era * 146097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)); // [0, 365]
  const mp = Math.floor((5 * doy + 2) / 153); // [0, 11]
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1; // [1, 31]
  const m = mp + (mp < 10 ? 3 : -9); // [1, 12]
  return {y: y + (m <= 2 ? 1 : 0), m, d};
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// 分钟数 -> YYYY-MM-DDTHH:mm；超出四位年份范围返回 null（绝不依赖机器时区）
function formatDateTime(min: number): string | null {
  const day = Math.floor(min / 1440);
  const rem = min - day * 1440;
  const {y, m, d} = civilFromDays(day);
  if (y < MIN_YEAR || y > MAX_YEAR) return null;
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}T${pad2(Math.floor(rem / 60))}:${pad2(rem % 60)}`;
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
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month) ||
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

// 将一组已合并区间裁剪到窗口 [wStart, wEnd) 内（左闭右开），丢弃不相交段
function clipSegments(
  segments: Array<[number, number]>,
  wStart: number,
  wEnd: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [s, e] of segments) {
    const a = Math.max(s, wStart);
    const b = Math.min(e, wEnd);
    if (a < b) out.push([a, b]);
  }
  return out;
}

// 两组已合并区间的交集（左闭右开）；切点相接（b===a）长度为 0，自然不产生段
function intersectSegments(
  a: Array<[number, number]>,
  b: Array<[number, number]>,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i][0], b[j][0]);
    const hi = Math.min(a[i][1], b[j][1]);
    if (lo < hi) out.push([lo, hi]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

// 多资源在窗口 [wStart, wEnd) 内的共同实际可用区间：
// 各自实际可用时间（开放合并后扣除有效停用并集）裁进窗口后逐组求交
function commonAvailableSegments(
  store: Store,
  ids: string[],
  wStart: number,
  wEnd: number,
): Array<[number, number]> {
  let common: Array<[number, number]> = [[wStart, wEnd]];
  for (const id of ids) {
    const r = store.resources.find((x) => x.id === id)!;
    const clipped = clipSegments(availableSegmentsOf(store, r), wStart, wEnd);
    common = intersectSegments(common, clipped);
    if (common.length === 0) break;
  }
  return common;
}

// ---------------------------------------------------------------------------
// 数据模型与文件存取
// ---------------------------------------------------------------------------

type ResourceType = 'venue' | 'equipment' | 'person';
type BookingStatus = 'active' | 'cancelled';
type WaitlistStatus = 'waiting' | 'fulfilled' | 'cancelled';
type WaitlistKind = 'fixed' | 'flexible'; // 固定时段候补 / 弹性时段候补
type ClosureStatus = 'active' | 'cancelled';
type BatchOpStatus = 'active' | 'undone'; // 批量改期操作：未撤销 / 已撤销

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
  seriesId?: string;
}

interface SeriesRec {
  id: string;
}

interface WaitlistRec {
  id: string; // 候补标识 W0001…，稳定且不复用
  kind: WaitlistKind; // fixed=固定时段；flexible=弹性时段（窗口内寻找最早连续时长）
  resourceIds: string[]; // 原请求资源（按标识排序）
  start: string; // 原请求开始时间；弹性项为窗口开始
  end: string; // 原请求结束时间；弹性项为窗口结束
  durationMinutes?: number; // 仅弹性项：所需连续时长（正整数分钟，不超过窗口长度）
  status: WaitlistStatus;
  seq: number; // 登记序号：1 基，列表与处理均按此稳定排序，重启后仍在
  bookingId?: string; // 已兑现时关联的普通预约标识
}

interface ClosureRec {
  id: string; // 停用标识 C0001…，稳定且不复用
  resourceId: string; // 单个已登记资源
  start: string;
  end: string;
  status: ClosureStatus;
}

// 一次批量改期提交中的单项快照（按清单顺序）
interface BatchOpItem {
  bookingId: string;
  seriesId?: string; // 提交时的系列归属（无系列则不含）
  before: {start: string; end: string; resourceIds: string[]}; // 改期前安排
  after: {start: string; end: string; resourceIds: string[]}; // 改期后安排（提交目标）
}

interface BatchOpRec {
  id: string; // 批量改期操作标识 O0001…，稳定且不复用（即使记录已撤销）
  status: BatchOpStatus;
  items: BatchOpItem[]; // 按提交（清单）顺序
}

// 一次 iCalendar 导入建立的“UID -> 预约”永久关联：
// 快照保留首次导入的时间与资源集合（之后预约被改期/取消/撤销也不变），
// 重放按快照比对本次请求，身份不依赖导入文件路径
interface ImportRec {
  uid: string; // 解码后的 UID（区分大小写），同一数据文件内唯一
  bookingId: string; // 首次导入生成的预约标识
  start: string; // 首次导入的开始时间快照 YYYY-MM-DDTHH:mm
  end: string; // 首次导入的结束时间快照
  resourceIds: string[]; // 首次导入的资源集合快照（按标识排序）
}

interface Store {
  version: 1;
  resourceSeq: number;
  bookingSeq: number;
  seriesSeq: number;
  waitlistSeq: number; // 已分配的最大候补序号（计数不复用）
  closureSeq: number; // 已分配的最大停用序号（计数不复用）
  batchSeq: number; // 已分配的最大批量改期操作序号（计数不复用，撤销也不回收）
  resources: ResourceRec[];
  bookings: BookingRec[];
  series: SeriesRec[];
  waitlist: WaitlistRec[];
  closures: ClosureRec[];
  batchOps: BatchOpRec[];
  imports: ImportRec[];
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
  return {
    version: 1,
    resourceSeq: 0,
    bookingSeq: 0,
    seriesSeq: 0,
    waitlistSeq: 0,
    closureSeq: 0,
    batchSeq: 0,
    resources: [],
    bookings: [],
    series: [],
    waitlist: [],
    closures: [],
    batchOps: [],
    imports: [],
  };
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
  if (o.seriesSeq !== undefined) {
    if (!isInt(o.seriesSeq)) bad('seriesSeq 必须是非负整数');
    store.seriesSeq = o.seriesSeq;
  }
  if (o.waitlistSeq !== undefined) {
    if (!isInt(o.waitlistSeq)) bad('waitlistSeq 必须是非负整数');
    store.waitlistSeq = o.waitlistSeq;
  }
  if (o.closureSeq !== undefined) {
    if (!isInt(o.closureSeq)) bad('closureSeq 必须是非负整数');
    store.closureSeq = o.closureSeq;
  }
  if (o.batchSeq !== undefined) {
    if (!isInt(o.batchSeq)) bad('batchSeq 必须是非负整数');
    store.batchSeq = o.batchSeq;
  }

  if (o.resources !== undefined && !Array.isArray(o.resources)) bad('resources 必须是数组');
  if (o.bookings !== undefined && !Array.isArray(o.bookings)) bad('bookings 必须是数组');
  if (o.series !== undefined && !Array.isArray(o.series)) bad('series 必须是数组');
  if (o.waitlist !== undefined && !Array.isArray(o.waitlist)) bad('waitlist 必须是数组');
  if (o.closures !== undefined && !Array.isArray(o.closures)) bad('closures 必须是数组');
  if (o.batchOps !== undefined && !Array.isArray(o.batchOps)) bad('batchOps 必须是数组');
  if (o.imports !== undefined && !Array.isArray(o.imports)) bad('imports 必须是数组');
  const rawResources = (o.resources ?? []) as unknown[];
  const rawBookings = (o.bookings ?? []) as unknown[];
  const rawSeries = (o.series ?? []) as unknown[];
  const rawWaitlist = (o.waitlist ?? []) as unknown[];
  const rawClosures = (o.closures ?? []) as unknown[];
  const rawBatchOps = (o.batchOps ?? []) as unknown[];
  const rawImports = (o.imports ?? []) as unknown[];

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

  // 系列先于预约校验：预约的 seriesId 必须指向真实存在的系列
  const seriesIds = new Set<string>();
  rawSeries.forEach((item, idx) => {
    const at = `series[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const s = item as Record<string, unknown>;
    if (typeof s.id !== 'string' || !/^S\d{4,}$/.test(s.id)) bad(`${at}.id 非法: ${String(s.id)}`);
    if (seriesIds.has(s.id)) bad(`系列标识重复: ${s.id}`);
    seriesIds.add(s.id);
    store.series.push({id: s.id});
    const n = Number(s.id.slice(1));
    if (n > store.seriesSeq) store.seriesSeq = n;
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
    let seriesId: string | undefined;
    if (b.seriesId !== undefined) {
      if (typeof b.seriesId !== 'string' || !/^S\d{4,}$/.test(b.seriesId)) {
        bad(`${at}(${b.id}).seriesId 非法: ${String(b.seriesId)}`);
      }
      if (!seriesIds.has(b.seriesId)) bad(`${at}(${b.id}) 引用了未知系列: ${b.seriesId}`);
      seriesId = b.seriesId;
    }
    const rec: BookingRec = {
      id: b.id,
      resourceIds: [...(ids as string[])].sort(),
      start: b.start,
      end: b.end,
      status: b.status,
    };
    if (seriesId !== undefined) rec.seriesId = seriesId;
    store.bookings.push(rec);
    const n = Number(b.id.slice(1));
    if (n > store.bookingSeq) store.bookingSeq = n;
  });

  // 候补最后校验：其 bookingId 关联必须指向真实存在的预约
  const waitlistIds = new Set<string>();
  const waitlistSeqs = new Set<number>();
  const linkedBookings = new Set<string>();
  const bookingById = new Map(store.bookings.map((b) => [b.id, b]));
  rawWaitlist.forEach((item, idx) => {
    const at = `waitlist[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const w = item as Record<string, unknown>;
    if (typeof w.id !== 'string' || !/^W\d{4,}$/.test(w.id)) bad(`${at}.id 非法: ${String(w.id)}`);
    if (waitlistIds.has(w.id)) bad(`候补标识重复: ${w.id}`);
    waitlistIds.add(w.id);
    const wn = Number(w.id.slice(1));
    if (wn > store.waitlistSeq) store.waitlistSeq = wn;

    if (!isInt(w.seq) || w.seq < 1) bad(`${at}(${w.id}).seq 必须是正整数`);
    if (waitlistSeqs.has(w.seq)) bad(`${at}(${w.id}) 候补登记序号重复: ${w.seq}`);
    waitlistSeqs.add(w.seq);
    // 标识序号即登记序号（W0005 的 seq 必须为 5），不一致说明状态机已损坏
    if (w.seq !== wn) {
      bad(`${at}(${w.id}) 登记序号 ${w.seq} 与标识序号 ${wn} 不一致`);
    }

    if (!Array.isArray(w.resourceIds) || w.resourceIds.length === 0) {
      bad(`${at}(${w.id}).resourceIds 必须是非空数组`);
    }
    const ids = w.resourceIds as unknown[];
    const wseen = new Set<string>();
    ids.forEach((rid) => {
      if (typeof rid !== 'string' || !resourceIds.has(rid)) {
        bad(`${at}(${w.id}) 引用了未知资源: ${String(rid)}`);
      }
      if (wseen.has(rid)) bad(`${at}(${w.id}) 资源重复: ${rid}`);
      wseen.add(rid);
    });

    if (typeof w.start !== 'string' || typeof w.end !== 'string') {
      bad(`${at}(${w.id}) 起止时间必须是字符串`);
    }
    const ws = parseDateTime(w.start as string, `${at}(${w.id}).start`);
    const we = parseDateTime(w.end as string, `${at}(${w.id}).end`);
    if (we <= ws) bad(`${at}(${w.id}) 结束必须晚于开始`);

    // 旧文件无 kind 字段，按固定时段候补直接兼容
    let kind: WaitlistKind = 'fixed';
    if (w.kind !== undefined) {
      if (w.kind !== 'fixed' && w.kind !== 'flexible') {
        bad(`${at}(${w.id}).kind 非法: ${String(w.kind)}`);
      }
      kind = w.kind;
    }

    // 弹性项独有 durationMinutes：正整数分钟且不超过窗口长度；
    // 固定项不得携带（携带即视为状态机损坏）
    let durationMinutes: number | undefined;
    if (w.durationMinutes !== undefined) {
      if (!isInt(w.durationMinutes) || w.durationMinutes < 1) {
        bad(`${at}(${w.id}).durationMinutes 必须是正整数`);
      }
      durationMinutes = w.durationMinutes;
    }
    if (kind === 'flexible') {
      if (durationMinutes === undefined) {
        bad(`${at}(${w.id}) 弹性候补缺少 durationMinutes`);
      } else if (durationMinutes > we - ws) {
        bad(`${at}(${w.id}) 所需时长 ${durationMinutes} 分钟超过窗口长度 ${we - ws} 分钟`);
      }
    } else if (durationMinutes !== undefined) {
      bad(`${at}(${w.id}) 固定时段候补不应携带 durationMinutes`);
    }

    if (w.status !== 'waiting' && w.status !== 'fulfilled' && w.status !== 'cancelled') {
      bad(`${at}(${w.id}).status 非法: ${String(w.status)}`);
    }

    let bookingId: string | undefined;
    if (w.bookingId !== undefined) {
      if (typeof w.bookingId !== 'string' || !/^B\d{4,}$/.test(w.bookingId)) {
        bad(`${at}(${w.id}).bookingId 非法: ${String(w.bookingId)}`);
      }
      const linked = bookingById.get(w.bookingId);
      if (!linked) bad(`${at}(${w.id}) 关联了未知预约: ${w.bookingId}`);
      if (linkedBookings.has(w.bookingId)) {
        bad(`${at}(${w.id}) 预约 ${w.bookingId} 已被另一项候补关联（一项预约只能对应一项候补）`);
      }
      linkedBookings.add(w.bookingId);
      bookingId = w.bookingId;
    }

    // 状态与关联必须自洽，否则视为数据损坏，拒绝加载（原文件保留）。
    // 已兑现候补关联的预约可被现有入口改期或取消：候补保留原请求与关联、
    // 不恢复等待，因此不要求关联预约的时间、资源或状态仍与原请求一致。
    if (w.status === 'fulfilled') {
      if (bookingId === undefined) {
        bad(`${at}(${w.id}) 已兑现但缺少关联预约标识 bookingId`);
      }
    } else if (bookingId !== undefined) {
      bad(`${at}(${w.id}) 状态为 ${w.status} 却携带关联预约 ${bookingId}（仅已兑现项可有）`);
    }

    const rec: WaitlistRec = {
      id: w.id,
      kind,
      resourceIds: [...(ids as string[])].sort(),
      start: w.start as string,
      end: w.end as string,
      status: w.status as WaitlistStatus,
      seq: w.seq,
    };
    if (durationMinutes !== undefined) rec.durationMinutes = durationMinutes;
    if (bookingId !== undefined) rec.bookingId = bookingId;
    store.waitlist.push(rec);
  });
  if (store.waitlistSeq !== 0 && store.waitlist.length === 0) {
    bad('waitlistSeq 非零却没有任何候补记录（计数与记录不一致）');
  }
  // 候补记录从不删除（取消也保留），序号集合必须恰好为 1..waitlistSeq
  for (let i = 1; i <= store.waitlistSeq; i++) {
    if (!waitlistSeqs.has(i)) bad(`候补队列缺号：找不到登记序号 ${i} 的记录`);
  }

  // 停用记录：引用已登记资源；取消仅改状态，记录从不删除
  const closureIds = new Set<string>();
  const closureNums = new Set<number>();
  rawClosures.forEach((item, idx) => {
    const at = `closures[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const c = item as Record<string, unknown>;
    if (typeof c.id !== 'string' || !/^C\d{4,}$/.test(c.id)) bad(`${at}.id 非法: ${String(c.id)}`);
    if (closureIds.has(c.id)) bad(`停用标识重复: ${c.id}`);
    closureIds.add(c.id);
    const cn = Number(c.id.slice(1));
    if (cn > store.closureSeq) store.closureSeq = cn;
    closureNums.add(cn);

    if (typeof c.resourceId !== 'string' || !resourceIds.has(c.resourceId)) {
      bad(`${at}(${c.id}) 引用了未知资源: ${String(c.resourceId)}`);
    }
    if (typeof c.start !== 'string' || typeof c.end !== 'string') {
      bad(`${at}(${c.id}) 起止时间必须是字符串`);
    }
    const cs = parseDateTime(c.start, `${at}(${c.id}).start`);
    const ce = parseDateTime(c.end, `${at}(${c.id}).end`);
    if (ce <= cs) bad(`${at}(${c.id}) 结束必须晚于开始`);
    if (c.status !== 'active' && c.status !== 'cancelled') {
      bad(`${at}(${c.id}).status 非法: ${String(c.status)}`);
    }
    store.closures.push({
      id: c.id,
      resourceId: c.resourceId,
      start: c.start,
      end: c.end,
      status: c.status,
    });
  });
  if (store.closureSeq !== 0 && store.closures.length === 0) {
    bad('closureSeq 非零却没有任何停用记录（计数与记录不一致）');
  }
  // 停用记录从不删除（取消也保留），标识序号集合必须恰好为 1..closureSeq
  for (let i = 1; i <= store.closureSeq; i++) {
    if (!closureNums.has(i)) bad(`停用记录缺号：找不到标识序号 ${i} 的记录`);
  }

  // 批量改期操作记录：撤销也不删除、不回收标识；快照与现状可能不同（期间被其他
  // 入口改期或取消），这不算损坏——因此只校验记录结构、引用与快照自身合法性，
  // 不要求快照与预约当前安排一致。
  const batchOpIds = new Set<string>();
  const batchOpNums = new Set<number>();
  rawBatchOps.forEach((item, idx) => {
    const at = `batchOps[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const op = item as Record<string, unknown>;
    if (typeof op.id !== 'string' || !/^O\d{4,}$/.test(op.id)) bad(`${at}.id 非法: ${String(op.id)}`);
    if (batchOpIds.has(op.id)) bad(`批量改期操作标识重复: ${op.id}`);
    batchOpIds.add(op.id);
    const on = Number(op.id.slice(1));
    if (on > store.batchSeq) store.batchSeq = on;
    batchOpNums.add(on);

    if (op.status !== 'active' && op.status !== 'undone') {
      bad(`${at}(${op.id}).status 非法: ${String(op.status)}`);
    }

    if (!Array.isArray(op.items) || op.items.length === 0) {
      bad(`${at}(${op.id}).items 必须是非空数组`);
    }
    const itemRecs = op.items as unknown[];
    const itemBookingIds = new Set<string>();
    const validateSide = (
      sideRaw: unknown,
      sideName: string,
    ): {start: string; end: string; resourceIds: string[]} => {
      const sat = `${at}(${op.id}).items[?].${sideName}`;
      if (typeof sideRaw !== 'object' || sideRaw === null || Array.isArray(sideRaw)) {
        bad(`${sat} 必须是对象`);
      }
      const side = sideRaw as Record<string, unknown>;
      for (const k of Object.keys(side)) {
        if (k !== 'start' && k !== 'end' && k !== 'resourceIds') {
          bad(`${sat} 存在未知字段 “${k}”（只允许 start、end、resourceIds）`);
        }
      }
      if (typeof side.start !== 'string' || typeof side.end !== 'string') {
        bad(`${sat} 起止时间必须是字符串`);
      }
      const s = parseDateTime(side.start as string, `${sat}.start`);
      const e = parseDateTime(side.end as string, `${sat}.end`);
      if (e <= s) bad(`${sat} 结束必须晚于开始`);
      if (!Array.isArray(side.resourceIds) || side.resourceIds.length === 0) {
        bad(`${sat}.resourceIds 必须是非空数组`);
      }
      const ids = side.resourceIds as unknown[];
      const seen = new Set<string>();
      ids.forEach((rid) => {
        if (typeof rid !== 'string' || !resourceIds.has(rid)) {
          bad(`${sat} 引用了未知资源: ${String(rid)}`);
        }
        if (seen.has(rid as string)) bad(`${sat} 资源重复: ${rid}`);
        seen.add(rid as string);
      });
      return {start: side.start as string, end: side.end as string, resourceIds: [...seen].sort()};
    };

    const opItems: BatchOpItem[] = [];
    itemRecs.forEach((itRaw, j) => {
      const iat = `${at}(${op.id}).items[${j}]`;
      if (typeof itRaw !== 'object' || itRaw === null || Array.isArray(itRaw)) {
        bad(`${iat} 必须是对象`);
      }
      const it = itRaw as Record<string, unknown>;
      for (const k of Object.keys(it)) {
        if (k !== 'bookingId' && k !== 'seriesId' && k !== 'before' && k !== 'after') {
          bad(`${iat} 存在未知字段 “${k}”（只允许 bookingId、seriesId、before、after）`);
        }
      }
      if (typeof it.bookingId !== 'string' || !/^B\d{4,}$/.test(it.bookingId)) {
        bad(`${iat}.bookingId 非法: ${String(it.bookingId)}`);
      }
      if (itemBookingIds.has(it.bookingId as string)) {
        bad(`${iat} 预约标识在同一操作内重复: ${it.bookingId}`);
      }
      itemBookingIds.add(it.bookingId as string);
      // 预约记录从不物理删除（取消也保留），引用必须可解析
      if (!bookingById.has(it.bookingId as string)) {
        bad(`${iat} 引用了未知预约: ${it.bookingId}`);
      }
      let seriesId: string | undefined;
      if (it.seriesId !== undefined) {
        if (typeof it.seriesId !== 'string' || !/^S\d{4,}$/.test(it.seriesId)) {
          bad(`${iat}.seriesId 非法: ${String(it.seriesId)}`);
        }
        if (!seriesIds.has(it.seriesId)) bad(`${iat} 引用了未知系列: ${it.seriesId}`);
        seriesId = it.seriesId;
      }
      if (it.before === undefined) bad(`${iat} 缺少改期前快照 before`);
      if (it.after === undefined) bad(`${iat} 缺少改期后快照 after`);
      const before = validateSide(it.before, 'before');
      const after = validateSide(it.after, 'after');
      const rec: BatchOpItem = {
        bookingId: it.bookingId as string,
        before,
        after,
      };
      if (seriesId !== undefined) rec.seriesId = seriesId;
      opItems.push(rec);
    });

    store.batchOps.push({
      id: op.id,
      status: op.status as BatchOpStatus,
      items: opItems,
    });
  });
  if (store.batchSeq !== 0 && store.batchOps.length === 0) {
    bad('batchSeq 非零却没有任何批量改期操作记录（计数与记录不一致）');
  }
  // 操作记录从不删除（撤销也保留），标识序号集合必须恰好为 1..batchSeq
  for (let i = 1; i <= store.batchSeq; i++) {
    if (!batchOpNums.has(i)) bad(`批量改期操作记录缺号：找不到标识序号 ${i} 的记录`);
  }

  // iCalendar 导入身份记录：UID 唯一且非空；关联的预约必须真实存在且不被另一条
  // 导入记录重复关联；快照自身须合法（真实时间、结束晚于开始、资源已知且不重复）。
  // 快照与预约现状不同不算损坏（预约可能已被改期、取消或随批量改期撤销而变动）。
  const importUids = new Set<string>();
  const importLinkedBookings = new Set<string>();
  rawImports.forEach((item, idx) => {
    const at = `imports[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const im = item as Record<string, unknown>;
    if (typeof im.uid !== 'string' || im.uid === '') bad(`${at}.uid 必须是非空字符串`);
    if (importUids.has(im.uid)) bad(`导入记录 UID 重复: ${im.uid}`);
    importUids.add(im.uid);
    if (typeof im.bookingId !== 'string' || !/^B\d{4,}$/.test(im.bookingId)) {
      bad(`${at}(UID “${im.uid}”).bookingId 非法: ${String(im.bookingId)}`);
    }
    if (!bookingById.has(im.bookingId)) {
      bad(`${at}(UID “${im.uid}”) 关联了未知预约: ${im.bookingId}`);
    }
    if (importLinkedBookings.has(im.bookingId)) {
      bad(`${at}(UID “${im.uid}”) 预约 ${im.bookingId} 已被另一条导入记录关联（一项预约只能对应一个 UID）`);
    }
    importLinkedBookings.add(im.bookingId);
    if (typeof im.start !== 'string' || typeof im.end !== 'string') {
      bad(`${at}(UID “${im.uid}”) 快照起止时间必须是字符串`);
    }
    const s = parseDateTime(im.start, `${at}(UID “${im.uid}”).start`);
    const e = parseDateTime(im.end, `${at}(UID “${im.uid}”).end`);
    if (e <= s) bad(`${at}(UID “${im.uid}”) 快照结束必须晚于开始`);
    if (!Array.isArray(im.resourceIds) || im.resourceIds.length === 0) {
      bad(`${at}(UID “${im.uid}”).resourceIds 必须是非空数组`);
    }
    const rids = im.resourceIds as unknown[];
    const rseen = new Set<string>();
    rids.forEach((rid) => {
      if (typeof rid !== 'string' || !resourceIds.has(rid)) {
        bad(`${at}(UID “${im.uid}”) 快照引用了未知资源: ${String(rid)}`);
      }
      if (rseen.has(rid)) bad(`${at}(UID “${im.uid}”) 快照资源重复: ${rid}`);
      rseen.add(rid);
    });
    store.imports.push({
      uid: im.uid,
      bookingId: im.bookingId,
      start: im.start,
      end: im.end,
      resourceIds: [...rseen].sort(),
    });
  });

  store.resources.sort((a, b) => a.id.localeCompare(b.id));
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  store.series.sort((a, b) => a.id.localeCompare(b.id));
  store.waitlist.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  store.closures.sort((a, b) => a.id.localeCompare(b.id));
  store.batchOps.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  store.imports.sort((a, b) => a.uid.localeCompare(b.uid));
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

// 从连续区间中扣除一段停用（左闭右开），返回剩余连续区间
function subtractSegments(
  segments: Array<[number, number]>,
  cuts: Array<[number, number]>,
): Array<[number, number]> {
  let result = segments;
  for (const [cs, ce] of mergeIntervals(cuts)) {
    const next: Array<[number, number]> = [];
    for (const [s, e] of result) {
      if (ce <= s || e <= cs) {
        next.push([s, e]);
        continue;
      }
      if (s < cs) next.push([s, cs]);
      if (ce < e) next.push([ce, e]);
    }
    result = next;
  }
  return result;
}

// 某资源的有效停用记录（按开始时间、标识排序）
function activeClosuresOf(store: Store, resourceId: string): ClosureRec[] {
  return store.closures
    .filter((c) => c.resourceId === resourceId && c.status === 'active')
    .sort(
      (a, b) =>
        parseDateTime(a.start, '停用开始时间') - parseDateTime(b.start, '停用开始时间') ||
        a.id.localeCompare(b.id),
    );
}

// 实际可用时间：原开放区间合并后，扣除该资源全部有效停用区间的并集（原开放记录保留）
function availableSegmentsOf(store: Store, r: ResourceRec): Array<[number, number]> {
  const cuts = activeClosuresOf(store, r.id).map(
    (c) =>
      [parseDateTime(c.start, '停用开始时间'), parseDateTime(c.end, '停用结束时间')] as [number, number],
  );
  return subtractSegments(openSegmentsOf(r), cuts);
}

interface CoverageGap {
  id: string;
  r: ResourceRec;
  closures: ClosureRec[]; // 与该区间重叠的相关有效停用（按开始时间、标识排序）
}

// 找出实际可用时间（开放扣除有效停用）不能完整覆盖 [startMin, endMin) 的资源
function findCoverageGaps(
  store: Store,
  ids: string[],
  startMin: number,
  endMin: number,
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  for (const id of ids) {
    const r = store.resources.find((x) => x.id === id)!;
    if (isFullyCovered(availableSegmentsOf(store, r), startMin, endMin)) continue;
    const closures = activeClosuresOf(store, id).filter((c) => {
      const cs = parseDateTime(c.start, '停用开始时间');
      const ce = parseDateTime(c.end, '停用结束时间');
      return cs < endMin && startMin < ce;
    });
    gaps.push({id, r, closures});
  }
  return gaps;
}

// 开放不足资源的统一展示：资源行 + 相关有效停用（标识与时间）
function gapLines(gaps: CoverageGap[], indent: string): string[] {
  const lines: string[] = [];
  for (const g of gaps) {
    lines.push(`${indent}- ${g.id}（${g.r.name}）`);
    for (const c of g.closures) {
      lines.push(`${indent}  相关有效停用: ${c.id}（${c.start} → ${c.end}）`);
    }
  }
  return lines;
}

// 校验每个资源的实际可用时间都能完整覆盖 [startMin, endMin)
function assertOpenCoverage(store: Store, ids: string[], startMin: number, endMin: number): void {
  const failing = findCoverageGaps(store, ids, startMin, endMin);
  if (failing.length > 0) {
    throw new BizError(
      '开放时间不足，以下资源的实际可用时间（开放区间扣除有效停用）不能完整覆盖预约区间：\n' +
        gapLines(failing, '').join('\n'),
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
// 多项预约目标的统一批次校验（无写入副作用）
//
// 创建系列、批量改期、安全撤销与 iCalendar 导入共用本套逻辑，不再各自重复
// 整批可行性循环。校验针对“全部目标生效后”的安排，统一三类检查：
//   1) 实际可用覆盖：开放区间重叠或相接合并后扣除有效停用并集，须连续覆盖目标；
//   2) 批外占用：批外有效预约（已取消不占用）与目标的共同资源时间重叠；
//   3) 批内冲突：本批各目标彼此之间的共同资源时间重叠。
// 区间一律左闭右开，端点相接可行；仅共同资源重叠才算冲突。
// 本函数只读取数据与目标，绝不修改目标、业务记录或标识计数；
// 全部失败项一次性收集（批内冲突在双方各自的失败项中都出现），
// 诊断的业务定位（成员时间/预约标识/UID）与报告顺序由各入口负责。
// ---------------------------------------------------------------------------

interface ValidationTarget {
  startMin: number;
  endMin: number;
  resourceIds: string[]; // 已校验、按标识排序的完整目标资源集合
}

interface BatchTargetFailure {
  index: number; // 目标数组下标（0 基）；报告顺序与业务定位由入口决定
  gaps: CoverageGap[]; // 实际可用时间不能完整覆盖目标的资源及相关有效停用
  external: Conflict[]; // 与批外有效预约的冲突（按预约标识排序）
  internal: Array<{otherIndex: number; shared: string[]}>; // 批内冲突（双方互见）
}

// excludeBookingIds：本批涉及预约的标识，其当前占用不计入批外占用
// （改期与撤销据此允许整批交换时段和资源；系列与导入传空集合）
function validateBatchTargets(
  store: Store,
  targets: ReadonlyArray<ValidationTarget>,
  excludeBookingIds: ReadonlySet<string> = new Set<string>(),
): BatchTargetFailure[] {
  const failures: BatchTargetFailure[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const gaps = findCoverageGaps(store, t.resourceIds, t.startMin, t.endMin);
    const external = findConflicts(store, t.resourceIds, t.startMin, t.endMin).filter(
      (c) => !excludeBookingIds.has(c.booking.id),
    );
    const wanted = new Set(t.resourceIds);
    const internal: BatchTargetFailure['internal'] = [];
    for (let j = 0; j < targets.length; j++) {
      if (j === i) continue;
      const o = targets[j];
      if (!(o.startMin < t.endMin && t.startMin < o.endMin)) continue;
      const shared = o.resourceIds.filter((id) => wanted.has(id)).sort();
      if (shared.length > 0) internal.push({otherIndex: j, shared});
    }
    if (gaps.length > 0 || external.length > 0 || internal.length > 0) {
      failures.push({index: i, gaps, external, internal});
    }
  }
  return failures;
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

async function cmdListResources(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`list-resources 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) {
    throw new UsageError(`list-resources 不接受位置参数: ${positionals.join(' ')}`);
  }
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

  // 全部可用后整体替换旧安排并落盘；失败则本进程内存与磁盘上的原安排都不变。
  // seriesId 不随改期变化：改期后仍属原系列。
  booking.start = startRaw;
  booking.end = endRaw;
  booking.resourceIds = ids;
  await saveStore(file, store);
  console.log(`已改期预约 ${id}（标识保持不变）`);
  if (booking.seriesId) console.log(`  所属系列: ${booking.seriesId}（改期后仍属该系列）`);
  console.log(`  时间: ${startRaw} → ${endRaw}`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
}

// ---------------------------------------------------------------------------
// 批量原子改期（按本地清单一次交换多项预约的时段/资源）
// ---------------------------------------------------------------------------

interface BatchTarget {
  index: number; // 清单中的 0 基序号
  booking: BookingRec;
  startRaw: string;
  endRaw: string;
  startMin: number;
  endMin: number;
  resourceIds: string[]; // 已校验、按标识排序，整体替换原集合
}

// 读取清单文件：不可读、不是合法 JSON 均明确失败（绝不按空清单处理）
async function loadManifest(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new BizError(`无法读取改期清单 ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BizError(`改期清单 ${file} 已损坏，不是合法 JSON：${(err as Error).message}`);
  }
}

// 清单结构（与数据文件无关的纯类型校验）；返回逐项原始记录
function parseManifestShape(raw: unknown, file: string): Array<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BizError(`改期清单 ${file} 内容非法：顶层必须是对象，形如 {"items": [...]}`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'items') throw new BizError(`改期清单 ${file} 内容非法：存在未知字段 “${k}”，只允许 items`);
  }
  if (!Array.isArray(o.items)) {
    throw new BizError(`改期清单 ${file} 内容非法：items 必须是非空数组`);
  }
  const items = o.items as unknown[];
  if (items.length === 0) throw new BizError(`改期清单 ${file} 为空：items 至少包含一项改期安排`);

  const problems: string[] = [];
  const records: Array<Record<string, unknown> | null> = [];
  items.forEach((it, idx) => {
    const at = `第 ${idx + 1} 项`;
    if (typeof it !== 'object' || it === null || Array.isArray(it)) {
      problems.push(`${at} 必须是对象`);
      records.push(null);
      return;
    }
    const rec = it as Record<string, unknown>;
    for (const k of Object.keys(rec)) {
      if (k !== 'bookingId' && k !== 'start' && k !== 'end' && k !== 'resourceIds') {
        problems.push(`${at} 存在未知字段 “${k}”（只允许 bookingId、start、end、resourceIds）`);
      }
    }
    if (typeof rec.bookingId !== 'string' || rec.bookingId === '') {
      problems.push(`${at} 的 bookingId 必须是非空字符串`);
    }
    if (typeof rec.start !== 'string' || rec.start === '') {
      problems.push(`${at} 的 start 必须是 YYYY-MM-DDTHH:mm 形式的非空字符串`);
    }
    if (typeof rec.end !== 'string' || rec.end === '') {
      problems.push(`${at} 的 end 必须是 YYYY-MM-DDTHH:mm 形式的非空字符串`);
    }
    if (!Array.isArray(rec.resourceIds)) {
      problems.push(`${at} 的 resourceIds 必须是非空数组（完整目标资源集合，整体替换原集合）`);
    } else {
      if (rec.resourceIds.length === 0) problems.push(`${at} 的 resourceIds 不能为空：资源集合整体替换，至少一个资源`);
      rec.resourceIds.forEach((rid, j) => {
        if (typeof rid !== 'string' || rid === '') {
          problems.push(`${at}.resourceIds[${j}] 必须是非空资源标识字符串`);
        }
      });
    }
    records.push(rec);
  });
  if (problems.length > 0) {
    throw new BizError(`改期清单 ${file} 内容非法，整批拒绝：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return records as Array<Record<string, unknown>>;
}

async function cmdRescheduleBatch(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(
      `reschedule-batch 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`,
    );
  }
  if (positionals.length !== 1) {
    throw new UsageError('用法: reschedule-batch <改期清单文件>');
  }
  const manifestFile = positionals[0];

  const file = activeDataFile;
  const store = await loadStore(file);
  const records = parseManifestShape(await loadManifest(manifestFile), manifestFile);

  // 第一阶段：逐项做与业务数据相关的基础校验，收集全部问题后一次性拒绝整批
  const problems: string[] = [];
  const seenBooking = new Map<string, number>(); // 标识 -> 首次出现的序号（1 基）
  const planned: Array<BatchTarget | null> = [];
  records.forEach((rec, idx) => {
    const at = `第 ${idx + 1} 项（${rec.bookingId as string}）`;
    let ok = true;

    const firstAt = seenBooking.get(rec.bookingId as string);
    if (firstAt !== undefined) {
      problems.push(`${at} 预约标识重复：该标识已在第 ${firstAt} 项出现，每项预约在清单中只能出现一次`);
      ok = false;
    } else {
      seenBooking.set(rec.bookingId as string, idx + 1);
    }

    const booking = store.bookings.find((b) => b.id === rec.bookingId);
    if (!booking) {
      problems.push(`${at} 未知预约标识: ${rec.bookingId}`);
      ok = false;
    } else if (booking.status === 'cancelled') {
      problems.push(`${at} 预约 ${booking.id} 已取消，不能改期`);
      ok = false;
    }

    const rawRids = rec.resourceIds as string[];
    const dupes = rawRids.filter((id, j) => rawRids.indexOf(id) !== j);
    if (dupes.length > 0) problems.push(`${at} 资源重复指定: ${[...new Set(dupes)].join('、')}`);
    const unknown = [...new Set(rawRids)]
      .filter((id) => !store.resources.some((r) => r.id === id))
      .sort();
    if (unknown.length > 0) problems.push(`${at} 未知资源标识: ${unknown.join('、')}`);

    let startMin = 0;
    let endMin = 0;
    let startParsed = false;
    let endParsed = false;
    try {
      startMin = parseDateTime(rec.start as string, `${at} 目标开始时间`);
      startParsed = true;
    } catch (err) {
      problems.push((err as BizError).message);
    }
    try {
      endMin = parseDateTime(rec.end as string, `${at} 目标结束时间`);
      endParsed = true;
    } catch (err) {
      problems.push((err as BizError).message);
    }
    if (startParsed && endParsed && endMin <= startMin) {
      problems.push(
        `${at} 目标结束时间必须晚于开始时间（开始: ${rec.start}，结束: ${rec.end}），允许跨日`,
      );
      ok = false;
    }

    if (!ok || !booking) {
      planned.push(null);
      return;
    }
    planned.push({
      index: idx,
      booking,
      startRaw: rec.start as string,
      endRaw: rec.end as string,
      startMin,
      endMin,
      resourceIds: [...new Set(rawRids)].sort(),
    });
  });

  if (problems.length > 0) {
    throw new BizError(`改期清单 ${manifestFile} 校验失败，整批拒绝（原有安排保持不变）：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  const targets = planned as BatchTarget[];
  const batchIds = new Set(targets.map((t) => t.booking.id));

  // 第二阶段：对“整批完成后”的安排做统一批次校验（无写入副作用）。
  // 本批预约的旧占用一律不视为障碍（排除本批全部标识）；
  // 障碍只来自本批之外的有效预约，以及本批各项的目标安排彼此之间。
  const failures = validateBatchTargets(store, targets, batchIds);

  if (failures.length > 0) {
    // 按清单顺序报告全部不满足条件的项；批内冲突在双方项中都会出现
    const blocks = failures.map((f) => {
      const t = targets[f.index];
      const lines = [`第 ${t.index + 1} 项 ${t.booking.id} 目标 ${t.startRaw} → ${t.endRaw}：`];
      if (f.gaps.length > 0) {
        lines.push('  开放不足资源:');
        lines.push(...gapLines(f.gaps, '    '));
      }
      if (f.external.length + f.internal.length > 0) {
        lines.push('  冲突预约:');
        for (const c of f.external) {
          lines.push(
            `    - ${c.booking.id}（${c.booking.start} → ${c.booking.end}）` +
              `：共同资源 ${formatResourceIds(store, c.shared)}`,
          );
        }
        for (const x of f.internal) {
          const o = targets[x.otherIndex];
          lines.push(
            `    - ${o.booking.id}（本批第 ${o.index + 1} 项目标 ${o.startRaw} → ${o.endRaw}）` +
              `：共同资源 ${formatResourceIds(store, x.shared)}`,
          );
        }
      }
      return lines.join('\n');
    });
    throw new BizError(
      `批量改期失败：共 ${failures.length} 项不满足条件（按清单顺序），整批未改动：\n${blocks.join('\n')}`,
    );
  }

  // 全部验证通过：一次性替换各项目标安排并原子落盘。
  // 仅改时间与资源；标识、status、seriesId、标识计数全部不变，不创建任何预约或系列。
  // 若保存失败，磁盘原文件保留；本进程亦以退出码 1 结束，不会报告成功。
  // 资源集合均已按标识排序，按位比较即可
  const sameArrangement = (t: BatchTarget): boolean =>
    t.booking.start === t.startRaw &&
    t.booking.end === t.endRaw &&
    t.booking.resourceIds.length === t.resourceIds.length &&
    t.booking.resourceIds.every((id, j) => id === t.resourceIds[j]);
  const noChange = targets.every(sameArrangement);
  if (noChange) {
    // 幂等：提交的安排与现状完全一致时成功且不触碰数据文件；
    // 不生成改期操作记录、不推进操作计数
    console.log(
      `批量改期成功：共 ${targets.length} 项，安排均与现状一致，无业务变化` +
        '（标识与系列归属不变，未生成改期操作记录，数据文件与标识计数未改动）',
    );
    for (const t of targets) {
      console.log(`第 ${t.index + 1} 项 ${t.booking.id}:`);
      if (t.booking.seriesId) console.log(`  所属系列: ${t.booking.seriesId}（保持不变）`);
      console.log(`  时间: ${t.startRaw} → ${t.endRaw}`);
      console.log(`  资源: ${formatResourceIds(store, t.resourceIds)}`);
    }
    return;
  }

  // 至少一项有变化：在改动前抓取全部提交项的完整快照（标识、提交时系列归属、
  // 改期前后时间与完整资源集合，顺序即清单顺序），生成一条“未撤销”操作记录，
  // 与新安排在同一次原子保存中落盘后才报告成功；保存失败则不留记录、不推进计数。
  const opItems: BatchOpItem[] = targets.map((t) => {
    const item: BatchOpItem = {
      bookingId: t.booking.id,
      before: {
        start: t.booking.start,
        end: t.booking.end,
        resourceIds: [...t.booking.resourceIds],
      },
      after: {start: t.startRaw, end: t.endRaw, resourceIds: [...t.resourceIds]},
    };
    if (t.booking.seriesId !== undefined) item.seriesId = t.booking.seriesId;
    return item;
  });
  store.batchSeq += 1;
  const opId = `O${String(store.batchSeq).padStart(4, '0')}`;
  for (const t of targets) {
    t.booking.start = t.startRaw;
    t.booking.end = t.endRaw;
    t.booking.resourceIds = t.resourceIds;
  }
  store.batchOps.push({id: opId, status: 'active', items: opItems});
  await saveStore(file, store);

  console.log(
    `批量改期成功：操作标识 ${opId}，共 ${targets.length} 项（标识与系列归属不变，未创建预约或系列）`,
  );
  for (const t of targets) {
    console.log(`第 ${t.index + 1} 项 ${t.booking.id}:`);
    if (t.booking.seriesId) console.log(`  所属系列: ${t.booking.seriesId}（保持不变）`);
    console.log(`  时间: ${t.startRaw} → ${t.endRaw}`);
    console.log(`  资源: ${formatResourceIds(store, t.resourceIds)}`);
  }
  console.log(`本次改期已记录为 ${opId}：可用 list-batch-ops 查询，undo-batch-op ${opId} 整笔安全撤销。`);
}

// ---------------------------------------------------------------------------
// 批量改期操作记录：查询与安全撤销
// 快照只描述该次提交的前后安排；之后其他入口造成的现状变化不算损坏，
// 撤销时按“当前值”与记录的改期后安排逐项核对。
// ---------------------------------------------------------------------------

const BATCH_OP_STATUS_LABEL: Record<BatchOpStatus, string> = {
  active: '未撤销',
  undone: '已撤销',
};

// 判断预约当前安排是否与某一快照完全一致（时间 + 完整资源集合，资源均已排序）
function arrangementMatches(b: BookingRec, side: BatchOpItem['before']): boolean {
  return (
    b.start === side.start &&
    b.end === side.end &&
    b.resourceIds.length === side.resourceIds.length &&
    b.resourceIds.every((id, j) => id === side.resourceIds[j])
  );
}

// 渲染单项的前后安排（系列归属在首行给出）
function renderBatchOpItem(store: Store, item: BatchOpItem, index: number, indent: string): string[] {
  const lines = [
    `${indent}第 ${index + 1} 项 ${item.bookingId}` +
      (item.seriesId !== undefined ? `（系列 ${item.seriesId}）` : ''),
  ];
  lines.push(`${indent}  改期前: ${item.before.start} → ${item.before.end}`);
  lines.push(`${indent}    资源: ${formatResourceIds(store, item.before.resourceIds)}`);
  lines.push(`${indent}  改期后: ${item.after.start} → ${item.after.end}`);
  lines.push(`${indent}    资源: ${formatResourceIds(store, item.after.resourceIds)}`);
  return lines;
}

async function cmdListBatchOps(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(
      `list-batch-ops 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`,
    );
  }
  if (positionals.length > 0) {
    throw new UsageError(`list-batch-ops 不接受位置参数: ${positionals.join(' ')}`);
  }

  const store = await loadStore(activeDataFile);
  if (store.batchOps.length === 0) {
    console.log(
      '暂无批量改期操作记录（无变化提交不建记录；可用 reschedule-batch 提交批量改期，undo-batch-op <操作标识> 撤销）。',
    );
    return;
  }
  // 记录按标识序号（即成功提交先后）加载与展示；项按提交顺序
  const undone = store.batchOps.filter((o) => o.status === 'undone').length;
  console.log(
    `批量改期操作记录（共 ${store.batchOps.length} 条，按操作先后；未撤销 ${store.batchOps.length - undone} 条，已撤销 ${undone} 条）：`,
  );
  for (const op of store.batchOps) {
    console.log(`- ${op.id} [${BATCH_OP_STATUS_LABEL[op.status]}]（${op.items.length} 项，按提交顺序）`);
    op.items.forEach((item, i) => {
      console.log(renderBatchOpItem(store, item, i, '    ').join('\n'));
    });
  }
}

async function cmdUndoBatchOp(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(
      `undo-batch-op 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`,
    );
  }
  if (positionals.length !== 1) {
    throw new UsageError('用法: undo-batch-op <批量改期操作标识>');
  }
  const opId = positionals[0];
  if (!/^O\d{4,}$/.test(opId)) throw new BizError(`批量改期操作标识非法: ${opId}`);

  const file = activeDataFile;
  const store = await loadStore(file);
  const op = store.batchOps.find((x) => x.id === opId);
  if (!op) throw new BizError(`未知批量改期操作标识: ${opId}`);

  if (op.status === 'undone') {
    // 幂等：重复撤销已撤销记录成功且不触碰当前安排——即使之后又有改期
    console.log(`操作 ${opId} 已是撤销状态，未做任何改动（当前安排保持不变）。`);
    return;
  }

  // 前置一致性：全部涉及预约须仍有效，且当前时间、资源集合、系列归属与该记录的
  // 改期后安排完全一致；按当前值比对，期间改动后又恢复一致仍可撤销。
  // 任一不一致即整笔拒绝并列出全部不一致预约。
  const mismatches: string[] = [];
  const involved = new Map<string, {booking: BookingRec; item: BatchOpItem; index: number}>();
  op.items.forEach((item, index) => {
    const b = store.bookings.find((x) => x.id === item.bookingId);
    if (!b) {
      mismatches.push(`第 ${index + 1} 项 ${item.bookingId}：预约记录不存在（数据可能已损坏）`);
      return;
    }
    if (b.status === 'cancelled') {
      mismatches.push(`第 ${index + 1} 项 ${b.id}：预约已取消，撤销不能复活已取消预约`);
      return;
    }
    involved.set(b.id, {booking: b, item, index});
    const reasons: string[] = [];
    if (!arrangementMatches(b, item.after)) {
      reasons.push(
        `当前安排（${b.start} → ${b.end}；资源 ${b.resourceIds.join('、')}）` +
          `与记录改期后安排（${item.after.start} → ${item.after.end}；资源 ${item.after.resourceIds.join('、')}）不一致`,
      );
    }
    const curSeries = b.seriesId;
    const recSeries = item.seriesId;
    if (curSeries !== recSeries) {
      reasons.push(
        `当前系列归属 ${curSeries ?? '无'} 与记录的系列归属 ${recSeries ?? '无'} 不一致`,
      );
    }
    if (reasons.length > 0) {
      mismatches.push(`第 ${index + 1} 项 ${b.id}：` + reasons.join('；'));
    }
  });

  if (mismatches.length > 0) {
    throw new BizError(
      `撤销 ${opId} 被拒绝：存在 ${mismatches.length} 项涉及预约的当前状态与该记录改期后安排不一致` +
        '（整笔不变，未恢复任何安排、未改变记录状态）：\n' +
        mismatches.map((m) => `- ${m}`).join('\n'),
    );
  }

  // 可行性：对“整笔恢复后”的最终安排做统一批次校验（无写入副作用）。
  // 本操作涉及预约的当前占用一律排除（允许互换时段）；
  // 障碍只来自本操作之外的有效预约，以及各项恢复安排彼此之间。
  const involvedIds = new Set(op.items.map((it) => it.bookingId));
  const targets = op.items.map((item) => ({
    startMin: parseDateTime(item.before.start, '恢复开始时间'),
    endMin: parseDateTime(item.before.end, '恢复结束时间'),
    resourceIds: item.before.resourceIds,
  }));
  const failures = validateBatchTargets(store, targets, involvedIds);

  if (failures.length > 0) {
    // 按提交顺序报告全部失败项；批内冲突在双方项中都会出现
    const blocks = failures.map((f) => {
      const item = op.items[f.index];
      const lines = [
        `第 ${f.index + 1} 项 ${item.bookingId} 恢复为 ${item.before.start} → ${item.before.end}：`,
      ];
      if (f.gaps.length > 0) {
        lines.push('  开放不足资源:');
        lines.push(...gapLines(f.gaps, '    '));
      }
      if (f.external.length + f.internal.length > 0) {
        lines.push('  冲突预约:');
        for (const c of f.external) {
          lines.push(
            `    - ${c.booking.id}（${c.booking.start} → ${c.booking.end}）` +
              `：共同资源 ${formatResourceIds(store, c.shared)}`,
          );
        }
        for (const x of f.internal) {
          const o = op.items[x.otherIndex];
          lines.push(
            `    - ${o.bookingId}（本操作第 ${x.otherIndex + 1} 项恢复为 ${o.before.start} → ${o.before.end}）` +
              `：共同资源 ${formatResourceIds(store, x.shared)}`,
          );
        }
      }
      return lines.join('\n');
    });
    throw new BizError(
      `撤销 ${opId} 失败：共 ${failures.length} 项恢复安排不满足条件（按提交顺序），整笔未改动：\n${blocks.join('\n')}`,
    );
  }

  // 全部校验通过：将涉及预约恢复为各自原时间与原资源，并把记录置为“已撤销”，
  // 同一次原子保存落盘后才报告成功。不新增撤销记录、不改变任何标识计数，
  // 不动 status/seriesId、候补原请求与兑现关联，不触碰无关预约，不自动处理候补。
  for (const {booking, item} of involved.values()) {
    booking.start = item.before.start;
    booking.end = item.before.end;
    booking.resourceIds = [...item.before.resourceIds];
  }
  op.status = 'undone';
  await saveStore(file, store);

  console.log(
    `已安全撤销 ${opId}：共 ${op.items.length} 项恢复为改期前安排（标识、有效状态与系列归属不变，未新增记录、未改变标识计数）`,
  );
  op.items.forEach((item, i) => {
    console.log(
      `  第 ${i + 1} 项 ${item.bookingId}` + (item.seriesId !== undefined ? `（系列 ${item.seriesId}）` : ''),
    );
    console.log(`    时间: ${item.before.start} → ${item.before.end}`);
    console.log(`    资源: ${formatResourceIds(store, item.before.resourceIds)}`);
  });
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
  const seriesNote = booking.seriesId ? `（系列 ${booking.seriesId} 的成员，仅取消该项）` : '';
  console.log(`已取消预约 ${id}${seriesNote}，其全部资源已释放。`);
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
    if (b.seriesId) console.log(`    所属系列: ${b.seriesId}`);
    console.log(`    资源: ${formatResourceIds(store, b.resourceIds)}`);
  }
}

// 解析正整数次数（不接受 0、负数、小数与前导零）
function parseOccurrences(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new BizError(`次数非法: “${raw}”，必须是正整数（含首项）`);
  }
  const n = Number(raw);
  if (n > MAX_OCCURRENCES) {
    throw new BizError(`次数过大: “${raw}”，最大为 ${MAX_OCCURRENCES}`);
  }
  return n;
}

interface PlannedMember {
  startRaw: string;
  endRaw: string;
  startMin: number;
  endMin: number;
}

// 按周展开系列：每项相对前一项将起止时间同时后移 7 个营业地日历日，
// 时刻与跨日长度保持不变。任何一项超出四位年份范围即整体拒绝。
function planWeeklyMembers(startMin: number, endMin: number, count: number): PlannedMember[] {
  const members: PlannedMember[] = [];
  for (let i = 0; i < count; i++) {
    const s = startMin + i * 7 * 1440;
    const e = endMin + i * 7 * 1440;
    const startRaw = formatDateTime(s);
    const endRaw = formatDateTime(e);
    if (startRaw === null || endRaw === null) {
      const nth = i + 1;
      throw new BizError(
        `系列第 ${nth} 项（约第 ${nth} 周）的时间超出四位年份范围（${MIN_YEAR}-${MAX_YEAR}），无法创建：` +
          '请缩短次数或改选更早的首项时间',
      );
    }
    members.push({startRaw, endRaw, startMin: s, endMin: e});
  }
  return members;
}

async function cmdCreateSeries(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource', 'start', 'end', 'count'], ['resource']);
  if (positionals.length > 0) throw new UsageError(`create-series 不接受位置参数: ${positionals.join(' ')}`);

  const resourceArgs = values.get('resource');
  if (!resourceArgs || resourceArgs.length === 0) throw new UsageError('至少需要一个 --resource');
  const startRaw = requireFlag(values, 'start');
  const endRaw = requireFlag(values, 'end');
  const count = parseOccurrences(requireFlag(values, 'count'));

  const file = activeDataFile;
  const store = await loadStore(file);

  const ids = resolveResourceIds(store, resourceArgs);
  const startMin = parseDateTime(startRaw, '首项开始时间');
  const endMin = parseDateTime(endRaw, '首项结束时间');
  if (endMin <= startMin) {
    throw new BizError(`首项结束时间必须晚于开始时间（开始: ${startRaw}，结束: ${endRaw}），允许跨日`);
  }

  // 先展开全部成员时间（含跨月、闰日、跨年、年份范围校验）
  const members = planWeeklyMembers(startMin, endMin, count);

  // 以展开后的全部成员为目标做统一批次校验（无写入副作用）：
  // 开放覆盖、与既有有效预约冲突、与系列内其他成员冲突
  const targets = members.map((m) => ({startMin: m.startMin, endMin: m.endMin, resourceIds: ids}));
  const failures = validateBatchTargets(store, targets);

  if (failures.length > 0) {
    // 按发生顺序报告所有失败项；任一项不满足则整批失败，不分配任何标识、不写文件
    const blocks = failures.map((f) => {
      const m = members[f.index];
      const lines = [`第 ${f.index + 1} 项 ${m.startRaw} → ${m.endRaw}：`];
      if (f.gaps.length > 0) {
        lines.push('  开放不足资源:');
        lines.push(...gapLines(f.gaps, '    '));
      }
      if (f.external.length > 0) {
        lines.push('  与以下既有预约冲突:');
        for (const c of f.external) {
          lines.push(
            `    - ${c.booking.id}（${c.booking.start} → ${c.booking.end}）` +
              `：共同资源 ${formatResourceIds(store, c.shared)}`,
          );
        }
      }
      if (f.internal.length > 0) {
        lines.push('  与系列内其他成员冲突:');
        for (const x of f.internal) {
          const o = members[x.otherIndex];
          lines.push(
            `    - 第 ${x.otherIndex + 1} 项（${o.startRaw} → ${o.endRaw}）：双方时间重叠`,
          );
        }
      }
      return lines.join('\n');
    });
    throw new BizError(
      `系列创建失败：共 ${failures.length} 项不满足条件（按发生顺序），整批未创建：\n${blocks.join('\n')}`,
    );
  }

  // 全部验证通过：分配一个系列标识与每项预约标识，一次性落盘。
  // 标识在此刻才生成，任何失败都不会推进计数。
  store.seriesSeq += 1;
  const seriesId = `S${String(store.seriesSeq).padStart(4, '0')}`;
  const assigned: Array<{id: string; m: PlannedMember}> = [];
  for (const m of members) {
    store.bookingSeq += 1;
    const id = `B${String(store.bookingSeq).padStart(4, '0')}`;
    store.bookings.push({
      id,
      resourceIds: ids,
      start: m.startRaw,
      end: m.endRaw,
      status: 'active',
      seriesId,
    });
    assigned.push({id, m});
  }
  store.series.push({id: seriesId});
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  store.series.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);

  console.log(`已创建按周重复系列 ${seriesId}（共 ${count} 项，每周一次，全部成员使用相同资源）`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
  assigned.forEach(({id, m}, i) => {
    console.log(`  第 ${i + 1} 项 ${id}: ${m.startRaw} → ${m.endRaw}`);
  });
}

async function cmdListSeries(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`list-series 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) throw new UsageError(`list-series 不接受位置参数: ${positionals.join(' ')}`);

  const store = await loadStore(activeDataFile);
  if (store.series.length === 0) {
    console.log('暂无预约系列。可使用 create-series 创建按周重复的多资源预约系列。');
    return;
  }
  console.log(`预约系列（共 ${store.series.length} 个）：`);
  for (const s of store.series) {
    const members = store.bookings
      .filter((b) => b.seriesId === s.id)
      .map((b) => ({b, startMin: parseDateTime(b.start, '预约开始时间')}))
      .sort((x, y) => x.startMin - y.startMin || x.b.id.localeCompare(y.b.id));
    const activeCount = members.filter((m) => m.b.status === 'active').length;
    console.log(`- 系列 ${s.id}（${members.length} 项，有效 ${activeCount} 项）`);
    for (const {b} of members) {
      const status = b.status === 'active' ? '有效' : '已取消';
      console.log(`    ${b.id} [${status}] ${b.start} → ${b.end}`);
      console.log(`      资源: ${formatResourceIds(store, b.resourceIds)}`);
    }
  }
}

async function cmdCancelSeries(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`cancel-series 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length !== 1) throw new UsageError('用法: cancel-series <系列标识>');
  const seriesId = positionals[0];
  if (!/^S\d{4,}$/.test(seriesId)) throw new BizError(`系列标识非法: ${seriesId}`);

  const file = activeDataFile;
  const store = await loadStore(file);
  const series = store.series.find((x) => x.id === seriesId);
  if (!series) throw new BizError(`未知系列标识: ${seriesId}`);

  // 仅取消仍有效的成员（含单独改期者）；已取消成员保持不变；无关预约不受影响
  const members = store.bookings
    .filter((b) => b.seriesId === seriesId)
    .sort((a, b) => a.id.localeCompare(b.id));
  const toCancel = members.filter((b) => b.status === 'active');
  if (toCancel.length === 0) {
    // 幂等：重复整体取消成功且不变
    console.log(`系列 ${seriesId} 已无可取消的有效成员，未做改动（共 ${members.length} 项，均已取消）。`);
    return;
  }
  for (const b of toCancel) b.status = 'cancelled';
  await saveStore(file, store);
  console.log(`已整体取消系列 ${seriesId}：本次取消 ${toCancel.length} 项，其全部资源已释放，记录均保留。`);
  for (const b of toCancel) console.log(`  - ${b.id}（${b.start} → ${b.end}）`);
  const already = members.length - toCancel.length;
  if (already > 0) console.log(`另有 ${already} 项此前已取消，保持不变。`);
}

// ---------------------------------------------------------------------------
// 候补队列：固定时段 / 弹性时段多资源候补的登记、列表、取消与手动整体处理
// 两种候补共用同一条登记顺序（seq），process-waitlist 按序逐项重查
// ---------------------------------------------------------------------------

const WAITLIST_STATUS_LABEL: Record<WaitlistStatus, string> = {
  waiting: '等待中',
  fulfilled: '已兑现',
  cancelled: '已取消',
};

const WAITLIST_KIND_LABEL: Record<WaitlistKind, string> = {
  fixed: '固定时段',
  flexible: '弹性时段',
};

// 原请求的统一展示：固定项给原时段；弹性项给窗口与所需连续时长
function renderWaitlistRequest(w: WaitlistRec): string {
  if (w.kind === 'flexible') {
    return `弹性窗口 ${w.start} → ${w.end}（所需连续时长 ${w.durationMinutes} 分钟）`;
  }
  return `固定时段 ${w.start} → ${w.end}`;
}

async function cmdAddWaitlist(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource', 'start', 'end'], ['resource']);
  if (positionals.length > 0) throw new UsageError(`add-waitlist 不接受位置参数: ${positionals.join(' ')}`);

  const resourceArgs = values.get('resource');
  if (!resourceArgs || resourceArgs.length === 0) throw new UsageError('至少需要一个 --resource');
  const startRaw = requireFlag(values, 'start');
  const endRaw = requireFlag(values, 'end');

  const file = activeDataFile;
  const store = await loadStore(file);

  const ids = resolveResourceIds(store, resourceArgs);
  const startMin = parseDateTime(startRaw, '候补开始时间');
  const endMin = parseDateTime(endRaw, '候补结束时间');
  if (endMin <= startMin) {
    throw new BizError(`候补结束时间必须晚于开始时间（开始: ${startRaw}，结束: ${endRaw}），允许跨日`);
  }
  // 候补同样要求全部资源的连续开放完整覆盖；但不检查冲突——冲突中空闲都可登记
  assertOpenCoverage(store, ids, startMin, endMin);

  // 候补不占用任何资源：仅追加队列记录（seq 即登记序号），处理时再重查
  store.waitlistSeq += 1;
  const seq = store.waitlistSeq;
  const id = `W${String(seq).padStart(4, '0')}`;
  store.waitlist.push({
    id,
    kind: 'fixed',
    resourceIds: ids,
    start: startRaw,
    end: endRaw,
    status: 'waiting',
    seq,
  });
  await saveStore(file, store);
  console.log(`已登记固定时段候补 ${id}（登记序号 ${seq}，不占用资源）`);
  console.log(`  时间: ${startRaw} → ${endRaw}`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
  console.log('  当前是否存在预约冲突均可登记；可使用 process-waitlist 手动处理整个队列。');
}

// 解析正整数分钟时长（不接受 0、负数、小数与前导零）
function parseDurationMinutes(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new BizError(`时长非法: “${raw}”，必须是正整数分钟`);
  }
  return Number(raw);
}

// 解析弹性候补的“窗口开始/窗口结束”
function parseFlexWindow(
  value: string,
): {start: string; end: string; startMin: number; endMin: number} {
  const parts = String(value ?? '').split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new BizError(
      `弹性窗口格式非法: “${value}”，应为 窗口开始/窗口结束（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm）`,
    );
  }
  const start = parts[0];
  const end = parts[1];
  const startMin = parseDateTime(start, '弹性窗口开始时间');
  const endMin = parseDateTime(end, '弹性窗口结束时间');
  if (endMin <= startMin) {
    throw new BizError(`弹性窗口结束时间必须晚于开始时间: “${value}”，允许跨日`);
  }
  return {start, end, startMin, endMin};
}

// 渲染一组分钟区间（附分钟数），按开始时间排序；空集给明确提示
function renderMinuteSegments(segments: Array<[number, number]>, indent: string): string[] {
  if (segments.length === 0) return [`${indent}（无）`];
  return segments.map(([s, e]) => {
    const startRaw = formatDateTime(s);
    const endRaw = formatDateTime(e);
    return `${indent}- ${startRaw} → ${endRaw}（${e - s} 分钟）`;
  });
}

async function cmdAddFlexWaitlist(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource', 'window', 'duration'], ['resource']);
  if (positionals.length > 0) {
    throw new UsageError(`add-flex-waitlist 不接受位置参数: ${positionals.join(' ')}`);
  }

  const resourceArgs = values.get('resource');
  if (!resourceArgs || resourceArgs.length === 0) throw new UsageError('至少需要一个 --resource');
  const windowRaw = requireFlag(values, 'window');
  const durationRaw = requireFlag(values, 'duration');

  const file = activeDataFile;
  const store = await loadStore(file);

  const ids = resolveResourceIds(store, resourceArgs);
  const win = parseFlexWindow(windowRaw);
  const durationMinutes = parseDurationMinutes(durationRaw);
  const windowLength = win.endMin - win.startMin;
  if (durationMinutes > windowLength) {
    throw new BizError(
      `所需连续时长 ${durationMinutes} 分钟超过窗口长度 ${windowLength} 分钟（窗口: ${win.start} → ${win.end}）`,
    );
  }

  // 登记忽略预约占用；只要求窗口内全部资源的“共同实际可用时间”
  // （开放合并扣除有效停用并集，无需整窗开放）存在能容纳完整时长的连续区间
  const common = commonAvailableSegments(store, ids, win.startMin, win.endMin);
  if (!common.some(([s, e]) => e - s >= durationMinutes)) {
    const lines = [
      `弹性候补登记失败：窗口 ${win.start} → ${win.end} 内，全部资源的共同实际可用时间` +
        `不存在长度不少于 ${durationMinutes} 分钟的连续区间（登记忽略预约占用，无需整窗开放）。`,
      '窗口内全部最大共同实际可用区间（开放区间合并重叠或相接后扣除有效停用并集）:',
    ];
    if (common.length === 0) {
      lines.push('  （空集：窗口内全部资源没有任何共同实际可用时间）');
    } else {
      lines.push(...renderMinuteSegments(common, '  '));
    }
    throw new BizError(lines.join('\n'));
  }

  // 候补不占用任何资源：仅追加队列记录，与固定候补共用同一条登记顺序
  store.waitlistSeq += 1;
  const seq = store.waitlistSeq;
  const id = `W${String(seq).padStart(4, '0')}`;
  store.waitlist.push({
    id,
    kind: 'flexible',
    resourceIds: ids,
    start: win.start,
    end: win.end,
    durationMinutes,
    status: 'waiting',
    seq,
  });
  await saveStore(file, store);
  console.log(`已登记弹性时段候补 ${id}（登记序号 ${seq}，不占用资源）`);
  console.log(`  窗口: ${win.start} → ${win.end}（窗口长度 ${windowLength} 分钟）`);
  console.log(`  所需连续时长: ${durationMinutes} 分钟`);
  console.log(`  资源: ${formatResourceIds(store, ids)}`);
  console.log('  登记忽略预约占用；process-waitlist 将在窗口内为全部资源寻找最早可行的连续安排。');
}

async function cmdListWaitlist(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`list-waitlist 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) {
    throw new UsageError(`list-waitlist 不接受位置参数: ${positionals.join(' ')}`);
  }

  const store = await loadStore(activeDataFile);
  if (store.waitlist.length === 0) {
    console.log(
      '候补队列为空。可使用 add-waitlist 登记固定时段候补，或 add-flex-waitlist 登记弹性时段候补。',
    );
    return;
  }
  const waiting = store.waitlist.filter((w) => w.status === 'waiting').length;
  const fulfilled = store.waitlist.filter((w) => w.status === 'fulfilled').length;
  const cancelled = store.waitlist.filter((w) => w.status === 'cancelled').length;
  console.log(
    `候补队列（共 ${store.waitlist.length} 项，按登记顺序；等待 ${waiting}，已兑现 ${fulfilled}，已取消 ${cancelled}）：`,
  );
  for (const w of store.waitlist) { // 已按 seq 升序加载
    console.log(`- ${w.id} [${WAITLIST_STATUS_LABEL[w.status]}] ${renderWaitlistRequest(w)}`);
    console.log(`    资源: ${formatResourceIds(store, w.resourceIds)}`);
    if (w.status === 'fulfilled' && w.bookingId !== undefined) {
      // 显示关联标识及其当前实际时间（该预约可被改期或取消；候补保留原请求与关联，不恢复等待）
      const b = store.bookings.find((x) => x.id === w.bookingId);
      const actual = b ? `（实际 ${b.start} → ${b.end}）` : '';
      console.log(`    兑现预约: ${w.bookingId}${actual}（候补保留原请求与关联，不恢复等待）`);
    }
  }
}

async function cmdCancelWaitlist(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`cancel-waitlist 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length !== 1) throw new UsageError('用法: cancel-waitlist <候补标识>');
  const id = positionals[0];
  if (!/^W\d{4,}$/.test(id)) throw new BizError(`候补标识非法: ${id}`);

  const file = activeDataFile;
  const store = await loadStore(file);
  const w = store.waitlist.find((x) => x.id === id);
  if (!w) throw new BizError(`未知候补标识: ${id}`);
  if (w.status === 'fulfilled') {
    throw new BizError(`候补 ${id} 已兑现（关联预约 ${w.bookingId}），不能取消；可直接改期或取消其预约`);
  }
  if (w.status === 'cancelled') {
    // 幂等：重复取消已取消项成功且不做任何改动
    console.log(`候补 ${id} 已是取消状态，未做改动。`);
    return;
  }
  w.status = 'cancelled'; // 取消仅改状态，记录保留且仍按登记顺序列出
  await saveStore(file, store);
  console.log(`已取消候补 ${id}，记录保留；该候补不再参与 process-waitlist 处理。`);
}

// 弹性项的窗口占用：与任一资源的有效预约（含本轮已选新预约）时间重叠即计入；
// 全部资源必须同时连续空闲，故任一资源被占都使该时刻不可安排。
// 返回裁剪到窗口内并合并后的占用区间。
function flexBusySegments(
  store: Store,
  ids: string[],
  wStart: number,
  wEnd: number,
): Array<[number, number]> {
  const wanted = new Set(ids);
  const cuts: Array<[number, number]> = [];
  for (const b of store.bookings) {
    if (b.status !== 'active') continue;
    if (!b.resourceIds.some((id) => wanted.has(id))) continue;
    const bStart = parseDateTime(b.start, '预约开始时间');
    const bEnd = parseDateTime(b.end, '预约结束时间');
    const a = Math.max(bStart, wStart);
    const c = Math.min(bEnd, wEnd);
    if (a < c) cuts.push([a, c]);
  }
  return mergeIntervals(cuts);
}

// 弹性项在窗口内的全部最大共同空闲区间（共同实际可用扣除有效预约与本轮已选占用）
function flexFreeSegments(
  store: Store,
  w: WaitlistRec,
): Array<[number, number]> {
  const wStart = parseDateTime(w.start, '弹性窗口开始时间');
  const wEnd = parseDateTime(w.end, '弹性窗口结束时间');
  const common = commonAvailableSegments(store, w.resourceIds, wStart, wEnd);
  return subtractSegments(common, flexBusySegments(store, w.resourceIds, wStart, wEnd));
}

async function cmdProcessWaitlist(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`process-waitlist 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) {
    throw new UsageError(`process-waitlist 不接受位置参数: ${positionals.join(' ')}`);
  }

  const file = activeDataFile;
  const store = await loadStore(file);

  // 已兑现/已取消项永不重新处理；两种候补只按共同的登记顺序遍历等待项
  const waiting = store.waitlist.filter((w) => w.status === 'waiting');
  if (waiting.length === 0) {
    // 明确说明且不改变记录或计数（不落盘）
    if (store.waitlist.length === 0) {
      console.log('候补队列为空，没有可处理的候补；记录与标识计数不变。');
    } else {
      console.log('候补队列中没有等待中的候补（均已兑现或已取消）；记录与标识计数不变。');
    }
    return;
  }

  // 本轮选中项即时分配预约标识并入内存（含弹性项的实际开始/结束）；
  // 后来者据此看到先选中者的占用，全部成功后一次性原子落盘；
  // 若保存失败，磁盘原文件、记录与计数均不变。
  const selected: Array<{
    w: WaitlistRec;
    bookingId: string;
    startRaw: string;
    endRaw: string;
    startMin: number;
    endMin: number;
  }> = [];
  const blocked: WaitlistRec[] = [];

  for (const w of waiting) {
    let slot: {startMin: number; endMin: number} | null = null;

    if (w.kind === 'fixed') {
      // 固定项使用原时段：重查开放覆盖与冲突（store.bookings 已含本轮先选新预约）
      const startMin = parseDateTime(w.start, '候补开始时间');
      const endMin = parseDateTime(w.end, '候补结束时间');
      const gaps = findCoverageGaps(store, w.resourceIds, startMin, endMin);
      const conflicts = findConflicts(store, w.resourceIds, startMin, endMin);
      if (gaps.length === 0 && conflicts.length === 0) slot = {startMin, endMin};
    } else {
      // 弹性项取窗口内最早可行的开始分钟，结束不超出窗口；不能拼接空隙
      const duration = w.durationMinutes!;
      const free = flexFreeSegments(store, w);
      for (const [s, e] of free) {
        if (e - s >= duration) {
          slot = {startMin: s, endMin: s + duration};
          break;
        }
      }
    }

    if (slot === null) {
      // 受阻项等待并继续后项：不重排队列、不移动任何已选项
      blocked.push(w);
      continue;
    }

    const startRaw = formatDateTime(slot.startMin);
    const endRaw = formatDateTime(slot.endMin);
    if (startRaw === null || endRaw === null) {
      // 理论不可达：窗口本身已校验在 0001-9999 内，安排不超出窗口
      throw new BizError(`候补 ${w.id} 的安排超出四位年份范围，本轮拒绝兑现（原记录保留）`);
    }
    store.bookingSeq += 1;
    const bookingId = `B${String(store.bookingSeq).padStart(4, '0')}`;
    store.bookings.push({
      id: bookingId,
      resourceIds: w.resourceIds,
      start: startRaw,
      end: endRaw,
      status: 'active',
    });
    w.status = 'fulfilled';
    w.bookingId = bookingId;
    selected.push({w, bookingId, startRaw, endRaw, startMin: slot.startMin, endMin: slot.endMin});
  }

  // 本轮预约标识 -> 来源候补标识，供阻挡报告标注“本轮新预约”
  const fromWaitlistByBooking = new Map(selected.map((s) => [s.bookingId, s.w.id]));

  if (selected.length === 0) {
    // 没有可兑现项也成功：明确说明，不保存、不改变记录或计数
    console.log(
      `候补处理完成：本轮处理 ${waiting.length} 项等待候补，没有可兑现项` +
        '（固定项开放不足或仍有冲突；弹性项窗口内无足够长的共同空闲），全部继续等待；记录、占用与标识计数不变。',
    );
    for (const w of blocked) {
      console.log(renderBlocked(store, w, fromWaitlistByBooking));
    }
    return;
  }

  // 选中项的普通预约已在内存中生成、候补已置为已兑现并有关联；
  // 一次性原子落盘后才报告成功。
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);

  const selectedById = new Map(selected.map((s) => [s.w.id, s]));
  console.log(
    `候补处理完成：按登记顺序处理 ${waiting.length} 项等待候补，本轮兑现 ${selected.length} 项，` +
      `${blocked.length} 项继续等待（已兑现/已取消项未参与）。`,
  );
  for (const w of waiting) { // 结果严格按队列顺序展示
    const s = selectedById.get(w.id);
    if (s) {
      console.log(`- 兑现 ${w.id}（${WAITLIST_KIND_LABEL[w.kind]}）→ 新预约 ${s.bookingId}（普通预约，不属于任何系列）`);
      if (w.kind === 'flexible') console.log(`    原请求: ${renderWaitlistRequest(w)}`);
      console.log(`    实际时间: ${s.startRaw} → ${s.endRaw}`);
      console.log(`    资源: ${formatResourceIds(store, w.resourceIds)}`);
    } else {
      console.log(renderBlocked(store, w, fromWaitlistByBooking));
    }
  }
}

// 受阻项报告：固定项列开放不足与全部阻挡（含本轮后项产生的预约——
// 本函数在全部选择完成后按最终占用渲染）；弹性项列窗口内全部最大共同空闲区间及分钟数
function renderBlocked(
  store: Store,
  w: WaitlistRec,
  fromWaitlistByBooking: Map<string, string>,
): string {
  const lines = [`- 继续等待 ${w.id}（${WAITLIST_KIND_LABEL[w.kind]}）：${renderWaitlistRequest(w)}`];

  if (w.kind === 'fixed') {
    const startMin = parseDateTime(w.start, '候补开始时间');
    const endMin = parseDateTime(w.end, '候补结束时间');
    const gaps = findCoverageGaps(store, w.resourceIds, startMin, endMin);
    if (gaps.length > 0) {
      lines.push('    开放不足资源:');
      lines.push(...gapLines(gaps, '      '));
    }
    const conflicts = findConflicts(store, w.resourceIds, startMin, endMin);
    if (conflicts.length > 0) {
      lines.push('    冲突预约（共同资源时间重叠）:');
      for (const c of conflicts) {
        const fromId = fromWaitlistByBooking.get(c.booking.id);
        const note = fromId ? `（本轮新预约，兑现自候补 ${fromId}）` : '';
        lines.push(
          `      - ${c.booking.id}${note}（${c.booking.start} → ${c.booking.end}）` +
            `：共同资源 ${formatResourceIds(store, c.shared)}`,
        );
      }
    }
    return lines.join('\n');
  }

  // 弹性项：按最终安排列出窗口内全部最大共同空闲区间及分钟数（按开始时间排序）
  const free = flexFreeSegments(store, w);
  lines.push('    窗口内全部最大共同空闲区间（全部资源同时连续可用，按开始时间排序）:');
  if (free.length === 0) {
    lines.push('      （空集：窗口内全部资源没有任何共同空闲区间，无法容纳所需连续时长）');
  } else {
    lines.push(...renderMinuteSegments(free, '      '));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 资源临时停用：场地维护、设备检修、人员休息
// 实际可用时间 = 原开放区间合并后扣除全部有效停用区间的并集（原开放记录保留）
// ---------------------------------------------------------------------------

const CLOSURE_STATUS_LABEL: Record<ClosureStatus, string> = {
  active: '有效',
  cancelled: '已取消',
};

async function cmdAddClosure(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource', 'start', 'end']);
  if (positionals.length > 0) throw new UsageError(`add-closure 不接受位置参数: ${positionals.join(' ')}`);

  const resourceId = requireFlag(values, 'resource');
  const startRaw = requireFlag(values, 'start');
  const endRaw = requireFlag(values, 'end');

  const file = activeDataFile;
  const store = await loadStore(file);

  const resource = store.resources.find((r) => r.id === resourceId);
  if (!resource) throw new BizError(`未知资源标识: ${resourceId}`);

  const startMin = parseDateTime(startRaw, '停用开始时间');
  const endMin = parseDateTime(endRaw, '停用结束时间');
  if (endMin <= startMin) {
    throw new BizError(`停用结束时间必须晚于开始时间（开始: ${startRaw}，结束: ${endRaw}），允许跨日`);
  }

  // 登记前检查该资源的全部有效预约（含系列成员与候补兑现预约；已取消不阻挡）。
  // 区间左闭右开，端点相接不算重叠；有重叠即拒绝，不改期或取消任何预约。
  const affected = store.bookings
    .filter((b) => {
      if (b.status !== 'active' || !b.resourceIds.includes(resourceId)) return false;
      const bs = parseDateTime(b.start, '预约开始时间');
      const be = parseDateTime(b.end, '预约结束时间');
      return bs < endMin && startMin < be;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  if (affected.length > 0) {
    const lines = affected.map((b) => `- ${b.id}（${b.start} → ${b.end}）`);
    throw new BizError(
      `无法登记停用：资源 ${resourceId}（${resource.name}）在该区间存在有效预约` +
        `（不自动改期或取消，请先处理）：\n${lines.join('\n')}`,
    );
  }

  // 全部校验通过后才生成标识、改内存、落盘；相同内容再次登记也是另一记录
  store.closureSeq += 1;
  const id = `C${String(store.closureSeq).padStart(4, '0')}`;
  store.closures.push({id, resourceId, start: startRaw, end: endRaw, status: 'active'});
  store.closures.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);
  console.log(`已登记停用 ${id}`);
  console.log(`  资源: ${resourceId}（${resource.name}）`);
  console.log(`  时间: ${startRaw} → ${endRaw}`);
  console.log('  该区间不再计入实际可用时间；取消停用请使用 cancel-closure。');
}

async function cmdListClosures(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`list-closures 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) {
    throw new UsageError(`list-closures 不接受位置参数: ${positionals.join(' ')}`);
  }

  const store = await loadStore(activeDataFile);
  if (store.closures.length === 0) {
    console.log('暂无停用记录。可使用 add-closure 登记场地维护、设备检修或人员休息。');
    return;
  }
  const sorted = [...store.closures].sort(
    (a, b) =>
      parseDateTime(a.start, '停用开始时间') - parseDateTime(b.start, '停用开始时间') ||
      a.id.localeCompare(b.id),
  );
  console.log(`停用记录（共 ${sorted.length} 条，按开始时间、标识排序）：`);
  for (const c of sorted) {
    console.log(`- ${c.id} [${CLOSURE_STATUS_LABEL[c.status]}] ${c.start} → ${c.end}`);
    console.log(`    资源: ${formatResourceIds(store, [c.resourceId])}`);
  }
}

async function cmdCancelClosure(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`cancel-closure 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length !== 1) throw new UsageError('用法: cancel-closure <停用标识>');
  const id = positionals[0];
  if (!/^C\d{4,}$/.test(id)) throw new BizError(`停用标识非法: ${id}`);

  const file = activeDataFile;
  const store = await loadStore(file);
  const closure = store.closures.find((c) => c.id === id);
  if (!closure) throw new BizError(`未知停用标识: ${id}`);
  if (closure.status === 'cancelled') {
    // 幂等：重复取消成功且不做任何改动
    console.log(`停用 ${id} 已是取消状态，未做改动。`);
    return;
  }
  // 仅使该记录失效并保留历史；其他重叠停用仍有效，不自动创建预约或处理候补
  closure.status = 'cancelled';
  await saveStore(file, store);
  console.log(`已取消停用 ${id}（记录保留），该区间恢复可用（不超出原开放时间）。`);
}

// ---------------------------------------------------------------------------
// iCalendar 导入（import-ical）
// 读取 UTF-8 的 VCALENDAR（VERSION:2.0，至少一个独立 VEVENT），为新事件各创建
// 一项普通预约（不加入系列、不自动处理候补），全部使用命令行给定的同一资源集合。
// UID 在同一数据文件中永久关联首次生成的预约；相同 UID 且时间、资源集合与首次
// 导入一致为重放（返回原预约当前安排与状态，不做任何改动），不一致则整批拒绝。
// ---------------------------------------------------------------------------

// 一个解析完成的 VEVENT（时间已换算为营业地分钟数与 YYYY-MM-DDTHH:mm 文本）
interface IcalEvent {
  uid: string; // 解码后的 UID（区分大小写）
  startRaw: string;
  endRaw: string;
  startMin: number;
  endMin: number;
}

// 标准折行展开：以空格或制表符开头的行是上一行的延续（去掉首个空白字符拼接）。
// 同时支持 CRLF 与 LF 行尾；空行忽略（文件末尾换行自然被吞掉）。
function unfoldIcalLines(text: string, bad: (reason: string) => never): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r\n|\n/)) {
    if (raw === '') continue;
    if (raw.startsWith(' ') || raw.startsWith('\t')) {
      if (lines.length === 0) bad('文件以折行续行开头，缺少被延续的内容行');
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// 拆分内容行为 属性名;参数:值；属性名忽略大小写（统一转大写返回）
function parseContentLine(
  line: string,
  bad: (reason: string) => never,
): {name: string; params: string[]; value: string} {
  const colon = line.indexOf(':');
  if (colon < 0) bad(`内容行缺少 “:”: “${line}”`);
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const segs = head.split(';');
  if (!/^[A-Za-z0-9-]+$/.test(segs[0])) bad(`属性名非法: “${segs[0]}”`);
  return {name: segs[0].toUpperCase(), params: segs.slice(1), value};
}

// UID 文本转义解码：\\ → \，\n/\N → 换行，\, → ,，\; → ;；其余反斜杠序列原样保留。
// 解码后再比较，因此同一 UID 的不同转义写法视为相同。
function unescapeIcalText(value: string): string {
  return value.replace(/\\(\\|[nN]|,|;)/g, (_all, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch,
  );
}

// 解析浮动时间 YYYYMMDDTHHmmss：秒必须为 00，年份 0001-9999，必须真实有效；
// 与机器时区无关（纯历法算术，与命令行时间格式同一套换算）
function parseIcalDateTime(
  value: string,
  label: string,
  bad: (reason: string) => never,
): {raw: string; min: number} {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) {
    bad(`${label}时间格式非法: “${value}”，仅支持浮动时间 YYYYMMDDTHHmmss（不接受全天、时区或 UTC 写法）`);
  }
  if (m![6] !== '00') bad(`${label}时间的秒必须为 00: “${value}”`);
  const year = Number(m![1]);
  const month = Number(m![2]);
  const day = Number(m![3]);
  const hour = Number(m![4]);
  const minute = Number(m![5]);
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 ||
      day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59) {
    bad(`${label}时间不是真实有效的时间: “${value}”`);
  }
  const min = daysFromCivil(year, month, day) * 1440 + hour * 60 + minute;
  return {raw: formatDateTime(min)!, min};
}

// DTSTART/DTEND 的参数：仅允许显式的 VALUE=DATE-TIME（即默认浮动时间）；
// 全天（VALUE=DATE）、时区（TZID）及其他参数一律拒绝
function assertFloatingDateTimeParams(
  params: string[],
  label: string,
  bad: (reason: string) => never,
): void {
  for (const p of params) {
    const upper = p.toUpperCase();
    if (upper === 'VALUE=DATE-TIME') continue;
    if (upper === 'VALUE=DATE') bad(`${label}不支持全天事件（VALUE=DATE）`);
    if (upper.startsWith('TZID=')) bad(`${label}不支持时区时间（TZID），仅接受浮动时间`);
    bad(`${label}携带不支持的参数 “${p}”，仅接受浮动时间 YYYYMMDDTHHmmss`);
  }
}

// 重复相关属性：出现即拒绝（不展开重复事件）
const ICAL_RECURRENCE_PROPS = new Set(['RRULE', 'RDATE', 'EXDATE', 'EXRULE', 'RECURRENCE-ID']);

// 解析整个 iCalendar 文件；任何结构错误、关键属性重复或缺失都抛出 BizError（整批失败）
function parseIcalFile(text: string, file: string): IcalEvent[] {
  const bad = (reason: string): never => {
    throw new BizError(`iCalendar 文件 ${file} 无法导入：${reason}（整批未导入，数据未改动）`);
  };
  const lines = unfoldIcalLines(text, bad);
  if (lines.length === 0) bad('文件为空');

  const events: IcalEvent[] = [];
  const seenUids = new Set<string>();
  let inCalendar = false;
  let calendarEnded = false;
  let versionSeen = false;
  let inEvent = false;
  let curUid: string | undefined;
  let curStart: {raw: string; min: number} | undefined;
  let curEnd: {raw: string; min: number} | undefined;

  const closeEvent = (): void => {
    if (curUid === undefined) bad('VEVENT 缺少 UID 属性');
    if (curStart === undefined) bad(`VEVENT（UID “${curUid}”）缺少 DTSTART 属性`);
    if (curEnd === undefined) bad(`VEVENT（UID “${curUid}”）缺少 DTEND 属性`);
    if (curEnd.min <= curStart.min) {
      bad(`VEVENT（UID “${curUid}”）结束时间必须晚于开始时间（${curStart.raw} → ${curEnd.raw}），允许跨日`);
    }
    if (seenUids.has(curUid)) bad(`文件内 UID 重复: “${curUid}”（解码后区分大小写）`);
    seenUids.add(curUid);
    events.push({
      uid: curUid,
      startRaw: curStart.raw,
      endRaw: curEnd.raw,
      startMin: curStart.min,
      endMin: curEnd.min,
    });
    inEvent = false;
    curUid = undefined;
    curStart = undefined;
    curEnd = undefined;
  };

  for (const line of lines) {
    const {name, params, value} = parseContentLine(line, bad);

    if (name === 'BEGIN') {
      const comp = value.trim().toUpperCase();
      if (calendarEnded) bad('END:VCALENDAR 之后仍有内容');
      if (!inCalendar) {
        if (comp !== 'VCALENDAR') bad(`顶层组件必须是 VCALENDAR，实际为 “${value.trim()}”`);
        inCalendar = true;
      } else if (!inEvent) {
        if (comp !== 'VEVENT') bad(`不支持的组件 “${value.trim()}”（仅接受 VEVENT）`);
        inEvent = true;
        curUid = undefined;
        curStart = undefined;
        curEnd = undefined;
      } else {
        bad(`事件内不允许嵌套组件 “${value.trim()}”（如 VALARM）`);
      }
      continue;
    }
    if (name === 'END') {
      const comp = value.trim().toUpperCase();
      if (!inCalendar) bad('END 出现在 BEGIN:VCALENDAR 之前');
      if (inEvent) {
        if (comp !== 'VEVENT') bad(`END:${value.trim()} 与 BEGIN:VEVENT 不匹配`);
        closeEvent();
      } else {
        if (comp !== 'VCALENDAR') bad(`END:${value.trim()} 没有匹配的 BEGIN`);
        inCalendar = false;
        calendarEnded = true;
      }
      continue;
    }

    if (calendarEnded) bad('END:VCALENDAR 之后仍有内容');
    if (!inCalendar) bad(`属性 “${name}” 出现在 BEGIN:VCALENDAR 之前`);

    if (!inEvent) {
      // 日历级属性：VERSION 必须恰为 2.0；METHOD:CANCEL 为取消事件，拒绝
      if (name === 'VERSION') {
        if (versionSeen) bad('VERSION 属性重复');
        versionSeen = true;
        if (value.trim() !== '2.0') bad(`仅支持 VERSION:2.0，实际为 “${value.trim()}”`);
      } else if (name === 'METHOD' && value.trim().toUpperCase() === 'CANCEL') {
        bad('取消事件（METHOD:CANCEL）不支持导入');
      }
      // 其余日历级属性（PRODID、CALSCALE 等）忽略
      continue;
    }

    // 事件内属性
    switch (name) {
      case 'UID': {
        if (curUid !== undefined) bad(`VEVENT 内 UID 属性重复（首个为 “${curUid}”）`);
        const uid = unescapeIcalText(value);
        if (uid === '') bad('VEVENT 的 UID 不能为空');
        curUid = uid;
        break;
      }
      case 'DTSTART': {
        if (curStart !== undefined) bad('VEVENT 内 DTSTART 属性重复');
        assertFloatingDateTimeParams(params, 'DTSTART ', bad);
        curStart = parseIcalDateTime(value.trim(), 'DTSTART ', bad);
        break;
      }
      case 'DTEND': {
        if (curEnd !== undefined) bad('VEVENT 内 DTEND 属性重复');
        assertFloatingDateTimeParams(params, 'DTEND ', bad);
        curEnd = parseIcalDateTime(value.trim(), 'DTEND ', bad);
        break;
      }
      case 'STATUS': {
        if (value.trim().toUpperCase() === 'CANCELLED') {
          bad('取消事件（STATUS:CANCELLED）不支持导入');
        }
        break;
      }
      case 'DESCRIPTION':
        break; // 描述属性忽略
      default:
        if (ICAL_RECURRENCE_PROPS.has(name)) {
          bad(`不支持重复相关属性 ${name}（不导入重复事件）`);
        }
        // 其余属性（SUMMARY、LOCATION、DTSTAMP、SEQUENCE 等）忽略
    }
  }

  if (inEvent) bad('VEVENT 缺少对应的 END:VEVENT');
  if (inCalendar) bad('VCALENDAR 缺少对应的 END:VCALENDAR');
  if (!versionSeen) bad('缺少 VERSION:2.0 属性');
  if (events.length === 0) bad('VCALENDAR 中没有任何 VEVENT（至少需要一个独立事件）');
  return events;
}

async function cmdImportIcal(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['resource'], ['resource']);
  if (positionals.length !== 1) {
    throw new UsageError('用法: import-ical <iCalendar 文件> --resource <标识> [--resource <标识> ...]');
  }
  const resourceArgs = values.get('resource');
  if (!resourceArgs || resourceArgs.length === 0) throw new UsageError('至少需要一个 --resource');
  const icalFile = positionals[0];

  const file = activeDataFile;
  const store = await loadStore(file);
  // 新事件统一使用该资源集合（至少一个不同的已登记资源，按标识排序）
  const ids = resolveResourceIds(store, resourceArgs);

  // 输入文件不可读、结构非法均整批失败，不触碰数据文件
  let text: string;
  try {
    text = await readFile(icalFile, 'utf8');
  } catch (err) {
    throw new BizError(`无法读取 iCalendar 文件 ${icalFile}: ${(err as Error).message}`);
  }
  const events = parseIcalFile(text, icalFile);

  // 区分重放与新增：UID 命中既有导入身份即重放候选；
  // 时间与资源集合（顺序无关）须与首次导入快照一致，否则整批拒绝
  const importByUid = new Map(store.imports.map((r) => [r.uid, r]));
  interface ImportItem {
    ev: IcalEvent;
    index: number; // 0 基，按文件顺序
    replay?: ImportRec;
  }
  const mismatches: string[] = [];
  const items: ImportItem[] = events.map((ev, index) => {
    const rec = importByUid.get(ev.uid);
    if (rec === undefined) return {ev, index};
    const sameTime = rec.start === ev.startRaw && rec.end === ev.endRaw;
    const sameResources =
      rec.resourceIds.length === ids.length && rec.resourceIds.every((x, j) => x === ids[j]);
    if (!sameTime || !sameResources) {
      mismatches.push(
        `第 ${index + 1} 项 UID “${ev.uid}”：首次导入为 ${rec.start} → ${rec.end}` +
          `（资源 ${rec.resourceIds.join('、')}），本次为 ${ev.startRaw} → ${ev.endRaw}` +
          `（资源 ${ids.join('、')}）`,
      );
    }
    return {ev, index, replay: rec};
  });
  if (mismatches.length > 0) {
    throw new BizError(
      `iCalendar 导入被拒绝：${mismatches.length} 个 UID 的时间或资源集合与首次导入不一致` +
        '（相同 UID 不会覆盖本地安排，整批未导入）：\n' +
        mismatches.map((m) => `- ${m}`).join('\n'),
    );
  }

  // 仅以新 UID 事件为目标做统一批次校验（无写入副作用）；
  // 重放项关联的旧预约本就在 store.bookings 中，按当前状态与安排自然参与
  // 既有占用（已取消不占用，改期后按新安排占用），不用首次导入快照代替现状
  const newItems = items.filter((it) => it.replay === undefined);
  const targets = newItems.map((it) => ({
    startMin: it.ev.startMin,
    endMin: it.ev.endMin,
    resourceIds: ids,
  }));
  const failures = validateBatchTargets(store, targets);

  if (failures.length > 0) {
    // 按文件顺序报告全部失败 UID、时间、不足资源（含相关停用）与全部冲突；批内冲突双方互列
    const blocks = failures.map((f) => {
      const item = newItems[f.index];
      const lines = [
        `第 ${item.index + 1} 项 UID “${item.ev.uid}”（${item.ev.startRaw} → ${item.ev.endRaw}）：`,
      ];
      if (f.gaps.length > 0) {
        lines.push('  开放不足资源:');
        lines.push(...gapLines(f.gaps, '    '));
      }
      if (f.external.length > 0) {
        lines.push('  冲突预约:');
        for (const c of f.external) {
          lines.push(
            `    - ${c.booking.id}（${c.booking.start} → ${c.booking.end}）` +
              `：共同资源 ${formatResourceIds(store, c.shared)}`,
          );
        }
      }
      if (f.internal.length > 0) {
        lines.push('  批内冲突:');
        for (const x of f.internal) {
          const o = newItems[x.otherIndex];
          lines.push(
            `    - 第 ${o.index + 1} 项 UID “${o.ev.uid}”` +
              `（${o.ev.startRaw} → ${o.ev.endRaw}）` +
              `：共同资源 ${formatResourceIds(store, x.shared)}`,
          );
        }
      }
      return lines.join('\n');
    });
    throw new BizError(
      `iCalendar 导入失败：共 ${failures.length} 项新事件不满足条件（按文件顺序），整批未导入：\n${blocks.join('\n')}`,
    );
  }

  const replayCount = items.length - newItems.length;
  const renderItem = (it: ImportItem, bookingId: string, isNew: boolean): string[] => {
    if (isNew) {
      return [
        `- 第 ${it.index + 1} 项 UID “${it.ev.uid}” → 新预约 ${bookingId}（新增，普通预约，不属于任何系列）`,
        `    时间: ${it.ev.startRaw} → ${it.ev.endRaw}`,
        `    资源: ${formatResourceIds(store, ids)}`,
      ];
    }
    // 重放：返回原预约的当前安排与状态，不做任何改动（已取消/被撤销也不复活）
    const b = store.bookings.find((x) => x.id === bookingId)!;
    const statusLabel = b.status === 'active' ? '已预约' : '已取消';
    return [
      `- 第 ${it.index + 1} 项 UID “${it.ev.uid}” → 预约 ${bookingId}（重放，未做改动）`,
      `    当前状态: ${statusLabel}`,
      `    当前安排: ${b.start} → ${b.end}`,
      `    当前资源: ${formatResourceIds(store, b.resourceIds)}`,
    ];
  };

  if (newItems.length === 0) {
    // 全为重放：不写文件、不推进任何计数
    console.log(
      `iCalendar 导入完成：共 ${items.length} 项，全部为重放（未写入数据文件，标识计数不变）`,
    );
    for (const it of items) {
      console.log(renderItem(it, it.replay!.bookingId, false).join('\n'));
    }
    return;
  }

  // 新预约与导入身份一次原子保存后才成功；标识在此刻才生成，任何失败都不推进计数
  const assigned = new Map<ImportItem, string>();
  for (const it of newItems) {
    store.bookingSeq += 1;
    const bookingId = `B${String(store.bookingSeq).padStart(4, '0')}`;
    store.bookings.push({
      id: bookingId,
      resourceIds: ids,
      start: it.ev.startRaw,
      end: it.ev.endRaw,
      status: 'active',
    });
    store.imports.push({
      uid: it.ev.uid,
      bookingId,
      start: it.ev.startRaw,
      end: it.ev.endRaw,
      resourceIds: [...ids],
    });
    assigned.set(it, bookingId);
  }
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  store.imports.sort((a, b) => a.uid.localeCompare(b.uid));
  await saveStore(file, store);

  console.log(`iCalendar 导入完成：共 ${items.length} 项（新增 ${newItems.length} 项，重放 ${replayCount} 项）`);
  for (const it of items) {
    const isNew = it.replay === undefined;
    const bookingId = isNew ? assigned.get(it)! : it.replay!.bookingId;
    console.log(renderItem(it, bookingId, isNew).join('\n'));
  }
}

// ---------------------------------------------------------------------------
// 帮助与入口
// ---------------------------------------------------------------------------

const HELP_TEXT = `shiftbook —— 本地多资源预约（含按周重复系列、固定/弹性候补队列、资源临时停用、批量改期记录与安全撤销，以及 iCalendar 导入）

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
      修改时间和/或资源（出现 --resource 即整体替换资源集合），标识保持不变；
      系列成员改期后仍属原系列，已取消项不能改期
  reschedule-batch <改期清单文件>
      按本地 JSON 清单原子批量改期多项预约（可一次交换时段、重排多项资源），
      清单写法见下方“批量改期清单”；整批全部通过校验并完整保存后才报告成功，
      任一项不满足则整批失败且原有时间、资源、状态、系列归属与占用全部不变。
      至少一项有变化时生成稳定且不复用的操作标识（如 O0001）并与新安排原子
      保存，记录全部提交项的预约标识、系列归属、改期前后时间与完整资源集合及
      清单顺序；安排均与现状一致的提交成功但不建记录、不改文件或计数
  list-batch-ops
      按操作先后列出全部批量改期操作记录（未撤销/已撤销状态，项按提交顺序
      显示改期前后时间与完整资源、系列归属）；空结果明确提示
  undo-batch-op <操作标识>
      按操作标识整笔安全撤销：涉及预约须仍有效，且当前时间、资源集合、系列
      归属与该记录改期后安排一致（按当前值比对，期间改动后恢复一致仍可撤销；
      不能复活已取消预约），否则整笔拒绝并列出全部不一致预约。再按整笔恢复后
      的最终安排校验开放覆盖与冲突（排除涉及预约自身的当前占用，允许互换时段；
      受阻列出全部失败项、开放不足资源、相关有效停用与全部冲突预约及共同资源）。
      通过后原子恢复原时间与原资源并置为已撤销；不新增记录、不改变标识计数，
      系列归属、候补原请求与兑现关联不变，无关预约不变，不自动处理候补。
      重复撤销已撤销记录成功且不触碰当前安排（即使之后又有改期）；未知标识失败。
      撤销后重提交相同清单若产生变化，生成新的操作标识（不按清单路径或内容复用）
  cancel-booking <预约标识>
      取消单项预约并释放全部资源；系列成员只取消该项；重复取消成功且无变化
  list-bookings --date <YYYY-MM-DD>
      列出与该日相交的预约（含跨日、已取消、系列成员），按开始时间再按标识排序

系列命令（按周重复，成员即普通预约）:
  create-series --resource <标识> [--resource <标识> ...] \\
      --start <首项开始> --end <首项结束> --count <正整数次数>
      自首项起每项相对前一项后移 7 个营业地日历日（时刻、跨日长度不变），
      次数含首项，全部成员使用相同资源；返回稳定系列标识（如 S0001）及
      按发生顺序关联的各项预约标识（如 B0001…）。任一项开放不足或冲突则整批失败
  list-series
      列出全部系列及其全部成员（按当前开始时间、预约标识排序）、资源、时间与状态，
      包括单独改期或取消的成员
  cancel-series <系列标识>
      整体取消该系列仍有效的成员（含单独改期者）并释放资源，记录保留；
      已取消成员与无关预约不受影响；重复取消成功且不变，未知系列失败

候补命令（固定时段 / 弹性时段的多资源候补，不自动处理，两种共用一条登记顺序）:
  add-waitlist --resource <标识> [--resource <标识> ...] \\
      --start <YYYY-MM-DDTHH:mm> --end <YYYY-MM-DDTHH:mm>
      登记一项固定时段候补：至少一个不同的已登记资源，全部资源须被连续开放
      完整覆盖；当前有预约冲突或资源空闲均可登记，候补不占用资源。返回稳定
      且不复用的候补标识（如 W0001）；重复登记相同内容视为另一项候补
  add-flex-waitlist --resource <标识> [--resource <标识> ...] \\
      --window <开始/结束> --duration <正整数分钟>
      登记一项弹性时段候补：在窗口（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm，
      真实有效、结束晚于开始、允许跨日、与机器时区无关）内为全部资源寻找所需
      连续时长的最早安排；时长为不超过窗口长度的正整数分钟。登记忽略预约
      占用，但窗口内全部资源的共同实际可用时间（开放合并重叠或相接后扣除
      有效停用并集，无需整窗开放）须能容纳完整时长，否则拒绝。候补不占用
      资源，返回稳定且不复用的候补标识；重复登记相同内容视为另一项候补
  list-waitlist
      按登记顺序列出全部候补的标识、种类、两种原请求（固定时段或弹性窗口+
      时长）、资源、等待/已兑现/已取消状态及兑现后的预约标识（空队列明确提示）
  cancel-waitlist <候补标识>
      取消等待中的候补（固定或弹性均可；记录保留，仍在列表中显示为已取消）；
      重复取消已取消项成功且不变；未知标识或取消已兑现项失败
  process-waitlist
      手动处理整个队列：按成功登记顺序逐项重查。固定项使用原时段（重查开放
      覆盖与冲突）；弹性项在窗口内取最早可行的开始分钟（结束不超出窗口，
      全部资源同时连续可用，不能拼接空隙），扣除有效预约及本轮已选项占用。
      全部资源可用才选中，受阻项继续等待并继续检查后项，绝不重排队列或移动
      已选项。每个选中项各生成一项普通预约（不加入系列、不改动原预约），
      新预约与候补已兑现状态及关联标识原子保存后才报告成功；结果按队列顺序
      展示（选中项显示两种标识、实际时间与完整资源；固定等待项列开放不足与
      全部阻挡含本轮后项产生的预约；弹性等待项按最终安排列出窗口内全部最大
      共同空闲区间及分钟数，按开始时间排序，空集明确提示）。没有可兑现项也
      成功且不改变记录或计数；预约或停用变更不自动处理候补

停用命令（场地维护、设备检修、人员休息）:
  add-closure --resource <标识> --start <YYYY-MM-DDTHH:mm> --end <YYYY-MM-DDTHH:mm>
      为一个已登记资源登记一段临时停用；不要求该区间原本开放。登记前检查该资源
      的全部有效预约（含系列成员与候补兑现预约，已取消不阻挡；左闭右开，端点
      相接不算重叠），有时间重叠即拒绝并列出全部受影响预约标识及时间，不改期
      或取消它们。成功返回稳定且不复用的停用标识（如 C0001）；相同内容再次
      登记也是另一记录，允许停用重叠或相接
  list-closures
      按开始时间、标识列出全部停用记录的资源、时间与有效/已取消状态
      （空结果明确提示）
  cancel-closure <停用标识>
      仅使指定停用记录失效并保留历史，该区间恢复可用（不超出原开放时间）；
      其他重叠停用仍有效；重复取消成功且无变化，未知标识失败；
      取消不自动创建预约或处理候补

导入命令（本地 iCalendar 文件批量导入预约）:
  import-ical <iCalendar 文件> --resource <标识> [--resource <标识> ...]
      读取 UTF-8 的 VCALENDAR（VERSION:2.0，至少一个独立 VEVENT；每项须有
      一个非空 UID、DTSTART 和 DTEND；时间仅支持浮动 YYYYMMDDTHHmmss，秒为
      00，年份 0001-9999，真实有效、结束晚于开始、允许跨日、不随机器时区
      变化；支持 CRLF 或 LF、标准折行与 UID 文本转义，属性名忽略大小写，
      解码后 UID 区分大小写；描述属性忽略，全天、时区、重复相关属性、取消
      事件及事件内嵌套组件拒绝；结构错误、关键属性重复或文件内 UID 重复
      均整批失败），为每个新事件各创建一项普通预约（不加入系列、不自动
      处理候补），全部新事件统一使用所给资源集合（至少一个不同的已登记
      资源）。UID 在同一数据文件中永久关联首次生成的预约（身份不依赖文件
      路径），并持久保留首次导入的时间与资源集合：相同 UID 且时间、资源
      集合一致为重放（资源顺序、折行与转义写法差异不算变化），返回原预约
      的当前安排与状态且不做任何改动（已改期、取消或撤销也不复活）；时间
      或资源集合不同则整批拒绝，不覆盖本地安排。文件可混合新项与重放项，
      仅新项校验开放覆盖与冲突（含批内冲突与全部既有有效预约）；全部为重
      放时不写文件、不推进计数；新预约与导入身份一次原子保存后才成功，
      按文件顺序显示 UID、预约标识、完整安排及新增或重放。
      文件示例:
        BEGIN:VCALENDAR
        VERSION:2.0
        BEGIN:VEVENT
        UID:meeting-001@example.com
        DTSTART:20261012T100000
        DTEND:20261012T110000
        END:VEVENT
        END:VCALENDAR

实际可用时间:
  资源的实际可用时间 = 原开放区间合并后扣除全部有效停用区间的并集（原开放
  记录保留）。创建预约、单项及批量改期、创建系列、登记及处理候补均按实际
  可用时间检查全部资源的完整覆盖；停用导致不足时列出受影响资源及相关有效
  停用标识和时间。已有候补不因新增停用而删除、取消或判作损坏；处理时受阻
  项继续等待并检查后项。取消停用后候补仅在再次手动处理时尝试兑现。

批量改期清单（reschedule-batch 的 JSON 文件，UTF-8，顶层 {"items": [...]}）:
  清单不能为空；每项字段：
    "bookingId":   要改期的预约标识（如 B0001）；未知或在清单中重复均整批拒绝，
                   已取消预约不能改期；普通预约与不同系列的成员可混合提交，
                   不要求同时提交整个系列
    "start"/"end": 目标起止时间 YYYY-MM-DDTHH:mm，必须真实有效（0001-9999 年），
                   结束晚于开始，允许跨日
    "resourceIds": 完整目标资源集合（如 ["R0001","R0002"]），整体替换原集合，
                   不能为空；未知或重复资源整批拒绝
  校验针对整批完成后的安排：本批各项的旧占用不视为障碍，因此即便逐项改期会被
  其他待改预约的旧占用阻挡，只要最终安排可行整批即成功（如互换时段）；
  逐项检查目标区间被全部目标资源的连续开放区间完整覆盖，以及与本批之外有效
  预约、与本批其他目标安排的冲突。开放不足或冲突时按清单顺序报告全部失败项
  （批内冲突在双方项中互相列明）。成功只改时间与资源，预约标识与系列归属
  不变，不创建预约或系列、不推进预约/系列/候补/停用标识计数；至少一项有
  变化时生成稳定且不复用的批量改期操作标识（O0001…），记录全部提交项并与
  改期原子保存，全部项安排均与现状一致时成功但不建记录、不改文件或操作计数；
  清单不可读、损坏或内容非法同样整批失败。记录可用 list-batch-ops 查询、
  undo-batch-op <操作标识> 整笔安全撤销（撤销不新增记录、不回收或推进计数）。
  清单示例:
    {
      "items": [
        {"bookingId": "B0001", "start": "2026-10-12T10:00", "end": "2026-10-12T11:00", "resourceIds": ["R0001"]},
        {"bookingId": "B0002", "start": "2026-10-12T14:00", "end": "2026-10-12T15:00", "resourceIds": ["R0001", "R0002"]}
      ]
    }

时间规则:
  日期时间格式 YYYY-MM-DDTHH:mm，查询日期 YYYY-MM-DD；
  为与机器时区无关的营业地时间，日期必须真实有效，结束晚于开始，允许跨日；
  按周移动按营业地日历日计算，跨月、闰日、跨年均准确，结果须落在 0001-9999 年内；
  区间左闭右开：一个预约的结束恰为另一预约的开始不算冲突；
  开放区间重叠或相接视为连续开放，预约须被每个所选资源的实际可用时间
  （开放区间扣除有效停用）完整覆盖；
  仅当存在共同资源且时间重叠时预约才冲突。

退出码:
  0  成功
  1  业务或文件失败（名称为空、未知/重复资源或预约、已取消预约、时间非法、
     开放不足、冲突、非法次数、超出四位年份、未知系列、未知候补、取消已兑现
     候补、候补标识非法、停用区间与有效预约重叠、未知停用、停用标识非法、
     改期清单不可读/损坏/内容非法、未知批量改期操作、撤销涉及预约与记录
     不一致或恢复安排受阻、iCalendar 文件不可读/结构非法、UID 与首次导入
     不一致、新事件开放不足或冲突、数据文件损坏（含候补、停用、批量改期或
     导入记录结构、引用或快照非法）或保存失败等）
  2  用法错误（未知参数、缺少必需选项、多余位置参数等）

示例:
  node app.ts add-resource --type 场地 --name 一号会议室 \\
      --open 2026-01-01T00:00/2027-01-01T00:00
  node app.ts create-booking --resource R0001 \\
      --start 2026-10-05T10:00 --end 2026-10-05T11:00
  node app.ts create-series --resource R0001 \\
      --start 2026-10-05T10:00 --end 2026-10-05T11:00 --count 4
  node app.ts list-series
  node app.ts reschedule-booking B0002 --start 2026-10-12T14:00 --end 2026-10-12T15:00
  node app.ts reschedule-batch ./reschedule.json
  node app.ts list-batch-ops
  node app.ts undo-batch-op O0001
  node app.ts list-bookings --date 2026-10-12
  node app.ts cancel-series S0001
  node app.ts add-waitlist --resource R0001 --resource R0002 \\
      --start 2026-10-12T10:00 --end 2026-10-12T11:00
  node app.ts add-flex-waitlist --resource R0001 --resource R0002 \\
      --window 2026-10-12T08:00/2026-10-12T18:00 --duration 60
  node app.ts list-waitlist
  node app.ts process-waitlist
  node app.ts cancel-waitlist W0001
  node app.ts add-closure --resource R0001 \\
      --start 2026-10-06T00:00 --end 2026-10-07T00:00
  node app.ts list-closures
  node app.ts cancel-closure C0001
  node app.ts import-ical ./events.ics --resource R0001 --resource R0002
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
      await cmdListResources(commandArgs);
      break;
    case 'create-booking':
      await cmdCreateBooking(commandArgs);
      break;
    case 'reschedule-booking':
      await cmdRescheduleBooking(commandArgs);
      break;
    case 'reschedule-batch':
      await cmdRescheduleBatch(commandArgs);
      break;
    case 'list-batch-ops':
      await cmdListBatchOps(commandArgs);
      break;
    case 'undo-batch-op':
      await cmdUndoBatchOp(commandArgs);
      break;
    case 'cancel-booking':
      await cmdCancelBooking(commandArgs);
      break;
    case 'list-bookings':
      await cmdListBookings(commandArgs);
      break;
    case 'create-series':
      await cmdCreateSeries(commandArgs);
      break;
    case 'list-series':
      await cmdListSeries(commandArgs);
      break;
    case 'cancel-series':
      await cmdCancelSeries(commandArgs);
      break;
    case 'add-waitlist':
      await cmdAddWaitlist(commandArgs);
      break;
    case 'add-flex-waitlist':
      await cmdAddFlexWaitlist(commandArgs);
      break;
    case 'list-waitlist':
      await cmdListWaitlist(commandArgs);
      break;
    case 'cancel-waitlist':
      await cmdCancelWaitlist(commandArgs);
      break;
    case 'process-waitlist':
      await cmdProcessWaitlist(commandArgs);
      break;
    case 'add-closure':
      await cmdAddClosure(commandArgs);
      break;
    case 'list-closures':
      await cmdListClosures(commandArgs);
      break;
    case 'cancel-closure':
      await cmdCancelClosure(commandArgs);
      break;
    case 'import-ical':
      await cmdImportIcal(commandArgs);
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
