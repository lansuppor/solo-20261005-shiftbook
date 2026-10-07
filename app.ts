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
// 候选组合查询：find-slot 在营业地时间窗口内为一组有顺序的需求（每组列出
// 可任选其一的候选资源）寻找能同时满足全部需求的最早连续时段——每组恰选一
// 个候选，全部所选资源互不相同并全程保持同一组合；只读快照，不写数据文件。
//
// 联合排程：schedule-flex 读取本地 JSON 清单（多项“窗口 + 连续时长 + 有顺序
// 需求组”的弹性预约请求），为整份清单寻找同时可行的安排（不逐项贪选最早，
// 候选开始分钟取基础空闲段起点与其他项占用结束的闭包，按清单顺序深度优先
// 试探，首个完整方案即“逐项先比开始分钟、再按组序比资源标识字典序”的最小
// 方案），有解时按清单顺序各创建一项普通预约并一次原子保存；无整体解明确
// 提示并退出 1，不保存部分方案。
//
// 弹性批量改期：reschedule-flex 读取本地 JSON 清单（多项“既有预约标识 +
// 目标窗口 + 有顺序候选资源组”的改期请求，时长保持预约当前长度），为整单
// 求解最终安排：先最小化变化预约数量（起止时间或完整资源集合不同才算变化），
// 数量相同再按清单顺序逐项先比开始分钟、再按组序比资源标识字典序取最小方案；
// 只改本批时间与资源，有变化时记一条批量改期操作记录（与改期同次原子保存，
// 可 list-batch-ops 查询、undo-batch-op 整笔安全撤销），无变化成功不写文件、
// 不建记录、不推进计数。
//
// 使用统计：usage-stats 统计窗口内所选资源的实际可用、占用、空闲分钟与
// 使用率（逐日 + 整窗 + 全部资源合计），并给出同时被占用的所选资源数量
// 峰值及全部达到峰值的最大连续区间；只读快照，不写数据文件。
//
// iCalendar 导入：import-ical 读取本地 UTF-8 的 VCALENDAR（VERSION:2.0），
// 为每个新 VEVENT 创建预约（统一使用命令行给定的资源集合，不自动处理候补）：
// 无 RRULE 的独立事件创建一项普通预约；带 RRULE:FREQ=WEEKLY;COUNT=n 的事件创建
// 一个按周重复系列（EXDATE 排除的发生不生成成员）。同一 UID 允许一个按周主事件
// （不带 RECURRENCE-ID，须随文件提交）配若干例外 VEVENT（各带单个 RECURRENCE-ID
// 及改期后的 DTSTART/DTEND）：例外匹配主事件展开后未排除的原开始，可改时间与时长，
// 不额外生成成员、不生成额外成员。UID 永久关联首次导入（独立事件关联其预约；
// 重复事件关联其系列、各原发生时间、对应成员及按原发生关联的例外起止集合），
// 相同 UID 且重复与否、首项时间、COUNT、排除集合、例外集合与资源集合一致为重放
// （不改动原安排），任一不同则整批拒绝；例外在文件中的书写位置与顺序不影响身份。
//
// iCalendar 本地导出：export-ical 按已解码 UID 选择一个已导入的按周重复系列，
// 只读一份完整快照，把保存本地变更后的当前安排导出为 VERSION:2.0 的 VCALENDAR
// （主事件保留首次 UID、首项 DTSTART/DTEND 与 RRULE；EXDATE 为首次排除集合与
// 已取消成员原开始的去重并集；有效成员相对原周展开的起止时间或完整资源集合有
// 变化时输出同 UID 例外，RECURRENCE-ID 固定为原开始、目标取当前值，首次导入
// 例外同样重新比较而不复制快照；取消成员不输出例外；全部取消仍生成合法但无
// 有效发生的日历）。不等待或改动写入保护、不修改业务数据、身份、历史或计数。
//
// 多项预约目标（系列成员、批量改期目标、撤销恢复安排、导入新事件）的可行性
// 校验统一由 validateBatchTargets 完成（无写入副作用），各入口只负责展开
// 目标、给出需排除的当前占用，并按各自业务定位与顺序渲染诊断。
//
// 多进程写入保护：所有修改入口以同一数据文件为单位互斥（锁文件），保护覆盖
// 读取决策所需状态、业务校验、分配标识与原子保存全过程；取得保护后据最新数据
// 决策。相对/绝对/含 ./.. 的等价路径共享同一把锁，不同数据文件互不影响。
// 竞争可等待，5 秒内未取得即以退出码 1 报告占用；进程异常退出留下的残留保护
// 由 recover-lock 在确认原写入进程已退出后解除。恢复入口之间以恢复协调文件
// 互斥，在互斥内重新核对目标后才删除，绝不误删新写入者已取得的保护。
// 查询不取锁，保存为原子替换，只读到提交前或提交后的完整快照。

import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {hostname} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';

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

// 一次 iCalendar 导入建立的“UID -> 预约/系列”永久关联：
// 独立事件（无 RRULE）：bookingId 指向首次导入生成的普通预约，count/exdates 缺省。
// 按周重复事件（RRULE:FREQ=WEEKLY;COUNT=n）：seriesId 指向首次导入创建的系列，
// occurrences 按原发生顺序记录每个未排除发生的原开始时间（YYYY-MM-DDTHH:mm）与
// 对应成员预约标识（排除的发生不在其中）；count/exdates 为首次请求的重复参数。
// exceptions 按原发生时间关联该次发生的改期例外（RECURRENCE-ID = 原开始，
// start/end 为例外的改期后起止；首次请求无例外时为空数组），同一次发生至多一个
// 例外，被替换原时段以例外时间参与覆盖与冲突校验。
// 快照保留首次导入的时间与资源集合（之后成员被改期/取消、系列被整体取消也不变），
// 重放按快照比对本次请求，身份不依赖导入文件路径
interface ImportRec {
  uid: string; // 解码后的 UID（区分大小写），同一数据文件内唯一
  bookingId?: string; // 独立事件：首次导入生成的预约标识
  seriesId?: string; // 重复事件：首次导入创建的系列标识
  start: string; // 首次导入的开始时间快照（首项 DTSTART）YYYY-MM-DDTHH:mm
  end: string; // 首次导入的结束时间快照（首项 DTEND）
  resourceIds: string[]; // 首次导入的资源集合快照（按标识排序）
  count?: number; // 仅重复事件：RRULE COUNT（1..100000，含首项）
  exdates?: string[]; // 仅重复事件：排除集合快照（原开始时间文本，按时间排序去重）
  occurrences?: Array<{start: string; bookingId: string}>; // 仅重复事件：原发生时间 -> 成员
  exceptions?: Array<{recurrenceId: string; start: string; end: string}>; // 仅重复事件：按原发生关联的例外起止（按原发生顺序）
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

