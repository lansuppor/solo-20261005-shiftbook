// shiftbook 多进程写入保护自动化回归测试
//
// 运行：npm test（等价于 node --test test/... test/multi-process.test.ts）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 真实多进程并发：以 spawn 同时启动多个 node app.ts 进程制造竞争，
//   不以连续调用代替竞争；测试钩子 SHIFTBOOK_LOCK_HOLD_MS 让持有保护的
//   进程停留指定毫秒，保证竞争可重复出现；
// - 每个场景使用独立临时数据目录，最终安排与关联由新进程查询
//   （list-* 命令），并直接核对数据文件内容与各项标识计数；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL: Array<[string, string]> = [['2026-01-01T00:00', '2027-01-01T00:00']];
// 255 字节文件名：保存时临时文件（<名>.<pid>.tmp）必然超出文件名长度上限，
// 从而在不调整任何权限的前提下，可重复地触发真实保存失败。
// 保护文件此时改用散列命名，不受影响。
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

// 异步并发入口：真实并行启动多个进程制造竞争
function runCliAsync(
  dataFile: string,
  args: string[],
  opts: {cwd?: string; env?: Record<string, string>} = {},
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const cp = spawn(process.execPath, [APP, '--data', dataFile, ...args], {
      cwd: opts.cwd,
      env: {...process.env, ...opts.env},
    });
    let stdout = '';
    let stderr = '';
    cp.stdout.on('data', (d) => (stdout += d));
    cp.stderr.on('data', (d) => (stderr += d));
    cp.on('error', reject);
    cp.on('close', (code) => resolvePromise({status: code ?? -1, stdout, stderr}));
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-mp-test-'));
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

function lockFilesIn(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.lock'));
}

function assertNoLeftoverLock(dir: string, ctx: string): void {
  assert.deepEqual(lockFilesIn(dir), [], `[${ctx}] 不应残留写入保护文件`);
}

// 等待条件成立（轮询），超时抛出带场景信息的错误
async function waitFor(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// 终止子进程并等待其真正退出（recover-lock 依赖“原进程已退出”的准确判断）
function killAndWait(cp: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    cp.once('exit', () => resolvePromise());
    cp.kill('SIGKILL');
  });
}

// ---------------------------------------------------------------------------
// 1. 等价路径竞争 + 可并存写入：相对/绝对/含 .. 的路径共享同一保护；
//    三个可并存的并发预约分别成功，全部保留且标识不重复
// ---------------------------------------------------------------------------

test('等价路径竞争：相对/绝对/含..路径共享保护，可并存并发写入全部保留', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003
  mkdirSync(join(dir, 'sub'));

  // 三个进程以同一数据文件的三种等价写法同时进入；不同资源同一时段，可并存。
  // 测试钩子让每个持有者停留片刻，保证保护确实发生竞争与等待。
  const env = {SHIFTBOOK_LOCK_HOLD_MS: '150'};
  const mkArgs = (rid: string) => [
    'create-booking',
    '--resource',
    rid,
    '--start',
    '2026-10-12T10:00',
    '--end',
    '2026-10-12T11:00',
  ];
  const [r1, r2, r3] = await Promise.all([
    runCliAsync(df, mkArgs('R0001'), {env}), // 绝对路径
    runCliAsync('./data.json', mkArgs('R0002'), {cwd: dir, env}), // 相对 + ./
    runCliAsync('../data.json', mkArgs('R0003'), {cwd: join(dir, 'sub'), env}), // 含 ..
  ]);
  for (const [i, r] of [r1, r2, r3].entries()) {
    assert.equal(r.status, 0, `第 ${i + 1} 个并发进程应成功\nstderr:\n${r.stderr}`);
  }

  // 直接核对文件：三项预约都保留、标识不重复、计数与记录一致
  const store = readStore(df);
  assert.equal(store.bookings.length, 3, '三个可并存请求都应保留');
  assert.deepEqual(
    store.bookings.map((b: any) => b.id).sort(),
    ['B0001', 'B0002', 'B0003'],
    '标识不重复且连续',
  );
  assert.equal(store.bookingSeq, 3, '预约计数与记录一致');
  // 标识按取得保护的先后分配，与进程不固定对应；三项预约的资源集合须互不重复
  assert.deepEqual(
    store.bookings.map((b: any) => b.resourceIds[0]).sort(),
    ['R0001', 'R0002', 'R0003'],
    '三个进程的预约都保留',
  );
  for (const b of store.bookings) assert.equal(b.status, 'active');

  // 由新进程查询最终安排
  const q = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程查询最终安排');
  for (const id of ['B0001', 'B0002', 'B0003']) {
    assert.ok(q.stdout.includes(id), `查询应包含 ${id}`);
  }
  assertNoLeftoverLock(dir, '等价路径竞争');
});

