// shiftbook 多进程写入保护自动化回归测试
//
// 运行：npm test（等价于 node --test test/write-lock.test.ts 及其余测试文件）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 并发场景由真实并行子进程竞争同一数据文件（不以连续调用代替竞争）；
// - 交接场景用真实子进程加明确同步点（环境变量 SHIFTBOOK_TEST_SYNC_DIR 下的
//   ready/go 标记文件）控制两个恢复请求与新写入者交错，并真正终止（SIGKILL）
//   持有保护的业务进程与协调中的恢复进程，不靠随机延时、不只构造已退出 PID；
// - 每个场景使用独立临时数据目录，最终安排与关联由新进程查询并核对文件与计数；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  renameSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import {tmpdir, hostname} from 'node:os';
import {join, dirname, basename, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件（<名>.<pid>.tmp）必然超出文件名长度上限，
// 从而在不调整任何权限的前提下，可重复地触发真实保存失败。
const LONG_NAME = 'f'.repeat(250) + '.json';

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

// 异步并发入口：真实并行子进程竞争同一数据文件
function runCliAsync(dataFile: string, args: string[], cwd?: string): Promise<CliResult> {
  return new Promise((resolveP, reject) => {
    const p = spawn(process.execPath, [APP, '--data', dataFile, ...args], {encoding: 'utf8', cwd});
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (status) => resolveP({status: status ?? -1, stdout, stderr}));
  });
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

function tempDir(t: {after: (fn: () => void) => void}): string {
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-lock-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(df: string, name: string, open: Array<[string, string]> = OPEN_ALL): void {
  const args = ['add-resource', '--type', 'venue', '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

// 与应用一致的锁文件路径：规范路径（解析相对/./..与符号链接）+ .lock
function lockPathOf(df: string, cwd?: string): string {
  const abs = resolve(cwd ?? process.cwd(), df);
  let canonical: string;
  try {
    canonical = realpathSync(abs);
  } catch {
    canonical = join(realpathSync(dirname(abs)), basename(abs));
  }
  return `${canonical}.lock`;
}

// 用一个真实存活进程持有指定数据文件的写入保护；release 结束该进程并等待其退出
function holdLock(df: string, t: {after: (fn: () => void) => void}, cwd?: string): {
  child: ChildProcess;
  lockPath: string;
  release: () => Promise<void>;
} {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
  const lockPath = lockPathOf(df, cwd);
  const info = {
    pid: child.pid,
    host: hostname(),
    dataFile: resolve(cwd ?? process.cwd(), df),
    acquiredAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(info) + '\n', {encoding: 'utf8', flag: 'wx'});
  let released = false;
  const release = (): Promise<void> => {
    if (released) return Promise.resolve();
    released = true;
    return new Promise((resolveP) => {
      child.once('close', () => resolveP());
      try {
        child.kill('SIGKILL');
      } catch {
        resolveP();
      }
    });
  };
  t.after(() => {
    void release();
    rmSync(lockPath, {force: true});
  });
  return {child, lockPath, release};
}

// 一个已经退出的进程标识（用于构造残留保护）
function deadPid(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const child = spawn(process.execPath, ['-e', ''], {stdio: 'ignore'});
    child.on('error', reject);
    child.on('close', () => resolveP(child.pid!));
  });
}

function leftoverLocks(dir: string): string[] {
  return readdirSync(dir).filter(
    (n) => n.endsWith('.lock') || n.startsWith('.shiftbook-') || n.includes('.recover-'),
  );
}

// ---------------------------------------------------------------------------
// 交接同步点基础设施：真实子进程在明确同步点暂停/放行（不靠随机延时）
// ---------------------------------------------------------------------------

interface SyncedChild {
  child: ChildProcess;
  pid: number;
  result: Promise<CliResult>;
}

// 以同步钩子启动真实子进程（修改或恢复命令）：子进程在写入保护交接的关键点
// 写出 <点名>-ready-<pid> 并等待 <点名>-go-<pid> 出现后放行
function spawnSynced(df: string, args: string[], syncDir: string): SyncedChild {
  const child = spawn(process.execPath, [APP, '--data', df, ...args], {
    env: {...process.env, SHIFTBOOK_TEST_SYNC_DIR: syncDir},
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const result = new Promise<CliResult>((resolveP, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolveP({status: status ?? -1, stdout, stderr}));
  });
  return {child, pid: child.pid!, result};
}

function makeSyncDir(dir: string): string {
  const d = join(dir, 'sync');
  mkdirSync(d);
  return d;
}

// 明确同步点：等待子进程在关键点写出 ready 标记
async function waitReady(syncDir: string, name: string, pid: number): Promise<void> {
  const file = join(syncDir, `${name}-ready-${pid}`);
  const deadline = Date.now() + 30000;
  for (;;) {
    if (existsSync(file)) return;
    if (Date.now() >= deadline) throw new Error(`等待同步点 ${name}-ready-${pid} 超时`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// 放行子进程越过该同步点
function signalGo(syncDir: string, name: string, pid: number): void {
  writeFileSync(join(syncDir, `${name}-go-${pid}`), 'go\n');
}

// 放行业务子进程一路跑到结束（取得保护后与保存完成后的同步点都预先放行；
// go 标记只是存在性检查，提前写出不影响同步语义）
function releaseToCompletion(syncDir: string, pid: number): void {
  signalGo(syncDir, 'lock-acquired', pid);
  signalGo(syncDir, 'store-saved', pid);
}

// 真正终止（SIGKILL）子进程并等待其退出
async function killAndWait(c: SyncedChild): Promise<CliResult> {
  c.child.kill('SIGKILL');
  return c.result;
}

const bookArgs = (start: string, end: string): string[] => [
  'create-booking', '--resource', 'R0001', '--start', start, '--end', end,
];

// ---------------------------------------------------------------------------
// 1. 等价路径共享同一把锁；不同数据文件互不阻挡；文件不存在也受保护
// ---------------------------------------------------------------------------

test('等价路径竞争：相对/绝对/含 ./.. 的写法共享保护；不同文件互不影响；不存在的文件也受保护', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const missing = join(dir, 'missing.json'); // 尚不存在的数据文件
  const hold1 = holdLock(df, t);
  const hold2 = holdLock(missing, t);

  const book = ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'];
  const addRes = ['add-resource', '--type', 'venue', '--name', '丙', '--open', '2026-01-01T00:00/2027-01-01T00:00'];
  // 同一数据文件的五种等价写法 + 不存在的文件 + 另一个不受阻挡的数据文件，同时竞争
  const [rAbs, rDot, rDotDot, rRel, rRelDot, rMissing, rOther] = await Promise.all([
    runCliAsync(df, book), // 绝对路径
    runCliAsync(join(dir, '.', 'data.json'), book), // 含 .
    runCliAsync(join(dir, '..', basename(dir), 'data.json'), book), // 含 ..
    runCliAsync('data.json', book, dir), // 相对路径（cwd=数据目录）
    runCliAsync('./data.json', book, dir), // 相对路径含 ./
    runCliAsync(missing, addRes), // 文件尚不存在也受保护
    runCliAsync(join(dir, 'other.json'), addRes), // 不同数据文件互不阻挡
  ]);

  for (const [name, r] of [
    ['绝对路径', rAbs],
    ['含 . 路径', rDot],
    ['含 .. 路径', rDotDot],
    ['相对路径', rRel],
    ['相对含 ./ 路径', rRelDot],
    ['不存在的文件', rMissing],
  ] as const) {
    assert.equal(r.status, 1, `[等价路径竞争] ${name} 应退出 1\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /正被其他进程占用/, `[等价路径竞争] ${name} 应报告占用`);
  }
  assert.equal(readStore(df).bookings.length, 0, '竞争失败不产生记录');
  assert.equal(readStore(df).bookingSeq, 0, '竞争失败不消耗标识');
  assert.ok(!existsSync(missing), '竞争失败不为不存在的文件产生数据文件');
  assert.equal(rOther.status, 0, `[不同数据文件] 不应被阻挡\nstderr:\n${rOther.stderr}`);

  // 活跃保护不可恢复（详见专门场景）；此处释放后等价路径立即可写
  await hold1.release();
  await hold2.release();
  rmSync(hold1.lockPath, {force: true});
  rmSync(hold2.lockPath, {force: true});
  const r3 = await runCliAsync(join(dir, '.', 'data.json'), book);
  assert.equal(r3.status, 0, `[等价路径竞争] 释放后含 . 路径应可写\nstderr:\n${r3.stderr}`);
  assert.equal(readStore(df).bookings.length, 1, '释放后写入保留');
  assert.deepEqual(leftoverLocks(dir), [], '写入完成后不残留锁文件');
});

// ---------------------------------------------------------------------------
// 2. 可并存的并发写入：分别成功、全部保留、标识不重复
// ---------------------------------------------------------------------------

test('并发可并存写入：全部成功保留且标识不重复', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  const N = 6;
  const results = await Promise.all(
    Array.from({length: N}, (_, i) =>
      runCliAsync(df, [
        'create-booking',
        '--resource',
        i % 2 === 0 ? 'R0001' : 'R0002',
        '--start',
        `2026-10-12T0${i}:00`,
        '--end',
        `2026-10-12T0${i}:30`,
      ]),
    ),
  );
  results.forEach((r, i) => {
    assert.equal(r.status, 0, `[可并存写入] 第 ${i + 1} 个请求应成功\nstderr:\n${r.stderr}`);
  });

  const store = readStore(df);
  assert.equal(store.bookings.length, N, '全部并存请求都须保留');
  assert.equal(new Set(store.bookings.map((b: any) => b.id)).size, N, '标识不重复');
  assert.equal(store.bookingSeq, N, '预约计数与记录一致');
  // 由新进程查询最终安排
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '并发后按日查询');
  assert.match(day.stdout, /共 6 条/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 3. 同资源冲突：最多一个成功；重试按最新占用报告冲突；失败不消耗标识
// ---------------------------------------------------------------------------

test('并发同资源冲突：最多一个成功，重试按最新占用报冲突，失败不消耗标识', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const book = ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'];
  const N = 6;
  const results = await Promise.all(Array.from({length: N}, () => runCliAsync(df, book)));
  const oks = results.filter((r) => r.status === 0);
  const fails = results.filter((r) => r.status === 1);
  assert.equal(oks.length, 1, `[同资源冲突] 应恰好一个成功\n${results.map((r) => r.stderr).join('\n')}`);
  assert.equal(fails.length, N - 1, '其余应失败');
  for (const f of fails) assert.match(f.stderr, /冲突/, '失败应按最新占用报告冲突');

  let store = readStore(df);
  assert.equal(store.bookings.length, 1, '只保留成功的一项');
  assert.equal(store.bookingSeq, 1, '竞争失败不消耗标识');

  // 重试仍按最新占用报告冲突（指明已保存的 B0001）
  const retry = await runCliAsync(df, book);
  assert.equal(retry.status, 1, '重试仍失败');
  assert.match(retry.stderr, /B0001/, '重试按最新占用报告冲突预约');

  // 不冲突的写入继续成功，标识连续
  const ok2 = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00',
  ]);
  assert.equal(ok2.status, 0, `[失败后继续写入] 应成功\nstderr:\n${ok2.stderr}`);
  store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookingSeq, 2);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 4. 并发处理候补：兑现不重复创建预约
// ---------------------------------------------------------------------------

test('并发处理候补：同一候补只兑现一次，不重复创建预约', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'], '登记候补 W0001');

  const results = await Promise.all(Array.from({length: 4}, () => runCliAsync(df, ['process-waitlist'])));
  results.forEach((r, i) => {
    assert.equal(r.status, 0, `[并发候补] 第 ${i + 1} 次处理应成功\nstderr:\n${r.stderr}`);
  });

  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '兑现不能重复创建预约');
  assert.equal(store.bookingSeq, 1, '预约计数与记录一致');
  assert.equal(store.waitlist.length, 1);
  assert.equal(store.waitlist[0].status, 'fulfilled', '候补已兑现');
  assert.equal(store.waitlist[0].bookingId, 'B0001', '兑现关联唯一预约');

  // 由新进程查询：候补关联与预约一致
  const list = ok(df, ['list-waitlist'], '并发后查询候补');
  assert.match(list.stdout, /W0001 \[已兑现\]/);
  assert.match(list.stdout, /兑现预约: B0001/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 5. 并发导入同一 iCalendar 文件：一个新增、其余重放，身份与计数完整
// ---------------------------------------------------------------------------

test('并发导入：相同 UID 只新增一次，其余按最新状态判为重放', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const ics = join(dir, 'events.ics');
  writeFileSync(
    ics,
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:meeting-001@example.com',
      'DTSTART:20261012T100000',
      'DTEND:20261012T110000',
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n'),
  );

  const args = ['import-ical', ics, '--resource', 'R0001'];
  const results = await Promise.all(Array.from({length: 3}, () => runCliAsync(df, args)));
  results.forEach((r, i) => {
    assert.equal(r.status, 0, `[并发导入] 第 ${i + 1} 次导入应成功\nstderr:\n${r.stderr}`);
  });

  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '同一 UID 只创建一项预约');
  assert.equal(store.bookingSeq, 1, '预约计数与记录一致');
  assert.equal(store.imports.length, 1, '导入身份只建一次');
  assert.equal(store.imports[0].uid, 'meeting-001@example.com');
  assert.equal(store.imports[0].bookingId, 'B0001', '导入身份关联首次预约');

  // 再次导入为全重放：不写文件、不推进计数
  const before = readFileSync(df);
  const replay = ok(df, args, '全重放导入');
  assert.match(replay.stdout, /全部为重放/);
  assert.ok(before.equals(readFileSync(df)), '全重放不写数据文件');
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 6. 并发重复撤销：一次生效、其余幂等，快照与计数完整保留
// ---------------------------------------------------------------------------

test('并发重复撤销：只撤销一次，其余按最新状态幂等成功', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], '预约 B0001');
  const manifest = join(dir, 'reschedule.json');
  writeFileSync(
    manifest,
    JSON.stringify({items: [{bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']}]}) + '\n',
  );
  ok(df, ['reschedule-batch', manifest], '批量改期 O0001');

  const results = await Promise.all(Array.from({length: 3}, () => runCliAsync(df, ['undo-batch-op', 'O0001'])));
  results.forEach((r, i) => {
    assert.equal(r.status, 0, `[并发撤销] 第 ${i + 1} 次撤销应成功\nstderr:\n${r.stderr}`);
  });

  const store = readStore(df);
  assert.equal(store.batchOps.length, 1, '不新增撤销记录');
  assert.equal(store.batchOps[0].status, 'undone', '记录已撤销');
  assert.equal(store.batchSeq, 1, '撤销不推进操作计数');
  const b = store.bookings.find((x: any) => x.id === 'B0001');
  assert.equal(b.start, '2026-10-12T09:00', '恢复改期前安排');
  assert.equal(b.end, '2026-10-12T10:00');
  assert.deepEqual(b.resourceIds, ['R0001']);
  // 批量操作快照完整保留
  assert.equal(store.batchOps[0].items[0].after.start, '2026-10-12T14:00');
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 7. 失败后继续写入：校验失败与保存失败均释放保护，后续写入不受影响
// ---------------------------------------------------------------------------

test('失败后继续写入：校验失败与保存失败都释放保护且不消耗标识', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], '预约 B0001');

  // 校验失败（冲突）：退出 1，保护释放，随后写入成功
  const conflict = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:30', '--end', '2026-10-12T10:30',
  ]);
  assert.equal(conflict.status, 1, '冲突应失败');
  assert.match(conflict.stderr, /冲突/);
  const ok2 = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00',
  ]);
  assert.equal(ok2.status, 0, `[校验失败后继续写入] 应成功\nstderr:\n${ok2.stderr}`);
  let store = readStore(df);
  assert.equal(store.bookings.length, 2, '失败不产生记录');
  assert.equal(store.bookingSeq, 2, '失败不消耗标识');

  // 保存失败（文件名 255 字节，临时文件名超限）：退出 1，原文件逐字节保留，
  // 保护释放（重试仍失败于保存而非占用）
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, readFileSync(df));
  const origBytes = readFileSync(longFile);
  const saveArgs = ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'];
  const r1 = await runCliAsync(longFile, saveArgs);
  assert.equal(r1.status, 1, '保存失败应退出 1');
  assert.match(r1.stderr, /保存数据文件/, '应报告保存失败');
  assert.ok(origBytes.equals(readFileSync(longFile)), '保存失败逐字节保留原文件');
  assert.deepEqual(leftoverLocks(dir), [], '保存失败后不残留锁文件');
  const r2 = await runCliAsync(longFile, saveArgs);
  assert.equal(r2.status, 1, '重试仍失败');
  assert.match(r2.stderr, /保存数据文件/, '重试仍失败于保存（保护可再次取得），而非占用');
  assert.ok(origBytes.equals(readFileSync(longFile)), '重试后原文件仍逐字节保留');
});

// ---------------------------------------------------------------------------
// 8. 恢复入口：活跃保护不可恢复；查询/帮助/用法错误不依赖保护；
//    进程终止后可恢复且不改业务数据；无残留与无法辨认均明确处理
// ---------------------------------------------------------------------------

test('恢复入口：活跃保护拒绝解除，进程退出后可恢复，恢复不改业务数据', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], '预约 B0001');
  const bytesBefore = readFileSync(df);

  // 活跃保护：recover-lock 明确拒绝，保护不被误删
  const hold = holdLock(df, t);
  const r1 = await runCliAsync(df, ['recover-lock']);
  assert.equal(r1.status, 1, '活跃保护应拒绝恢复');
  assert.match(r1.stderr, /拒绝解除/);
  assert.match(r1.stderr, /仍在运行|运行中的进程/);
  assert.ok(existsSync(hold.lockPath), '活跃保护不得被误删');

  // 查询、帮助与用法错误不依赖保护
  const q = await runCliAsync(df, ['list-bookings', '--date', '2026-10-12']);
  assert.equal(q.status, 0, `[查询不等待保护] 应成功\nstderr:\n${q.stderr}`);
  assert.match(q.stdout, /B0001 \[已预约\]/);
  const h = await runCliAsync(df, ['--help']);
  assert.equal(h.status, 0, '帮助不依赖保护');
  const u = await runCliAsync(df, ['bogus-command']);
  assert.equal(u.status, 2, '用法错误不依赖保护');

  // 原写入进程退出后：recover-lock 解除残留保护，不改业务数据与计数
  await hold.release();
  const r2 = await runCliAsync(df, ['recover-lock']);
  assert.equal(r2.status, 0, `[进程退出后恢复] 应成功\nstderr:\n${r2.stderr}`);
  assert.match(r2.stdout, /已解除/);
  assert.ok(!existsSync(hold.lockPath), '残留保护已解除');
  assert.ok(bytesBefore.equals(readFileSync(df)), '恢复不改业务数据');
  let store = readStore(df);
  assert.equal(store.bookingSeq, 1, '恢复不改标识计数');
  assert.equal(store.bookings.length, 1, '恢复不重放旧命令');

  // 恢复后写入立即可用
  const ok2 = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00',
  ]);
  assert.equal(ok2.status, 0, `[恢复后继续写入] 应成功\nstderr:\n${ok2.stderr}`);
  store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookingSeq, 2);

  // 没有残留保护：明确提示且不改动
  const r3 = await runCliAsync(df, ['recover-lock']);
  assert.equal(r3.status, 0, '无残留保护时恢复为无操作');
  assert.match(r3.stdout, /没有残留写入保护/);

  // 锁内容无法辨认：无法确认原写入进程，明确拒绝
  const garbage = join(dir, 'garbage.json');
  writeFileSync(lockPathOf(garbage), '这不是合法的锁文件内容');
  const r4 = await runCliAsync(garbage, ['recover-lock']);
  assert.equal(r4.status, 1, '无法辨认的保护应拒绝恢复');
  assert.match(r4.stderr, /无法确认原写入进程/);
  assert.deepEqual(leftoverLocks(dir).filter((n) => !n.startsWith('garbage')), [], '不残留其他锁文件');
});

// ---------------------------------------------------------------------------
// 9. 进程终止后的恢复：异常退出留下的残留保护可解除，数据保持完整快照
// ---------------------------------------------------------------------------

test('进程终止后的恢复：残留保护可解除，数据为提交前或提交后的完整快照', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const bytesBefore = readFileSync(df);

  // 模拟异常退出：以已退出进程的标识留下残留保护（进程终止时未来得及释放）
  const pid = await deadPid();
  const lockPath = lockPathOf(df);
  writeFileSync(
    lockPath,
    JSON.stringify({pid, host: hostname(), dataFile: resolve(df), acquiredAt: new Date().toISOString()}) + '\n',
  );

  // 修改入口报告占用（等待 5 秒上限）；数据仍是完整快照
  const busy = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00',
  ]);
  assert.equal(busy.status, 1, '残留保护下修改入口应报告占用');
  assert.match(busy.stderr, /正被其他进程占用/);
  assert.match(busy.stderr, /recover-lock/);
  assert.ok(bytesBefore.equals(readFileSync(df)), '数据保持提交前的完整快照');

  // 确认原写入进程已退出：恢复成功，随后写入正常
  const rec = await runCliAsync(df, ['recover-lock']);
  assert.equal(rec.status, 0, `[终止后恢复] 应成功\nstderr:\n${rec.stderr}`);
  assert.match(rec.stdout, /已确认退出/);
  assert.ok(bytesBefore.equals(readFileSync(df)), '恢复不改业务数据');
  const ok2 = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00',
  ]);
  assert.equal(ok2.status, 0, `[恢复后写入] 应成功\nstderr:\n${ok2.stderr}`);
  const store = readStore(df);
  assert.equal(store.bookings.length, 1);
  assert.equal(store.bookingSeq, 1);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 10. 恢复交接竞态：两个恢复请求与新写入者交错——较早的恢复不得删除新写入者
//     的保护，目标更替退出 1，第三写入者不能越过新保护
// ---------------------------------------------------------------------------

test('恢复交接竞态：较早恢复不删除新保护，目标更替退出 1，第三写入者不能越过', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), '预约 B0001');
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // 真实的残留保护：业务修改进程取得保护后被真正终止（非构造已退出 PID）
  const victim = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', victim.pid);
  await killAndWait(victim);
  assert.ok(existsSync(lockPath), '被终止进程应留下残留保护');
  const staleText = readFileSync(lockPath, 'utf8');

  // 两个恢复请求都先确认同一份残留保护（停在认领前）
  const recA = spawnSynced(df, ['recover-lock'], sync);
  const recB = spawnSynced(df, ['recover-lock'], sync);
  await waitReady(sync, 'recover-validated', recA.pid);
  await waitReady(sync, 'recover-validated', recB.pid);

  // A 先认领：确认过的保护被原子改名到 A 的交接文件，原路径腾空
  signalGo(sync, 'recover-validated', recA.pid);
  await waitReady(sync, 'recover-claimed', recA.pid);
  assert.ok(!existsSync(lockPath), '认领后原路径腾空');
  assert.ok(existsSync(`${lockPath}.recover-${recA.pid}`), 'A 的交接文件存在');

  // 交接进行中，第三个恢复请求明确拒绝而不打扰
  const recC = await runCliAsync(df, ['recover-lock']);
  assert.equal(recC.status, 1, '交接进行中其他恢复应拒绝');
  assert.match(recC.stderr, /正在交接/);

  // 新写入者取得保护（停在取得后、提交前）
  const writer = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', writer.pid);
  const newLockText = readFileSync(lockPath, 'utf8');
  assert.notEqual(newLockText, staleText, '新写入者取得了新的保护');

  // B 现在继续：确认过的旧保护已被 A 解除，原路径已是新写入者的保护 ->
  // B 认领到的与先前确认的不一致（目标更替）：放回原位、退出 1，不删除新保护
  signalGo(sync, 'recover-validated', recB.pid);
  signalGo(sync, 'recover-claimed', recB.pid);
  const rB = await recB.result;
  assert.equal(rB.status, 1, `[目标更替] 较早恢复应退出 1\nstdout:\n${rB.stdout}`);
  assert.match(rB.stderr, /更替/);
  assert.match(rB.stderr, /放回原位/);
  assert.doesNotMatch(rB.stdout + rB.stderr, /已解除/, '不得宣称解除了新保护');
  assert.equal(readFileSync(lockPath, 'utf8'), newLockText, 'B 不得删除新写入者的保护');

  // 第三写入者不能越过新写入者持有的保护
  const third = await runCliAsync(df, bookArgs('2026-10-12T11:00', '2026-10-12T12:00'));
  assert.equal(third.status, 1, '第三写入者应报告占用');
  assert.match(third.stderr, /正被其他进程占用/);

  // A 继续：只删除自己认领的那一份，新写入者的保护保持有效
  signalGo(sync, 'recover-claimed', recA.pid);
  const rA = await recA.result;
  assert.equal(rA.status, 0, `[A 完成恢复] 应成功\nstderr:\n${rA.stderr}`);
  assert.match(rA.stdout, /已解除/);
  assert.ok(!existsSync(`${lockPath}.recover-${recA.pid}`), 'A 的交接文件已删除');
  assert.equal(readFileSync(lockPath, 'utf8'), newLockText, 'A 不得删除新写入者的保护');

  // 新写入者继续提交并正常释放；已保存预约不丢失，随后写入立即可用
  releaseToCompletion(sync, writer.pid);
  const rW = await writer.result;
  assert.equal(rW.status, 0, `[新写入者提交] 应成功\nstderr:\n${rW.stderr}`);
  assert.match(rW.stdout, /已创建预约 B0002/);
  const ok3 = ok(df, bookArgs('2026-10-12T11:00', '2026-10-12T12:00'), '交接后继续写入');
  assert.match(ok3.stdout, /已创建预约 B0003/);

  const store = readStore(df);
  assert.equal(store.bookings.length, 3, '已保存预约不丢失');
  assert.equal(store.bookingSeq, 3, '预约计数与记录一致');
  // 由新进程查询最终安排
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '交接后按日查询');
  assert.match(day.stdout, /共 3 条/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁或交接文件');
});

// ---------------------------------------------------------------------------
// 11. 正常释放交接：等待者依次取得保护；释放只作用于本次取得的那一份
// ---------------------------------------------------------------------------

test('正常释放交接：等待者依次取得；释放不删除他人后来取得的保护', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // W1 持锁暂停，W2 排队等待；W1 放行后保存并释放，W2 随即取得并完成
  const w1 = spawnSynced(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), sync);
  await waitReady(sync, 'lock-acquired', w1.pid);
  const w2 = runCliAsync(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'));
  releaseToCompletion(sync, w1.pid);
  const r1 = await w1.result;
  assert.equal(r1.status, 0, `[W1 提交] 应成功\nstderr:\n${r1.stderr}`);
  const r2 = await w2;
  assert.equal(r2.status, 0, `[W2 交接后提交] 应成功\nstderr:\n${r2.stderr}`);
  let store = readStore(df);
  assert.equal(store.bookings.length, 2, '正常交接后两次提交都保留');
  assert.equal(store.bookingSeq, 2);

  // 释放守卫：W3 持锁暂停期间其保护被外力移除，W4 取得新保护；
  // W3 结束时的释放只针对本次取得的那一份，不得删除 W4 的保护
  const w3 = spawnSynced(df, bookArgs('2026-10-12T11:00', '2026-10-12T12:00'), sync);
  await waitReady(sync, 'lock-acquired', w3.pid);
  rmSync(lockPath, {force: true}); // 外力移除（如人工清理残留）
  const w4 = spawnSynced(df, bookArgs('2026-10-12T12:00', '2026-10-12T13:00'), sync);
  await waitReady(sync, 'lock-acquired', w4.pid);
  const w4LockText = readFileSync(lockPath, 'utf8');
  releaseToCompletion(sync, w3.pid);
  const r3 = await w3.result;
  assert.equal(r3.status, 0, `[W3 提交] 应成功\nstderr:\n${r3.stderr}`);
  assert.equal(readFileSync(lockPath, 'utf8'), w4LockText, 'W3 的释放不得删除 W4 取得的保护');
  releaseToCompletion(sync, w4.pid);
  const r4 = await w4.result;
  assert.equal(r4.status, 0, `[W4 提交] 应成功\nstderr:\n${r4.stderr}`);
  store = readStore(df);
  assert.equal(store.bookings.length, 4, '全部提交保留');
  assert.equal(store.bookingSeq, 4);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 12. 真实终止：持有保护的业务进程与交接中的恢复进程被真正终止后——
//     活跃拒绝、退出可恢复、提交前后均为完整快照、交接残留无需人工删文件
// ---------------------------------------------------------------------------

test('真实终止：活跃保护拒绝恢复，终止后可恢复；交接中断的残留由恢复入口安全清理', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), '预约 B0001');
  const bytesBefore = readFileSync(df);
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // 业务修改进程真实持有保护（存活）：恢复明确拒绝，保护不被误删
  const holder = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', holder.pid);
  const rRefuse = await runCliAsync(df, ['recover-lock']);
  assert.equal(rRefuse.status, 1, '活跃保护应拒绝恢复');
  assert.match(rRefuse.stderr, /拒绝解除/);
  assert.match(rRefuse.stderr, /运行中的进程/);
  assert.ok(existsSync(lockPath), '活跃保护不得被误删');

  // 真正终止持有进程（提交前）：残留保护可恢复，数据为提交前完整快照
  await killAndWait(holder);
  const rRec1 = await runCliAsync(df, ['recover-lock']);
  assert.equal(rRec1.status, 0, `[终止后恢复] 应成功\nstderr:\n${rRec1.stderr}`);
  assert.match(rRec1.stdout, /已确认退出/);
  assert.ok(!existsSync(lockPath), '残留保护已解除');
  assert.ok(bytesBefore.equals(readFileSync(df)), '数据为提交前的完整快照');
  assert.equal(readStore(df).bookingSeq, 1, '恢复不改标识计数');

  // 业务进程在保存完成后、释放前被真正终止：数据为提交后的完整快照
  const committer = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', committer.pid);
  signalGo(sync, 'lock-acquired', committer.pid);
  await waitReady(sync, 'store-saved', committer.pid);
  await killAndWait(committer);
  assert.ok(existsSync(lockPath), '终止于提交后释放前：残留保护仍在');
  let store = readStore(df);
  assert.equal(store.bookings.length, 2, '数据为提交后的完整快照（B0002 已保存）');
  assert.equal(store.bookingSeq, 2);
  const rRec2 = await runCliAsync(df, ['recover-lock']);
  assert.equal(rRec2.status, 0, `[提交后终止的恢复] 应成功\nstderr:\n${rRec2.stderr}`);
  store = readStore(df);
  assert.equal(store.bookings.length, 2, '恢复不改业务数据');
  assert.equal(store.bookingSeq, 2, '恢复不改标识计数');

  // 恢复进程在交接中途被真正终止：留下交接文件
  const victim = spawnSynced(df, bookArgs('2026-10-12T11:00', '2026-10-12T12:00'), sync);
  await waitReady(sync, 'lock-acquired', victim.pid);
  await killAndWait(victim); // 制造新的残留保护
  const recoverer = spawnSynced(df, ['recover-lock'], sync);
  await waitReady(sync, 'recover-validated', recoverer.pid);
  signalGo(sync, 'recover-validated', recoverer.pid);
  await waitReady(sync, 'recover-claimed', recoverer.pid);
  await killAndWait(recoverer); // 交接中断：认领后未删除
  assert.ok(!existsSync(lockPath), '认领后原路径腾空');
  assert.ok(existsSync(`${lockPath}.recover-${recoverer.pid}`), '交接中断留下交接文件');

  // 无需人工删文件：恢复入口安全清理已确认失去持有者的交接状态
  const rClean = await runCliAsync(df, ['recover-lock']);
  assert.equal(rClean.status, 0, `[交接清理] 应成功\nstderr:\n${rClean.stderr}`);
  assert.match(rClean.stdout, /已清理/);
  assert.deepEqual(leftoverLocks(dir), [], '交接文件与残留保护均已清理');
  store = readStore(df);
  assert.equal(store.bookings.length, 2, '清理交接不改业务数据');
  assert.equal(store.bookingSeq, 2, '清理交接不改标识计数');

  // 清理后写入立即可用
  const ok2 = ok(df, bookArgs('2026-10-12T11:00', '2026-10-12T12:00'), '清理后继续写入');
  assert.match(ok2.stdout, /已创建预约 B0003/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 13. 认领核对：确认过的保护在认领前被更替时，认领到的他人保护放回原位，
//     退出 1 且不删除任何保护
// ---------------------------------------------------------------------------

test('恢复认领核对：目标在认领前被更替时认领到的保护放回原位', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // 真实的残留保护（业务进程取得保护后被真正终止）
  const victim = spawnSynced(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), sync);
  await waitReady(sync, 'lock-acquired', victim.pid);
  await killAndWait(victim);

  // 恢复 A 确认残留保护后停在认领前
  const recA = spawnSynced(df, ['recover-lock'], sync);
  await waitReady(sync, 'recover-validated', recA.pid);

  // 另一恢复抢先完成解除；新写入者随即取得保护并暂停
  const rB = await runCliAsync(df, ['recover-lock']);
  assert.equal(rB.status, 0, `[另一恢复解除] 应成功\nstderr:\n${rB.stderr}`);
  const writer = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', writer.pid);
  const writerLockText = readFileSync(lockPath, 'utf8');

  // A 继续：认领（原子改名）到的是新写入者的保护，核对不一致 -> 放回原位、退出 1
  signalGo(sync, 'recover-validated', recA.pid);
  await waitReady(sync, 'recover-claimed', recA.pid);
  assert.ok(!existsSync(lockPath), 'A 认领后原路径暂时腾空');
  signalGo(sync, 'recover-claimed', recA.pid);
  const rA = await recA.result;
  assert.equal(rA.status, 1, '[认领核对不一致] 应退出 1');
  assert.match(rA.stderr, /更替/);
  assert.match(rA.stderr, /放回原位/);
  assert.equal(readFileSync(lockPath, 'utf8'), writerLockText, '新写入者的保护完好放回');
  assert.deepEqual(leftoverLocks(dir).filter((n) => n.includes('.recover-')), [], '不留交接文件');

  // 新写入者继续提交，不受干扰（放回的 inode 不变，其正常释放仍生效）
  releaseToCompletion(sync, writer.pid);
  const rW = await writer.result;
  assert.equal(rW.status, 0, `[新写入者提交] 应成功\nstderr:\n${rW.stderr}`);
  assert.equal(readStore(df).bookings.length, 1);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 14. 中断交接的清理：原持有者仍存活时把保护放回原位而非删除
// ---------------------------------------------------------------------------

test('中断交接清理：原持有者仍存活时保护放回原位，恢复随后拒绝解除', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // 业务进程真实持有保护（存活）
  const holder = spawnSynced(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), sync);
  await waitReady(sync, 'lock-acquired', holder.pid);
  const holderLockText = readFileSync(lockPath, 'utf8');

  // 模拟此前一次中断的交接：保护被改名到已退出恢复者的交接文件
  const dead = await deadPid();
  renameSync(lockPath, `${lockPath}.recover-${dead}`);
  assert.ok(!existsSync(lockPath));

  // 恢复入口：认领者已退出、原持有者仍存活 -> 把保护放回原位；
  // 随后主流程确认持有者存活 -> 拒绝解除（退出 1），保护不被误删
  const r = await runCliAsync(df, ['recover-lock']);
  assert.equal(r.status, 1, '原持有者存活时应拒绝解除');
  assert.match(r.stdout, /放回原位/);
  assert.match(r.stderr, /拒绝解除/);
  assert.equal(readFileSync(lockPath, 'utf8'), holderLockText, '保护已放回原位且内容不变');
  assert.deepEqual(leftoverLocks(dir).filter((n) => n.includes('.recover-')), [], '交接文件已清理');

  // 持有者继续提交并正常释放（inode 不变，释放仍作用于本次取得的保护）
  releaseToCompletion(sync, holder.pid);
  const rH = await holder.result;
  assert.equal(rH.status, 0, `[持有者提交] 应成功\nstderr:\n${rH.stderr}`);
  assert.equal(readStore(df).bookings.length, 1);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁文件');
});

// ---------------------------------------------------------------------------
// 15. 并发恢复同一份残留保护：恰好一个解除，其余幂等无操作（退出 0）
// ---------------------------------------------------------------------------

test('并发恢复同一份残留保护：一个解除，其余幂等无操作且不重复删除', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, bookArgs('2026-10-12T09:00', '2026-10-12T10:00'), '预约 B0001');
  const bytesBefore = readFileSync(df);
  const sync = makeSyncDir(dir);
  const lockPath = lockPathOf(df);

  // 真实的残留保护（业务进程取得保护后被真正终止）
  const victim = spawnSynced(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), sync);
  await waitReady(sync, 'lock-acquired', victim.pid);
  await killAndWait(victim);

  // 两个恢复请求都确认同一份残留保护后同时放行：原子认领保证恰好一个解除
  const recA = spawnSynced(df, ['recover-lock'], sync);
  const recB = spawnSynced(df, ['recover-lock'], sync);
  await waitReady(sync, 'recover-validated', recA.pid);
  await waitReady(sync, 'recover-validated', recB.pid);
  for (const pid of [recA.pid, recB.pid]) {
    signalGo(sync, 'recover-validated', pid);
    signalGo(sync, 'recover-claimed', pid);
  }
  const [rA, rB] = await Promise.all([recA.result, recB.result]);
  assert.equal(rA.status, 0, `[恢复 A] 应成功\nstderr:\n${rA.stderr}`);
  assert.equal(rB.status, 0, `[恢复 B] 应成功\nstderr:\n${rB.stderr}`);
  const outputs = [rA.stdout, rB.stdout];
  assert.equal(
    outputs.filter((s) => /已解除/.test(s)).length,
    1,
    `恰好一个恢复解除保护\nA:\n${rA.stdout}\nB:\n${rB.stdout}`,
  );
  assert.equal(
    outputs.filter((s) => /已被解除.*无需重复操作/.test(s)).length,
    1,
    `另一个幂等无操作\nA:\n${rA.stdout}\nB:\n${rB.stdout}`,
  );
  assert.ok(!existsSync(lockPath), '残留保护已解除');
  assert.ok(bytesBefore.equals(readFileSync(df)), '恢复不改业务数据');
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁或交接文件');

  // 恢复后写入立即可用
  const ok2 = ok(df, bookArgs('2026-10-12T10:00', '2026-10-12T11:00'), '恢复后继续写入');
  assert.match(ok2.stdout, /已创建预约 B0002/);
});