  // iCalendar 导入身份记录：UID 唯一且非空。两类身份：
  //   独立事件 -> bookingId 指向一项普通预约；
  //   按周重复事件 -> seriesId 指向一个系列，occurrences 按原发生顺序记录每个
  //   未排除发生的原开始时间与对应成员（count/exdates 为首次请求的重复参数）。
  // 成员预约与系列均不得被另一条导入记录重复关联；快照自身须合法（真实时间、
  // 结束晚于开始、资源已知且不重复、COUNT 合法、排除集合与发生映射自洽）。
  // 成员现状（被改期/取消）与首次请求不同不算损坏。
  const importUids = new Set<string>();
  const importLinkedBookings = new Set<string>();
  const importLinkedSeries = new Set<string>();
  const claimBooking = (uid: string, bId: string, at: string): void => {
    if (!bookingById.has(bId)) bad(`${at}(UID “${uid}”) 关联了未知预约: ${bId}`);
    if (importLinkedBookings.has(bId)) {
      bad(`${at}(UID “${uid}”) 预约 ${bId} 已被另一条导入记录关联（一项预约只能对应一个 UID）`);
    }
    importLinkedBookings.add(bId);
  };
  rawImports.forEach((item, idx) => {
    const at = `imports[${idx}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) bad(`${at} 必须是对象`);
    const im = item as Record<string, unknown>;
    if (typeof im.uid !== 'string' || im.uid === '') bad(`${at}.uid 必须是非空字符串`);
    if (importUids.has(im.uid)) bad(`导入记录 UID 重复: ${im.uid}`);
    importUids.add(im.uid);
    const uid = im.uid;

    const hasBooking = im.bookingId !== undefined;
    const hasSeries = im.seriesId !== undefined;
    if (hasBooking === hasSeries) {
      bad(`${at}(UID “${uid}”) 必须恰好提供 bookingId（独立事件）或 seriesId（重复事件）之一`);
    }
    if (typeof im.start !== 'string' || typeof im.end !== 'string') {
      bad(`${at}(UID “${uid}”) 快照起止时间必须是字符串`);
    }
    const s = parseDateTime(im.start as string, `${at}(UID “${uid}”).start`);
    const e = parseDateTime(im.end as string, `${at}(UID “${uid}”).end`);
    if (e <= s) bad(`${at}(UID “${uid}”) 快照结束必须晚于开始`);
    if (!Array.isArray(im.resourceIds) || im.resourceIds.length === 0) {
      bad(`${at}(UID “${uid}”).resourceIds 必须是非空数组`);
    }
    const rids = im.resourceIds as unknown[];
    const rseen = new Set<string>();
    rids.forEach((rid) => {
      if (typeof rid !== 'string' || !resourceIds.has(rid)) {
        bad(`${at}(UID “${uid}”) 快照引用了未知资源: ${String(rid)}`);
      }
      if (rseen.has(rid)) bad(`${at}(UID “${uid}”) 快照资源重复: ${rid}`);
      rseen.add(rid);
    });

    const rec: ImportRec = {
      uid,
      start: im.start as string,
      end: im.end as string,
      resourceIds: [...rseen].sort(),
    };

    if (hasBooking) {
      // 独立事件身份：不得携带重复字段
      if (typeof im.bookingId !== 'string' || !/^B\d{4,}$/.test(im.bookingId)) {
        bad(`${at}(UID “${uid}”).bookingId 非法: ${String(im.bookingId)}`);
      }
      for (const k of ['count', 'exdates', 'occurrences', 'exceptions']) {
        if (im[k] !== undefined) bad(`${at}(UID “${uid}”) 独立事件身份不应携带 ${k}`);
      }
      claimBooking(uid, im.bookingId as string, at);
      rec.bookingId = im.bookingId as string;
      store.imports.push(rec);
      return;
    }

    // 重复事件身份
    if (typeof im.seriesId !== 'string' || !/^S\d{4,}$/.test(im.seriesId)) {
      bad(`${at}(UID “${uid}”).seriesId 非法: ${String(im.seriesId)}`);
    }
    if (!seriesIds.has(im.seriesId)) {
      bad(`${at}(UID “${uid}”) 关联了未知系列: ${im.seriesId}`);
    }
    if (importLinkedSeries.has(im.seriesId)) {
      bad(`${at}(UID “${uid}”) 系列 ${im.seriesId} 已被另一条导入记录关联（一个系列只能对应一个 UID）`);
    }
    importLinkedSeries.add(im.seriesId);
    rec.seriesId = im.seriesId;

    if (!isInt(im.count) || im.count < 1 || im.count > MAX_OCCURRENCES) {
      bad(`${at}(UID “${uid}”).count 必须是 1..${MAX_OCCURRENCES} 的整数`);
    }
    rec.count = im.count;
    if (!Array.isArray(im.exdates)) bad(`${at}(UID “${uid}”).exdates 必须是数组`);
    const exSet = new Set<string>();
    (im.exdates as unknown[]).forEach((xv, j) => {
      if (typeof xv !== 'string') bad(`${at}(UID “${uid}”).exdates[${j}] 必须是时间字符串`);
      parseDateTime(xv, `${at}(UID “${uid}”).exdates[${j}]`);
      if (exSet.has(xv)) bad(`${at}(UID “${uid}”) 排除时间重复: ${xv}`);
      exSet.add(xv);
    });
    rec.exdates = [...exSet].sort();

    if (!Array.isArray(im.occurrences) || im.occurrences.length === 0) {
      bad(`${at}(UID “${uid}”).occurrences 必须是非空数组（全部发生被排除的首次请求非法）`);
    }
    const occTimes = new Set<string>();
    const occs: Array<{start: string; bookingId: string}> = [];
    (im.occurrences as unknown[]).forEach((ov, j) => {
      const oat = `${at}(UID “${uid}”).occurrences[${j}]`;
      if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) bad(`${oat} 必须是对象`);
      const o = ov as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k !== 'start' && k !== 'bookingId') bad(`${oat} 存在未知字段 “${k}”`);
      }
      if (typeof o.start !== 'string') bad(`${oat}.start 必须是时间字符串`);
      parseDateTime(o.start, `${oat}.start`);
      if (occTimes.has(o.start)) bad(`${at}(UID “${uid}”) 原发生时间重复: ${o.start}`);
      occTimes.add(o.start);
      if (typeof o.bookingId !== 'string' || !/^B\d{4,}$/.test(o.bookingId)) {
        bad(`${oat}.bookingId 非法: ${String(o.bookingId)}`);
      }
      claimBooking(uid, o.bookingId, at);
      occs.push({start: o.start, bookingId: o.bookingId});
    });

    // 映射自洽性：按首项与 COUNT 展开全部原发生（须在四位年份内），
    // 未排除发生必须恰好等于 occurrences（时间集合一致、顺序按发生先后）
    const expectedAll: string[] = [];
    for (let i = 0; i < rec.count; i++) {
      const raw = formatDateTime(s + i * 7 * 1440);
      if (raw === null) bad(`${at}(UID “${uid}”) 重复展开超出四位年份范围（0001-9999）`);
      expectedAll.push(raw);
    }
    const expectedKept = expectedAll.filter((t) => !exSet.has(t));
    const excludedNotInSeries = [...exSet].filter((t) => !expectedAll.includes(t));
    if (excludedNotInSeries.length > 0) {
      bad(`${at}(UID “${uid}”) 排除时间不匹配任何原发生: ${excludedNotInSeries.join('、')}`);
    }
    if (occs.length !== expectedKept.length || occs.some((o, j) => o.start !== expectedKept[j])) {
      bad(
        `${at}(UID “${uid}”) 发生映射缺漏或重复：COUNT=${rec.count}、排除 ${exSet.size} 项` +
          `时应有 ${expectedKept.length} 个未排除发生且按发生顺序排列`,
      );
    }
    // 成员必须恰好为所关联系列的全部成员（1:1：系列成员不重不漏）
    const seriesMembers = new Set(
      store.bookings.filter((b) => b.seriesId === rec.seriesId).map((b) => b.id),
    );
    for (const o of occs) {
      if (!seriesMembers.has(o.bookingId)) {
        bad(`${at}(UID “${uid}”) 成员 ${o.bookingId} 不属于系列 ${rec.seriesId}`);
      }
    }
    if (occs.length !== seriesMembers.size) {
      bad(`${at}(UID “${uid}”) 系列 ${rec.seriesId} 存在未登记在 occurrences 中的成员（系列与发生映射必须一一对应）`);
    }
    rec.occurrences = occs;

    // 例外集合（旧记录无 exceptions 字段视为空集合）：每项按原发生时间
    // （RECURRENCE-ID，必须命中某个未排除原发生）关联改期后起止，同一原发生
    // 至多一个例外；快照自身须合法（真实时间、结束晚于开始）。成员现状与
    // 例外快照不同不算损坏（本地可再改期、取消）。
    const exceptions: Array<{recurrenceId: string; start: string; end: string}> = [];
    if (im.exceptions !== undefined) {
      if (!Array.isArray(im.exceptions)) bad(`${at}(UID “${uid}”).exceptions 必须是数组`);
      const keptTimes = new Set(occs.map((o) => o.start));
      const exOccSeen = new Set<string>();
      (im.exceptions as unknown[]).forEach((xv, j) => {
        const eat = `${at}(UID “${uid}”).exceptions[${j}]`;
        if (typeof xv !== 'object' || xv === null || Array.isArray(xv)) bad(`${eat} 必须是对象`);
        const x = xv as Record<string, unknown>;
        for (const k of Object.keys(x)) {
          if (k !== 'recurrenceId' && k !== 'start' && k !== 'end') bad(`${eat} 存在未知字段 “${k}”`);
        }
        if (typeof x.recurrenceId !== 'string') bad(`${eat}.recurrenceId 必须是时间字符串`);
        parseDateTime(x.recurrenceId, `${eat}.recurrenceId`);
        if (!keptTimes.has(x.recurrenceId)) {
          bad(`${at}(UID “${uid}”) 例外的 RECURRENCE-ID ${x.recurrenceId} 不匹配任何未排除原发生`);
        }
        if (exOccSeen.has(x.recurrenceId)) {
          bad(`${at}(UID “${uid}”) 同一原发生存在重复例外: ${x.recurrenceId}`);
        }
        exOccSeen.add(x.recurrenceId);
        if (typeof x.start !== 'string') bad(`${eat}.start 必须是时间字符串`);
        if (typeof x.end !== 'string') bad(`${eat}.end 必须是时间字符串`);
        const xs = parseDateTime(x.start, `${eat}.start`);
        const xe = parseDateTime(x.end, `${eat}.end`);
        if (xe <= xs) bad(`${eat} 结束必须晚于开始`);
        exceptions.push({recurrenceId: x.recurrenceId, start: x.start, end: x.end});
      });
    }
    // 规范化为按原发生顺序排列，顺序不影响身份
    const occOrder = new Map(occs.map((o, k) => [o.start, k]));
    exceptions.sort((a, b) => occOrder.get(a.recurrenceId)! - occOrder.get(b.recurrenceId)!);
    rec.exceptions = exceptions;

    store.imports.push(rec);
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
// 多进程写入保护（同一数据文件全局互斥）
//
// 所有修改入口在读取数据前先取得本数据文件的写入保护（锁文件，wx 独占创建），
// 保护覆盖读取决策所需状态、业务校验、标识分配与原子保存全过程，命令结束时
// 统一释放（正常结束、校验失败、保存失败均释放）。锁文件按数据文件的规范路径
// 命名：相对路径、绝对路径与含 ./.. 的等价写法共享同一把锁；不同数据文件
// 互不影响；数据文件尚不存在时同样受保护。竞争可等待，但 5 秒内未取得即以
// 退出码 1 报告占用（可重试）。进程异常退出会留下残留锁：recover-lock 仅在
// 确认原写入进程已退出后解除，存活或无法确认一律拒绝，不按保护存在时长抢占。
//
// 交接互斥：取得（wx 独占创建）、释放（仅删自己取得的那份）、恢复三者都不得
// 误删他人的保护。恢复入口之间以恢复协调文件（<锁文件>.recover，wx 独占创建）
// 互斥：任一时刻至多一个恢复者持有协调文件，持有者在互斥内重新核对目标后才
// 删除锁文件——持有协调文件期间，原持有者已确认退出（不会再释放）、其他恢复者
// 进不了互斥、新写入者只能在锁文件不存在时取得（wx），因此互斥内的删除恰好
// 删除本次确认的那一份残留保护，绝不误删新写入者已取得的保护；发现目标更替
// （锁已易主或已消失）则以退出码 1 说明原因或按无操作退出 0，不宣称解除新保护。
// 恢复者异常退出会留下残留协调文件：下一恢复入口在确认其持有者已退出后清理
// 并重试，无需人工删文件。
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 5000; // 取得写入保护的最长等待时间
const LOCK_RETRY_MS = 40; // 竞争重试间隔（含随机抖动，避免齐步）

// 数据文件的规范路径：解析相对路径与 ./..，并尽量解析符号链接
// （文件尚不存在时解析其父目录，父目录也不可用时退化为绝对路径）
function canonicalDataPath(file: string): string {
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

// 锁文件路径：与数据文件同目录、按规范路径命名；文件名长度受限（如 255 字节）
// 时退化为同目录下的散列锁名，同一数据文件的所有进程仍共享同一把锁
function lockPathFor(file: string): string {
  const canonical = canonicalDataPath(file);
  const primary = `${canonical}.lock`;
  if (Buffer.byteLength(basename(primary), 'utf8') <= 250) return primary;
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 24);
  return join(dirname(canonical), `.shiftbook-${hash}.lock`);
}

// 恢复协调文件路径：恢复入口之间的互斥（<锁文件>.recover），与锁文件同样
// 按规范路径命名并受文件名长度限制（超限时同样退化为同目录散列名）
function recoveryPathFor(file: string): string {
  const lockPath = lockPathFor(file);
  const primary = `${lockPath}.recover`;
  if (Buffer.byteLength(basename(primary), 'utf8') <= 250) return primary;
  const canonical = canonicalDataPath(file);
  const hash = createHash('sha256').update(`${canonical}recover`).digest('hex').slice(0, 24);
  return join(dirname(canonical), `.shiftbook-${hash}.recover`);
}

interface LockInfo {
  pid: number; // 取得保护的进程
  host: string; // 取得保护的主机（恢复时只能确认本机进程）
  dataFile: string; // 被保护数据文件的规范路径
  acquiredAt: string; // 取得时间（ISO 文本，仅供诊断，不作为解除依据）
}

function currentLockInfo(file: string): LockInfo {
  return {
    pid: process.pid,
    host: hostname(),
    dataFile: canonicalDataPath(file),
    acquiredAt: new Date().toISOString(),
  };
}

// 解析锁/协调文件内容；无法辨认（非 JSON、缺字段或字段非法）返回 null
function parseLockInfo(text: string): LockInfo | null {
  try {
    const parsed = JSON.parse(text) as LockInfo;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.host !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// 确认 info 所指保护的原持有进程已退出：存活、非本机、内容无法辨认或查询异常
// 均抛出 BizError 拒绝，不按保护存在时长抢占；确认退出后返回该 info
function assertLockStale(info: LockInfo | null, lockPath: string): LockInfo {
  if (info === null) {
    throw new BizError(
      `写入保护文件 ${lockPath} 内容无法辨认，无法确认原写入进程，拒绝解除（请人工核查后自行处理该文件）`,
    );
  }
  if (info.host !== hostname()) {
    throw new BizError(
      `写入保护由另一台主机（${info.host}）的进程 ${info.pid} 取得，本机无法确认其是否已退出，拒绝解除`,
    );
  }
  let alive = false;
  try {
    process.kill(info.pid, 0);
    alive = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw new BizError(`无法确认原写入进程 ${info.pid} 是否已退出（无权限查询），拒绝解除写入保护`);
    }
  }
  if (alive) {
    throw new BizError(
      `写入保护仍由运行中的进程 ${info.pid} 持有（始于 ${info.acquiredAt}），拒绝解除；` +
        '不按保护存在时长抢占，请等待其结束，或确认其已退出后重试',
    );
  }
  return info;
}

// 测试同步点（仅当环境变量 SHIFTBOOK_TEST_SYNC_DIR 指向某目录时启用）：
// 到达指定步骤时写入 <dir>/<name>.ready（内容为进程标识），并等待 <dir>/<name>.go
// 出现后继续，供回归测试以真实子进程精确控制取得/恢复交接的时序（明确同步点，
// 而非随机延时）。正常使用不设置该变量，完全无开销。
async function testSyncPoint(name: string): Promise<void> {
  const dir = process.env.SHIFTBOOK_TEST_SYNC_DIR;
  if (!dir) return;
  const go = join(dir, `${name}.go`);
  await writeFile(join(dir, `${name}.ready`), `${process.pid}\n`, 'utf8');
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await readFile(go, 'utf8');
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new BizError(`测试同步点 ${name} 无法读取: ${(err as Error).message}`);
      }
      if (Date.now() >= deadline) throw new BizError(`测试同步点 ${name} 等待超时`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

// 本进程当前持有的锁（一次命令至多一把；main 统一释放）
let heldLockPath: string | null = null;

async function acquireWriteLock(file: string): Promise<void> {
  if (heldLockPath !== null) return;
  const lockPath = lockPathFor(file);
  const content = JSON.stringify(currentLockInfo(file)) + '\n';
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await writeFile(lockPath, content, {encoding: 'utf8', flag: 'wx'});
      heldLockPath = lockPath;
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new BizError(`无法取得数据文件写入保护（锁文件 ${lockPath}）：${(err as Error).message}`);
      }
      if (Date.now() >= deadline) {
        let owner = '';
        try {
          const info = JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
          owner = `（当前由进程 ${info.pid} 持有，始于 ${info.acquiredAt}）`;
        } catch {
          // 占用信息不可读不影响“被占用”的结论
        }
        throw new BizError(
          `数据文件 ${file} 正被其他进程占用${owner}：${LOCK_TIMEOUT_MS / 1000} 秒内未能取得写入保护，` +
            '本次未做任何改动，可稍后重试；若确认原写入进程已异常退出，可使用 recover-lock 解除残留保护',
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS + Math.floor(Math.random() * LOCK_RETRY_MS)));
    }
  }
}

// 释放本进程取得的保护；仅删除自己创建的锁文件，绝不动其他进程后来取得的保护
async function releaseWriteLock(): Promise<void> {
  const lockPath = heldLockPath;
  if (lockPath === null) return;
  heldLockPath = null;
  try {
    const info = JSON.parse(await readFile(lockPath, 'utf8')) as LockInfo;
    if (info.pid !== process.pid || info.host !== hostname()) return;
    await unlink(lockPath);
  } catch {
    // 锁文件已不存在或不可读：不影响本次命令的结果
  }
}

// 修改入口专用读取：先取得本数据文件的写入保护，再据最新数据决策。
// 保护一直持有到命令结束（main 统一释放），覆盖业务校验、标识分配与原子保存。
async function loadStoreForWrite(file: string): Promise<Store> {
  await acquireWriteLock(file);
  await testSyncPoint('write-lock-acquired'); // 测试钩子：取得保护后的交接观察点
  return loadStore(file);
}

// 本地恢复入口：仅确认原写入进程已退出时才解除残留保护；存活或无法确认一律
// 明确拒绝，不按保护存在时长抢占。不重放旧命令，不改业务数据或标识计数。
//
// 交接安全：恢复者之间以恢复协调文件互斥（wx 独占创建，任一时刻至多一个
// 恢复者），持有者在互斥内重新核对目标后才删除锁文件。持有协调文件期间：
// 原持有进程已确认退出（不会再释放该锁）、其他恢复者进不了互斥、新写入者
// 只能在锁文件不存在时取得（wx 独占创建）——因此互斥内的 unlink 恰好删除
// 本次确认的那一份残留保护，绝不误删新写入者后来取得的保护；发现目标更替
// （锁已易主或已消失）以退出码 1 说明原因或按无操作退出 0，不宣称解除新保护。
// 恢复者异常退出留下的残留协调文件，由下一恢复入口在确认其持有者退出后清理，
// 无需人工删文件。
async function cmdRecoverLock(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(`recover-lock 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`);
  }
  if (positionals.length > 0) {
    throw new UsageError('用法: recover-lock（确认原写入进程已退出后，解除本数据文件的残留写入保护）');
  }

  const file = activeDataFile;
  const lockPath = lockPathFor(file);
  const recoveryPath = recoveryPathFor(file);

  // 读取锁文件：undefined = 不存在；null = 内容无法辨认
  const readLockInfo = async (): Promise<LockInfo | null | undefined> => {
    let text: string;
    try {
      text = await readFile(lockPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new BizError(`无法读取写入保护文件 ${lockPath}: ${(err as Error).message}`);
    }
    return parseLockInfo(text);
  };

  // 第一次检查（不创建任何协调状态）：无保护直接退出 0 且无操作；
  // 明显不可恢复（存活、非本机、无法辨认、查询异常）直接拒绝
  const first = await readLockInfo();
  if (first === undefined) {
    console.log(`数据文件 ${file} 没有残留写入保护，无需恢复。`);
    return;
  }
  assertLockStale(first, lockPath);

  // 取得恢复互斥（协调文件，wx 独占创建）：保证“核对目标”与“解除保护”之间
  // 没有其他恢复者插入。已有协调文件时：持有者存活则退出 1（不重复解除）；
  // 确认持有者已退出则清理其残留协调文件后重试（恢复者异常退出的交接清理）。
  const myInfo = JSON.stringify(currentLockInfo(file)) + '\n';
  for (;;) {
    try {
      await writeFile(recoveryPath, myInfo, {encoding: 'utf8', flag: 'wx'});
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new BizError(`无法取得恢复互斥（协调文件 ${recoveryPath}）：${(err as Error).message}`);
      }
      let otherText: string;
      try {
        otherText = await readFile(recoveryPath, 'utf8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue; // 刚好被清理，重试
        throw new BizError(`无法读取恢复协调文件 ${recoveryPath}: ${(readErr as Error).message}`);
      }
      const other = parseLockInfo(otherText);
      if (other === null) {
        throw new BizError(
          `恢复协调文件 ${recoveryPath} 内容无法辨认，无法确认另一恢复进程是否存活，拒绝继续（请人工核查后自行处理该文件）`,
        );
      }
      if (other.host !== hostname()) {
        throw new BizError(
          `恢复协调文件由另一台主机（${other.host}）的进程 ${other.pid} 取得，本机无法确认其是否已退出，拒绝继续`,
        );
      }
      let otherAlive = false;
      try {
        process.kill(other.pid, 0);
        otherAlive = true;
      } catch (killErr) {
        if ((killErr as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw new BizError(`无法确认另一恢复进程 ${other.pid} 是否已退出（无权限查询），拒绝继续`);
        }
      }
      if (otherAlive) {
        throw new BizError(
          `另一恢复进程 ${other.pid} 正在处理本数据文件的写入保护，本次不重复解除；请等待其结束后重试`,
        );
      }
      // 另一恢复者已确认退出：清理其残留协调文件（可能刚好被他人清理，忽略失败）
      await unlink(recoveryPath).catch(() => {});
    }
  }

  // 持有恢复互斥：此刻起其他恢复者进不了互斥；原持有进程已确认退出不会再释放；
  // 新写入者只能在锁文件不存在时取得（wx）。因此在互斥内重新核对目标后的删除，
  // 恰好删除本次确认的那一份残留保护。
  try {
    const second = await readLockInfo();
    if (second === undefined) {
      console.log('残留写入保护已被解除（可能由另一恢复入口处理），无需重复操作。');
      return;
    }
    // 目标更替（旧保护已被解除、新写入者取得保护）在此拒绝：存活即退出 1，
    // 绝不删除新写入者的保护，也不宣称解除
    const info = assertLockStale(second, lockPath);
    await testSyncPoint('recover-before-unlock'); // 测试钩子：删除前的交接观察点
    await unlink(lockPath);
    console.log(
      `已解除数据文件 ${file} 的残留写入保护（原写入进程 ${info.pid} 已确认退出）。` +
        '未重放任何旧命令，数据文件、业务记录与标识计数均未改动。',
    );
  } finally {
    // 释放恢复互斥：仅删除自己取得的那一份协调文件（内容核对为本进程）
    try {
      const info = parseLockInfo(await readFile(recoveryPath, 'utf8'));
      if (info !== null && info.pid === process.pid && info.host === hostname()) {
        await unlink(recoveryPath);
      }
    } catch {
      // 协调文件已不存在或不可读：不影响本次恢复的结果
    }
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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(activeDataFile);

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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);

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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);

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

// 解析“窗口开始/窗口结束”（弹性候补窗口、候选组合查询窗口共用；label 用于报错定位）
function parseFlexWindow(
  value: string,
  label = '弹性窗口',
): {start: string; end: string; startMin: number; endMin: number} {
  const parts = String(value ?? '').split('/');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new BizError(
      `${label}格式非法: “${value}”，应为 窗口开始/窗口结束（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm）`,
    );
  }
  const start = parts[0];
  const end = parts[1];
  const startMin = parseDateTime(start, `${label}开始时间`);
  const endMin = parseDateTime(end, `${label}结束时间`);
  if (endMin <= startMin) {
    throw new BizError(`${label}结束时间必须晚于开始时间: “${value}”，允许跨日`);
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
  const store = await loadStoreForWrite(file);

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
  const store = await loadStoreForWrite(file);
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
  const store = await loadStoreForWrite(file);

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
// 候选资源组合的最早可行时段查询（find-slot，只读）
//
// 给定营业地时间窗口、所需连续分钟数与有顺序的需求组（每组列出可任选其一的
// 已登记资源），在窗口内寻找能同时满足全部需求的最早开始分钟：每组恰选一个
// 候选，全部所选资源互不相同，并在整个时段保持同一组合（不中途更换资源、
// 不拼接间断时间）。各资源空闲时间 = 开放区间合并重叠或相接后扣除有效停用
// 并集与当前有效预约占用（取消的预约/停用与未兑现候补不阻挡），区间左闭
// 右开、端点相接可行。同一最早开始有多个组合时，按组顺序的资源标识序列取
// 字典序最小者。本命令只读一份完整快照：不取写入保护、不创建任何记录、
// 不写数据文件或推进计数；方案不保留位置，后续创建预约仍检查最新状态。
// ---------------------------------------------------------------------------

interface RequirementGroup {
  index: number; // 1 基，需求组顺序
  candidates: string[]; // 已校验、按标识排序的候选资源（组内输入顺序不影响结果）
}

// 解析并校验需求组：至少一组（由调用方保证），每组非空；
// 组内重复或未知资源拒绝；同一资源允许出现在不同组（求解时保证所选互不相同）
function parseRequirementGroups(store: Store, rawGroups: string[]): RequirementGroup[] {
  return rawGroups.map((raw, i) => {
    const label = `第 ${i + 1} 需求组`;
    const ids = raw.split(',').map((s) => s.trim());
    if (ids.some((s) => s === '')) {
      throw new BizError(
        `${label}为空或含空项: “${raw}”，应为逗号分隔的已登记资源标识（如 R0001,R0002）`,
      );
    }
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const id of ids) {
      if (seen.has(id) && !dupes.includes(id)) dupes.push(id);
      seen.add(id);
    }
    if (dupes.length > 0) throw new BizError(`${label}内候选资源重复: ${dupes.join('、')}`);
    const unknown = [...seen].filter((id) => !store.resources.some((r) => r.id === id)).sort();
    if (unknown.length > 0) throw new BizError(`${label}含未知资源标识: ${unknown.join('、')}`);
    return {index: i + 1, candidates: [...seen].sort()};
  });
}

// 单个资源在窗口内的空闲区间：实际可用时间（开放合并后扣除有效停用并集）
// 裁进窗口，再扣除该资源当前有效预约的占用（普通预约、系列成员、导入预约与
// 候补兑现预约均按当前安排占用；已取消不占用）；
// excludeBookingIds 中的预约（弹性批量改期的本批预约）旧占用不计
function resourceFreeSegments(
  store: Store,
  id: string,
  wStart: number,
  wEnd: number,
  excludeBookingIds: ReadonlySet<string> = new Set<string>(),
): Array<[number, number]> {
  const r = store.resources.find((x) => x.id === id)!;
  const available = clipSegments(availableSegmentsOf(store, r), wStart, wEnd);
  const busy: Array<[number, number]> = [];
  for (const b of store.bookings) {
    if (b.status !== 'active') continue;
    if (excludeBookingIds.has(b.id)) continue;
    if (!b.resourceIds.includes(id)) continue;
    const bStart = parseDateTime(b.start, '预约开始时间');
    const bEnd = parseDateTime(b.end, '预约结束时间');
    const a = Math.max(bStart, wStart);
    const c = Math.min(bEnd, wEnd);
    if (a < c) busy.push([a, c]);
  }
  return subtractSegments(available, busy);
}

// 固定开始分钟上的字典序最小可行资源序列：逐组按标识升序试探，
// 选定前先用增广路匹配确认剩余组仍能各选一个互不相同的可用候选，
// 因此不会因前组贪选较小标识而漏掉需要调整前组选择的可行组合，
// 也不会把每组各自可行误当成整体可行
function lexMinAssignment(
  groups: RequirementGroup[],
  usable: (id: string) => boolean,
): string[] | null {
  const chosen: string[] = [];
  const used = new Set<string>();

  // 第 from 组起（0 基）在 used 之外能否各选一个互不相同的可用候选
  const restMatchable = (from: number): boolean => {
    const match = new Map<string, number>(); // 资源 -> 组下标
    const tryAssign = (g: number, seen: Set<string>): boolean => {
      for (const id of groups[g].candidates) {
        if (used.has(id) || seen.has(id) || !usable(id)) continue;
        seen.add(id);
        const owner = match.get(id);
        if (owner === undefined || tryAssign(owner, seen)) {
          match.set(id, g);
          return true;
        }
      }
      return false;
    };
    for (let g = from; g < groups.length; g++) {
      if (!tryAssign(g, new Set())) return false;
    }
    return true;
  };

  for (let g = 0; g < groups.length; g++) {
    let picked: string | null = null;
    for (const id of groups[g].candidates) {
      if (used.has(id) || !usable(id)) continue;
      used.add(id);
      if (restMatchable(g + 1)) {
        picked = id;
        break;
      }
      used.delete(id);
    }
    if (picked === null) return null;
    chosen.push(picked);
  }
  return chosen;
}

// 窗口内能同时满足全部需求的最早开始分钟及该时刻字典序最小的组合；
// 最早可行开始必为某候选资源某段空闲的起点（共同空闲段的起点即某资源空闲段起点），
// 故逐一升序试探全部候选资源的空闲段起点即可
function findEarliestSlot(
  store: Store,
  groups: RequirementGroup[],
  wStart: number,
  wEnd: number,
  duration: number,
): {startMin: number; endMin: number; picks: string[]} | null {
  const freeById = new Map<string, Array<[number, number]>>();
  const starts = new Set<number>();
  for (const g of groups) {
    for (const id of g.candidates) {
      if (freeById.has(id)) continue;
      const free = resourceFreeSegments(store, id, wStart, wEnd);
      freeById.set(id, free);
      for (const [s, e] of free) {
        if (e - s >= duration) starts.add(s);
      }
    }
  }

  const usableAt = (s: number): ((id: string) => boolean) => {
    const e = s + duration;
    const cache = new Map<string, boolean>();
    return (id: string): boolean => {
      let v = cache.get(id);
      if (v === undefined) {
        v = isFullyCovered(freeById.get(id)!, s, e);
        cache.set(id, v);
      }
      return v;
    };
  };

  for (const s of [...starts].sort((a, b) => a - b)) {
    if (s + duration > wEnd) continue; // 结束不得超出窗口
    const picks = lexMinAssignment(groups, usableAt(s));
    if (picks !== null) return {startMin: s, endMin: s + duration, picks};
  }
  return null;
}

async function cmdFindSlot(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['window', 'duration', 'group'], ['group']);
  if (positionals.length > 0) {
    throw new UsageError(`find-slot 不接受位置参数: ${positionals.join(' ')}`);
  }
  const windowRaw = requireFlag(values, 'window');
  const durationRaw = requireFlag(values, 'duration');
  const groupArgs = values.get('group');
  if (!groupArgs || groupArgs.length === 0) {
    throw new UsageError('至少需要一个 --group 需求组（逗号分隔的候选资源标识，如 --group R0001,R0002）');
  }

  // 查询只读一份完整快照：不取写入保护、不写数据文件、不推进任何计数
  const store = await loadStore(activeDataFile);

  const win = parseFlexWindow(windowRaw, '查询窗口');
  const durationMinutes = parseDurationMinutes(durationRaw);
  const windowLength = win.endMin - win.startMin;
  if (durationMinutes > windowLength) {
    throw new BizError(
      `所需连续时长 ${durationMinutes} 分钟超过窗口长度 ${windowLength} 分钟（窗口: ${win.start} → ${win.end}）`,
    );
  }
  const groups = parseRequirementGroups(store, groupArgs);

  const found = findEarliestSlot(store, groups, win.startMin, win.endMin, durationMinutes);
  if (found === null) {
    // 无解明确提示，退出码仍为 0；绝不返回少组或缩短时长的方案
    console.log(
      `无解：窗口 ${win.start} → ${win.end} 内不存在能同时满足全部 ${groups.length} 个需求组的` +
        `连续 ${durationMinutes} 分钟时段（每组须各选一个候选，全部所选资源互不相同并全程保持同一组合）。`,
    );
    return;
  }

  const startRaw = formatDateTime(found.startMin);
  const endRaw = formatDateTime(found.endMin);
  if (startRaw === null || endRaw === null) {
    // 理论不可达：窗口已校验在 0001-9999 内，时段不超出窗口
    throw new BizError('可行时段超出四位年份范围');
  }
  console.log(`最早可行时段: ${startRaw} → ${endRaw}（${durationMinutes} 分钟）`);
  console.log('所选资源（按需求组顺序，全程保持同一组合）:');
  found.picks.forEach((id, i) => {
    const r = store.resources.find((x) => x.id === id)!;
    console.log(`  第 ${i + 1} 组: ${id}（${r.name}，${RESOURCE_TYPE_LABEL[r.type]}）`);
  });
}

// ---------------------------------------------------------------------------
// 多项弹性预约的联合排程与原子创建（schedule-flex）
//
// 读取本地 JSON 清单（{"items": [...], "relations": [...]}，非空、有顺序），
// 每项给出营业地时间窗口、所需连续分钟数与有顺序的需求组（每组列出一个可
// 任选其一的候选资源数组）；顶层可附 "relations"（省略或为空保持原行为）：
// 每条关系以从 1 开始的清单序号指定前项与后项及非负整数分钟最小、最大间隔
// （minGap <= maxGap，零允许紧接），要求“后项开始 - 前项结束 ∈ [min,max]”
// 含两端；关系可逆清单顺序、也适用于不同资源的项；非整数或越界序号、自指、
// 重复有向关系、有向环均由 parseFlexRelations 整单拒绝。
// 为整份清单寻找同时可行的安排：每项完整落在自身窗口内，每组恰选一个候选，
// 一项所选资源互不相同并全程固定（不换资源、不拼接间断）；全部关系同时
// 生效；新项之间仅共同资源的左闭右开时间重叠才冲突，端点相接可行。多个
// 完整方案按清单顺序逐项比较：先比该项开始分钟，再按需求组顺序以字符串
// 字典序比资源标识，第一处差异取较小者，随后才比较下一项（清单顺序只用于
// 取舍，不限定活动发生先后；关系不改变取舍次序）。
// 有解时按清单顺序各创建一项普通预约（稳定、不复用标识，不加入系列、不改动
// 既有预约与候补、不自动处理候补、不保留关系），原子保存全部预约后才报告
// 成功；无整体解明确提示并退出 1，不保存部分方案。每次提交都是新的创建
// 请求，不按清单路径或内容去重。
//
// 求解不逐项贪选最早：项 i 的开始分钟若被项 j 的占用“顶住”，则 s_i = s_j + d_j，
// 故候选开始分钟取三类边界的闭包：(1) 基础空闲段起点；(2) 其他项占用结束
// s_j + d_j（仅候选资源集合有交集的项之间传播）；(3) 关系间隔边界——关系
// p->q 间隔 [lo,hi] 下，已知 s_p 传播 s_q 的 s_p+d_p+lo 与 s_p+d_p+hi，已知
// s_q 传播 s_p 的 s_q-d_p-hi 与 s_q-d_p-lo（按开始分钟归纳，最小方案的每个
// 开始都落在该闭包内）。随后按清单顺序深度优先逐项试探：开始分钟升序、
// 同一开始的资源序列按字典序升序枚举，放置每项时检查全部两端都已放置的
// 关系（每条边恰在第二个端点放置时检查一次，逆清单方向由前项放置处补查），
// 首个完整方案即按上述比较的最小方案——不会因为逐项固定最早选择而漏掉须
// 调整前项时间或资源（含被最大间隔顶推延后）的解，也不跳过受阻项。
// ---------------------------------------------------------------------------

interface FlexRelation {
  predecessor: number; // 前项（1 基清单序号）
  successor: number; // 后项（1 基清单序号）
  minGap: number; // 最小衔接间隔（非负整数分钟，含两端）
  maxGap: number; // 最大衔接间隔（非负整数分钟，minGap <= maxGap）
}

interface FlexPlanItem {
  index: number; // 1 基清单序号
  startRaw: string; // 窗口开始（YYYY-MM-DDTHH:mm）
  endRaw: string; // 窗口结束
  startMin: number;
  endMin: number;
  duration: number; // 所需连续分钟数（正整数，不超过窗口长度）
  groups: RequirementGroup[]; // 有顺序的需求组，每组恰选一个候选
  incoming: FlexRelation[]; // 以本项为后项的关系（前项可能在清单更后面）
}

interface FlexPlacement {
  startMin: number;
  endMin: number;
  picks: string[]; // 按需求组顺序的所选资源
}

// 读取预约清单文件：不可读、不是合法 JSON 均明确失败（绝不按空清单处理）
async function loadFlexManifest(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new BizError(`无法读取预约清单 ${file}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BizError(`预约清单 ${file} 已损坏，不是合法 JSON：${(err as Error).message}`);
  }
}

// 清单结构（与业务数据无关的纯类型校验）；返回逐项原始记录
function parseFlexPlanShape(raw: unknown, file: string): {
  items: Array<Record<string, unknown>>;
  relations: Array<Record<string, unknown>>;
} {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BizError(`预约清单 ${file} 内容非法：顶层必须是对象，形如 {"items": [...]}`);
  }
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k !== 'items' && k !== 'relations') {
      throw new BizError(`预约清单 ${file} 内容非法：存在未知字段 “${k}”，只允许 items、relations`);
    }
  }
  if (!Array.isArray(o.items)) {
    throw new BizError(`预约清单 ${file} 内容非法：items 必须是非空数组`);
  }
  const items = o.items as unknown[];
  if (items.length === 0) throw new BizError(`预约清单 ${file} 为空：items 至少包含一项预约请求`);

  // 附加项间关系（可省略或为空数组：省略或为空保持无关系的原行为）。
  // 结构在此做与业务数据无关的纯类型校验；序号范围、自指、重复与有向环
  // 需在知道项数后由 parseFlexRelations 再校验。
  const relationRecords: Array<Record<string, unknown>> = [];
  if (o.relations !== undefined) {
    if (!Array.isArray(o.relations)) {
      throw new BizError(`预约清单 ${file} 内容非法：relations 必须是数组（可省略或为空）`);
    }
    const relProblems: string[] = [];
    (o.relations as unknown[]).forEach((rel, ri) => {
      const at = `第 ${ri + 1} 条关系`;
      if (typeof rel !== 'object' || rel === null || Array.isArray(rel)) {
        relProblems.push(`${at} 必须是对象`);
        return;
      }
      const rr = rel as Record<string, unknown>;
      let wellFormed = true;
      for (const k of Object.keys(rr)) {
        if (k !== 'predecessor' && k !== 'successor' && k !== 'minGap' && k !== 'maxGap') {
          relProblems.push(`${at} 存在未知字段 “${k}”（只允许 predecessor、successor、minGap、maxGap）`);
          wellFormed = false;
        }
      }
      for (const k of ['predecessor', 'successor', 'minGap', 'maxGap'] as const) {
        if (typeof rr[k] !== 'number' || !Number.isInteger(rr[k])) {
          relProblems.push(`${at} 的 ${k} 必须是整数（前项/后项为从 1 开始的清单序号，间隔为非负整数分钟）`);
          wellFormed = false;
        }
      }
      if (wellFormed) {
        if ((rr.minGap as number) < 0 || (rr.maxGap as number) < 0) {
          relProblems.push(`${at} 的最小、最大间隔必须是非负整数分钟`);
        } else if ((rr.minGap as number) > (rr.maxGap as number)) {
          relProblems.push(
            `${at} 最小间隔 ${rr.minGap} 分钟不得大于最大间隔 ${rr.maxGap} 分钟`,
          );
        }
      }
      relationRecords.push(rr);
    });
    if (relProblems.length > 0) {
      throw new BizError(`预约清单 ${file} 内容非法，整单拒绝：\n${relProblems.map((p) => `- ${p}`).join('\n')}`);
    }
  }

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
      if (k !== 'window' && k !== 'duration' && k !== 'groups') {
        problems.push(`${at} 存在未知字段 “${k}”（只允许 window、duration、groups）`);
      }
    }
    if (typeof rec.window !== 'string' || rec.window === '') {
      problems.push(`${at} 的 window 必须是 窗口开始/窗口结束 形式的非空字符串`);
    }
    if (typeof rec.duration !== 'number' || !Number.isInteger(rec.duration) || rec.duration <= 0) {
      problems.push(`${at} 的 duration 必须是正整数分钟（不超过窗口长度）`);
    }
    if (!Array.isArray(rec.groups) || rec.groups.length === 0) {
      problems.push(`${at} 的 groups 必须是非空数组（至少一个有顺序的需求组）`);
    } else {
      rec.groups.forEach((g, gi) => {
        if (!Array.isArray(g) || g.length === 0) {
          problems.push(`${at} 第 ${gi + 1} 需求组必须是非空数组（可任选其一的候选资源标识）`);
        } else {
          g.forEach((id) => {
            if (typeof id !== 'string' || id === '') {
              problems.push(`${at} 第 ${gi + 1} 需求组含非法候选：候选资源标识必须是非空字符串`);
            }
          });
        }
      });
    }
    records.push(rec);
  });
  if (problems.length > 0) {
    throw new BizError(`预约清单 ${file} 内容非法，整单拒绝：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return {items: records as Array<Record<string, unknown>>, relations: relationRecords};
}

// 解析附加项间关系：序号以从 1 开始的清单序号指定前项与后项；非整数或越界
// 序号、自指、重复有向关系（同一前项→后项，书写顺序无关）、有向环均整单拒绝。
// 间隔结构（整数、非负、min<=max）已在 parseFlexPlanShape 校验。
function parseFlexRelations(
  rawRelations: Array<Record<string, unknown>>,
  itemCount: number,
  file: string,
): FlexRelation[] {
  const problems: string[] = [];
  const seen = new Set<string>(); // “前项->后项”，重复有向关系（与书写顺序无关）整单拒绝
  const relations: FlexRelation[] = [];
  rawRelations.forEach((rr, ri) => {
    const at = `第 ${ri + 1} 条关系`;
    const predecessor = rr.predecessor as number;
    const successor = rr.successor as number;
    const minGap = rr.minGap as number;
    const maxGap = rr.maxGap as number;
    let validRefs = true;
    if (predecessor < 1 || predecessor > itemCount) {
      problems.push(`${at} 前项序号 ${predecessor} 越界：清单共 ${itemCount} 项，序号须从 1 开始`);
      validRefs = false;
    }
    if (successor < 1 || successor > itemCount) {
      problems.push(`${at} 后项序号 ${successor} 越界：清单共 ${itemCount} 项，序号须从 1 开始`);
      validRefs = false;
    }
    if (validRefs && predecessor === successor) {
      problems.push(`${at} 自指：前项与后项不能同为第 ${predecessor} 项`);
      validRefs = false;
    }
    if (validRefs) {
      // 同一有向关系（前项→后项）重复书写即重复，与其在清单中的书写顺序无关；
      // 两个相反方向的关系不算重复，而构成有向环（由下方环检测拒绝）
      const key = `${predecessor}->${successor}`;
      if (seen.has(key)) {
        problems.push(`${at} 重复有向关系：第 ${predecessor} 项 → 第 ${successor} 项的关系已指定`);
      } else {
        seen.add(key);
        relations.push({predecessor, successor, minGap, maxGap});
      }
    }
  });
  if (problems.length > 0) {
    throw new BizError(`预约清单 ${file} 内容非法，整单拒绝：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }

  // 有向环检测（Kahn 拓扑排序）：关系可逆清单顺序，环使“后项开始-前项结束”
  // 的先后约束不可同时满足，整单拒绝
  const indegree = new Array<number>(itemCount).fill(0);
  const adjacency = Array.from({length: itemCount}, () => [] as number[]);
  for (const rel of relations) {
    adjacency[rel.predecessor - 1].push(rel.successor - 1);
    indegree[rel.successor - 1] += 1;
  }
  const queue = indegree.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  let visited = 0;
  const working = [...indegree];
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;
    for (const next of adjacency[node]) {
      working[next] -= 1;
      if (working[next] === 0) queue.push(next);
    }
  }
  if (visited !== itemCount) {
    throw new BizError(
      `预约清单 ${file} 内容非法，整单拒绝：项间关系存在有向环（须为有向无环图；关系可逆清单顺序，但不能循环）`,
    );
  }
  return relations;
}