// ---------------------------------------------------------------------------
// 2. 同资源冲突：共同资源重叠的两个并发预约最多一个成功；
//    另一个重试时按最新占用报告冲突；失败不产生记录、不消耗标识
// ---------------------------------------------------------------------------

test('同资源冲突：两个重叠预约最多一个成功，重试按最新占用报告冲突', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  const args = [
    'create-booking',
    '--resource',
    'R0001',
    '--start',
    '2026-10-12T10:00',
    '--end',
    '2026-10-12T11:00',
  ];
  const env = {SHIFTBOOK_LOCK_HOLD_MS: '200'};
  const [ra, rb] = await Promise.all([runCliAsync(df, args, {env}), runCliAsync(df, args, {env})]);

  const winners = [ra, rb].filter((r) => r.status === 0);
  const losers = [ra, rb].filter((r) => r.status === 1);
  assert.equal(winners.length, 1, `应恰好一个成功\nA: ${ra.status}\nB: ${rb.status}`);
  assert.equal(losers.length, 1, '应恰好一个因冲突失败');
  assert.match(losers[0].stderr, /冲突/, '失败者按最新占用报告冲突');
  assert.match(losers[0].stderr, /B0001/, '冲突报告列出已成功保存的预约');

  // 重试失败者：仍按最新占用报告冲突（不是占用超时、不是脏读）
  const retry = bizFail(df, args, '冲突后重试');
  assert.match(retry.stderr, /冲突/);
  assert.match(retry.stderr, /B0001/);

  // 竞争失败不产生本次记录、不消耗标识，也不回退成功者的提交
  let store = readStore(df);
  assert.equal(store.bookings.length, 1, '只保留成功者的预约');
  assert.equal(store.bookings[0].id, 'B0001');
  assert.equal(store.bookingSeq, 1, '失败未消耗标识');

  // 不重叠的后续写入成功，标识连续（证明失败者没有消耗 B0002）
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'],
    '冲突后的正常写入',
  );
  store = readStore(df);
  assert.deepEqual(
    store.bookings.map((b: any) => b.id).sort(),
    ['B0001', 'B0002'],
    '标识连续不跳号',
  );
  assert.equal(store.bookingSeq, 2);
  assertNoLeftoverLock(dir, '同资源冲突');
});

// ---------------------------------------------------------------------------
// 3. 同时处理候补：并发 process-waitlist 不重复创建预约，
//    候补兑现关联完整保留
// ---------------------------------------------------------------------------

test('同时处理候补：并发 process-waitlist 不重复兑现', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  ok(
    df,
    ['add-waitlist', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    '登记候补 W0001',
  );

  const env = {SHIFTBOOK_LOCK_HOLD_MS: '200'};
  const [ra, rb] = await Promise.all([
    runCliAsync(df, ['process-waitlist'], {env}),
    runCliAsync(df, ['process-waitlist'], {env}),
  ]);
  // 先到者兑现候补；后到者按最新状态判断（无等待项），同样成功且不改动
  assert.equal(ra.status, 0, `第一个 process-waitlist 应成功\n${ra.stderr}`);
  assert.equal(rb.status, 0, `第二个 process-waitlist 应成功\n${rb.stderr}`);

  // 候补只兑现一次：恰好一项新预约、一个兑现关联、计数只推进一次
  const store = readStore(df);
  assert.equal(store.bookings.length, 1, '候补兑现不能重复创建预约');
  assert.equal(store.bookings[0].id, 'B0001');
  assert.equal(store.bookingSeq, 1, '预约计数只推进一次');
  assert.equal(store.waitlist.length, 1);
  assert.equal(store.waitlist[0].id, 'W0001');
  assert.equal(store.waitlist[0].status, 'fulfilled');
  assert.equal(store.waitlist[0].bookingId, 'B0001', '兑现关联完整保留');
  assert.equal(store.waitlistSeq, 1);

  // 由新进程查询关联；再次处理不重复创建
  const q = ok(df, ['list-waitlist'], '新进程查询候补关联');
  assert.match(q.stdout, /W0001 \[已兑现\]/);
  assert.match(q.stdout, /B0001/);
  ok(df, ['process-waitlist'], '再次处理（无等待项）');
  const store2 = readStore(df);
  assert.equal(store2.bookings.length, 1, '重复处理不再创建预约');
  assert.equal(store2.bookingSeq, 1);
  assertNoLeftoverLock(dir, '同时处理候补');
});

