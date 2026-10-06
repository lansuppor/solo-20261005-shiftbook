// shiftbook 多进程写入保护自动化回归测试
//
// 运行：npm test（等价于 node --test test/write-lock.test.ts 及其余测试文件）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 并发场景由真实并行子进程竞争同一数据文件（不以连续调用代替竞争）；
// - 交接场景（取得/释放/恢复）用真实子进程加明确同步点（SHIFTBOOK_TEST_SYNC_DIR
//   测试钩子）控制交错时序，并真正终止持有保护的业务进程与协调中的恢复进程
//   （不以构造已退出 PID 或随机延时代替）；
// - 每个场景使用独立临时数据目录，最终安排与关联由新进程查询并核对文件与计数；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync} from 'node:fs';
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

// 可中途终止的真实子进程：返回句柄与结果 Promise；env 用于注入测试同步点目录
// （SHIFTBOOK_TEST_SYNC_DIR，应用内测试钩子在指定交接点写 ready 标记并等待 go 标记）
function spawnCli(
  dataFile: string,
  args: string[],
  env?: Record<string, string>,
): {child: ChildProcess; result: Promise<CliResult>} {
  const child = spawn(process.execPath, [APP, '--data', dataFile, ...args], {
    encoding: 'utf8',
    env: {...process.env, ...env},
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const result = new Promise<CliResult>((resolveP, reject) => {
    child.on('error', reject);
    child.on('close', (status) => resolveP({status: status ?? -1, stdout, stderr}));
  });
  return {child, result};
}

// 明确同步点：等待子进程在交接点写下的 ready 标记出现（非随机延时）
async function waitForSyncPoint(path: string, ctx: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待同步点超时: ${ctx}（${path}）`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// 真正终止子进程（SIGKILL）并等待其退出；进程结束时来不及执行任何释放逻辑
function killAndWait(child: ChildProcess): Promise<void> {
  return new Promise((resolveP) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveP();
    child.once('close', () => resolveP());
    child.kill('SIGKILL');
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

// 与应用一致的恢复协调文件路径：<锁文件>.recover
function recoveryPathOf(df: string, cwd?: string): string {
  return `${lockPathOf(df, cwd)}.recover`;
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
    (n) => n.endsWith('.lock') || n.endsWith('.recover') || n.startsWith('.shiftbook-'),
  );
}

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
// 10. 正常释放交接：释放只解除本次取得的保护，等待者随后取得并提交
// ---------------------------------------------------------------------------

test('正常释放交接：释放只作用于本次取得的保护，等待中的写入者随后取得并提交', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const sync1 = join(dir, 'sync1');
  const sync2 = join(dir, 'sync2');
  mkdirSync(sync1);
  mkdirSync(sync2);

  // W1 取得保护后停在同步点（真实持锁的修改进程）
  const w1 = spawnCli(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: sync1},
  );
  t.after(() => {
    w1.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(sync1, 'write-lock-acquired.ready'), 'W1 取得保护');

  // W2 真实并行竞争同一数据文件：在 W1 持锁期间等待
  const w2 = spawnCli(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: sync2},
  );
  t.after(() => {
    w2.child.kill('SIGKILL');
  });

  // W1 正常结束：提交并释放本次保护；W2 随后取得保护并停在自己的同步点
  writeFileSync(join(sync1, 'write-lock-acquired.go'), 'go');
  const r1 = await w1.result;
  assert.equal(r1.status, 0, `[释放交接] W1 应成功\nstderr:\n${r1.stderr}`);
  await waitForSyncPoint(join(sync2, 'write-lock-acquired.ready'), 'W2 取得保护');
  // W1 的释放没有误删 W2 取得的保护：锁文件内容属于 W2
  const held = JSON.parse(readFileSync(lockPathOf(df), 'utf8'));
  assert.equal(held.pid, w2.child.pid, 'W1 释放后保护应属于 W2（释放只删除自己取得的那份）');

  // W2 继续提交成功，两项预约都保留
  writeFileSync(join(sync2, 'write-lock-acquired.go'), 'go');
  const r2 = await w2.result;
  assert.equal(r2.status, 0, `[释放交接] W2 应成功\nstderr:\n${r2.stderr}`);
  const store = readStore(df);
  assert.equal(store.bookings.length, 2, '两次提交都保留');
  assert.equal(store.bookingSeq, 2, '预约计数与记录一致');
  // 由新进程查询最终安排
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '释放交接后按日查询');
  assert.match(day.stdout, /共 2 条/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁或协调文件');
});

// ---------------------------------------------------------------------------
// 11. 恢复交接竞态：两个恢复请求与新写入者交错，恢复只解除确认的那次保护
// ---------------------------------------------------------------------------

test('恢复交接：交错的两个恢复与新写入者，恢复不误删新保护，第三写入者不能越过', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], '预约 B0001');
  const bytesBefore = readFileSync(df);
  const lockPath = lockPathOf(df);
  const recoveryPath = recoveryPathOf(df);

  // 真实业务修改进程 W0 取得保护后被真正终止（非构造的已退出 PID）→ 残留保护
  const sync0 = join(dir, 'sync0');
  mkdirSync(sync0);
  const w0 = spawnCli(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: sync0},
  );
  t.after(() => {
    w0.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(sync0, 'write-lock-acquired.ready'), 'W0 取得保护');
  await killAndWait(w0.child);
  assert.ok(existsSync(lockPath), 'W0 被终止后留下残留保护');
  assert.ok(bytesBefore.equals(readFileSync(df)), 'W0 被终止时数据保持提交前的完整快照');

  // 恢复 R1：确认 W0 退出、持有恢复互斥后，在删除前停在同步点
  const syncR1 = join(dir, 'syncR1');
  mkdirSync(syncR1);
  const r1 = spawnCli(df, ['recover-lock'], {SHIFTBOOK_TEST_SYNC_DIR: syncR1});
  t.after(() => {
    r1.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(syncR1, 'recover-before-unlock.ready'), 'R1 删除前同步点');
  assert.ok(existsSync(recoveryPath), 'R1 持有恢复协调文件');

  // 交错的恢复 R2：恢复互斥被占用 → 退出 1，锁与协调文件都保持
  const r2 = runCli(df, ['recover-lock']);
  assert.equal(r2.status, 1, `[恢复交错] R2 不应重复解除\nstdout:\n${r2.stdout}`);
  assert.match(r2.stderr, /另一恢复进程/);
  assert.ok(existsSync(lockPath), 'R2 不得删除残留保护');
  assert.ok(existsSync(recoveryPath), 'R2 不得删除他人的恢复协调文件');

  // R1 继续：解除 W0 的残留保护并正常释放恢复互斥
  writeFileSync(join(syncR1, 'recover-before-unlock.go'), 'go');
  const r1r = await r1.result;
  assert.equal(r1r.status, 0, `[恢复交接] R1 应成功\nstderr:\n${r1r.stderr}`);
  assert.match(r1r.stdout, /已解除/);
  assert.ok(!existsSync(lockPath), 'R1 解除了确认的那次残留保护');
  assert.ok(!existsSync(recoveryPath), 'R1 正常结束释放恢复互斥');
  assert.ok(bytesBefore.equals(readFileSync(df)), '恢复不改业务数据');

  // 新写入者 W1 取得保护（停在同步点持锁）
  const syncW1 = join(dir, 'syncW1');
  mkdirSync(syncW1);
  const w1 = spawnCli(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: syncW1},
  );
  t.after(() => {
    w1.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(syncW1, 'write-lock-acquired.ready'), 'W1 取得新保护');
  const held = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(held.pid, w1.child.pid, '新保护属于 W1');

  // 较早的恢复请求不得删除新保护：发现目标更替（新写入者存活）→ 退出 1 说明原因
  const r3 = runCli(df, ['recover-lock']);
  assert.equal(r3.status, 1, `[目标更替] 新写入者存活时恢复应拒绝\nstdout:\n${r3.stdout}`);
  assert.match(r3.stderr, /拒绝解除/);
  assert.ok(existsSync(lockPath), '新写入者的保护不得被误删');
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')).pid, w1.child.pid, '新保护仍属于 W1');

  // 第三写入者不能越过新保护：5 秒内未取得即失败，不产生记录、不消耗标识
  const w3 = runCli(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T11:00', '--end', '2026-10-12T12:00',
  ]);
  assert.equal(w3.status, 1, `[第三写入者] 不应越过新保护\nstdout:\n${w3.stdout}`);
  assert.match(w3.stderr, /正被其他进程占用/);

  // W1 继续提交：已保存预约不丢失，第三写入者未留下任何记录
  writeFileSync(join(syncW1, 'write-lock-acquired.go'), 'go');
  const w1r = await w1.result;
  assert.equal(w1r.status, 0, `[恢复后继续提交] W1 应成功\nstderr:\n${w1r.stderr}`);
  const store = readStore(df);
  assert.equal(store.bookings.length, 2, 'B0001 与 W1 的预约都保留');
  assert.equal(store.bookingSeq, 2, '被终止的 W0 与被阻挡的 W3 都未消耗标识');
  // 由新进程查询最终安排并核对
  const day = ok(df, ['list-bookings', '--date', '2026-10-12'], '恢复交接后按日查询');
  assert.match(day.stdout, /共 2 条/);
  assert.match(day.stdout, /B0001 \[已预约\] 2026-10-12T09:00 → 2026-10-12T10:00/);
  assert.match(day.stdout, /B0002 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁或协调文件');
});

// ---------------------------------------------------------------------------
// 12. 真正终止协调中的恢复进程：残留协调文件由后续恢复安全清理
// ---------------------------------------------------------------------------

test('恢复者异常退出：残留协调文件由后续恢复入口确认退出后清理，无需人工删文件', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(df, ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T10:00'], '预约 B0001');
  const bytesBefore = readFileSync(df);
  const lockPath = lockPathOf(df);
  const recoveryPath = recoveryPathOf(df);

  // 真实业务修改进程持锁后被真正终止 → 残留保护
  const sync0 = join(dir, 'sync0');
  mkdirSync(sync0);
  const w0 = spawnCli(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    {SHIFTBOOK_TEST_SYNC_DIR: sync0},
  );
  t.after(() => {
    w0.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(sync0, 'write-lock-acquired.ready'), 'W0 取得保护');
  await killAndWait(w0.child);
  assert.ok(existsSync(lockPath), 'W0 被终止后留下残留保护');

  // 恢复 R1 持有恢复互斥、在删除前被真正终止 → 残留协调文件与残留保护都留下
  const syncR1 = join(dir, 'syncR1');
  mkdirSync(syncR1);
  const r1 = spawnCli(df, ['recover-lock'], {SHIFTBOOK_TEST_SYNC_DIR: syncR1});
  t.after(() => {
    r1.child.kill('SIGKILL');
  });
  await waitForSyncPoint(join(syncR1, 'recover-before-unlock.ready'), 'R1 删除前同步点');
  // R1 存活持有互斥时，另一恢复请求退出 1 且不动任何文件
  const rx = runCli(df, ['recover-lock']);
  assert.equal(rx.status, 1, `[恢复者存活] 另一恢复不应重复解除\nstdout:\n${rx.stdout}`);
  assert.match(rx.stderr, /另一恢复进程/);
  await killAndWait(r1.child);
  assert.ok(existsSync(lockPath), 'R1 被终止后残留保护仍在');
  assert.ok(existsSync(recoveryPath), 'R1 被终止后残留协调文件仍在');

  // 后续恢复入口：确认 R1 已退出后自动清理残留协调文件并完成恢复
  const r2 = runCli(df, ['recover-lock']);
  assert.equal(r2.status, 0, `[清理残留协调] 后续恢复应成功\nstderr:\n${r2.stderr}`);
  assert.match(r2.stdout, /已解除/);
  assert.ok(!existsSync(lockPath), '残留保护已解除');
  assert.ok(!existsSync(recoveryPath), '残留协调文件已清理');
  assert.ok(bytesBefore.equals(readFileSync(df)), '恢复不改业务数据与计数');

  // 恢复后写入立即可用，数据为完整快照
  const ok2 = await runCliAsync(df, [
    'create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00',
  ]);
  assert.equal(ok2.status, 0, `[清理后继续写入] 应成功\nstderr:\n${ok2.stderr}`);
  const store = readStore(df);
  assert.equal(store.bookings.length, 2);
  assert.equal(store.bookingSeq, 2);
  assert.deepEqual(leftoverLocks(dir), [], '不残留锁或协调文件');
});