// 逐项做与业务数据相关的校验（窗口真实有效、时长不超过窗口、组内重复与未知资源），
// 收集全部问题后一次性拒绝整单；通过则返回排程项
function parseFlexPlanItems(store: Store, records: Array<Record<string, unknown>>, file: string): FlexPlanItem[] {
  const problems: string[] = [];
  const items: Array<FlexPlanItem | null> = records.map((rec, idx) => {
    const at = `第 ${idx + 1} 项`;
    let ok = true;

    let win: {start: string; end: string; startMin: number; endMin: number} | null = null;
    try {
      win = parseFlexWindow(rec.window as string, `${at}窗口`);
    } catch (err) {
      if (err instanceof BizError) {
        problems.push(err.message);
        ok = false;
      } else {
        throw err;
      }
    }

    const duration = rec.duration as number; // 结构校验已保证正整数
    if (win !== null && duration > win.endMin - win.startMin) {
      problems.push(
        `${at} 所需连续时长 ${duration} 分钟超过窗口长度 ${win.endMin - win.startMin} 分钟` +
          `（窗口: ${win.start} → ${win.end}）`,
      );
      ok = false;
    }

    const groups: RequirementGroup[] = [];
    (rec.groups as string[][]).forEach((ids, gi) => {
      const glabel = `${at} 第 ${gi + 1} 需求组`;
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const id of ids) {
        if (seen.has(id) && !dupes.includes(id)) dupes.push(id);
        seen.add(id);
      }
      if (dupes.length > 0) {
        problems.push(`${glabel}内候选资源重复: ${dupes.join('、')}`);
        ok = false;
      }
      const unknown = [...seen].filter((id) => !store.resources.some((r) => r.id === id)).sort();
      if (unknown.length > 0) {
        problems.push(`${glabel}含未知资源标识: ${unknown.join('、')}`);
        ok = false;
      }
      groups.push({index: gi + 1, candidates: [...seen].sort()});
    });

    if (!ok || win === null) return null;
    return {
      index: idx + 1,
      startRaw: win.start,
      endRaw: win.end,
      startMin: win.startMin,
      endMin: win.endMin,
      duration,
      groups,
      incoming: [],
    };
  });
  if (problems.length > 0) {
    throw new BizError(`预约清单 ${file} 内容非法，整单拒绝：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return items as FlexPlanItem[];
}

// 固定开始分钟上，按需求组顺序字典序升序枚举全部可行资源序列
// （每组恰选一个候选，全部所选互不相同；候选已按标识排序）
function* assignmentsInLexOrder(
  groups: RequirementGroup[],
  usable: (id: string) => boolean,
): Generator<string[], void, undefined> {
  const used = new Set<string>();
  const acc: string[] = [];
  function* rec(g: number): Generator<string[], void, undefined> {
    if (g === groups.length) {
      yield [...acc];
      return;
    }
    for (const id of groups[g].candidates) {
      if (used.has(id) || !usable(id)) continue;
      used.add(id);
      acc.push(id);
      yield* rec(g + 1);
      acc.pop();
      used.delete(id);
    }
  }
  yield* rec(0);
}

// 联合求解：找到即返回按清单顺序的各项安排（开始分钟 + 各组所选资源），无整体解返回 null。
// 逐项（清单顺序）深度优先：开始分钟升序、同一开始的资源序列字典序升序，
// 首个完整方案即“逐项先比开始分钟、再比资源序列”的最小方案。
function solveFlexPlan(store: Store, items: FlexPlanItem[]): FlexPlacement[] | null {
  const n = items.length;
  // 每项各候选资源的基础空闲段：实际可用时间（开放合并后扣除有效停用并集）
  // 裁进自身窗口，再扣除当前有效预约占用（已取消预约/停用与未兑现候补不阻挡）
  const baseFree: Array<Map<string, Array<[number, number]>>> = items.map((it) => {
    const m = new Map<string, Array<[number, number]>>();
    for (const g of it.groups) {
      for (const id of g.candidates) {
        if (!m.has(id)) m.set(id, resourceFreeSegments(store, id, it.startMin, it.endMin));
      }
    }
    return m;
  });

  // 候选开始分钟闭包：
  // 1) 基础空闲段起点；
  // 2) “被其他项占用结束顶住”的起点 s_i = s_j + d_j（仅候选资源集合有交集的项
  //    之间传播，对应共同资源左闭右开冲突的边界）；
  // 3) 项间关系边界：关系 p -> q（间隔 [lo,hi]）要求 s_p + d_p + lo <= s_q
  //    <= s_p + d_p + hi。已知 s_p 时 s_q 的边界为 s_p+d_p+lo、s_p+d_p+hi；
  //    已知 s_q 时 s_p 的边界为 s_q-d_p-hi、s_q-d_p-lo（关系可逆清单顺序、
  //    也适用于不同资源的项）。
  // 最小方案中每项的开始必落在自身窗口内某约束边界的闭包上（按开始分钟归纳：
  // 若两侧均不贴边界即可整体平移至更小开始，与最小性矛盾），闭包在有限整数
  // 值域（各项窗内）上迭代必收敛。
  const candidateIds = items.map((it) => {
    const set = new Set<string>();
    for (const g of it.groups) for (const id of g.candidates) set.add(id);
    return set;
  });
  const sharesCandidate = (a: number, b: number): boolean => {
    for (const id of candidateIds[a]) if (candidateIds[b].has(id)) return true;
    return false;
  };
  // 关系邻接：incoming[i] 已按后项归并；outgoing 供“先放置后项、后放置前项”
  // （逆清单顺序关系）时在放置前项处统一检查
  const outgoing: Array<FlexRelation[][]> = items.map(() => []);
  items.forEach((it, i) => {
    for (const rel of it.incoming) outgoing[rel.predecessor - 1].push(rel);
  });
  const relBetween = new Map<string, FlexRelation[]>(); // “a,b”（a<b 的下标）上的关系（含各自方向）
  items.forEach((it) => {
    for (const rel of it.incoming) {
      const a = Math.min(rel.predecessor, rel.successor) - 1;
      const b = Math.max(rel.predecessor, rel.successor) - 1;
      const key = `${a},${b}`;
      const list = relBetween.get(key) ?? [];
      list.push(rel);
      relBetween.set(key, list);
    }
  });
  const fitsWindow = (i: number, t: number): boolean =>
    t >= items[i].startMin && t + items[i].duration <= items[i].endMin;
  const candStarts: Array<Set<number>> = items.map((it, i) => {
    const set = new Set<number>();
    for (const segs of baseFree[i].values()) {
      for (const [s] of segs) {
        if (fitsWindow(i, s)) set.add(s);
      }
    }
    return set;
  });
  let changed = true;
  while (changed) {
    changed = false;
    const add = (i: number, t: number): void => {
      if (fitsWindow(i, t) && !candStarts[i].has(t)) {
        candStarts[i].add(t);
        changed = true;
      }
    };
    for (let j = 0; j < n; j++) {
      for (const s of candStarts[j]) {
        for (let i = 0; i < n; i++) {
          if (i === j) continue;
          // 2) 共同资源冲突边界：i 紧接 j 之后开始
          if (sharesCandidate(i, j)) add(i, s + items[j].duration);
          // 3) 项间关系边界
          const a = Math.min(i, j);
          const b = Math.max(i, j);
          for (const rel of relBetween.get(`${a},${b}`) ?? []) {
            if (rel.predecessor - 1 === j && rel.successor - 1 === i) {
              // j 是前项、i 是后项：s_i = s_j + d_j + [min,max]
              add(i, s + items[j].duration + rel.minGap);
              add(i, s + items[j].duration + rel.maxGap);
            } else if (rel.predecessor - 1 === i && rel.successor - 1 === j) {
              // i 是前项、j 是后项：s_i = s_j - d_i - [min,max]
              add(i, s - items[i].duration - rel.maxGap);
              add(i, s - items[i].duration - rel.minGap);
            }
          }
        }
      }
    }
  }

  // 已放置项的开始/结束（未放置为 null）与对各资源的占用（随试探入栈/出栈增减）
  const placedStart = new Array<number | null>(n).fill(null);
  const placedEnd = new Array<number | null>(n).fill(null);
  const occById = new Map<string, Array<[number, number]>>();

  // 放置 idx（[s,e]）时，对全部两端都已放置的关系做边界检查（含两端）；
  // 每条边恰在其第二个端点放置时被检查一次
  const relationsSatisfied = (idx: number, s: number, e: number): boolean => {
    for (const rel of items[idx].incoming) {
      // idx 是后项；前项可能尚未放置（逆清单顺序），稍后在前项放置处检查
      const predEnd = placedEnd[rel.predecessor - 1];
      if (predEnd !== null && (s - predEnd < rel.minGap || s - predEnd > rel.maxGap)) return false;
    }
    for (const rel of outgoing[idx]) {
      // idx 是前项；后项可能先放置（逆清单顺序）
      const succStart = placedStart[rel.successor - 1];
      if (succStart !== null && (succStart - e < rel.minGap || succStart - e > rel.maxGap)) return false;
    }
    return true;
  };

  const search = (idx: number): FlexPlacement[] | null => {
    if (idx === n) return [];
    const it = items[idx];
    // 当前空闲段 = 基础空闲段扣除已放置项占用
    const freeById = new Map<string, Array<[number, number]>>();
    for (const [id, segs] of baseFree[idx]) {
      const occ = occById.get(id);
      freeById.set(id, occ !== undefined && occ.length > 0 ? subtractSegments(segs, occ) : segs);
    }
    for (const s of [...candStarts[idx]].sort((a, b) => a - b)) {
      const e = s + it.duration;
      // 先按项间关系剪枝（不依赖资源选择）
      if (!relationsSatisfied(idx, s, e)) continue;
      const cache = new Map<string, boolean>();
      const usable = (id: string): boolean => {
        let v = cache.get(id);
        if (v === undefined) {
          v = isFullyCovered(freeById.get(id)!, s, e);
          cache.set(id, v);
        }
        return v;
      };
      for (const picks of assignmentsInLexOrder(it.groups, usable)) {
        for (const id of picks) {
          const occ = occById.get(id) ?? [];
          occ.push([s, e]);
          occById.set(id, occ);
        }
        placedStart[idx] = s;
        placedEnd[idx] = e;
        const rest = search(idx + 1);
        if (rest !== null) return [{startMin: s, endMin: e, picks}, ...rest];
        for (const id of picks) occById.get(id)!.pop();
      }
    }
    // 本分路失败：清除本项放置痕迹，避免上一层改试其他选项时把陈旧端点
    // 误当作已放置（逆清单顺序关系会读取后项端点）
    placedStart[idx] = null;
    placedEnd[idx] = null;
    return null;
  };

  return search(0);
}

async function cmdScheduleFlex(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(
      `schedule-flex 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`,
    );
  }
  if (positionals.length !== 1) {
    throw new UsageError('用法: schedule-flex <预约清单文件>');
  }
  const manifestFile = positionals[0];

  // 修改入口：先取得写入保护再读最新数据，排程至保存全程受保护
  const file = activeDataFile;
  const store = await loadStoreForWrite(file);
  const parsed = parseFlexPlanShape(await loadFlexManifest(manifestFile), manifestFile);
  const items = parseFlexPlanItems(store, parsed.items, manifestFile);
  // 附加项间关系：序号越界、自指、重复有向关系、有向环均在此整单拒绝；
  // 关系可逆清单顺序、也适用于不同资源的项，按后项归并供求解统一检查
  const relations = parseFlexRelations(parsed.relations, items.length, manifestFile);
  for (const rel of relations) items[rel.successor - 1].incoming.push(rel);

  const plan = solveFlexPlan(store, items);
  if (plan === null) {
    throw new BizError(
      `无整体解：清单 ${manifestFile} 的 ${items.length} 项预约不存在同时可行的安排` +
        '（每项须完整落在自身窗口内，各组所选资源互不相同并全程固定，' +
        '新项之间共同资源时间不得重叠，全部项间先后与衔接间隔关系须同时满足）。未创建任何预约，数据文件未改动。',
    );
  }

  // 全部校验与求解通过：按清单顺序分配稳定且不复用的预约标识，一次原子保存
  const created: Array<{id: string; start: string; end: string; picks: string[]}> = [];
  plan.forEach((p) => {
    const start = formatDateTime(p.startMin);
    const end = formatDateTime(p.endMin);
    if (start === null || end === null) {
      // 理论不可达：窗口已校验在 0001-9999 内，时段不超出窗口
      throw new BizError('可行时段超出四位年份范围');
    }
    store.bookingSeq += 1;
    const id = `B${String(store.bookingSeq).padStart(4, '0')}`;
    store.bookings.push({id, resourceIds: [...p.picks].sort(), start, end, status: 'active'});
    created.push({id, start, end, picks: p.picks});
  });
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  await saveStore(file, store);

  console.log(`联合排程成功：已按清单顺序原子创建 ${created.length} 项预约`);
  created.forEach((c, i) => {
    console.log(`- 第 ${i + 1} 项 -> ${c.id}: ${c.start} → ${c.end}（${items[i].duration} 分钟）`);
    c.picks.forEach((id, g) => {
      const r = store.resources.find((x) => x.id === id)!;
      console.log(`    第 ${g + 1} 组: ${id}（${r.name}，${RESOURCE_TYPE_LABEL[r.type]}）`);
    });
  });
}

// ---------------------------------------------------------------------------
// 弹性批量改期（reschedule-flex）
//
// 读取本地 JSON 清单（{"items": [...]}，非空、有顺序），每项给出一个既有预约
// 标识、目标时间窗口与有顺序的候选资源组，时长保持预约当前长度。为整单求解
// 最终安排：排除本批旧占用，其余有效预约按现状阻挡（取消记录与未兑现候补
// 不阻挡）；开放合并重叠或相接后扣除有效停用；每项完整落窗，各组恰选一个
// 且所选互异，全部所选资源同时连续可用、全程固定；仅共同资源的左闭右开
// 时间重叠冲突，端点相接可行。
//
// 取舍：先最小化变化预约数量（起止时间或完整资源集合不同才算变化，资源
// 顺序不计）；数量相同再按清单顺序逐项先比开始分钟、再按组序比资源标识
// 字符串，取字典序最小的完整方案（候选书写顺序不影响结果）。求解按变化
// 数 k = 0..n 递增试探：候选开始分钟取“基础空闲段起点 ∪ 各项当前开始
// （在窗内时）”与“其他项占用结束（s_j + d_j）”的闭包（仅候选资源集合
// 有交集的项之间传播），随后按清单顺序深度优先（开始升序、同一开始的
// 资源序列字典序升序）并带上变化预算剪枝，首个完整方案即该 k 下的最小
// 方案；最小可行 k 即最少变化数。
//
// 只改本批预约的时间与资源：标识、状态、系列归属、导入身份与首次请求、
// 候补原请求及兑现关联全部保留，不新建预约、不自动处理候补。至少一项有
// 变化时，将全部提交项的前后完整安排、系列归属及清单顺序记为一条稳定
// 不复用的批量改期操作记录（O0001…，与 list-batch-ops / undo-batch-op
// 共用），与改期同次原子保存，仅推进操作计数；无变化成功不写文件、不建
// 记录、不推进计数。每次提交按当前状态求解，撤销后重提产生变化分配新的
// 操作标识。
// ---------------------------------------------------------------------------

interface FlexRescheduleItem {
  index: number; // 1 基清单序号
  booking: BookingRec;
  startRaw: string; // 窗口开始（YYYY-MM-DDTHH:mm）
  endRaw: string; // 窗口结束
  startMin: number;
  endMin: number;
  duration: number; // 预约当前长度（分钟），改期后保持不变
  curStartMin: number; // 当前开始分钟
  curResourceIds: string[]; // 当前完整资源集合（按标识排序）
  groups: RequirementGroup[]; // 有顺序的候选资源组，每组恰选一个
}

// 清单结构（与业务数据无关的纯类型校验）；返回逐项原始记录
function parseFlexRescheduleShape(raw: unknown, file: string): Array<Record<string, unknown>> {
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
  if (items.length === 0) throw new BizError(`改期清单 ${file} 为空：items 至少包含一项改期请求`);

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
      if (k !== 'bookingId' && k !== 'window' && k !== 'groups') {
        problems.push(`${at} 存在未知字段 “${k}”（只允许 bookingId、window、groups）`);
      }
    }
    if (typeof rec.bookingId !== 'string' || rec.bookingId === '') {
      problems.push(`${at} 的 bookingId 必须是非空字符串`);
    }
    if (typeof rec.window !== 'string' || rec.window === '') {
      problems.push(`${at} 的 window 必须是 窗口开始/窗口结束 形式的非空字符串`);
    }
    if (!Array.isArray(rec.groups) || rec.groups.length === 0) {
      problems.push(`${at} 的 groups 必须是非空数组（至少一个有顺序的候选资源组）`);
    } else {
      rec.groups.forEach((g, gi) => {
        if (!Array.isArray(g) || g.length === 0) {
          problems.push(`${at} 第 ${gi + 1} 候选资源组必须是非空数组（可任选其一的候选资源标识）`);
        } else {
          g.forEach((id) => {
            if (typeof id !== 'string' || id === '') {
              problems.push(`${at} 第 ${gi + 1} 候选资源组含非法候选：候选资源标识必须是非空字符串`);
            }
          });
        }
      });
    }
    records.push(rec);
  });
  if (problems.length > 0) {
    throw new BizError(`改期清单 ${file} 内容非法，整单拒绝：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return records as Array<Record<string, unknown>>;
}

// 逐项做与业务数据相关的校验（预约未知/重复/已取消、窗口真实有效且不短于
// 预约当前时长、组内重复与未知资源），收集全部问题后一次性拒绝整单
function parseFlexRescheduleItems(
  store: Store,
  records: Array<Record<string, unknown>>,
  file: string,
): FlexRescheduleItem[] {
  const problems: string[] = [];
  const seenBooking = new Map<string, number>(); // 标识 -> 首次出现的序号（1 基）
  const items: Array<FlexRescheduleItem | null> = records.map((rec, idx) => {
    const bookingId = rec.bookingId as string;
    const at = `第 ${idx + 1} 项（${bookingId}）`;
    let ok = true;

    const firstAt = seenBooking.get(bookingId);
    if (firstAt !== undefined) {
      problems.push(`${at} 预约标识重复：该标识已在第 ${firstAt} 项出现，每项预约在清单中只能出现一次`);
      ok = false;
    } else {
      seenBooking.set(bookingId, idx + 1);
    }

    const booking = store.bookings.find((b) => b.id === bookingId);
    if (!booking) {
      problems.push(`${at} 未知预约标识: ${bookingId}`);
      ok = false;
    } else if (booking.status === 'cancelled') {
      problems.push(`${at} 预约 ${booking.id} 已取消，不能改期`);
      ok = false;
    }

    let win: {start: string; end: string; startMin: number; endMin: number} | null = null;
    try {
      win = parseFlexWindow(rec.window as string, `${at}窗口`);
    } catch (err) {
      if (err instanceof BizError) {
        problems.push(err.message);
        ok = false;
      } else {
        throw err;
      }
    }

    let duration = 0;
    let curStartMin = 0;
    if (booking !== undefined) {
      curStartMin = parseDateTime(booking.start, `${at} 当前开始时间`);
      duration = parseDateTime(booking.end, `${at} 当前结束时间`) - curStartMin;
    }
    if (win !== null && booking !== undefined && win.endMin - win.startMin < duration) {
      problems.push(
        `${at} 窗口长度 ${win.endMin - win.startMin} 分钟小于预约当前时长 ${duration} 分钟` +
          `（窗口: ${win.start} → ${win.end}，时长保持预约当前长度）`,
      );
      ok = false;
    }

    const groups: RequirementGroup[] = [];
    (rec.groups as string[][]).forEach((ids, gi) => {
      const glabel = `${at} 第 ${gi + 1} 候选资源组`;
      const seen = new Set<string>();
      const dupes: string[] = [];
      for (const id of ids) {
        if (seen.has(id) && !dupes.includes(id)) dupes.push(id);
        seen.add(id);
      }
      if (dupes.length > 0) {
        problems.push(`${glabel}内候选资源重复: ${dupes.join('、')}`);
        ok = false;
      }
      const unknown = [...seen].filter((id) => !store.resources.some((r) => r.id === id)).sort();
      if (unknown.length > 0) {
        problems.push(`${glabel}含未知资源标识: ${unknown.join('、')}`);
        ok = false;
      }
      groups.push({index: gi + 1, candidates: [...seen].sort()});
    });

    if (!ok || win === null || booking === undefined) return null;
    return {
      index: idx + 1,
      booking,
      startRaw: win.start,
      endRaw: win.end,
      startMin: win.startMin,
      endMin: win.endMin,
      duration,
      curStartMin,
      curResourceIds: [...booking.resourceIds].sort(),
      groups,
    };
  });
  if (problems.length > 0) {
    throw new BizError(`改期清单 ${file} 校验失败，整单拒绝（原有安排保持不变）：\n${problems.map((p) => `- ${p}`).join('\n')}`);
  }
  return items as FlexRescheduleItem[];
}

// 所选资源序列（按组顺序）与当前资源集合是否一致（资源顺序不计）
function sameResourceSet(picks: string[], curSorted: string[]): boolean {
  if (picks.length !== curSorted.length) return false;
  const sorted = [...picks].sort();
  return sorted.every((id, i) => id === curSorted[i]);
}

// 联合求解整单最终安排：先最小化变化预约数量，数量相同再按清单顺序逐项
// 先比开始分钟、再按组序比资源标识字符串，取字典序最小完整方案。
// 返回按清单顺序的各项安排（开始分钟 + 各组所选资源），无整体解返回 null。
function solveFlexReschedule(store: Store, items: FlexRescheduleItem[]): FlexPlacement[] | null {
  // 本批预约的旧占用一律不视为障碍；其余有效预约按现状阻挡
  const batchIds = new Set(items.map((it) => it.booking.id));
  const baseFree: Array<Map<string, Array<[number, number]>>> = items.map((it) => {
    const m = new Map<string, Array<[number, number]>>();
    for (const g of it.groups) {
      for (const id of g.candidates) {
        if (!m.has(id)) m.set(id, resourceFreeSegments(store, id, it.startMin, it.endMin, batchIds));
      }
    }
    return m;
  });

  // 候选开始分钟闭包：基础空闲段起点 ∪ 各项当前开始（在窗内时），
  // 加上“被其他项占用结束顶住”的起点 s_i = s_j + d_j
  // （仅候选资源集合有交集的项之间传播；值域有限，必收敛）
  const candidateIds = items.map((it) => {
    const set = new Set<string>();
    for (const g of it.groups) for (const id of g.candidates) set.add(id);
    return set;
  });
  const sharesCandidate = (a: number, b: number): boolean => {
    for (const id of candidateIds[a]) if (candidateIds[b].has(id)) return true;
    return false;
  };
  const candStarts: Array<Set<number>> = items.map((it, i) => {
    const set = new Set<number>();
    for (const segs of baseFree[i].values()) {
      for (const [s] of segs) {
        if (s + it.duration <= it.endMin) set.add(s);
      }
    }
    // 当前开始落在窗内时，“保持现状”总是一个候选（是否可行在试探中判定）
    if (it.curStartMin >= it.startMin && it.curStartMin + it.duration <= it.endMin) {
      set.add(it.curStartMin);
    }
    return set;
  });
  let changed = true;
  while (changed) {
    changed = false;
    for (let j = 0; j < items.length; j++) {
      for (let i = 0; i < items.length; i++) {
        if (i === j || !sharesCandidate(i, j)) continue;
        for (const s of candStarts[j]) {
          const t = s + items[j].duration;
          if (
            t >= items[i].startMin &&
            t + items[i].duration <= items[i].endMin &&
            !candStarts[i].has(t)
          ) {
            candStarts[i].add(t);
            changed = true;
          }
        }
      }
    }
  }

  // 已放置项对各资源的占用（随试探入栈/出栈增减；不变项同样放置以阻挡他项）
  const occById = new Map<string, Array<[number, number]>>();

  // 按清单顺序深度优先：开始分钟升序、同一开始的资源序列字典序升序，
  // 只接受变化数不超过 budget 的完整方案；首个完整方案即该预算下的最小方案
  const search = (idx: number, budget: number): FlexPlacement[] | null => {
    if (idx === items.length) return [];
    const it = items[idx];
    const freeById = new Map<string, Array<[number, number]>>();
    for (const [id, segs] of baseFree[idx]) {
      const occ = occById.get(id);
      freeById.set(id, occ !== undefined && occ.length > 0 ? subtractSegments(segs, occ) : segs);
    }
    for (const s of [...candStarts[idx]].sort((a, b) => a - b)) {
      const e = s + it.duration;
      const cache = new Map<string, boolean>();
      const usable = (id: string): boolean => {
        let v = cache.get(id);
        if (v === undefined) {
          v = isFullyCovered(freeById.get(id)!, s, e);
          cache.set(id, v);
        }
        return v;
      };
      for (const picks of assignmentsInLexOrder(it.groups, usable)) {
        // 起止时间或完整资源集合任一不同才算变化（时长固定，开始即决定结束；资源顺序不计）
        const cost = s === it.curStartMin && sameResourceSet(picks, it.curResourceIds) ? 0 : 1;
        if (cost > budget) continue;
        for (const id of picks) {
          const occ = occById.get(id) ?? [];
          occ.push([s, e]);
          occById.set(id, occ);
        }
        const rest = search(idx + 1, budget - cost);
        if (rest !== null) return [{startMin: s, endMin: e, picks}, ...rest];
        for (const id of picks) occById.get(id)!.pop();
      }
    }
    return null;
  };

  // 变化数 k 递增：首个有解的 k 即最少变化数，其首个完整方案即最终取舍
  for (let k = 0; k <= items.length; k++) {
    const plan = search(0, k);
    if (plan !== null) return plan;
  }
  return null;
}

async function cmdRescheduleFlex(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, []);
  if (values.size > 0) {
    throw new UsageError(
      `reschedule-flex 不接受选项: ${[...values.keys()].map((k) => '--' + k).join(' ')}`,
    );
  }
  if (positionals.length !== 1) {
    throw new UsageError('用法: reschedule-flex <改期清单文件>');
  }
  const manifestFile = positionals[0];

  // 修改入口：先取得写入保护再读最新数据，求解至保存全程受保护
  const file = activeDataFile;
  const store = await loadStoreForWrite(file);
  const records = parseFlexRescheduleShape(await loadManifest(manifestFile), manifestFile);
  const items = parseFlexRescheduleItems(store, records, manifestFile);

  const plan = solveFlexReschedule(store, items);
  if (plan === null) {
    throw new BizError(
      `无整体解：清单 ${manifestFile} 的 ${items.length} 项改期不存在同时可行的安排` +
        '（每项须完整落在自身窗口内，各组所选资源互不相同并全程固定，' +
        '本批之间共同资源时间不得重叠）。未改动任何预约，数据文件与标识计数未改动。',
    );
  }

  // 展开各项最终安排（开始分钟 -> 文本；窗口已校验在 0001-9999 内，时段不超出窗口）
  const resolved = items.map((it, i) => {
    const p = plan[i];
    const start = formatDateTime(p.startMin);
    const end = formatDateTime(p.endMin);
    if (start === null || end === null) {
      // 理论不可达：窗口已校验在四位年份内，时段不超出窗口
      throw new BizError('可行时段超出四位年份范围');
    }
    const isChanged = !(p.startMin === it.curStartMin && sameResourceSet(p.picks, it.curResourceIds));
    return {item: it, start, end, picks: p.picks, changed: isChanged};
  });

  const printPlan = (): void => {
    for (const r of resolved) {
      const b = r.item.booking;
      console.log(
        `- 第 ${r.item.index} 项 ${b.id}` +
          (b.seriesId !== undefined ? `（系列 ${b.seriesId}，归属不变）` : '') +
          `: ${r.start} → ${r.end}（${r.item.duration} 分钟）`,
      );
      r.picks.forEach((id, g) => {
        const res = store.resources.find((x) => x.id === id)!;
        console.log(`    第 ${g + 1} 组: ${id}（${res.name}，${RESOURCE_TYPE_LABEL[res.type]}）`);
      });
    }
  };

  // 无变化：成功但不写文件、不建记录、不推进计数
  if (resolved.every((r) => !r.changed)) {
    console.log(
      `弹性批量改期成功：共 ${resolved.length} 项，安排均与现状一致，无业务变化` +
        '（标识与系列归属不变，未生成改期操作记录，数据文件与标识计数未改动）',
    );
    printPlan();
    return;
  }

  // 至少一项有变化：将全部提交项的前后完整安排、系列归属及清单顺序记为一条
  // “未撤销”批量改期操作记录，与新安排在同一次原子保存中落盘后才报告成功；
  // 保存失败则不留记录、不推进计数。仅改时间与资源；标识、status、seriesId、
  // 导入身份与候补关联、其余标识计数全部不变，不创建任何预约或系列。
  const opItems: BatchOpItem[] = resolved.map((r) => {
    const b = r.item.booking;
    const item: BatchOpItem = {
      bookingId: b.id,
      before: {start: b.start, end: b.end, resourceIds: [...b.resourceIds]},
      after: {start: r.start, end: r.end, resourceIds: [...r.picks].sort()},
    };
    if (b.seriesId !== undefined) item.seriesId = b.seriesId;
    return item;
  });
  store.batchSeq += 1;
  const opId = `O${String(store.batchSeq).padStart(4, '0')}`;
  for (const r of resolved) {
    r.item.booking.start = r.start;
    r.item.booking.end = r.end;
    r.item.booking.resourceIds = [...r.picks].sort();
  }
  store.batchOps.push({id: opId, status: 'active', items: opItems});
  await saveStore(file, store);

  console.log(
    `弹性批量改期成功：操作标识 ${opId}，共 ${resolved.length} 项` +
      `（变化 ${resolved.filter((r) => r.changed).length} 项；仅改时间与资源，标识、状态与系列归属不变，未创建预约或系列）`,
  );
  printPlan();
  console.log(`本次改期已记录为 ${opId}：可用 list-batch-ops 查询，undo-batch-op ${opId} 整笔安全撤销。`);
}