// ---------------------------------------------------------------------------
// 4. 保存失败释放保护：失败后可继续写入（不因残留保护误报占用），
//    原数据与计数不变
// ---------------------------------------------------------------------------

test('保存失败释放保护：失败后同一文件可继续进入写入流程', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001

  // 同一数据放到保存必然失败的位置（文件名 255 字节，保存临时文件名超限；
  // 保护文件改用散列命名，取得保护不受影响）
  const origBytes = readFileSync(df);
  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, origBytes);
  const args = [
    'create-booking',
    '--resource',
    'R0001',
    '--start',
    '2026-10-12T10:00',
    '--end',
    '2026-10-12T11:00',
  ];

  const r1 = bizFail(longFile, args, '保存失败');
  assert.match(r1.stderr, /保存数据文件/, '应报告保存失败');
  assert.deepEqual(readFileSync(longFile), origBytes, '保存失败原文件逐字节保留');

  // 保护已随失败释放：同一文件立即再次进入写入流程，
  // 仍因保存失败退出 1，而不是误报“正被占用”
  const r2 = bizFail(longFile, args, '保存失败后继续写入');
  assert.match(r2.stderr, /保存数据文件/, '应再次走到保存并失败');
  assert.ok(!r2.stderr.includes('正被其他进程占用'), '不得误报占用（保护已释放）');

  // 无残留保护；数据与计数未被失败尝试改动
  assertNoLeftoverLock(dir, '保存失败');
  const store = readStore(longFile);
  assert.equal(store.bookings.length, 0, '保存失败不产生记录');
  assert.equal(store.bookingSeq, 0, '保存失败不消耗标识');

  // 同一数据在可保存位置写入成功，标识从 1 开始
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, origBytes);
  ok(retryFile, args, '可保存位置重试');
  const store2 = readStore(retryFile);
  assert.equal(store2.bookings.length, 1);
  assert.equal(store2.bookings[0].id, 'B0001', '失败尝试未消耗标识');
  assert.equal(store2.bookingSeq, 1);
});

// ---------------------------------------------------------------------------
// 5. 占用超时、活跃保护不可恢复、持有者终止后恢复并继续写入
// ---------------------------------------------------------------------------

test('占用超时退出 1；活跃保护拒绝恢复；持有者终止后恢复并继续写入', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const lockPath = `${df}.lock`;

  // 用一个存活的“持有者”进程占位：保护文件记录其进程号
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  t.after(() => {
    try {
      holder.kill('SIGKILL');
    } catch {
      // 已退出：忽略
    }
  });
  assert.ok(holder.pid, '持有者应已启动');
  writeFileSync(
    lockPath,
    JSON.stringify({pid: holder.pid, token: 'manual-token', dataFile: df}) + '\n',
  );

  // (a) 竞争可等待，但 5 秒内未取得保护即以退出码 1 说明占用；失败可重试
  const t0 = Date.now();
  const busy = bizFail(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    '占用超时',
  );
  const waited = Date.now() - t0;
  assert.match(busy.stderr, /正被其他进程占用/, '应说明文件正被占用');
  assert.ok(waited >= 4900 && waited < 8000, `应等待约 5 秒后放弃，实际 ${waited}ms`);
  assert.ok(existsSync(lockPath), '占用失败不得解除他人保护');

  // (b) 持有者仍存活：恢复入口明确拒绝，不按保护存在时长抢占
  const refuse = bizFail(df, ['recover-lock'], '活跃保护拒绝恢复');
  assert.match(refuse.stderr, /仍存活/, '应说明持有者仍存活');
  assert.match(refuse.stderr, /拒绝解除/);
  assert.ok(existsSync(lockPath), '拒绝后保护仍在');

  // (c) 持有者终止后：恢复成功，随后写入成功；占用失败未消耗标识
  await killAndWait(holder);
  ok(df, ['recover-lock'], '持有者终止后恢复');
  assert.ok(!existsSync(lockPath), '残留保护已解除');
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    '恢复后写入',
  );
  const store = readStore(df);
  assert.equal(store.bookings.length, 1);
  assert.equal(store.bookings[0].id, 'B0001', '占用失败未消耗标识');
  assert.equal(store.bookingSeq, 1);
  assertNoLeftoverLock(dir, '占用与恢复');
});

