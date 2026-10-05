// shiftbook 批量改期（reschedule-batch）与安全撤销（undo-batch-op）的自动化回归测试。
//
// 运行：npm test（等价于 node --test test/）
//
// 约定：
// - 全部场景经现有命令行入口操作：子进程执行 node app.ts --data <临时文件> <命令>；
// - 每个场景使用隔离临时目录与独立数据文件，保存结果一律由新进程（再次调用 CLI）
//   或重新读取数据文件核对；
// - 失败时 node --test 以非零退出并打印所在场景（测试名）；
// - 结束后清理全部临时文件；不读取用户默认数据文件、不依赖网络；
// - 输出断言只针对业务内容（标识、时间、状态等关键子串），不冻结整段输出措辞。

import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {chmod, mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'app.ts');
const OPEN_ALL = '2026-01-01T00:00/2027-01-01T00:00';

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

// 以新进程调用命令行入口；返回退出码与输出，绝不抛出
function runCli(cwd: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [APP, ...args], {cwd}, (err, stdout, stderr) => {
      const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
      resolve({code, stdout, stderr});
    });
  });
}

interface Env {
  dir: string;
  data: string;
  cli: (args: string[]) => Promise<CliResult>;
}

// 每个场景一个隔离临时目录；cwd 也在该目录内，默认数据文件绝不会被触碰
async function makeEnv(t: TestContext): Promise<Env> {
  const dir = await mkdtemp(join(tmpdir(), 'shiftbook-batch-test-'));
  t.after(async () => {
    await chmod(dir, 0o755).catch(() => {});
    await rm(dir, {recursive: true, force: true});
  });
  const data = join(dir, 'data.json');
  const cli = (args: string[]) => runCli(dir, ['--data', data, ...args]);
  return {dir, data, cli};
}

function mustOk(r: CliResult, what: string): void {
  assert.equal(r.code, 0, `${what} 应成功（退出码 0），实际退出码 ${r.code}\nstderr:\n${r.stderr}`);
}