// ---------------------------------------------------------------------------
// 资源使用率与繁忙时段统计（usage-stats，只读）
//
// 统计窗口内所选资源的实际可用、占用、空闲分钟与使用率（逐日 + 整窗），
// 并给出同时被占用的所选资源数量峰值及全部达到峰值的最大连续区间。
// 实际可用时间 = 开放区间合并重叠或相接后扣除有效停用并集，再裁剪到窗口；
// 占用只计有效预约（普通、系列成员、导入、候补兑现同口径；已取消预约/停用、
// 未兑现候补、导入首次请求快照与改期历史快照均不计）的当前时间与当前资源，
// 并取与实际可用区间的交集，同一资源的重叠占用合并、一分钟只计一次。
// 本命令只读一份完整快照：不取写入保护、不写数据文件、不推进任何计数。
// ---------------------------------------------------------------------------

// 一组互不相交区间的总分钟数
function totalMinutes(segments: Array<[number, number]>): number {
  return segments.reduce((sum, [s, e]) => sum + (e - s), 0);
}

// 使用率百分比：占用/可用，四舍五入至两位小数；分母为零显示“不适用”
function formatUsagePercent(occupied: number, available: number): string {
  if (available === 0) return '不适用';
  return `${(Math.round((occupied * 10000) / available) / 100).toFixed(2)}%`;
}