// ---------------------------------------------------------------------------
// 6. 进程异常终止：数据保持提交前的完整快照，查询不等待保护，
//    recover-lock 解除应用自身留下的残留保护后可继续写入
// ---------------------------------------------------------------------------

test('进程异常终止：完整快照保留，活跃保护不可恢复，终止后可恢复并继续写入', async (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  const lockPath = `${df}.lock`;
  const bytesBefore = readFileSync(df);

  // 子进程取得保护后长时间停留（测试钩子），模拟写入中途被异常终止
  const child = spawn(
    process.execPath,
    [
      APP,
      '--data',
      df,
      'create-booking',
      '--resource',
      'R0001',
      '--start',
      '2026-10-12T10:00',
      '--end',
      '2026-10-12T11:00',
    ],
    {env: {...process.env, SHIFTBOOK_LOCK_HOLD_MS: '30000'}},
  );
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出：忽略
    }
  });
  await waitFor(() => existsSync(lockPath), 5000, '子进程取得保护');

  // 查询不等待写入保护：保护被持有期间立即读到完整快照
  const q = ok(df, ['list-resources'], '保护期间查询不等待');
  assert.match(q.stdout, /R0001/);

  // 持有者（应用进程自身）仍存活：恢复被拒绝
  const refuse = bizFail(df, ['recover-lock'], '活跃保护拒绝恢复');
  assert.match(refuse.stderr, /仍存活/);
  assert.ok(existsSync(lockPath), '拒绝后保护仍在');

  // 异常终止持有者：数据只能是提交前或提交后的完整快照（此处为提交前）
  await killAndWait(child);
  const rawAfter = readFileSync(df, 'utf8');
  assert.equal(rawAfter, bytesBefore.toString('utf8'), '数据保持提交前的完整快照');
  const snap = JSON.parse(rawAfter); // 完整合法 JSON
  assert.equal(snap.bookings.length, 0, '未提交不产生记录');
  assert.equal(snap.bookingSeq, 0, '未提交不推进计数');
  assert.ok(existsSync(lockPath), '异常终止留下残留保护');

  // 恢复：确认原写入进程已退出后解除残留保护；不重放旧命令、不改业务数据或计数
  ok(df, ['recover-lock'], '终止后恢复');
  assert.ok(!existsSync(lockPath), '残留保护已解除');
  assert.equal(readFileSync(df, 'utf8'), rawAfter, '恢复不改动业务数据');

  // 恢复后写入成功；被终止进程未消耗标识
  ok(
    df,
    ['create-booking', '--resource', 'R0001', '--start', '2026-10-12T10:00', '--end', '2026-10-12T11:00'],
    '恢复后写入',
  );
  const store = readStore(df);
  assert.equal(store.bookings.length, 1);
  assert.equal(store.bookings[0].id, 'B0001', '被终止进程未消耗标识');
  assert.equal(store.bookingSeq, 1);
  const q2 = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程查询最终安排');
  assert.match(q2.stdout, /B0001 \[已预约\] 2026-10-12T10:00 → 2026-10-12T11:00/);
  assertNoLeftoverLock(dir, '异常终止恢复');
});