function mustBizFail(r: CliResult, what: string): void {
  assert.equal(
    r.code,
    1,
    `${what} 应以退出码 1 失败，实际退出码 ${r.code}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
  );
}

function assertIncludes(text: string, needle: string, what: string): void {
  assert.ok(text.includes(needle), `${what}：输出中应包含 “${needle}”\n实际输出:\n${text}`);
}

async function readStore(env: Env): Promise<any> {
  return JSON.parse(await readFile(env.data, 'utf8'));
}

function bookingOf(store: any, id: string): any {
  const b = store.bookings.find((x: any) => x.id === id);
  assert.ok(b, `数据文件中应存在预约 ${id}`);
  return b;
}

async function addResource(env: Env, type: string, name: string): Promise<void> {
  mustOk(
    await env.cli(['add-resource', '--type', type, '--name', name, '--open', OPEN_ALL]),
    `登记资源 ${name}`,
  );
}

async function createBooking(env: Env, rid: string, start: string, end: string): Promise<void> {
  mustOk(
    await env.cli(['create-booking', '--resource', rid, '--start', start, '--end', end]),
    `创建预约 ${rid} ${start}`,
  );
}

async function writeManifest(env: Env, items: unknown[], name = 'manifest.json'): Promise<string> {
  const p = join(env.dir, name);
  await writeFile(p, JSON.stringify({items}, null, 2));
  return p;
}

// 把目录设为只读以制造可重复的真实保存失败；环境不支持（如 root）时返回 false
async function makeDirReadOnly(dir: string): Promise<boolean> {
  await chmod(dir, 0o555);
  try {
    await writeFile(join(dir, '.probe'), 'x');
    await rm(join(dir, '.probe'), {force: true});
    await chmod(dir, 0o755);
    return false;
  } catch {
    return true;
  }
}

async function assertNoTmpLeft(dir: string, what: string): Promise<void> {
  const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], `${what}：保存失败后不应残留临时文件`);
}

// ---------------------------------------------------------------------------
// 1. 混合提交成功：普通预约 + 不同系列成员 + 候补兑现预约（含一项未变化项），
//    互换时段、资源整体替换；操作记录保留全部提交项的前后安排与顺序
// ---------------------------------------------------------------------------
test('批量改期：普通/系列/候补混合提交（含未变化项）互换时段并整体替换资源', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await addResource(env, '设备', '投影仪'); // R0002
  await addResource(env, '人员', '张三'); // R0003
  await addResource(env, '场地', '二号厅'); // R0004

  // B0001 普通预约；S0001 = B0002/B0003；S0002 = B0004（不同系列成员）
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  mustOk(
    await env.cli([
      'create-series', '--resource', 'R0002',
      '--start', '2026-10-12T14:00', '--end', '2026-10-12T15:00', '--count', '2',
    ]),
    '创建系列 S0001',
  ); // B0002(10-12) B0003(10-19)
  mustOk(
    await env.cli([
      'create-series', '--resource', 'R0003',
      '--start', '2026-10-13T09:00', '--end', '2026-10-13T10:00', '--count', '1',
    ]),
    '创建系列 S0002',
  ); // B0004
  // 候补兑现预约 B0005（来自 W0001）
  mustOk(
    await env.cli(['add-waitlist', '--resource', 'R0004', '--start', '2026-10-14T10:00', '--end', '2026-10-14T11:00']),
    '登记候补 W0001',
  );
  mustOk(await env.cli(['process-waitlist']), '处理候补兑现 W0001'); // -> B0005
  // 仍在等待的候补 W0002：批量改期不得自动处理它
  mustOk(
    await env.cli(['add-waitlist', '--resource', 'R0001', '--start', '2026-10-16T10:00', '--end', '2026-10-16T11:00']),
    '登记候补 W0002',
  );
  // 无关预约 B0006：必须保持不变
  await createBooking(env, 'R0001', '2026-10-15T10:00', '2026-10-15T11:00'); // B0006

  const manifest = await writeManifest(env, [
    // B0001 与 B0002 互换时段与资源（逐项改期会被对方旧占用阻挡，整批可行）
    {bookingId: 'B0001', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0002']},
    {bookingId: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
    // 未变化项：时间与资源均与现状一致，仍应被记录
    {bookingId: 'B0004', start: '2026-10-13T09:00', end: '2026-10-13T10:00', resourceIds: ['R0003']},
    // 候补兑现预约：时间不变，资源集合整体替换
    {bookingId: 'B0005', start: '2026-10-14T10:00', end: '2026-10-14T11:00', resourceIds: ['R0002', 'R0004']},
  ]);

  const r = await env.cli(['reschedule-batch', manifest]);
  mustOk(r, '混合批量改期');
  assertIncludes(r.stdout, 'O0001', '成功输出应给出操作标识');
  assertIncludes(r.stdout, '第 1 项 B0001', '成功输出按清单顺序列出各项');
  assertIncludes(r.stdout, '第 4 项 B0005', '成功输出按清单顺序列出各项');

  // 由新进程核对保存结果：完整时间、资源、系列归属
  const store = await readStore(env);
  assert.equal(store.batchSeq, 1, '操作计数应推进到 1');
  assert.equal(store.bookingSeq, 6, '批量改期不得推进预约计数');
  assert.equal(store.seriesSeq, 2, '批量改期不得推进系列计数');
  assert.equal(store.waitlistSeq, 2, '批量改期不得推进候补计数');

  const b1 = bookingOf(store, 'B0001');
  assert.equal(b1.start, '2026-10-12T14:00');
  assert.equal(b1.end, '2026-10-12T15:00');
  assert.deepEqual(b1.resourceIds, ['R0002']);
  assert.equal(b1.seriesId, undefined, '普通预约不应有系列归属');

  const b2 = bookingOf(store, 'B0002');
  assert.equal(b2.start, '2026-10-12T10:00');
  assert.equal(b2.end, '2026-10-12T11:00');
  assert.deepEqual(b2.resourceIds, ['R0001']);
  assert.equal(b2.seriesId, 'S0001', '系列成员改期后仍属原系列');

  const b3 = bookingOf(store, 'B0003'); // 同系列未提交成员不受影响
  assert.equal(b3.start, '2026-10-19T14:00');
  assert.deepEqual(b3.resourceIds, ['R0002']);
  assert.equal(b3.seriesId, 'S0001');

  const b4 = bookingOf(store, 'B0004'); // 未变化项
  assert.equal(b4.start, '2026-10-13T09:00');
  assert.equal(b4.end, '2026-10-13T10:00');
  assert.deepEqual(b4.resourceIds, ['R0003']);
  assert.equal(b4.seriesId, 'S0002');

  const b5 = bookingOf(store, 'B0005'); // 候补兑现预约：资源整体替换
  assert.equal(b5.start, '2026-10-14T10:00');
  assert.equal(b5.end, '2026-10-14T11:00');
  assert.deepEqual(b5.resourceIds, ['R0002', 'R0004']);

  const b6 = bookingOf(store, 'B0006'); // 无关预约不变
  assert.equal(b6.start, '2026-10-15T10:00');
  assert.deepEqual(b6.resourceIds, ['R0001']);

  // 候补原请求与关联保留；等待中的候补未被自动处理
  const w1 = store.waitlist.find((w: any) => w.id === 'W0001');
  assert.equal(w1.status, 'fulfilled');
  assert.equal(w1.bookingId, 'B0005', '候补兑现关联不变');
  assert.equal(w1.start, '2026-10-14T10:00', '候补保留原请求时间');
  assert.equal(w1.end, '2026-10-14T11:00');
  assert.deepEqual(w1.resourceIds, ['R0004'], '候补保留原请求资源');
  const w2 = store.waitlist.find((w: any) => w.id === 'W0002');
  assert.equal(w2.status, 'waiting', '批量改期不得自动处理候补');
  assert.equal(w2.bookingId, undefined);

  // 操作记录：全部提交项（含未变化项）的前后安排与清单顺序
  assert.equal(store.batchOps.length, 1);
  const op = store.batchOps[0];
  assert.equal(op.id, 'O0001');
  assert.equal(op.status, 'active');
  assert.deepEqual(
    op.items.map((it: any) => it.bookingId),
    ['B0001', 'B0002', 'B0004', 'B0005'],
    '记录项顺序即清单顺序',
  );
  assert.deepEqual(op.items[0].before, {start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']});
  assert.deepEqual(op.items[0].after, {start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0002']});
  assert.equal(op.items[1].seriesId, 'S0001', '记录应保留提交时系列归属');
  assert.deepEqual(op.items[2].before, op.items[2].after, '未变化项前后安排一致');
  assert.equal(op.items[2].seriesId, 'S0002');
  assert.deepEqual(op.items[3].after.resourceIds, ['R0002', 'R0004']);

  // 新进程查询：操作记录、系列归属、候补关联、按日安排
  const ops = await env.cli(['list-batch-ops']);
  mustOk(ops, '查询批量改期操作记录');
  assertIncludes(ops.stdout, 'O0001', '记录列表含操作标识');
  assertIncludes(ops.stdout, '未撤销', '记录状态为未撤销');
  assertIncludes(ops.stdout, '第 1 项 B0001', '记录项按提交顺序');
  assertIncludes(ops.stdout, '第 3 项 B0004（系列 S0002）', '记录项显示系列归属');
  assertIncludes(ops.stdout, '2026-10-12T10:00 → 2026-10-12T11:00', '记录含改期前时间');
  assertIncludes(ops.stdout, '2026-10-12T14:00 → 2026-10-12T15:00', '记录含改期后时间');
  assert.ok(
    ops.stdout.indexOf('第 1 项 B0001') < ops.stdout.indexOf('第 2 项 B0002') &&
      ops.stdout.indexOf('第 2 项 B0002') < ops.stdout.indexOf('第 3 项 B0004'),
    '记录项输出顺序应与清单一致',
  );

  const series = await env.cli(['list-series']);
  mustOk(series, '查询系列');
  assertIncludes(series.stdout, 'S0001', '系列仍在');
  assertIncludes(series.stdout, 'B0002', '成员仍在系列中');

  const wl = await env.cli(['list-waitlist']);
  mustOk(wl, '查询候补');
  assertIncludes(wl.stdout, 'W0001', '候补记录在');
  assertIncludes(wl.stdout, 'B0005', '候补兑现关联在');
  assertIncludes(wl.stdout, 'W0002', '等待候补仍在等待');

  const day = await env.cli(['list-bookings', '--date', '2026-10-12']);
  mustOk(day, '按日查询');
  assertIncludes(day.stdout, 'B0001', '当天含 B0001');
  assertIncludes(day.stdout, 'B0002', '当天含 B0002');
});

// ---------------------------------------------------------------------------
// 2. 幂等：无变化首次提交与重复提交成功，显示完整安排但不写文件、不增记录或计数
// ---------------------------------------------------------------------------
test('幂等：无变化提交与重复提交成功但不写文件、不增记录或计数', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0001', '2026-10-12T14:00', '2026-10-12T15:00'); // B0002

  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T14:00', end: '2026-10-12T15:00', resourceIds: ['R0001']},
  ]);

  const bytes0 = await readFile(env.data);
  const mtime0 = (await stat(env.data)).mtimeMs;

  for (let round = 1; round <= 2; round++) {
    const r = await env.cli(['reschedule-batch', manifest]);
    mustOk(r, `无变化提交（第 ${round} 次）`);
    assertIncludes(r.stdout, '无业务变化', '应明确提示无业务变化');
    assertIncludes(r.stdout, '第 1 项 B0001', '仍显示完整安排');
    assertIncludes(r.stdout, '2026-10-12T10:00 → 2026-10-12T11:00', '仍显示完整安排');
    assertIncludes(r.stdout, '第 2 项 B0002', '仍显示完整安排');

    const bytes1 = await readFile(env.data);
    assert.ok(bytes0.equals(bytes1), `第 ${round} 次无变化提交不得改动数据文件（逐字节一致）`);
    assert.equal((await stat(env.data)).mtimeMs, mtime0, `第 ${round} 次无变化提交不得触碰文件修改时间`);

    const store = await readStore(env);
    assert.equal(store.batchOps.length, 0, '无变化提交不得生成操作记录');
    assert.equal(store.batchSeq, 0, '无变化提交不得推进操作计数');
  }

  const ops = await env.cli(['list-batch-ops']);
  mustOk(ops, '查询空操作记录');
  assertIncludes(ops.stdout, '暂无批量改期操作记录', '无记录时明确提示');
});

// ---------------------------------------------------------------------------
// 3. 身份与幂等：改动后恢复一致仍可撤销；重复撤销不动现状；重提交分配新标识
// ---------------------------------------------------------------------------
test('撤销身份：改动后恢复一致仍可撤销；重复撤销不动现状；重提交分配新操作标识', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0001', '2026-10-12T14:00', '2026-10-12T15:00'); // B0002

  const manifest1 = await writeManifest(
    env,
    [{bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']}],
    'm1.json',
  );
  mustOk(await env.cli(['reschedule-batch', manifest1]), '第一次批量改期'); // O0001
  const manifest2 = await writeManifest(
    env,
    [{bookingId: 'B0002', start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0001']}],
    'm2.json',
  );
  mustOk(await env.cli(['reschedule-batch', manifest2]), '第二次批量改期（较新记录）'); // O0002

  // 较早记录 O0001 涉及的 B0001 被改动，再恢复至其改期后安排
  mustOk(
    await env.cli(['reschedule-booking', 'B0001', '--start', '2026-10-14T10:00', '--end', '2026-10-14T11:00']),
    '改动 O0001 涉及预约',
  );
  mustOk(
    await env.cli(['reschedule-booking', 'B0001', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00']),
    '恢复至 O0001 改期后安排',
  );

  // 仍可撤销：恢复原时间与资源，操作状态持久化
  const undo = await env.cli(['undo-batch-op', 'O0001']);
  mustOk(undo, '撤销较早记录 O0001');
  assertIncludes(undo.stdout, 'O0001', '撤销输出含操作标识');
  let store = await readStore(env);
  let b1 = bookingOf(store, 'B0001');
  assert.equal(b1.start, '2026-10-12T10:00', '撤销恢复原时间');
  assert.equal(b1.end, '2026-10-12T11:00');
  assert.deepEqual(b1.resourceIds, ['R0001'], '撤销恢复原资源');
  assert.equal(store.batchOps.find((o: any) => o.id === 'O0001').status, 'undone', '操作状态已持久化为已撤销');
  assert.equal(store.batchOps.find((o: any) => o.id === 'O0002').status, 'active', '较新记录不受影响');
  assert.equal(store.batchSeq, 2, '撤销不回收也不推进操作计数');

  const ops = await env.cli(['list-batch-ops']);
  mustOk(ops, '新进程核对操作状态');
  assertIncludes(ops.stdout, 'O0001', '记录仍在');
  assertIncludes(ops.stdout, '已撤销', '新进程可见已撤销状态');
  assertIncludes(ops.stdout, '未撤销', '新进程可见未撤销状态');

  // 随后再改期 B0001，重复撤销旧记录：当前安排不受影响
  mustOk(
    await env.cli(['reschedule-booking', 'B0001', '--start', '2026-10-15T10:00', '--end', '2026-10-15T11:00']),
    '撤销后再改期',
  );
  const bytes0 = await readFile(env.data);
  const again = await env.cli(['undo-batch-op', 'O0001']);
  mustOk(again, '重复撤销已撤销记录');
  assertIncludes(again.stdout, '已是撤销状态', '重复撤销明确提示且不改动');
  assert.ok(bytes0.equals(await readFile(env.data)), '重复撤销不得改动数据文件');
  store = await readStore(env);
  b1 = bookingOf(store, 'B0001');
  assert.equal(b1.start, '2026-10-15T10:00', '重复撤销不影响当前安排');

  // 撤销后重提交原清单产生变化：分配新操作标识，不复用旧记录
  const resub = await env.cli(['reschedule-batch', manifest1]);
  mustOk(resub, '撤销后重提交原清单');
  assertIncludes(resub.stdout, 'O0003', '应分配新操作标识 O0003');
  assert.ok(!resub.stdout.includes('O0001') || resub.stdout.indexOf('O0003') >= 0, '不得复用旧标识');
  store = await readStore(env);
  assert.equal(store.batchSeq, 3, '新提交推进操作计数');
  assert.equal(store.batchOps.length, 3, '旧记录全部保留');
  assert.equal(store.batchOps.find((o: any) => o.id === 'O0001').status, 'undone', '旧记录仍已撤销');
  const o3 = store.batchOps.find((o: any) => o.id === 'O0003');
  assert.equal(o3.status, 'active');
  assert.equal(o3.items[0].before.start, '2026-10-15T10:00', '新记录快照基于当前安排');
  assert.equal(o3.items[0].after.start, '2026-10-13T10:00');
});

// ---------------------------------------------------------------------------
// 4. 整批拒绝：清单含已取消预约；各类校验失败逐字节保留数据文件
// ---------------------------------------------------------------------------
test('整批拒绝：已取消预约、非法清单均整批失败且数据文件逐字节保留', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0001', '2026-10-12T14:00', '2026-10-12T15:00'); // B0002
  mustOk(await env.cli(['cancel-booking', 'B0002']), '取消 B0002');

  const bytes0 = await readFile(env.data);

  // 清单含已取消预约：整批拒绝，另一项合法改动也不生效
  const m1 = await writeManifest(
    env,
    [
      {bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
      {bookingId: 'B0002', start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0001']},
    ],
    'm1.json',
  );
  const r1 = await env.cli(['reschedule-batch', m1]);
  mustBizFail(r1, '含已取消预约的批量改期');
  assertIncludes(r1.stderr, 'B0002', '失败原因指出已取消预约');
  assertIncludes(r1.stderr, '已取消', '失败原因说明已取消');
  assert.ok(!r1.stdout.includes('成功'), '失败不得报告成功');
  assert.ok(bytes0.equals(await readFile(env.data)), '校验失败后数据文件逐字节保留');

  // 清单引用未知资源：整批拒绝
  const m2 = await writeManifest(
    env,
    [{bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0099']}],
    'm2.json',
  );
  const r2 = await env.cli(['reschedule-batch', m2]);
  mustBizFail(r2, '含未知资源的批量改期');
  assertIncludes(r2.stderr, 'R0099', '失败原因指出未知资源');
  assert.ok(bytes0.equals(await readFile(env.data)), '校验失败后数据文件逐字节保留');

  // 清单不是合法 JSON：明确失败
  const badJson = join(env.dir, 'bad.json');
  await writeFile(badJson, '{not json');
  const r3 = await env.cli(['reschedule-batch', badJson]);
  mustBizFail(r3, '损坏的改期清单');
  assert.ok(bytes0.equals(await readFile(env.data)), '清单损坏时数据文件逐字节保留');

  // 全部失败后：安排、历史与计数均未变
  const store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-12T10:00', '合法项也不被部分改期');
  assert.equal(bookingOf(store, 'B0002').status, 'cancelled', '已取消项保持取消');
  assert.equal(store.batchOps.length, 0, '失败不留操作记录');
  assert.equal(store.batchSeq, 0, '失败不推进操作计数');
});

// ---------------------------------------------------------------------------
// 5. 撤销整笔拒绝：多个涉及预约当前安排不一致，列出全部且不复活取消项
// ---------------------------------------------------------------------------
test('撤销整笔拒绝：多项当前安排与记录不一致（含已取消）时列出全部', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0001', '2026-10-12T14:00', '2026-10-12T15:00'); // B0002

  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0001']},
  ]);
  mustOk(await env.cli(['reschedule-batch', manifest]), '批量改期'); // O0001

  // 制造两项不一致：B0001 被再次改期；B0002 被取消
  mustOk(
    await env.cli(['reschedule-booking', 'B0001', '--start', '2026-10-14T10:00', '--end', '2026-10-14T11:00']),
    '改期 B0001 使其与记录不一致',
  );
  mustOk(await env.cli(['cancel-booking', 'B0002']), '取消 B0002');

  const bytes0 = await readFile(env.data);
  const undo = await env.cli(['undo-batch-op', 'O0001']);
  mustBizFail(undo, '撤销存在不一致的记录');
  assertIncludes(undo.stderr, 'B0001', '列出安排不一致的预约');
  assertIncludes(undo.stderr, '不一致', '说明不一致');
  assertIncludes(undo.stderr, 'B0002', '列出已取消的预约');
  assertIncludes(undo.stderr, '已取消', '说明已取消不能复活');
  assert.ok(!undo.stdout.includes('已安全撤销'), '失败不得报告撤销成功');
  assert.ok(bytes0.equals(await readFile(env.data)), '撤销拒绝后数据文件逐字节保留');

  const store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-14T10:00', '不一致预约保持现状');
  assert.equal(bookingOf(store, 'B0002').status, 'cancelled', '撤销不复活已取消预约');
  assert.equal(store.batchOps[0].status, 'active', '记录保持未撤销');
});

// ---------------------------------------------------------------------------
// 6. 恢复受阻：恢复目标同时受有效停用与批外预约阻挡；解除阻挡后恢复成功
// ---------------------------------------------------------------------------
test('撤销恢复受阻：有效停用与批外预约阻挡全部列出，解除后恢复成功', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await addResource(env, '设备', '投影仪'); // R0002
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0002', '2026-10-12T14:00', '2026-10-12T15:00'); // B0002

  // 从独立安排出发的批量改期：两项都移到 10-13
  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0002']},
  ]);
  mustOk(await env.cli(['reschedule-batch', manifest]), '批量改期'); // O0001

  // 阻挡一：有效停用覆盖 B0001 的恢复目标区间
  mustOk(
    await env.cli(['add-closure', '--resource', 'R0001', '--start', '2026-10-12T09:00', '--end', '2026-10-12T12:00']),
    '登记阻挡停用',
  ); // C0001
  // 阻挡二：批外预约占用 B0002 的恢复目标时段
  await createBooking(env, 'R0002', '2026-10-12T14:00', '2026-10-12T15:00'); // B0003

  const bytes0 = await readFile(env.data);
  const undo = await env.cli(['undo-batch-op', 'O0001']);
  mustBizFail(undo, '恢复受阻的撤销');
  assertIncludes(undo.stderr, '第 1 项 B0001', '列出全部失败项');
  assertIncludes(undo.stderr, '第 2 项 B0002', '列出全部失败项');
  assertIncludes(undo.stderr, 'C0001', '列出相关停用标识');
  assertIncludes(undo.stderr, '2026-10-12T09:00', '列出相关停用时间');
  assertIncludes(undo.stderr, 'B0003', '列出冲突预约');
  assertIncludes(undo.stderr, 'R0002', '列出共同资源');
  assert.ok(bytes0.equals(await readFile(env.data)), '恢复受阻时数据文件逐字节保留');
  let store = await readStore(env);
  assert.equal(store.batchOps[0].status, 'active', '受阻撤销不改变记录状态');
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-13T10:00', '受阻撤销不改变安排');

  // 解除全部阻挡后恢复成功
  mustOk(await env.cli(['cancel-closure', 'C0001']), '取消阻挡停用');
  mustOk(await env.cli(['cancel-booking', 'B0003']), '取消批外阻挡预约');
  const undo2 = await env.cli(['undo-batch-op', 'O0001']);
  mustOk(undo2, '解除阻挡后撤销');
  store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-12T10:00', 'B0001 恢复原时间');
  assert.deepEqual(bookingOf(store, 'B0001').resourceIds, ['R0001'], 'B0001 恢复原资源');
  assert.equal(bookingOf(store, 'B0002').start, '2026-10-12T14:00', 'B0002 恢复原时间');
  assert.deepEqual(bookingOf(store, 'B0002').resourceIds, ['R0002'], 'B0002 恢复原资源');
  assert.equal(store.batchOps[0].status, 'undone', '记录状态持久化为已撤销');
});

// ---------------------------------------------------------------------------
// 7. 互换时段与端点相接安排的批量改期与恢复均可行
// ---------------------------------------------------------------------------
test('互换时段与端点相接安排的批量改期与撤销均可行', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  // 同一资源上两个端点相接的预约
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  await createBooking(env, 'R0001', '2026-10-12T11:00', '2026-10-12T12:00'); // B0002

  // 互换时段：互换后仍端点相接
  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-12T11:00', end: '2026-10-12T12:00', resourceIds: ['R0001']},
    {bookingId: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
  ]);
  mustOk(await env.cli(['reschedule-batch', manifest]), '互换时段的批量改期'); // O0001
  let store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-12T11:00', '互换后 B0001 占用后段');
  assert.equal(bookingOf(store, 'B0002').start, '2026-10-12T10:00', '互换后 B0002 占用前段');

  // 恢复互换时段：恢复后依旧端点相接，可行
  mustOk(await env.cli(['undo-batch-op', 'O0001']), '恢复互换时段');
  store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-12T10:00', '恢复后 B0001 回到前段');
  assert.equal(bookingOf(store, 'B0001').end, '2026-10-12T11:00');
  assert.equal(bookingOf(store, 'B0002').start, '2026-10-12T11:00', '恢复后 B0002 回到后段');
  assert.equal(bookingOf(store, 'B0002').end, '2026-10-12T12:00');
  assert.equal(store.batchOps[0].status, 'undone');
});

// ---------------------------------------------------------------------------
// 8. 保存失败（批量改期）：退出 1、不报告成功、原文件字节/安排/历史/计数不变；
//    换可保存位置用同一原数据重试，标识未被消耗
// ---------------------------------------------------------------------------
test('保存失败：批量改期不落盘不消耗标识，换可写位置以同一原数据重试成功', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
  ]);

  const bytes0 = await readFile(env.data);
  if (!(await makeDirReadOnly(env.dir))) {
    t.skip('当前环境无法通过目录权限模拟保存失败（可能为 root），跳过');
    return;
  }
  try {
    const r = await env.cli(['reschedule-batch', manifest]);
    mustBizFail(r, '保存失败的批量改期');
    assertIncludes(r.stderr, '保存', '失败原因指向保存');
    assert.ok(!r.stdout.includes('成功'), '保存失败不得报告成功');
    assert.ok(!r.stdout.includes('O0001'), '保存失败不得给出操作标识');
  } finally {
    await chmod(env.dir, 0o755);
  }
  assert.ok(bytes0.equals(await readFile(env.data)), '保存失败后原数据文件逐字节保留');
  await assertNoTmpLeft(env.dir, '批量改期保存失败');
  const store = await readStore(env);
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-12T10:00', '没有部分改期');
  assert.equal(store.batchOps.length, 0, '没有留下操作记录');
  assert.equal(store.batchSeq, 0, '标识计数未被消耗');

  // 在可保存的位置用同一原数据重试：未消费标识，改期完整生效
  const dir2 = await mkdtemp(join(tmpdir(), 'shiftbook-batch-retry-'));
  t.after(async () => rm(dir2, {recursive: true, force: true}));
  const data2 = join(dir2, 'data.json');
  await writeFile(data2, bytes0);
  const retry = await runCli(dir2, ['--data', data2, 'reschedule-batch', manifest]);
  mustOk(retry, '可写位置重试批量改期');
  assertIncludes(retry.stdout, 'O0001', '重试获得首个操作标识（失败未消耗）');
  const store2 = JSON.parse(await readFile(data2, 'utf8'));
  assert.equal(bookingOf(store2, 'B0001').start, '2026-10-13T10:00', '重试后改期生效');
  assert.equal(store2.batchSeq, 1);
  assert.equal(store2.batchOps[0].id, 'O0001');
});

// ---------------------------------------------------------------------------
// 9. 保存失败（撤销）：退出 1、不提前撤销，原文件字节/安排/记录状态不变；
//    换可保存位置重试撤销成功
// ---------------------------------------------------------------------------
test('保存失败：撤销不提前生效，换可写位置重试成功', async (t) => {
  const env = await makeEnv(t);
  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  const manifest = await writeManifest(env, [
    {bookingId: 'B0001', start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
  ]);
  mustOk(await env.cli(['reschedule-batch', manifest]), '批量改期'); // O0001

  const bytes0 = await readFile(env.data);
  if (!(await makeDirReadOnly(env.dir))) {
    t.skip('当前环境无法通过目录权限模拟保存失败（可能为 root），跳过');
    return;
  }
  try {
    const r = await env.cli(['undo-batch-op', 'O0001']);
    mustBizFail(r, '保存失败的撤销');
    assertIncludes(r.stderr, '保存', '失败原因指向保存');
    assert.ok(!r.stdout.includes('已安全撤销'), '保存失败不得报告撤销成功');
  } finally {
    await chmod(env.dir, 0o755);
  }
  assert.ok(bytes0.equals(await readFile(env.data)), '保存失败后原数据文件逐字节保留');
  await assertNoTmpLeft(env.dir, '撤销保存失败');
  const store = await readStore(env);
  assert.equal(store.batchOps[0].status, 'active', '没有提前撤销');
  assert.equal(bookingOf(store, 'B0001').start, '2026-10-13T10:00', '安排保持改期后状态');
  assert.equal(store.batchSeq, 1, '标识计数不变');

  // 在可保存的位置用同一原数据重试撤销
  const dir2 = await mkdtemp(join(tmpdir(), 'shiftbook-undo-retry-'));
  t.after(async () => rm(dir2, {recursive: true, force: true}));
  const data2 = join(dir2, 'data.json');
  await writeFile(data2, bytes0);
  const retry = await runCli(dir2, ['--data', data2, 'undo-batch-op', 'O0001']);
  mustOk(retry, '可写位置重试撤销');
  assertIncludes(retry.stdout, 'O0001', '重试撤销针对同一记录');
  const store2 = JSON.parse(await readFile(data2, 'utf8'));
  assert.equal(store2.batchOps[0].status, 'undone', '重试后记录已撤销');
  assert.equal(bookingOf(store2, 'B0001').start, '2026-10-12T10:00', '重试后恢复原安排');
  assert.equal(store2.batchSeq, 1, '撤销不推进标识计数');
});

// ---------------------------------------------------------------------------
// 10. 旧文件兼容：缺少批量操作记录等字段的旧文件可直接使用；
//     旧入口改期/取消后历史快照与现状不同仍可读取，记录与撤销状态不丢失
// ---------------------------------------------------------------------------
test('旧文件兼容：缺少批量操作记录字段，旧入口操作后记录与撤销状态不丢失', async (t) => {
  const env = await makeEnv(t);
  // 手工构造旧格式数据文件：无 series/waitlist/closures/batchOps 及对应计数
  const legacy = {
    version: 1,
    resourceSeq: 1,
    bookingSeq: 2,
    resources: [{id: 'R0001', type: 'venue', name: '旧会议室', open: [['2026-01-01T00:00', '2027-01-01T00:00']]}],
    bookings: [
      {id: 'B0001', resourceIds: ['R0001'], start: '2026-10-12T10:00', end: '2026-10-12T11:00', status: 'active'},
      {id: 'B0002', resourceIds: ['R0001'], start: '2026-10-12T14:00', end: '2026-10-12T15:00', status: 'active'},
    ],
  };
  await writeFile(env.data, JSON.stringify(legacy, null, 2) + '\n');

  // 旧文件可直接查询
  const day = await env.cli(['list-bookings', '--date', '2026-10-12']);
  mustOk(day, '旧文件按日查询');
  assertIncludes(day.stdout, 'B0001', '旧文件预约可读');
  assertIncludes(day.stdout, 'B0002', '旧文件预约可读');

  // 旧入口改期可用
  mustOk(
    await env.cli(['reschedule-booking', 'B0001', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00']),
    '旧入口改期旧文件预约',
  );

  // 产生一条操作记录并撤销（撤销状态需跨旧入口操作保留）
  const m1 = await writeManifest(
    env,
    [{bookingId: 'B0002', start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0001']}],
    'm1.json',
  );
  mustOk(await env.cli(['reschedule-batch', m1]), '旧文件上首次批量改期'); // O0001
  mustOk(await env.cli(['undo-batch-op', 'O0001']), '撤销 O0001');
  // 撤销后重提交产生新标识 O0002
  mustOk(await env.cli(['reschedule-batch', m1]), '撤销后重提交'); // O0002

  // 旧入口再次改期 B0002：历史快照（O0002 的 after）与现状不同
  mustOk(
    await env.cli(['reschedule-booking', 'B0002', '--start', '2026-10-14T14:00', '--end', '2026-10-14T15:00']),
    '旧入口改期使快照与现状不同',
  );
  // 旧入口取消另一项
  mustOk(await env.cli(['cancel-booking', 'B0001']), '旧入口取消');

  // 历史快照与现状不同仍可读取；记录与撤销状态不丢失
  const ops = await env.cli(['list-batch-ops']);
  mustOk(ops, '快照与现状不同仍可读取记录');
  assertIncludes(ops.stdout, 'O0001', '旧记录仍在');
  assertIncludes(ops.stdout, 'O0002', '新记录仍在');
  assertIncludes(ops.stdout, '已撤销', '撤销状态保留');
  assertIncludes(ops.stdout, '未撤销', '未撤销状态保留');
  assertIncludes(ops.stdout, '2026-10-13T14:00 → 2026-10-13T15:00', '历史快照原样保留');

  const store = await readStore(env);
  assert.equal(store.batchOps.length, 2, '记录不丢失');
  assert.equal(store.batchOps.find((o: any) => o.id === 'O0001').status, 'undone', '撤销状态不丢失');
  assert.equal(store.batchOps.find((o: any) => o.id === 'O0002').status, 'active');
  assert.equal(store.batchSeq, 2);
  assert.deepEqual(
    store.batchOps.find((o: any) => o.id === 'O0002').items[0].after,
    {start: '2026-10-13T14:00', end: '2026-10-13T15:00', resourceIds: ['R0001']},
    '快照不被后续旧入口操作改写',
  );
  assert.equal(bookingOf(store, 'B0002').start, '2026-10-14T14:00', '现状与快照不同');
});

// ---------------------------------------------------------------------------
// 11. 负例：非法记录引用与非法时间快照——查询和修改均退出 1 并保留文件
// ---------------------------------------------------------------------------
test('负例：非法记录引用与非法时间快照，查询和修改均失败并保留文件', async (t) => {
  // 构造基础数据（经 CLI），再分别写入两种损坏的批量操作记录
  async function seedBase(): Promise<{env: Env; store: any}> {
    const env = await makeEnv(t);
    await addResource(env, '场地', '一号厅'); // R0001
    await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
    return {env, store: await readStore(env)};
  }

  async function assertCorruptRejected(env: Env, what: string): Promise<void> {
    const bytes0 = await readFile(env.data);
    const query = await env.cli(['list-batch-ops']);
    mustBizFail(query, `${what}：查询`);
    const modify = await env.cli([
      'reschedule-booking', 'B0001', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00',
    ]);
    mustBizFail(modify, `${what}：修改`);
    assert.ok(bytes0.equals(await readFile(env.data)), `${what}：数据文件逐字节保留`);
  }

  // 非法记录引用：操作记录引用不存在的预约
  {
    const {env, store} = await seedBase();
    store.batchSeq = 1;
    store.batchOps = [{
      id: 'O0001',
      status: 'active',
      items: [{
        bookingId: 'B9999',
        before: {start: '2026-10-12T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
        after: {start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
      }],
    }];
    await writeFile(env.data, JSON.stringify(store, null, 2) + '\n');
    const bytes0 = await readFile(env.data);
    const query = await env.cli(['list-batch-ops']);
    mustBizFail(query, '非法记录引用：查询');
    assertIncludes(query.stderr, 'B9999', '失败原因指出非法引用');
    const modify = await env.cli([
      'reschedule-booking', 'B0001', '--start', '2026-10-13T10:00', '--end', '2026-10-13T11:00',
    ]);
    mustBizFail(modify, '非法记录引用：修改');
    assert.ok(bytes0.equals(await readFile(env.data)), '非法记录引用：数据文件逐字节保留');
  }

  // 非法时间快照：before.start 不是真实时间
  {
    const {env, store} = await seedBase();
    store.batchSeq = 1;
    store.batchOps = [{
      id: 'O0001',
      status: 'active',
      items: [{
        bookingId: 'B0001',
        before: {start: '2026-10-32T10:00', end: '2026-10-12T11:00', resourceIds: ['R0001']},
        after: {start: '2026-10-13T10:00', end: '2026-10-13T11:00', resourceIds: ['R0001']},
      }],
    }];
    await writeFile(env.data, JSON.stringify(store, null, 2) + '\n');
    await assertCorruptRejected(env, '非法时间快照');
  }
});

// ---------------------------------------------------------------------------
// 12. 现有业务入口与数据格式继续可用；不触碰用户默认数据文件
// ---------------------------------------------------------------------------
test('现有入口冒烟：帮助、创建/查询/取消可用，且不产生默认数据文件', async (t) => {
  const env = await makeEnv(t);

  const help = await env.cli(['--help']);
  mustOk(help, '显示帮助');
  assertIncludes(help.stdout, 'reschedule-batch', '帮助含批量改期');
  assertIncludes(help.stdout, 'undo-batch-op', '帮助含撤销');

  const unknown = await env.cli(['no-such-command']);
  assert.equal(unknown.code, 2, '未知命令应以用法错误退出码 2 失败');

  await addResource(env, '场地', '一号厅'); // R0001
  await createBooking(env, 'R0001', '2026-10-12T10:00', '2026-10-12T11:00'); // B0001
  const day = await env.cli(['list-bookings', '--date', '2026-10-12']);
  mustOk(day, '按日查询');
  assertIncludes(day.stdout, 'B0001', '新预约可见');
  mustOk(await env.cli(['cancel-booking', 'B0001']), '取消预约');
  const day2 = await env.cli(['list-bookings', '--date', '2026-10-12']);
  mustOk(day2, '取消后按日查询');
  assertIncludes(day2.stdout, '已取消', '取消状态可见');

  // 所有操作均通过 --data 指定临时文件：临时目录中绝不应出现默认数据文件
  const entries = await readdir(env.dir);
  assert.ok(!entries.includes('shiftbook-data.json'), '测试不得产生或读取用户默认数据文件');
});