// 营业地日历日序号 -> YYYY-MM-DD（与机器时区无关；调用方保证年份在 0001-9999 内）
function formatBusinessDate(dayIndex: number): string {
  const {y, m, d} = civilFromDays(dayIndex);
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

// 某资源在窗口内的占用区间：全部有效预约按当前时间与当前资源裁剪进窗口，
// 再与实际可用区间求交；同一资源的重叠占用合并，一分钟只计一次
function occupiedSegmentsOf(
  store: Store,
  resourceId: string,
  available: Array<[number, number]>,
  wStart: number,
  wEnd: number,
): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (const b of store.bookings) {
    if (b.status !== 'active' || !b.resourceIds.includes(resourceId)) continue;
    const bs = parseDateTime(b.start, '预约开始时间');
    const be = parseDateTime(b.end, '预约结束时间');
    const s = Math.max(bs, wStart);
    const e = Math.min(be, wEnd);
    if (s < e) raw.push([s, e]);
  }
  return intersectSegments(available, mergeIntervals(raw));
}

// 窗口内同时被占用的所选资源数量峰值及全部达到峰值的最大连续区间（按开始时间排序）。
// 按资源计数（而非预约）；同一时刻的端点变化合并结算——一段结束、另一段同时开始
// 不制造瞬时重叠，相接的峰值段因此自然合并；无占用时峰值为零且不列区间。
function peakConcurrency(
  occupiedSets: Array<Array<[number, number]>>,
): {peak: number; intervals: Array<[number, number]>} {
  const delta = new Map<number, number>();
  for (const segs of occupiedSets) {
    for (const [s, e] of segs) {
      delta.set(s, (delta.get(s) ?? 0) + 1);
      delta.set(e, (delta.get(e) ?? 0) - 1);
    }
  }
  const times = [...delta.keys()].sort((a, b) => a - b);
  let count = 0;
  let peak = 0;
  const intervals: Array<[number, number]> = [];
  for (let i = 0; i < times.length; i++) {
    count += delta.get(times[i])!;
    const next = times[i + 1];
    if (next === undefined || next === times[i]) continue;
    if (count > peak) {
      peak = count;
      intervals.length = 0; // 更高的峰值出现：此前累计的旧峰值区间作废
      intervals.push([times[i], next]);
    } else if (count === peak && peak > 0) {
      const last = intervals[intervals.length - 1];
      if (last && last[1] === times[i]) last[1] = next; // 相接的峰值段合并
      else intervals.push([times[i], next]);
    }
  }
  return {peak, intervals};
}

async function cmdUsageStats(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['window', 'resource'], ['resource']);
  if (positionals.length > 0) {
    throw new UsageError(`usage-stats 不接受位置参数: ${positionals.join(' ')}`);
  }
  const windowRaw = requireFlag(values, 'window');

  // 统计只读一份完整快照：不取写入保护、不写数据文件、不推进任何计数
  const store = await loadStore(activeDataFile);

  const win = parseFlexWindow(windowRaw, '统计窗口');
  const resourceArgs = values.get('resource') ?? [];
  let ids: string[];
  if (resourceArgs.length === 0) {
    // 未选择时统计全部资源；名册为空时明确提示并退出 0
    if (store.resources.length === 0) {
      console.log('名册为空：尚未登记任何资源，无法统计。可使用 add-resource 登记场地、设备或人员。');
      return;
    }
    ids = store.resources.map((r) => r.id);
  } else {
    ids = resolveResourceIds(store, resourceArgs); // 未知或重复资源拒绝
  }

  // 每个所选资源：窗口内实际可用区间（开放合并后扣除有效停用并集，再裁剪到窗口）
  // 与占用区间（有效预约当前时间 ∩ 实际可用区间，重叠合并，一分钟只计一次）
  const perResource = ids.map((id) => {
    const r = store.resources.find((x) => x.id === id)!;
    const available = clipSegments(availableSegmentsOf(store, r), win.startMin, win.endMin);
    const occupied = occupiedSegmentsOf(store, id, available, win.startMin, win.endMin);
    return {r, available, occupied};
  });

  const label = (r: ResourceRec): string => `${r.id}（${r.name}，${RESOURCE_TYPE_LABEL[r.type]}）`;
  const statLine = (avail: number, occ: number): string =>
    `可用 ${avail} 分钟，占用 ${occ} 分钟，空闲 ${avail - occ} 分钟，使用率 ${formatUsagePercent(occ, avail)}`;

  console.log(`统计窗口: ${win.start} → ${win.end}（所选资源 ${ids.length} 个，区间左闭右开）`);

  // 逐日明细：覆盖与窗口有正长度交集的全部营业日期，按午夜拆分，
  // 首尾不足一天只计窗口内部分；含零可用或零占用的所选资源
  console.log('逐日明细（按日期、资源标识排序）:');
  const firstDay = Math.floor(win.startMin / 1440);
  const lastDay = Math.floor((win.endMin - 1) / 1440);
  for (let day = firstDay; day <= lastDay; day++) {
    const ds = Math.max(day * 1440, win.startMin);
    const de = Math.min((day + 1) * 1440, win.endMin);
    console.log(`${formatBusinessDate(day)}:`);
    for (const {r, available, occupied} of perResource) {
      const avail = totalMinutes(clipSegments(available, ds, de));
      const occ = totalMinutes(clipSegments(occupied, ds, de));
      console.log(`  - ${label(r)}: ${statLine(avail, occ)}`);
    }
  }

  // 整窗汇总：每个所选资源一行；另汇总全部所选资源，
  // 合计使用率以总占用除总可用，不平均各项百分比
  console.log('整窗汇总（按资源标识排序）:');
  let sumAvail = 0;
  let sumOcc = 0;
  for (const {r, available, occupied} of perResource) {
    const avail = totalMinutes(available);
    const occ = totalMinutes(occupied);
    sumAvail += avail;
    sumOcc += occ;
    console.log(`  - ${label(r)}: ${statLine(avail, occ)}`);
  }
  console.log(
    `全部所选资源合计: 可用 ${sumAvail} 资源分钟，占用 ${sumOcc} 资源分钟，` +
      `空闲 ${sumAvail - sumOcc} 资源分钟，使用率 ${formatUsagePercent(sumOcc, sumAvail)}`,
  );

  // 繁忙峰值：同时被占用的所选资源数量峰值及全部达到峰值的最大连续区间
  const {peak, intervals} = peakConcurrency(perResource.map((p) => p.occupied));
  if (peak === 0) {
    console.log('繁忙峰值: 0（窗口内没有所选资源被占用，无峰值区间）');
    return;
  }
  console.log(`繁忙峰值: 同时被占用的所选资源数量峰值为 ${peak}，达到峰值的全部最大连续区间（按开始时间排序）:`);
  for (const [s, e] of intervals) {
    console.log(`  - ${formatDateTime(s)} → ${formatDateTime(e)}（${e - s} 分钟）`);
  }
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
  const store = await loadStoreForWrite(file);

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
  const store = await loadStoreForWrite(file);
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
// 读取 UTF-8 的 VCALENDAR（VERSION:2.0，至少一个独立 VEVENT），为新事件创建预约，
// 全部使用命令行给定的同一资源集合（不自动处理候补）：无 RRULE 的事件创建一项
// 普通预约；带 RRULE:FREQ=WEEKLY;COUNT=n 的事件创建按周重复系列（EXDATE 排除的
// 发生不生成成员）。同一 UID 允许一个不带 RECURRENCE-ID 的按周主事件配若干例外
// VEVENT（各带单个 RECURRENCE-ID 与改期后 DTSTART/DTEND，文件中位置不限）：
// 例外匹配展开后未排除的原开始并替换该次发生的目标时间，不额外生成成员。
// UID 永久关联首次导入（独立事件关联预约；重复事件关联系列、各原发生时间、成员
// 及按原发生关联的例外起止集合）；相同 UID 且请求一致为重放（返回当前安排与状态，
// 不做任何改动），重复与否/首项时间/COUNT/排除集合/例外集合/资源集合任一不同则
// 整批拒绝，例外的书写顺序不影响身份。
// ---------------------------------------------------------------------------

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

// 仍一律拒绝的重复相关属性（RRULE、EXDATE 与 RECURRENCE-ID 已支持受限子集）
const ICAL_RECURRENCE_PROPS = new Set(['RDATE', 'EXRULE']);

// 解析 RRULE 值：仅支持 FREQ=WEEKLY 与 COUNT=n 两个部件（n 为 1..100000 的整数，
// 含首项）；部件名大小写无关、顺序无关。空部件、重复部件、FREQ 其他取值、
// INTERVAL/BYDAY/UNTIL 等任何其他部件一律拒绝。
function parseWeeklyRrule(value: string, bad: (reason: string) => never): number {
  const segs = value.split(';');
  let freq: string | undefined;
  let count: string | undefined;
  for (const seg of segs) {
    const eq = seg.indexOf('=');
    if (eq <= 0) bad(`RRULE 部件格式非法: “${seg}”（应为 名称=值）`);
    const name = seg.slice(0, eq).trim().toUpperCase();
    const v = seg.slice(eq + 1).trim();
    if (v === '') bad(`RRULE 部件 ${name} 的值不能为空`);
    if (name === 'FREQ') {
      if (freq !== undefined) bad('RRULE 的 FREQ 部件重复');
      freq = v.toUpperCase();
    } else if (name === 'COUNT') {
      if (count !== undefined) bad('RRULE 的 COUNT 部件重复');
      count = v;
    } else {
      bad(`不支持的 RRULE 部件 “${seg}”（仅支持 FREQ=WEEKLY 与 COUNT）`);
    }
  }
  if (freq === undefined) bad('RRULE 缺少 FREQ 部件（仅支持 FREQ=WEEKLY）');
  if (freq !== 'WEEKLY') bad(`仅支持按周重复 FREQ=WEEKLY，实际为 FREQ=${freq}`);
  if (count === undefined) bad('RRULE 缺少 COUNT 部件（仅支持 FREQ=WEEKLY;COUNT=n）');
  if (!/^\d+$/.test(count)) bad(`RRULE 的 COUNT 必须是整数: “${count}”`);
  const n = Number(count);
  if (n < 1 || n > MAX_OCCURRENCES) {
    bad(`RRULE 的 COUNT 必须在 1..${MAX_OCCURRENCES} 之间（含首项）: “${count}”`);
  }
  return n;
}

// 解析一条 EXDATE 属性：参数沿用浮动时间限制（与 DTSTART/DTEND 相同）；
// 值可为一个或多个以逗号分隔的浮动时间（逗号在未转义状态下分隔），各时间
// 必须真实有效，秒为 00；只能匹配原开始时间（由调用方与展开结果比对）。
// 同一事件允许多行 EXDATE，所有时间合并后按集合去重。
function parseExdateValue(
  params: string[],
  value: string,
  bad: (reason: string) => never,
): Array<{raw: string; min: number}> {
  assertFloatingDateTimeParams(params, 'EXDATE ', bad);
  const parts = value.split(',');
  if (parts.some((p) => p.trim() === '')) bad('EXDATE 存在空的时间值（逗号列表每项都须是浮动时间）');
  return parts.map((p) => parseIcalDateTime(p.trim(), 'EXDATE ', bad));
}

// 一个解析完成的 VEVENT 发生（时间已换算为营业地分钟数与 YYYY-MM-DDTHH:mm 文本）。
// start*/end* 为该成员的最终目标时间（套用例外后）；original* 为按 RRULE 展开的
// 原时段（未套例外时两者相同）；hasException 标记该次发生是否被例外替换。
interface IcalOccurrence {
  startRaw: string;
  endRaw: string;
  startMin: number;
  endMin: number;
  originalStartRaw: string;
  originalEndRaw: string;
  hasException: boolean;
}

// 按周系列的单次改期例外：recurrenceId 为被替换原发生的原开始，
// start/end 为改期后的目标起止（可改时间与时长）
interface IcalException {
  recurrenceIdRaw: string;
  recurrenceIdMin: number;
  startRaw: string;
  endRaw: string;
  startMin: number;
  endMin: number;
}

interface IcalEvent {
  uid: string; // 解码后的 UID（区分大小写）
  startRaw: string; // 首项开始
  endRaw: string; // 首项结束
  startMin: number;
  endMin: number;
  recurring: boolean; // 是否带 RRULE:FREQ=WEEKLY;COUNT=n
  count?: number; // 重复事件的 COUNT（含首项，1..100000）
  exdates?: string[]; // 重复事件的排除集合（原开始时间文本，去重按时间排序）
  occurrences: IcalOccurrence[]; // 独立事件 1 项；重复事件为全部未排除发生（按原发生顺序，尚未套用例外）
  exceptions?: IcalException[]; // 仅重复事件：按原发生关联的改期例外（按原发生顺序）
}

// 解析 RECURRENCE-ID 属性：单个浮动时间（沿用 DTSTART 的参数限制），
// 但显式拒绝 RANGE 参数（单次改期例外不得跨范围影响后续发生）
function parseRecurrenceIdValue(
  params: string[],
  value: string,
  bad: (reason: string) => never,
): {raw: string; min: number} {
  for (const p of params) {
    if (/^RANGE=/i.test(p)) bad('RECURRENCE-ID 不支持 RANGE 参数（单次改期例外只影响该次原发生）');
  }
  assertFloatingDateTimeParams(params, 'RECURRENCE-ID ', bad);
  if (value.includes(',')) bad('RECURRENCE-ID 只能指定单个时间（不接受逗号列表）');
  return parseIcalDateTime(value.trim(), 'RECURRENCE-ID ', bad);
}

// 一个刚从文件读出、尚未归并到主事件的原始 VEVENT
interface RawVevent {
  order: number; // 在文件中的 VEVENT 次序（0 基）
  uid: string;
  start: {raw: string; min: number};
  end: {raw: string; min: number};
  rrule?: string;
  exdates: Array<{raw: string; min: number}>;
  recurrenceId?: {raw: string; min: number}; // 带此属性者为例外 VEVENT
}

// 解析整个 iCalendar 文件；任何结构错误、关键属性重复或缺失都抛出 BizError（整批失败）。
// 同一 UID 允许一个不带 RECURRENCE-ID 的按周主事件配若干例外 VEVENT（各带单个
// RECURRENCE-ID 与改期后 DTSTART/DTEND，可位于主事件之前或之后）；其余重复 UID 拒绝。
function parseIcalFile(text: string, file: string): IcalEvent[] {
  const bad = (reason: string): never => {
    throw new BizError(`iCalendar 文件 ${file} 无法导入：${reason}（整批未导入，数据未改动）`);
  };
  const lines = unfoldIcalLines(text, bad);
  if (lines.length === 0) bad('文件为空');

  const rawEvents: RawVevent[] = [];
  let inCalendar = false;
  let calendarEnded = false;
  let versionSeen = false;
  let inEvent = false;
  let curUid: string | undefined;
  let curStart: {raw: string; min: number} | undefined;
  let curEnd: {raw: string; min: number} | undefined;
  let curRrule: string | undefined; // RRULE 原文（至多一条）
  let curExdates: Array<{raw: string; min: number}> = []; // 多行 EXDATE 合并后的候选时间
  let curRecurrenceId: {raw: string; min: number} | undefined;

  const closeEvent = (): void => {
    if (curUid === undefined) bad('VEVENT 缺少 UID 属性');
    if (curStart === undefined) bad(`VEVENT（UID “${curUid}”）缺少 DTSTART 属性`);
    if (curEnd === undefined) bad(`VEVENT（UID “${curUid}”）缺少 DTEND 属性`);
    if (curEnd.min <= curStart.min) {
      bad(`VEVENT（UID “${curUid}”）结束时间必须晚于开始时间（${curStart.raw} → ${curEnd.raw}），允许跨日`);
    }
    rawEvents.push({
      order: rawEvents.length,
      uid: curUid,
      start: curStart,
      end: curEnd,
      ...(curRrule !== undefined ? {rrule: curRrule} : {}),
      exdates: curExdates,
      ...(curRecurrenceId !== undefined ? {recurrenceId: curRecurrenceId} : {}),
    });
    inEvent = false;
    curUid = undefined;
    curStart = undefined;
    curEnd = undefined;
    curRrule = undefined;
    curExdates = [];
    curRecurrenceId = undefined;
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
        curRrule = undefined;
        curExdates = [];
        curRecurrenceId = undefined;
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
      case 'RRULE': {
        if (curRrule !== undefined) bad('VEVENT 内 RRULE 属性重复');
        if (params.length > 0) bad(`RRULE 不支持属性参数: “${params.join(';')}”`);
        curRrule = value.trim();
        break;
      }
      case 'EXDATE': {
        // 沿用浮动时间与参数限制；多行、逗号列表在归并主事件时合并去重
        curExdates.push(...parseExdateValue(params, value, bad));
        break;
      }
      case 'RECURRENCE-ID': {
        // 单次改期例外：单个浮动时间，不允许 RANGE 参数；只能配按周主事件
        if (curRecurrenceId !== undefined) bad('VEVENT 内 RECURRENCE-ID 属性重复');
        curRecurrenceId = parseRecurrenceIdValue(params, value, bad);
        break;
      }
      case 'DESCRIPTION':
        break; // 描述属性忽略
      default:
        if (ICAL_RECURRENCE_PROPS.has(name)) {
          bad(`不支持重复相关属性 ${name}（仅支持按周 RRULE、EXDATE 排除日期与 RECURRENCE-ID 单次例外）`);
        }
        // 其余属性（SUMMARY、LOCATION、DTSTAMP、SEQUENCE 等）忽略
    }
  }

  if (inEvent) bad('VEVENT 缺少对应的 END:VEVENT');
  if (inCalendar) bad('VCALENDAR 缺少对应的 END:VCALENDAR');
  if (!versionSeen) bad('缺少 VERSION:2.0 属性');
  if (rawEvents.length === 0) bad('VCALENDAR 中没有任何 VEVENT（至少需要一个独立事件）');

  // 按 UID 归并：每个 UID 至多一个不带 RECURRENCE-ID 的主事件，
  // 其余同 UID VEVENT 必须是带 RECURRENCE-ID 的例外且主事件须为按周重复事件。
  // 主事件/独立事件的文件顺序决定返回顺序；例外在文件中的位置不限。
  interface RawGroup {
    master?: RawVevent;
    exceptions: RawVevent[];
  }
  const groups = new Map<string, RawGroup>();
  for (const raw of rawEvents) {
    let g = groups.get(raw.uid);
    if (g === undefined) {
      g = {exceptions: []};
      groups.set(raw.uid, g);
    }
    if (raw.recurrenceId === undefined) {
      if (g.master !== undefined) {
        bad(`文件内 UID 重复: “${raw.uid}”（同一 UID 只允许一个不带 RECURRENCE-ID 的主事件，其余须为例外 VEVENT）`);
      }
      g.master = raw;
    } else {
      g.exceptions.push(raw);
    }
  }

  const buildEvent = (uid: string, g: RawGroup): IcalEvent => {
    const master = g.master;
    if (master === undefined) {
      const ids = g.exceptions
        .map((x) => x.recurrenceId!.raw)
        .join('、');
      bad(
        `UID “${uid}” 的例外 VEVENT（RECURRENCE-ID ${ids}）缺少随文件提交的主事件` +
          '（须有一个不带 RECURRENCE-ID 的按周重复 VEVENT）',
      );
    }
    const curStart = master.start;
    const curEnd = master.end;
    const ev: IcalEvent = {
      uid,
      startRaw: curStart.raw,
      endRaw: curEnd.raw,
      startMin: curStart.min,
      endMin: curEnd.min,
      recurring: false,
      occurrences: [],
    };

    // 无规则却有 EXDATE：整批拒绝（排除日期只在按周重复事件中有意义）
    if (master.rrule === undefined) {
      if (master.exdates.length > 0) bad(`VEVENT（UID “${uid}”）含 EXDATE 却没有 RRULE（无规则不能带排除日期）`);
      if (g.exceptions.length > 0) {
        bad(
          `UID “${uid}” 存在 ${g.exceptions.length} 个带 RECURRENCE-ID 的例外 VEVENT，` +
            '但其主事件不是按周重复事件（RECURRENCE-ID 只能配 RRULE:FREQ=WEEKLY 主事件）',
        );
      }
      ev.occurrences.push({
        startRaw: curStart.raw,
        endRaw: curEnd.raw,
        startMin: curStart.min,
        endMin: curEnd.min,
        originalStartRaw: curStart.raw,
        originalEndRaw: curEnd.raw,
        hasException: false,
      });
      return ev;
    }

    const count = parseWeeklyRrule(master.rrule, bad);
    ev.recurring = true;
    ev.count = count;
    // EXDATE 只能匹配原开始时间：全部候选必须落在按周展开的原开始时间集合上，
    // 多行与逗号列表合并、按集合去重
    const allStarts = new Map<number, string>();
    for (let i = 0; i < count; i++) {
      const sMin = curStart.min + i * 7 * 1440;
      const eMin = curEnd.min + i * 7 * 1440;
      const sRaw = formatDateTime(sMin);
      const eRaw = formatDateTime(eMin);
      if (sRaw === null || eRaw === null) {
        bad(`VEVENT（UID “${uid}”）按周展开第 ${i + 1} 项超出四位年份范围（0001-9999），整批拒绝`);
      }
      allStarts.set(sMin, sRaw);
    }
    const exSet = new Set<number>();
    for (const ex of master.exdates) {
      if (!allStarts.has(ex.min)) {
        bad(
          `VEVENT（UID “${uid}”）的 EXDATE ${ex.raw} 不匹配任何原开始时间` +
            '（排除日期只能等于某一发生的原开始时间，时刻须一致）',
        );
      }
      exSet.add(ex.min);
    }
    ev.exdates = [...exSet].map((m) => allStarts.get(m)!).sort();

    // 未排除的原发生（此时尚未套用例外）
    const kept: IcalOccurrence[] = [];
    for (let i = 0; i < count; i++) {
      const sMin = curStart.min + i * 7 * 1440;
      if (exSet.has(sMin)) continue; // 仅为未排除项生成成员
      kept.push({
        startRaw: formatDateTime(sMin)!,
        endRaw: formatDateTime(curEnd.min + i * 7 * 1440)!,
        startMin: sMin,
        endMin: curEnd.min + i * 7 * 1440,
        originalStartRaw: formatDateTime(sMin)!,
        originalEndRaw: formatDateTime(curEnd.min + i * 7 * 1440)!,
        hasException: false,
      });
    }
    if (kept.length === 0) {
      bad(`VEVENT（UID “${uid}”）的全部 ${count} 个发生都被 EXDATE 排除，整批拒绝（至少保留一项）`);
    }

    // 归并例外 VEVENT：不得带 RRULE/EXDATE；RECURRENCE-ID 须命中一个未排除原开始，
    // 同一原发生至多一个例外；例外可改时间与时长（沿用浮动时间参数限制）。
    const exceptions: IcalException[] = [];
    const exceptionByOcc = new Map<number, IcalException>();
    for (const x of g.exceptions) {
      const rid = x.recurrenceId!;
      if (x.rrule !== undefined) {
        bad(`例外 VEVENT（UID “${uid}”，RECURRENCE-ID ${rid.raw}）不得带 RRULE（例外仍属该系列）`);
      }
      if (x.exdates.length > 0) {
        bad(`例外 VEVENT（UID “${uid}”，RECURRENCE-ID ${rid.raw}）不得带 EXDATE`);
      }
      if (!allStarts.has(rid.min)) {
        bad(
          `例外 VEVENT（UID “${uid}”）的 RECURRENCE-ID ${rid.raw} 不匹配任何原开始时间` +
            '（须等于主事件展开后某一发生的原开始时间，时刻须一致）',
        );
      }
      if (exSet.has(rid.min)) {
        bad(`例外 VEVENT（UID “${uid}”）的 RECURRENCE-ID ${rid.raw} 匹配的原发生已被 EXDATE 排除`);
      }
      if (exceptionByOcc.has(rid.min)) {
        bad(`UID “${uid}” 同一原发生 ${rid.raw} 存在重复例外 VEVENT（一次原发生至多一个例外）`);
      }
      const ex: IcalException = {
        recurrenceIdRaw: rid.raw,
        recurrenceIdMin: rid.min,
        startRaw: x.start.raw,
        endRaw: x.end.raw,
        startMin: x.start.min,
        endMin: x.end.min,
      };
      exceptionByOcc.set(rid.min, ex);
      exceptions.push(ex);
    }
    // 例外书写顺序不影响身份与结果：统一按原发生顺序排列
    exceptions.sort((a, b) => a.recurrenceIdMin - b.recurrenceIdMin);
    ev.exceptions = exceptions;

    // 展开并排除后用例外目标替换对应原发生：不额外生成成员，被替换原时段不再参与校验
    for (const occ of kept) {
      const ex = exceptionByOcc.get(occ.startMin);
      if (ex === undefined) continue;
      occ.startRaw = ex.startRaw;
      occ.endRaw = ex.endRaw;
      occ.startMin = ex.startMin;
      occ.endMin = ex.endMin;
      occ.hasException = true;
    }
    ev.occurrences = kept;
    return ev;
  };

  return [...groups.entries()]
    .map(([uid, g]) => ({uid, g, masterOrder: g.master?.order ?? Number.MAX_SAFE_INTEGER}))
    .sort((a, b) => a.masterOrder - b.masterOrder)
    .map(({uid, g}) => buildEvent(uid, g));
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
  const store = await loadStoreForWrite(file);
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
  // 重复与否、首项时间、COUNT、排除集合、按原发生关联的例外集合与资源集合（顺序无关）
  // 须与首次导入快照完全一致，否则整批拒绝；部件顺序、排除值/例外的书写顺序与
  // 资源顺序不算变化。
  const importByUid = new Map(store.imports.map((r) => [r.uid, r]));
  interface ImportItem {
    ev: IcalEvent;
    index: number; // 0 基，按主事件/独立事件的文件顺序
    replay?: ImportRec;
  }
  const sameStringSet = (a: string[], b: string[]): boolean =>
    a.length === b.length && a.every((x, j) => x === b[j]); // 两侧均已排序
  // 例外身份：按原发生（RECURRENCE-ID）关联改期后起止；书写顺序不影响身份
  type ExceptionKey = {recurrenceId: string; start: string; end: string};
  const exceptionMap = (list: ReadonlyArray<ExceptionKey>): Map<string, {start: string; end: string}> =>
    new Map(list.map((x) => [x.recurrenceId, {start: x.start, end: x.end}]));
  const sameExceptions = (a: ReadonlyArray<ExceptionKey>, b: ReadonlyArray<ExceptionKey>): boolean => {
    if (a.length !== b.length) return false;
    const mb = exceptionMap(b);
    return a.every((x) => {
      const y = mb.get(x.recurrenceId);
      return y !== undefined && y.start === x.start && y.end === x.end;
    });
  };
  // 解析结果的例外字段名为 *Raw，比对前归一化为快照同构的三元组
  const parsedExceptions = (ev: IcalEvent): ExceptionKey[] =>
    (ev.exceptions ?? []).map((x) => ({recurrenceId: x.recurrenceIdRaw, start: x.startRaw, end: x.endRaw}));
  const mismatches: string[] = [];
  const items: ImportItem[] = events.map((ev, index) => {
    const rec = importByUid.get(ev.uid);
    if (rec === undefined) return {ev, index};
    const firstDesc =
      `${rec.start} → ${rec.end}` +
      (rec.count !== undefined
        ? `，COUNT=${rec.count}，排除 ${rec.exdates?.length ?? 0} 项，例外 ${rec.exceptions?.length ?? 0} 个`
        : '') +
      `（资源 ${rec.resourceIds.join('、')}）`;
    const thisDesc =
      `${ev.startRaw} → ${ev.endRaw}` +
      (ev.count !== undefined
        ? `，COUNT=${ev.count}，排除 ${ev.exdates?.length ?? 0} 项，例外 ${ev.exceptions?.length ?? 0} 个`
        : '') +
      `（资源 ${ids.join('、')}）`;
    const reasons: string[] = [];
    if ((rec.seriesId !== undefined) !== ev.recurring) {
      reasons.push(ev.recurring ? '首次导入为独立事件，本次为重复事件' : '首次导入为重复事件，本次为独立事件');
    }
    if (rec.start !== ev.startRaw || rec.end !== ev.endRaw) reasons.push('首项时间不同');
    if (ev.recurring && rec.count !== ev.count) {
      reasons.push(`COUNT 不同（首次 ${rec.count ?? '?'}，本次 ${ev.count}）`);
    }
    if (ev.recurring && !sameStringSet(rec.exdates ?? [], ev.exdates ?? [])) {
      reasons.push('排除集合不同');
    }
    if (ev.recurring && !sameExceptions(rec.exceptions ?? [], parsedExceptions(ev))) {
      reasons.push('例外集合不同（按原发生关联的例外增删或例外起止时间改变）');
    }
    if (!sameStringSet(rec.resourceIds, ids)) reasons.push('资源集合不同');
    if (reasons.length > 0) {
      mismatches.push(
        `第 ${index + 1} 项 UID “${ev.uid}”：${reasons.join('；')}；` +
          `首次导入为 ${firstDesc}，本次为 ${thisDesc}`,
      );
    }
    return {ev, index, replay: rec};
  });
  if (mismatches.length > 0) {
    throw new BizError(
      `iCalendar 导入被拒绝：${mismatches.length} 个 UID 的重复与否、首项时间、COUNT、排除集合、` +
        '例外集合或资源集合与首次导入不一致（相同 UID 不会覆盖本地安排，整批未导入）：\n' +
        mismatches.map((m) => `- ${m}`).join('\n'),
    );
  }

  // 把全部新事件的未排除发生按“文件顺序、事件内原发生顺序”展平为批次目标。
  // 仅新预约接受目标校验；重放成员本就在 store.bookings 中，按其当前状态与安排
  // 参与既有占用（已取消不占用，改期后按新安排占用），不用首次导入快照代替现状。
  const newItems = items.filter((it) => it.replay === undefined);
  interface FlatTarget extends ValidationTarget {
    item: ImportItem; // 归属的新事件
    occ: IcalOccurrence;
    occNo: number; // 1 基，未排除发生中的序号（独立事件恒为 1）
  }
  const flat: FlatTarget[] = [];
  for (const item of newItems) {
    item.ev.occurrences.forEach((occ, j) => {
      flat.push({item, occ, occNo: j + 1, startMin: occ.startMin, endMin: occ.endMin, resourceIds: ids});
    });
  }
  const failures = validateBatchTargets(store, flat);

  if (failures.length > 0) {
    // 按文件及原发生顺序报告全部受阻发生：UID、原发生与目标时间、开放不足资源
    // （含相关停用）、全部冲突与共同资源；批内双方互列 UID、原发生与目标时间。
    // 无例外的发生原时段即目标，沿用“时间”写法；例外项额外列出原发生与被释放原时段。
    const occLabel = (o: IcalOccurrence): string =>
      o.hasException
        ? `原发生 ${o.originalStartRaw}，目标时间 ${o.startRaw} → ${o.endRaw}`
        : `${o.startRaw} → ${o.endRaw}`;
    const blocks = failures.map((f) => {
      const t = flat[f.index];
      const ev = t.item.ev;
      const lines = [
        `第 ${t.item.index + 1} 项 UID “${ev.uid}” 第 ${t.occNo} 次发生（${occLabel(t.occ)}）：`,
      ];
      if (t.occ.hasException) {
        lines.push(
          `  单次改期例外（RECURRENCE-ID ${t.occ.originalStartRaw}）：被替换原时段 ` +
            `${t.occ.originalStartRaw} → ${t.occ.originalEndRaw} 已释放，不参与覆盖或冲突校验`,
        );
      }
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
          const o = flat[x.otherIndex];
          lines.push(
            `    - 第 ${o.item.index + 1} 项 UID “${o.item.ev.uid}” 第 ${o.occNo} 次发生（${occLabel(o.occ)}）` +
              `：共同资源 ${formatResourceIds(store, x.shared)}`,
          );
        }
      }
      return lines.join('\n');
    });
    throw new BizError(
      `iCalendar 导入失败：共 ${failures.length} 个发生不满足条件（按文件及原发生顺序），整批未导入：\n${blocks.join('\n')}`,
    );
  }

  const replayCount = items.length - newItems.length;

  // 新增独立事件 -> 预约标识；新增重复事件 -> 系列标识及“原发生 -> 成员标识”
  const assignedBooking = new Map<ImportItem, string>();
  const assignedSeries = new Map<ImportItem, {seriesId: string; members: Array<{occ: IcalOccurrence; bookingId: string}>}>();

  const renderItem = (it: ImportItem): string[] => {
    const ev = it.ev;
    if (it.replay === undefined) {
      if (!ev.recurring) {
        const bookingId = assignedBooking.get(it)!;
        return [
          `- 第 ${it.index + 1} 项 UID “${ev.uid}” → 新预约 ${bookingId}（新增，普通预约，不属于任何系列）`,
          `    时间: ${ev.startRaw} → ${ev.endRaw}`,
          `    资源: ${formatResourceIds(store, ids)}`,
        ];
      }
      const {seriesId, members} = assignedSeries.get(it)!;
      const exPart =
        ev.exceptions!.length > 0 ? `，单次改期例外 ${ev.exceptions!.length} 个` : '';
      const lines = [
        `- 第 ${it.index + 1} 项 UID “${ev.uid}” → 新系列 ${seriesId}` +
          `（新增按周重复系列：COUNT=${ev.count}，排除 ${ev.exdates!.length} 项${exPart}，生成 ${members.length} 个成员）`,
        `    资源: ${formatResourceIds(store, ids)}`,
      ];
      for (let k = 0; k < members.length; k++) {
        const {occ, bookingId} = members[k];
        if (occ.hasException) {
          lines.push(
            `    第 ${k + 1} 次发生（原发生 ${occ.originalStartRaw}） → ${bookingId} [已预约]`,
          );
          lines.push(
            `      单次改期例外（RECURRENCE-ID ${occ.originalStartRaw}）: ` +
              `${occ.startRaw} → ${occ.endRaw}`,
          );
        } else {
          lines.push(`    第 ${k + 1} 次发生（原发生 ${occ.originalStartRaw}） → ${bookingId}: ${occ.startRaw} → ${occ.endRaw}`);
        }
      }
      return lines;
    }

    // 重放：显示原系列、原发生时间、预约及其当前时间、资源、状态；
    // 不做任何改动（成员被改期、单独/整体取消或随批量改期撤销也不复活、不重建）。
    // 首次请求的例外快照只说明该次发生曾随导入改期；现状一律以成员当前安排为准。
    const rec = it.replay;
    if (rec.bookingId !== undefined) {
      const b = store.bookings.find((x) => x.id === rec.bookingId)!;
      const statusLabel = b.status === 'active' ? '已预约' : '已取消';
      return [
        `- 第 ${it.index + 1} 项 UID “${ev.uid}” → 预约 ${rec.bookingId}（重放，未做改动）`,
        `    当前状态: ${statusLabel}`,
        `    当前安排: ${b.start} → ${b.end}`,
        `    当前资源: ${formatResourceIds(store, b.resourceIds)}`,
      ];
    }
    const exceptionByOcc = exceptionMap(rec.exceptions ?? []);
    const exPartReplay =
      (rec.exceptions?.length ?? 0) > 0 ? `，例外 ${rec.exceptions!.length} 个` : '';
    const lines = [
      `- 第 ${it.index + 1} 项 UID “${ev.uid}” → 系列 ${rec.seriesId}` +
        `（重放，未做改动；COUNT=${rec.count}，排除 ${rec.exdates!.length} 项${exPartReplay}，成员 ${rec.occurrences!.length} 个）`,
    ];
    rec.occurrences!.forEach((o, k) => {
      const b = store.bookings.find((x) => x.id === o.bookingId)!;
      const statusLabel = b.status === 'active' ? '已预约' : '已取消';
      const ex = exceptionByOcc.get(o.start);
      lines.push(`    第 ${k + 1} 次发生（原发生 ${o.start}） → ${o.bookingId} [${statusLabel}]`);
      if (ex !== undefined) {
        lines.push(`      首次请求例外目标: ${ex.start} → ${ex.end}（现状以成员当前安排为准，不复活、不补员）`);
      }
      lines.push(`      当前安排: ${b.start} → ${b.end}`);
      lines.push(`      当前资源: ${formatResourceIds(store, b.resourceIds)}`);
    });
    return lines;
  };

  if (newItems.length === 0) {
    // 全重放：不写文件、不推进任何计数
    console.log(
      `iCalendar 导入完成：共 ${items.length} 项，全部为重放（未写入数据文件，标识计数不变）`,
    );
    for (const it of items) console.log(renderItem(it).join('\n'));
    return;
  }

  // 新系列、成员与导入身份在同一次原子保存中落盘后才报告成功；
  // 标识在此刻才按文件顺序与原发生顺序生成，任何失败都不推进计数、不写文件。
  for (const it of newItems) {
    const ev = it.ev;
    if (!ev.recurring) {
      store.bookingSeq += 1;
      const bookingId = `B${String(store.bookingSeq).padStart(4, '0')}`;
      store.bookings.push({
        id: bookingId,
        resourceIds: ids,
        start: ev.startRaw,
        end: ev.endRaw,
        status: 'active',
      });
      store.imports.push({
        uid: ev.uid,
        bookingId,
        start: ev.startRaw,
        end: ev.endRaw,
        resourceIds: [...ids],
      });
      assignedBooking.set(it, bookingId);
      continue;
    }

    store.seriesSeq += 1;
    const seriesId = `S${String(store.seriesSeq).padStart(4, '0')}`;
    store.series.push({id: seriesId});
    const members: Array<{occ: IcalOccurrence; bookingId: string}> = [];
    for (const occ of ev.occurrences) {
      store.bookingSeq += 1;
      const bookingId = `B${String(store.bookingSeq).padStart(4, '0')}`;
      store.bookings.push({
        id: bookingId,
        resourceIds: ids,
        start: occ.startRaw,
        end: occ.endRaw,
        status: 'active',
        seriesId,
      });
      members.push({occ, bookingId});
    }
    store.imports.push({
      uid: ev.uid,
      seriesId,
      start: ev.startRaw,
      end: ev.endRaw,
      resourceIds: [...ids],
      count: ev.count,
      exdates: [...ev.exdates!],
      occurrences: members.map(({occ, bookingId}) => ({start: occ.originalStartRaw, bookingId})),
      exceptions: ev.exceptions!.map((x) => ({
        recurrenceId: x.recurrenceIdRaw,
        start: x.startRaw,
        end: x.endRaw,
      })),
    });
    assignedSeries.set(it, {seriesId, members});
  }
  store.bookings.sort((a, b) => a.id.localeCompare(b.id));
  store.series.sort((a, b) => a.id.localeCompare(b.id));
  store.imports.sort((a, b) => a.uid.localeCompare(b.uid));
  await saveStore(file, store);

  console.log(`iCalendar 导入完成：共 ${items.length} 项（新增 ${newItems.length} 项，重放 ${replayCount} 项）`);
  for (const it of items) console.log(renderItem(it).join('\n'));
}

// ---------------------------------------------------------------------------
// iCalendar 本地导出（export-ical，只读）
//
// 按已解码 UID 选择一个“已导入的按周重复系列”，把保存本地变更后的当前安排
// 导出为 VERSION:2.0 的 VCALENDAR：
//   - 主事件保留首次 UID、首项 DTSTART/DTEND 与 RRULE:FREQ=WEEKLY;COUNT=n；
//   - EXDATE = 首次排除集合 ∪ 已取消成员原开始时间（按时间去重排序）；
//   - 有效成员相对“原周展开”的起止时间或完整资源集合有变化时，输出同 UID 的
//     例外 VEVENT：RECURRENCE-ID 固定为该成员原开始，DTSTART/DTEND 取当前值，
//     DESCRIPTION 为当前完整资源集合；无变化不输出例外；取消成员不输出例外。
// 首次导入时随文件带来的例外也一律按上述规则与原周展开重新比较，不复制首次
// 例外快照；全部成员取消时仍生成合法但无有效发生的日历（EXDATE 覆盖全部发生）。
//
// 只读一份完整快照：不等待或改动写入保护、不修改业务数据、身份、历史或计数，
// 原有 UID 重放规则不变。输出先写临时文件再原子替换，完整替换成功后才退出 0；
// 输出路径与数据文件、写入保护或恢复协调文件等价时拒绝。
// ---------------------------------------------------------------------------

const EXPORT_PRODID = '-//shiftbook//local weekly-series export//CN';

// TEXT 值转义：反斜杠、分号、逗号与换行（\r\n、\r、\n 均编码为 \n）
function escapeIcalText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// RFC 5545 折行：物理行不超过 75 个 UTF-8 字节（不计行尾 CRLF），续行以一个
// 空格开头（该空格计入 75 字节，故续行内容至多 74 字节）；按码点切分，绝不拆开
// 一个 Unicode 字符。
function foldIcalLine(line: string): string[] {
  const chunks: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    const limit = chunks.length === 0 ? 75 : 74;
    if (curBytes + len > limit) {
      chunks.push(cur);
      cur = '';
      curBytes = 0;
    }
    cur += ch;
    curBytes += len;
  }
  chunks.push(cur);
  return chunks.map((c, i) => (i === 0 ? c : ` ${c}`));
}

// 营业地时间文本 YYYY-MM-DDTHH:mm -> 浮动 iCalendar 时间 YYYYMMDDTHHmm00
function floatingFromRaw(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(raw);
  if (!m) throw new BizError(`内部时间文本无法转换为浮动 iCalendar 时间: “${raw}”`);
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}00`;
}

// 合法 UTC 的 DTSTAMP：YYYYMMDDTHHMMSSZ
function utcStampNow(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// DESCRIPTION 文本：逐资源列出标识、名称与类型（中文类型标签），按标识排序，
// 每项一行（输出时换行经 TEXT 转义为 \n）
function resourceDescription(store: Store, ids: string[]): string {
  return ids
    .map((id) => {
      const r = store.resources.find((x) => x.id === id);
      if (r === undefined) throw new BizError(`数据损坏：资源 ${id} 不存在，无法导出其名称与类型（未写出任何文件）`);
      return `资源 ${r.id} ${r.name}（${RESOURCE_TYPE_LABEL[r.type]}）`;
    })
    .join('\n');
}

interface SeriesExport {
  text: string;
  activeCount: number; // 有效成员数
  excludedCount: number; // 输出 EXDATE 数量（首次排除 ∪ 已取消成员原开始）
  exceptionCount: number; // 输出例外 VEVENT 数量
}

function buildSeriesIcal(store: Store, rec: ImportRec): SeriesExport {
  if (rec.seriesId === undefined || rec.count === undefined || rec.occurrences === undefined) {
    throw new BizError(`UID “${rec.uid}” 不是按周重复系列导入身份（导出中止，未写出任何文件）`);
  }
  const stamp = utcStampNow();
  const firstResourceIds = [...rec.resourceIds].sort();
  // 每次原发生的时长与首项相同（按周后移只改日期、不改时刻与跨日长度）
  const masterDurationMin =
    parseDateTime(rec.end, '导出：首项结束时间') - parseDateTime(rec.start, '导出：首项开始时间');

  const exdates = new Set<string>(rec.exdates ?? []);
  interface OutException {
    recurrenceId: string;
    start: string;
    end: string;
    resourceIds: string[];
  }
  const exceptions: OutException[] = []; // rec.occurrences 按原发生顺序，追加即有序
  let activeCount = 0;
  const bookingById = new Map(store.bookings.map((b) => [b.id, b]));

  for (const occ of rec.occurrences) {
    const b = bookingById.get(occ.bookingId);
    if (b === undefined) {
      throw new BizError(
        `数据损坏：UID “${rec.uid}” 的成员预约 ${occ.bookingId} 不存在（导出中止，未写出任何文件）`,
      );
    }
    if (b.status === 'cancelled') {
      // 取消成员：不输出例外，其原开始并入排除集合
      exdates.add(occ.start);
      continue;
    }
    activeCount += 1;
    const origStartMin = parseDateTime(occ.start, '导出：成员原发生开始时间');
    const origEndRaw = formatDateTime(origStartMin + masterDurationMin);
    if (origEndRaw === null) {
      throw new BizError(
        `数据损坏：UID “${rec.uid}” 原发生 ${occ.start} 的结束超出四位年份范围（0001-9999，导出中止）`,
      );
    }
    const currentResourceIds = [...b.resourceIds].sort();
    const sameResources =
      currentResourceIds.length === firstResourceIds.length &&
      currentResourceIds.every((id, j) => id === firstResourceIds[j]);
    // 与“原周展开”逐项比较：首次导入例外、本地改期/换资源一视同仁
    const changed = b.start !== occ.start || b.end !== origEndRaw || !sameResources;
    if (changed) {
      exceptions.push({recurrenceId: occ.start, start: b.start, end: b.end, resourceIds: currentResourceIds});
    }
  }

  const excludedSorted = [...exdates].sort(); // 定宽文本字典序即原发生时间顺序
  const uidText = escapeIcalText(rec.uid);
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${EXPORT_PRODID}`];

  // 主事件在前：保留首次 UID、首项 DTSTART/DTEND 与 RRULE；DESCRIPTION 用首次资源集合
  lines.push('BEGIN:VEVENT');
  lines.push(`UID:${uidText}`);
  lines.push(`DTSTAMP:${stamp}`);
  lines.push(`DTSTART:${floatingFromRaw(rec.start)}`);
  lines.push(`DTEND:${floatingFromRaw(rec.end)}`);
  lines.push(`RRULE:FREQ=WEEKLY;COUNT=${rec.count}`);
  for (const ex of excludedSorted) lines.push(`EXDATE:${floatingFromRaw(ex)}`);
  lines.push(`DESCRIPTION:${escapeIcalText(resourceDescription(store, firstResourceIds))}`);
  lines.push('END:VEVENT');

  // 例外按原发生顺序；RECURRENCE-ID 固定为原开始，目标时间与资源取当前值
  for (const x of exceptions) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${uidText}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`RECURRENCE-ID:${floatingFromRaw(x.recurrenceId)}`);
    lines.push(`DTSTART:${floatingFromRaw(x.start)}`);
    lines.push(`DTEND:${floatingFromRaw(x.end)}`);
    lines.push(`DESCRIPTION:${escapeIcalText(resourceDescription(store, x.resourceIds))}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');

  const text = lines.map(foldIcalLine).flat().join('\r\n') + '\r\n';
  return {text, activeCount, excludedCount: exdates.size, exceptionCount: exceptions.length};
}

async function cmdExportIcal(args: string[]): Promise<void> {
  const {values, positionals} = parseFlags(args, ['output']);
  if (positionals.length !== 1) {
    throw new UsageError('用法: export-ical <已解码 UID> --output <iCalendar 输出文件>');
  }
  const uid = positionals[0];
  const output = requireFlag(values, 'output');
  const file = activeDataFile;

  // 输出不得与数据文件、写入保护（<数据文件>.lock）或恢复协调文件（.lock.recover）
  // 等价：相对/绝对/含 ./.. 的同源写法（含指向数据文件的符号链接）一律拒绝
  const outCanonical = canonicalDataPath(output);
  const blockedPaths = [canonicalDataPath(file), lockPathFor(file), recoveryPathFor(file)];
  if (blockedPaths.includes(outCanonical)) {
    throw new BizError(
      `导出文件 ${output} 与数据文件、其写入保护或恢复协调文件等价，拒绝写出（请指定其他输出路径）`,
    );
  }

  // 只读一份完整快照：不等待写入保护、不修改数据文件、身份、历史或计数
  const store = await loadStore(file);
  const rec = store.imports.find((x) => x.uid === uid);
  if (rec === undefined) {
    throw new BizError(
      `未找到 UID “${uid}” 的导入记录：export-ical 只能选择已导入的按周重复系列` +
      '（UID 为导入时解码后的值，区分大小写；独立事件不能导出）',
    );
  }
  if (rec.seriesId === undefined) {
    throw new BizError(
      `UID “${uid}” 关联的是独立事件（预约 ${rec.bookingId}），不是按周重复系列：` +
      'export-ical 仅导出已导入的按周重复系列',
    );
  }
  const result = buildSeriesIcal(store, rec);

  // 先完整写入临时文件再原子改名：任何失败都不触碰原输出文件；
  // 原输出不存在时失败也不留半成品（临时文件已清理）
  const tmp = `${output}.${process.pid}.export-tmp`;
  try {
    await writeFile(tmp, result.text, {encoding: 'utf8', flag: 'wx'});
    await rename(tmp, output);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw new BizError(
      `写入导出文件 ${output} 失败：${(err as Error).message}` +
      '（原输出文件保持不变；原本不存在时也未留下半成品，业务数据未改动）',
    );
  }

  console.log(
    `已导出按周重复系列：UID “${uid}”（系列 ${rec.seriesId}）→ ${output}\n` +
      `  有效成员 ${result.activeCount} 项；` +
      `排除 ${result.excludedCount} 项（首次排除集合与已取消成员原开始的并集）；` +
      `输出例外 ${result.exceptionCount} 个。`,
  );
}

// ---------------------------------------------------------------------------
// 帮助与入口
// ---------------------------------------------------------------------------

const HELP_TEXT = `shiftbook —— 本地多资源预约（含按周重复系列、固定/弹性候补队列、资源临时停用、批量改期记录与安全撤销、iCalendar 导入与已导入按周系列的本地导出、候选资源组合的最早可行时段查询、多项弹性预约的联合排程与原子创建、尽量少改动既有预约的弹性批量改期，以及资源使用率与繁忙时段统计）

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
  reschedule-flex <改期清单文件>
      弹性批量改期：按本地 JSON 清单为多项既有预约求解整单最终安排（每项给出
      预约标识、目标窗口与有顺序的候选资源组，时长保持预约当前长度），先尽量
      少改动既有预约，再取字典序最小方案；清单写法见下方“弹性批量改期清单”。
      至少一项有变化时生成稳定且不复用的操作标识（如 O0001）并与新安排原子
      保存；安排均与现状一致的提交成功但不建记录、不改文件或计数
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

查询命令（候选资源组合的最早可行时段，只读不写）:
  find-slot --window <开始/结束> --duration <正整数分钟> \\
      --group <候选资源,逗号分隔> [--group <候选资源,逗号分隔> ...]
      在营业地时间窗口（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm，真实有效、
      结束晚于开始、允许跨日、与机器时区无关）内，为一组有顺序的需求寻找
      能同时满足全部需求的最早连续时段：每个 --group 列出一组可任选其一的
      已登记资源（至少一组，每组非空；组内重复或未知资源拒绝；同一资源可
      出现在不同组，例如两名工作人员用两个需求组表达）。时长为不超过窗口
      长度的正整数分钟。每组恰选一个候选，全部所选资源互不相同，并在整个
      时段保持同一组合（不中途更换资源、不拼接间断时间）。各资源空闲时间
      = 开放区间合并重叠或相接后扣除有效停用并集与当前有效预约占用（取消
      的预约/停用与未兑现候补不阻挡），区间左闭右开、端点相接可行。有解时
      显示起止时间与按需求组顺序的所选资源（标识、名称、类型）；同一最早
      开始有多个组合时，按组顺序的资源标识序列取字典序最小者（组内候选
      输入顺序不影响结果）。无解明确提示且退出码为 0，不返回少组或缩短
      时长的方案。本命令只读一份完整数据快照：不等待写入保护、不创建预约
      或任何记录、不写数据文件或推进计数；方案不保留位置，后续创建预约仍
      检查最新状态

联合排程命令（多项弹性预约的联合排程与原子创建）:
  schedule-flex <预约清单文件>
      读取本地 JSON 清单（UTF-8，顶层 {"items": [...]}，非空、有顺序），
      为整份清单寻找同时可行的安排并原子创建全部预约。每项字段：
        "window":   时间窗口 "YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm"
                    （真实有效、结束晚于开始、允许跨日、与机器时区无关）
        "duration": 所需连续分钟数（不超过窗口长度的正整数）
        "groups":   有顺序的需求组数组，每组是一个候选资源标识数组
                    （如 [["R0001","R0002"],["R0003"]]）；至少一组、每组非空，
                    未知或组内重复资源整单拒绝；资源可跨组、跨项出现
      每项须完整落在自身窗口内：每组恰选一个候选，一项所选资源互不相同，
      全部所选资源同时连续可用且全程固定（不换资源、不拼接间断）；开放重叠
      或相接先合并，再扣除有效停用与全部有效预约的当前占用（取消记录及未
      兑现候补不阻挡）；新项之间仅共同资源的左闭右开时间重叠才冲突，端点
      相接可行。求解面向整单可行性：不会逐项固定最早选择后漏掉须调整前项
      时间或资源的解，也不跳过受阻项。多个完整方案按清单顺序逐项比较：
      先比该项开始分钟，再按需求组顺序以字符串字典序比资源标识，第一处
      差异取较小者（候选书写顺序不影响结果；清单顺序只用于取舍，不限定
      活动发生先后）。可附加项间关系（顶层 "relations" 数组，省略或为空
      保持原行为）：每条以从 1 开始的清单序号给出前项 predecessor 与后项
      successor，及非负整数分钟最小、最大衔接间隔 minGap/maxGap（minGap
      ≤ maxGap，零允许紧接）；全部关系同时生效，要求后项开始减前项结束
      落在 [minGap, maxGap]（含两端），适用于不同资源的项，关系方向可逆
      清单顺序（后项可写在前面）。非整数或越界序号、自指、重复有向关系、
      有向环均整单拒绝。关系只约束创建时求解；创建后各项仍可独立改期或
      取消。有解时按清单顺序各创建一项普通预约（稳定、不复用标识，不加入
      系列、不改动既有预约或候补、不自动处理候补），原子保存全部预约后才
      退出 0，并显示各项标识、起止时间与按组对应的资源；每次提交都是新的
      创建请求，不按清单路径或内容去重。无整体解明确提示并退出 1，不保存
      部分方案；清单不可读、损坏或内容非法同样整单失败，不产生记录、占用
      或计数变化。
      清单示例:
        {
          "items": [
            {"window": "2026-10-12T08:00/2026-10-12T18:00", "duration": 60, "groups": [["R0001","R0002"], ["R0003"]]},
            {"window": "2026-10-12T09:00/2026-10-12T12:00", "duration": 90, "groups": [["R0001"]]}
          ],
          "relations": [
            {"predecessor": 1, "successor": 2, "minGap": 0, "maxGap": 120}
          ]
        }

统计命令（资源使用率与繁忙时段，只读）:
  usage-stats --window <开始/结束> [--resource <标识> ...]
      统计窗口（YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm，真实有效、结束晚于开始、
      允许跨日、与机器时区无关，左闭右开）内所选资源的实际使用情况，帮助判断
      场地、设备、人员的繁忙程度。未指定 --resource 时统计全部已登记资源
      （名册为空时明确提示并退出 0）；未知或重复资源拒绝。每个资源的实际可用
      时间 = 开放区间合并重叠或相接后扣除有效停用并集，再裁剪到窗口；占用只计
      有效预约（普通、系列成员、导入与候补兑现预约同口径；已取消预约/停用、
      未兑现候补、导入首次请求快照与改期历史快照均不计）的当前时间与当前
      资源，并取与实际可用区间的交集，同一资源的重叠占用合并、一分钟只计
      一次，多资源预约在每个所选资源分别计时。逐日明细覆盖与窗口有正长度
      交集的全部营业日期（按午夜拆分，首尾不足一天只计窗口内部分，含零可用
      或零占用的所选资源，按日期再按资源标识排序）；整窗再按资源逐行汇总并
      合计全部所选资源的可用、占用、空闲资源分钟与使用率（空闲 = 可用 - 占用，
      使用率 = 占用/可用，百分比四舍五入至两位小数，分母为零显示不适用；合计
      以总占用除总可用，不平均各项百分比）。另显示窗口内同时被占用的所选资源
      数量峰值及全部达到峰值的最大连续区间（按开始时间排序；按资源而非预约
      计数，端点交接不制造瞬时重叠，相接的峰值段合并，无占用时峰值为零且不
      列区间）。本命令只读一份完整数据快照：不等待写入保护、不创建任何记录、
      不写数据文件或推进计数

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
      读取 UTF-8 的 VCALENDAR（VERSION:2.0，至少一个 VEVENT；每项须有
      一个非空 UID、DTSTART 和 DTEND；时间仅支持浮动 YYYYMMDDTHHmmss，秒为
      00，年份 0001-9999，真实有效、结束晚于开始、允许跨日、不随机器时区
      变化；支持 CRLF 或 LF、标准折行与 UID 文本转义，属性名忽略大小写，
      解码后 UID 区分大小写；描述属性忽略，全天、时区、RDATE/EXRULE、
      取消事件及事件内嵌套组件拒绝；结构错误、关键属性重复或文件内 UID
      重复均整批失败（同一 UID 的主事件+例外组合除外，见下）。
      全部新事件统一使用所给资源集合（至少一个不同的已登记资源）。
      无 RRULE 的事件创建一项普通预约；
      带 RRULE:FREQ=WEEKLY;COUNT=n（n 为 1..100000 的整数，含首项；部件
      大小写与顺序无关，其他 FREQ 与任何其他部件拒绝）的事件创建一个按周
      重复系列：首项由 DTSTART/DTEND 确定，每项起止同时后移 7 个营业地
      日历日（时刻与跨日长度不变），仅为未排除项生成成员，超出 0001-9999
      年整批拒绝。EXDATE 沿用浮动时间及参数限制，可多行、逗号列表、集合
      去重，只能匹配某一发生的原开始时间（时刻须一致）；无 RRULE 却有
      EXDATE 或全部发生被排除均整批拒绝。
      单次改期例外：同一 UID 允许一个不带 RECURRENCE-ID 的按周主事件配
      若干例外 VEVENT（主事件须随文件提交，例外在文件中的位置不限），
      其余重复 UID 拒绝。例外须有恰好一个 RECURRENCE-ID（浮动时间、秒
      00、年份 0001-9999，禁止 RANGE 参数与逗号列表）及自身 DTSTART/
      DTEND（同一套浮动时间参数限制，可改时间与时长），不得带 RRULE 或
      EXDATE；RECURRENCE-ID 匹配主事件展开后未排除的某个原开始（时刻须
      一致），同一原发生不得重复。例外仍属该系列、使用命令行资源，不额外
      生成成员——展开并排除后以例外目标替换该次发生，被替换原时段不参与
      覆盖或冲突校验；新目标统一校验实际可用覆盖与共同资源左闭右开冲突。
      UID 在同一数据文件中永久关联首次请求（独立事件关联其预约；重复事件
      关联其系列、各原发生时间、对应成员及按原发生关联的例外起止集合），
      身份不依赖文件路径；相同 UID 的重复与否、首项时间、COUNT、排除集合、
      例外集合或资源集合改变均整批拒绝（部件与排除值的顺序、例外书写顺序、
      资源顺序不算变化），一致则为重放：按原发生顺序显示系列、原发生、
      成员标识、当前时间、资源与状态（含首次请求例外目标），不做任何改动
      （成员本地改期、单独/整体取消或随批量改期撤销也不覆盖、不复活、不补员）。
      文件可混合独立与重复事件、多个系列、新项与重放，仅新目标校验开放覆盖
      与批内外冲突（重放成员按当前有效安排占用），受阻按主事件/独立事件的
      文件顺序及原发生顺序报告全部 UID、原发生、目标时间、不足资源、相关停用、
      全部冲突与共同资源，批内双方互列；全部为重放时不写文件、不推进计数；
      新系列、成员与导入身份（含例外快照）一次原子保存后才成功。
      文件示例:
        BEGIN:VCALENDAR
        VERSION:2.0
        BEGIN:VEVENT
        UID:meeting-001@example.com
        DTSTART:20261012T100000
        DTEND:20261012T110000
        END:VEVENT
        BEGIN:VEVENT
        UID:weekly-review@example.com
        DTSTART:20261006T100000
        DTEND:20261006T110000
        RRULE:FREQ=WEEKLY;COUNT=4
        EXDATE:20261013T100000
        END:VEVENT
        BEGIN:VEVENT
        UID:weekly-review@example.com
        RECURRENCE-ID:20261020T100000
        DTSTART:20261021T140000
        DTEND:20261021T150000
        END:VEVENT
        END:VCALENDAR

导出命令（已导入按周重复系列的本地 iCalendar 导出，只读）:
  export-ical <已解码 UID> --output <iCalendar 输出文件>
      按导入时解码后的 UID（区分大小写）选择一个已导入的按周重复系列，把保存
      本地变更（成员改期、换资源、单独取消、整体取消、批量改期安全撤销等）后的
      当前安排导出到本地 UTF-8 iCalendar 文件。未知 UID 或 UID 关联的是独立事件
      （而非按周系列）均拒绝；输出路径与数据文件、写入保护（<数据文件>.lock）或
      恢复协调文件等价（含符号链接）时拒绝。
      输出 VERSION:2.0 的 VCALENDAR（含 PRODID，各 VEVENT 含 UID 与合法 UTC 的
      DTSTAMP，CRLF、标准 75 字节折行，文本转义反斜杠、分号、逗号与换行）：
      主事件在前，保留首次 UID、首项 DTSTART/DTEND（浮动 YYYYMMDDTHHmmss，秒
      00，年份 0001-9999，时刻与跨日规则同导入）与 RRULE:FREQ=WEEKLY;COUNT=n；
      EXDATE 为首次排除集合与已取消成员原开始时间的去重并集（按原发生排序）。
      有效成员相对“原周展开”的起止时间或完整资源集合有变化时，输出同 UID 的
      例外 VEVENT：RECURRENCE-ID 固定为该成员原开始，DTSTART/DTEND 取当前值；
      无变化不输出例外；首次导入带来的例外也按当前安排重新比较，不复制首次
      例外快照；取消成员不输出例外。主事件 DESCRIPTION 为首次资源集合，例外
      DESCRIPTION 为当前完整资源集合，均逐行列出资源标识、名称与类型并按标识
      排序。全部成员取消时仍生成合法且无有效发生的日历。例外与排除值按原发生
      顺序排列。本命令只读一份完整数据快照：不等待或改动写入保护、不修改业务
      数据、身份、历史或计数，原 UID 重放规则不变；旧记录无例外字段仍可导出。
      输出先写临时文件再原子替换，完整替换成功后才退出 0，报告有效成员、排除
      与例外数量；读写失败退出 1 且原输出文件保持不变（原本不存在时不留半成品），
      业务文件始终不变。
      示例:
        node app.ts export-ical weekly-review@example.com --output ./weekly.ics

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

弹性批量改期清单（reschedule-flex 的 JSON 文件，UTF-8，顶层 {"items": [...]}）:
  清单非空且有顺序；每项字段：
    "bookingId": 要改期的预约标识（如 B0001）；未知、在清单中重复或已取消
                 均整单拒绝；普通预约、系列成员、导入预约与候补兑现预约可
                 混合提交，不要求同时提交整个系列
    "window":    目标窗口 "YYYY-MM-DDTHH:mm/YYYY-MM-DDTHH:mm"（0001-9999 年，
                 真实有效、结束晚于开始、允许跨日、与机器时区无关），长度不得
                 小于预约当前时长；时长保持预约当前长度
    "groups":    有顺序的候选资源组数组（如 [["R0001","R0002"],["R0003"]]）；
                 至少一组、每组非空，组内重复或未知资源整单拒绝；资源可跨组、
                 跨项出现
  求解整单最终安排：排除本批旧占用，其余有效预约按现状阻挡（取消记录与未
  兑现候补不阻挡）；开放合并重叠或相接后扣除有效停用；每项完整落窗，各组
  恰选一个且所选互异，全部所选资源同时连续可用、全程固定；仅共同资源的
  左闭右开时间重叠冲突，端点相接可行。取舍：先最小化变化预约数量（起止
  时间或完整资源集合不同才算变化，资源顺序不计），数量相同再按清单顺序
  逐项先比开始分钟、再按组序比资源标识字符串，取字典序最小完整方案
  （候选书写顺序不影响结果）。只改本批时间与资源：标识、状态、系列归属、
  导入身份与首次请求、候补原请求及兑现关联全部保留，不新建预约、不自动
  处理候补。至少一项有变化时生成稳定且不复用的批量改期操作标识（O0001…），
  记录全部提交项的前后完整安排、系列归属及清单顺序，与改期同次原子保存，
  仅推进操作计数；无变化成功但不写文件、不建记录、不推进计数。记录可用
  list-batch-ops 查询、undo-batch-op <操作标识> 整笔安全撤销；每次提交按
  当前状态求解，撤销后重提产生变化分配新的操作标识。无整体解、清单不可读、
  损坏或内容非法均整单失败（退出码 1），不改动任何预约、不推进计数。
  清单示例:
    {
      "items": [
        {"bookingId": "B0001", "window": "2026-10-12T08:00/2026-10-12T18:00", "groups": [["R0001", "R0002"], ["R0003"]]},
        {"bookingId": "B0002", "window": "2026-10-12T09:00/2026-10-12T12:00", "groups": [["R0001"]]}
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

并发写入保护:
  所有修改入口以同一数据文件为单位互斥：先取得写入保护（锁文件
  <数据文件>.lock），再读取最新数据、校验、分配标识并原子保存，命令结束
  统一释放（正常结束、校验失败、保存失败均释放）。相对路径、绝对路径与
  含 ./.. 的等价写法共享同一把锁；不同数据文件互不影响；数据文件尚不存在
  时也受保护。竞争可等待，5 秒内未取得保护即以退出码 1 报告占用（可重试，
  失败不产生记录、不消耗标识）。查询命令不等待保护，只读到提交前或提交后
  的完整快照；帮助与用法错误不依赖保护。
  recover-lock
      本地恢复入口：进程异常退出可能留下残留保护（锁文件），导致修改入口
      一直报告占用。本命令仅在确认原写入进程已退出时解除残留保护；进程仍
      存活或无法确认时明确拒绝，不按保护存在时长抢占。恢复入口之间以恢复
      协调文件互斥，在互斥内重新核对目标后才删除：多个恢复请求交错时只
      解除已确认原持有者退出的那次保护，绝不误删新写入者已取得的保护；
      发现目标更替（锁已易主或已消失）以退出码 1 说明原因或按无操作处理，
      不宣称解除新保护。恢复者异常退出留下的残留协调文件，由后续恢复
      入口在确认其持有者退出后自动清理，无需人工删文件。不重放旧命令，
      不改业务数据或标识计数；没有残留保护时明确提示且不改动。

退出码:
  0  成功
  1  业务或文件失败（名称为空、未知/重复资源或预约、需求组为空或含未知/
     组内重复候选、已取消预约、时间非法、
     开放不足、冲突、非法次数、超出四位年份、未知系列、未知候补、取消已兑现
     候补、候补标识非法、停用区间与有效预约重叠、未知停用、停用标识非法、
     改期清单不可读/损坏/内容非法、预约清单不可读/损坏/内容非法（含项间
     关系序号越界或非整数、自指、重复有向关系、有向环、间隔非法）或整单无
     可行方案、弹性批量改期清单不可读/损坏/内容非法或整单无可行方案、未知批量改期操作、撤销涉及预约与记录
     不一致或恢复安排受阻、iCalendar 文件不可读/结构非法（含重复规则或
     EXDATE 非法、无规则带 EXDATE、全部排除、展开超出四位年份）、UID 与
     首次导入不一致、新事件开放不足或冲突、数据文件损坏（含候补、停用、
     批量改期或导入记录结构、引用或快照非法）、保存失败、导出未知 UID 或
     选择了独立事件、导出输出路径与数据/保护/恢复协调文件等价或写出失败、
     数据文件被其他进程占用（5 秒内未取得写入保护）或恢复被拒绝（原写入进程
     存活或无法确认已退出）等）
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
  node app.ts reschedule-flex ./reschedule-flex.json
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
  node app.ts find-slot --window 2026-10-12T08:00/2026-10-12T18:00 \\
      --duration 60 --group R0001,R0002 --group R0003,R0004
  node app.ts schedule-flex ./flex-plan.json
  node app.ts usage-stats --window 2026-10-12T00:00/2026-10-14T00:00 \\
      --resource R0001 --resource R0002
  node app.ts add-closure --resource R0001 \\
      --start 2026-10-06T00:00 --end 2026-10-07T00:00
  node app.ts list-closures
  node app.ts cancel-closure C0001
  node app.ts import-ical ./events.ics --resource R0001 --resource R0002
  node app.ts export-ical weekly-review@example.com --output ./weekly.ics
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
  try {
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
      case 'reschedule-flex':
        await cmdRescheduleFlex(commandArgs);
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
      case 'find-slot':
        await cmdFindSlot(commandArgs);
        break;
      case 'schedule-flex':
        await cmdScheduleFlex(commandArgs);
        break;
      case 'usage-stats':
        await cmdUsageStats(commandArgs);
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
      case 'export-ical':
        await cmdExportIcal(commandArgs);
        break;
      case 'recover-lock':
        await cmdRecoverLock(commandArgs);
        break;
      default:
        throw new UsageError(`未知命令: ${command}`);
    }
  } finally {
    // 正常结束、校验失败与保存失败都走到这里：释放本次取得的写入保护
    await releaseWriteLock();
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
