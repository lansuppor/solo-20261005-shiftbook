// shiftbook 联合排程项间先后与衔接间隔关系（schedule-flex relations）自动化回归测试
//
// 运行：npm test（本文件随全部测试一起执行）
// 说明：
// - 使用 Node.js 24 内置测试运行器（node:test），无外部依赖、不访问网络；
// - 全部经命令行入口（node app.ts --data <临时文件>）操作，不读取用户默认数据文件；
// - 每个场景使用独立临时数据目录，保存结果由新进程查询（list-bookings 等）；
// - 覆盖：关系作用于不同资源（最小间隔顶推后项）、最大间隔迫使前项延后、
//   多个前项同时生效（含关系书写顺序不影响结果）、逆清单方向关系、跨日与
//   关系不改变取舍次序、零间隔紧接、非法关系（非整数/越界序号、自指、重复
//   有向关系、有向环、min>max、缺字段、顶层类型错误、未知字段）、关系导致
//   无整体解、真实保存失败与重试（标识未消费）、省略或空关系保持原行为、
//   新进程查询持久结果且创建后可独立改期/取消（关系只约束创建时求解）、
//   重复提交仍为新创建请求；
// - 任一断言失败即非零退出，输出中标注场景与步骤；结束后自动清理临时文件。

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
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
  const dir = mkdtempSync(join(tmpdir(), 'shiftbook-flex-relations-test-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function addResource(
  df: string,
  name: string,
  open: Array<[string, string]> = OPEN_ALL,
  type = 'venue',
): void {
  const args = ['add-resource', '--type', type, '--name', name];
  for (const [s, e] of open) args.push('--open', `${s}/${e}`);
  ok(df, args, `登记资源 ${name}`);
}

interface Manifest {
  items: unknown[];
  relations?: unknown;
}

function writeManifest(dir: string, name: string, manifest: Manifest | unknown[]): string {
  const p = join(dir, name);
  const body = Array.isArray(manifest) ? {items: manifest} : manifest;
  writeFileSync(p, JSON.stringify(body) + '\n', 'utf8');
  return p;
}

function writeRawManifest(dir: string, name: string, raw: string): string {
  const p = join(dir, name);
  writeFileSync(p, raw, 'utf8');
  return p;
}

function readStore(df: string): any {
  return JSON.parse(readFileSync(df, 'utf8'));
}

function assertFileBytes(df: string, expected: Buffer, ctx: string): void {
  assert.ok(expected.equals(readFileSync(df)), `[${ctx}] 失败不得改动数据文件（逐字节比对）`);
}

interface ExpectedItem {
  id: string;
  start: string;
  end: string;
  picks: string[];
}

// 断言联合排程输出：按清单顺序的各项标识、起止时间与按组对应的资源
function assertPlan(r: CliResult, expected: ExpectedItem[], ctx: string): void {
  assert.match(
    r.stdout,
    new RegExp(`联合排程成功：已按清单顺序原子创建 ${expected.length} 项预约`),
    `[${ctx}] 成功提示\nstdout:\n${r.stdout}`,
  );
  expected.forEach((e, i) => {
    assert.match(
      r.stdout,
      new RegExp(`- 第 ${i + 1} 项 -> ${e.id}: ${e.start} → ${e.end}`),
      `[${ctx}] 第 ${i + 1} 项起止时间\nstdout:\n${r.stdout}`,
    );
    e.picks.forEach((id, g) => {
      assert.match(
        r.stdout,
        new RegExp(`第 ${g + 1} 组: ${id}（`),
        `[${ctx}] 第 ${i + 1} 项第 ${g + 1} 组应选 ${id}\nstdout:\n${r.stdout}`,
      );
    });
  });
}

function assertBooking(
  df: string,
  id: string,
  start: string,
  end: string,
  resourceIds: string[],
  ctx: string,
): void {
  const store = readStore(df);
  const b = (store.bookings as any[]).find((x) => x.id === id);
  assert.ok(b, `[${ctx}] 应存在预约 ${id}`);
  assert.equal(b.start, start, `[${ctx}] ${id} 开始时间`);
  assert.equal(b.end, end, `[${ctx}] ${id} 结束时间`);
  assert.deepEqual(b.resourceIds, [...resourceIds].sort(), `[${ctx}] ${id} 资源集合`);
  assert.equal(b.status, 'active', `[${ctx}] ${id} 状态`);
  assert.equal(b.seriesId, undefined, `[${ctx}] ${id} 不加入系列`);
}

// ---------------------------------------------------------------------------
// 1. 关系作用于不同资源：最小间隔把后项顶到前项结束之后（资源不相关也生效）
// ---------------------------------------------------------------------------

test('不同资源：最小间隔顶推后项开始，零资源相关也生效；零间隔允许紧接', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  // 两项资源完全不相交：无关系时各自 08:00 即可；minGap=30 把第 2 项顶到 09:30
  const m = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    relations: [{predecessor: 1, successor: 2, minGap: 30, maxGap: 120}],
  });
  const r = ok(df, ['schedule-flex', m], '不同资源最小间隔');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:30', end: '2026-10-12T10:30', picks: ['R0002']},
    ],
    '不同资源最小间隔',
  );
  assertBooking(df, 'B0001', '2026-10-12T08:00', '2026-10-12T09:00', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T09:30', '2026-10-12T10:30', ['R0002'], '落盘');

  // 同一资源 + 零间隔：后项开始恰为前项结束（左闭右开端点相接，可行）
  const df2 = join(dir, 'data2.json');
  addResource(df2, '唯一会议室');
  const m2 = writeManifest(dir, 'plan2.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
    ],
    relations: [{predecessor: 1, successor: 2, minGap: 0, maxGap: 0}],
  });
  const r2 = ok(df2, ['schedule-flex', m2], '零间隔紧接');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '零间隔紧接',
  );
});

// ---------------------------------------------------------------------------
// 2. 最大间隔迫使前项延后：后项早段不可用，前项不能逐项固定最早
// ---------------------------------------------------------------------------

test('最大间隔迫使前项延后：后项 10:00 才可行，maxGap=0 把前项顶到 09:00', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001 全天开放
  // R0002 在 08:30-10:00 停用型空档（开放不连续），第 2 项最早只能 10:00 开始
  addResource(df, '乙', [
    ['2026-01-01T00:00', '2026-10-12T08:30'],
    ['2026-10-12T10:00', '2027-01-01T00:00'],
  ]); // R0002

  const m = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    // maxGap=0：后项开始恰为前项结束；后项最早 10:00 => 前项 09:00-10:00
    relations: [{predecessor: 1, successor: 2, minGap: 0, maxGap: 0}],
  });
  const r = ok(df, ['schedule-flex', m], '最大间隔顶推前项');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0002']},
    ],
    '最大间隔顶推前项',
  );
  assertBooking(df, 'B0001', '2026-10-12T09:00', '2026-10-12T10:00', ['R0001'], '落盘');
  assertBooking(df, 'B0002', '2026-10-12T10:00', '2026-10-12T11:00', ['R0002'], '落盘');
});

// ---------------------------------------------------------------------------
// 3. 多个前项同时生效；关系书写顺序不影响结果
// ---------------------------------------------------------------------------

test('多个前项：后项开始须同时满足全部关系；关系数组顺序不影响结果', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002
  addResource(df, '丙'); // R0003

  const build = (relOrder: Array<[number, number]>): string =>
    writeManifest(
      dir,
      `plan-${relOrder.map((x) => x.join('')).join('-')}.json`,
      {
        items: [
          {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
          {window: '2026-10-12T09:00/2026-10-12T10:00', duration: 60, groups: [['R0002']]},
          {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 30, groups: [['R0003']]},
        ],
        // 第 3 项开始 - 第 1 项结束 ∈ [30,120]，第 3 项开始 - 第 2 项结束 ∈ [30,120]。
        // 第 2 项窗口恰等于时长，只能 09:00-10:00；第 1 项最早 08:00-09:00，
        // 故第 3 项最早 = max(09:00+30, 10:00+30) = 10:30。
        relations: relOrder.map(([p, s]) => ({predecessor: p, successor: s, minGap: 30, maxGap: 120})),
      },
    );

  const expected: ExpectedItem[] = [
    {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
    {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0002']},
    {id: 'B0003', start: '2026-10-12T10:30', end: '2026-10-12T11:00', picks: ['R0003']},
  ];

  // 同一数据文件上依次提交会分配新标识，故用独立数据文件对照两种关系书写顺序
  const orders: Array<[number, number][]> = [
    [
      [1, 3],
      [2, 3],
    ],
    [
      [2, 3],
      [1, 3],
    ],
  ];
  orders.forEach((order, oi) => {
    const d = join(dir, `multi-${oi}.json`);
    addResource(d, '甲');
    addResource(d, '乙');
    addResource(d, '丙');
    const m = build(order);
    const r = ok(d, ['schedule-flex', m], `多前项顺序 ${JSON.stringify(order)}`);
    const want = expected.map((e) => ({...e}));
    assertPlan(r, want, `多前项顺序 ${JSON.stringify(order)}`);
    assertBooking(d, 'B0003', '2026-10-12T10:30', '2026-10-12T11:00', ['R0003'], `多前项落盘 ${oi}`);
  });
});

// ---------------------------------------------------------------------------
// 4. 逆清单关系：后项（前项角色）写在清单后面，约束仍生效
// ---------------------------------------------------------------------------

test('逆清单关系：第 2 项是前项、第 1 项是后项时，第 1 项开始被顶到第 2 项结束之后', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲'); // R0001
  addResource(df, '乙'); // R0002

  const m = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T13:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T13:00', duration: 60, groups: [['R0002']]},
    ],
    // predecessor=2, successor=1：s1 - e2 ∈ [60,120]；第 2 项最早 08:00-09:00，
    // 故第 1 项最早 10:00
    relations: [{predecessor: 2, successor: 1, minGap: 60, maxGap: 120}],
  });
  const r = ok(df, ['schedule-flex', m], '逆清单关系');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T10:00', end: '2026-10-12T11:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
    ],
    '逆清单关系',
  );
});

// ---------------------------------------------------------------------------
// 5. 跨日关系，且关系不改变取舍：第 1 项字典序选择优先于第 2 项更早开始
// ---------------------------------------------------------------------------

test('跨日与取舍：间隔跨午夜计算正确；第 1 项资源字典序优先，不因关系让第 2 项更早', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲', [['2026-10-12T20:00', '2026-10-13T04:00']]); // R0001
  addResource(df, '乙', [['2026-10-12T20:00', '2026-10-13T04:00']]); // R0002

  const m = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T23:00/2026-10-13T02:00', duration: 60, groups: [['R0001', 'R0002']]},
      {window: '2026-10-12T22:00/2026-10-13T03:00', duration: 60, groups: [['R0001']]},
    ],
    // 若第 1 项取 R0002，第 2 项可 22:00 开始；但第 1 项 23:00 同开始下
    // R0001 字典序更小，故取 R0001，第 2 项被跨午夜间隔顶到次日 01:00。
    relations: [{predecessor: 1, successor: 2, minGap: 60, maxGap: 300}],
  });
  const r = ok(df, ['schedule-flex', m], '跨日与取舍');
  assertPlan(
    r,
    [
      {id: 'B0001', start: '2026-10-12T23:00', end: '2026-10-13T00:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-13T01:00', end: '2026-10-13T02:00', picks: ['R0001']},
    ],
    '跨日与取舍',
  );
  assertBooking(df, 'B0001', '2026-10-12T23:00', '2026-10-13T00:00', ['R0001'], '跨日落盘');
  assertBooking(df, 'B0002', '2026-10-13T01:00', '2026-10-13T02:00', ['R0001'], '跨日落盘');
});

// ---------------------------------------------------------------------------
// 6. 非法关系：非整数/越界序号、自指、重复有向关系、有向环、间隔非法等整单拒绝
// ---------------------------------------------------------------------------

test('非法关系：各类结构与语义错误整单拒绝（退出 1）且不留任何记录', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');

  const baseItems =
    '[{"window":"2026-10-12T08:00/2026-10-12T13:00","duration":60,"groups":[["R0001"]]},' +
    '{"window":"2026-10-12T08:00/2026-10-12T13:00","duration":60,"groups":[["R0002"]]}]';

  const cases: Array<[string, string, RegExp]> = [
    ['自指', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":1,"minGap":0,"maxGap":0}]}`, /自指/],
    ['前项越界', `{"items":${baseItems},"relations":[{"predecessor":0,"successor":1,"minGap":0,"maxGap":0}]}`, /越界/],
    ['后项越界', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":3,"minGap":0,"maxGap":0}]}`, /越界/],
    ['序号非整数', `{"items":${baseItems},"relations":[{"predecessor":1.5,"successor":2,"minGap":0,"maxGap":0}]}`, /predecessor 必须是整数/],
    ['序号字符串', `{"items":${baseItems},"relations":[{"predecessor":"1","successor":2,"minGap":0,"maxGap":0}]}`, /predecessor 必须是整数/],
    ['负间隔', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":-1,"maxGap":0}]}`, /非负整数/],
    ['间隔非整数', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":0.5,"maxGap":2}]}`, /minGap 必须是整数/],
    ['最小大于最大', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":5,"maxGap":2}]}`, /不得大于最大间隔/],
    [
      '重复有向关系',
      `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":0,"maxGap":10},{"predecessor":1,"successor":2,"minGap":5,"maxGap":5}]}`,
      /重复有向关系/,
    ],
    [
      '两节点环',
      `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":0,"maxGap":10},{"predecessor":2,"successor":1,"minGap":0,"maxGap":10}]}`,
      /有向环/,
    ],
    [
      '三节点环',
      '{"items":[' +
        '{"window":"2026-10-12T08:00/2026-10-12T13:00","duration":60,"groups":[["R0001"]]},' +
        '{"window":"2026-10-12T08:00/2026-10-12T13:00","duration":60,"groups":[["R0001"]]},' +
        '{"window":"2026-10-12T08:00/2026-10-12T13:00","duration":60,"groups":[["R0001"]]}],' +
        '"relations":[{"predecessor":1,"successor":2,"minGap":0,"maxGap":300},' +
        '{"predecessor":2,"successor":3,"minGap":0,"maxGap":300},' +
        '{"predecessor":3,"successor":1,"minGap":0,"maxGap":300}]}',
      /有向环/,
    ],
    ['缺 maxGap', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":0}]}`, /maxGap 必须是整数/],
    ['关系非对象', `{"items":${baseItems},"relations":[[1,2,0,0]]}`, /必须是对象/],
    ['关系未知字段', `{"items":${baseItems},"relations":[{"predecessor":1,"successor":2,"minGap":0,"maxGap":0,"lag":1}]}`, /未知字段/],
    ['relations 非数组', `{"items":${baseItems},"relations":"1,2,0,0"}`, /relations 必须是数组/],
    ['顶层未知字段', `{"items":${baseItems},"relations":[],"bogus":1}`, /未知字段/],
  ];

  const bytesBefore = readFileSync(df);
  for (const [label, raw, expectRe] of cases) {
    const m = writeRawManifest(dir, `bad-${label}.json`, raw);
    const r = bizFail(df, ['schedule-flex', m], `非法关系-${label}`);
    assert.match(r.stderr, expectRe, `[非法关系-${label}] 应说明原因\nstderr:\n${r.stderr}`);
    assert.ok(!r.stdout.includes('联合排程成功'), `[非法关系-${label}] 不报告成功`);
  }
  assertFileBytes(df, bytesBefore, '全部非法关系拒绝后');
  const store = readStore(df);
  assert.equal(store.bookings.length, 0, '非法关系不留预约');
  assert.equal(store.bookingSeq, 0, '非法关系不推进标识计数');

  // 合法请求仍从 B0001 开始
  const mOk = writeManifest(dir, 'ok.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001', 'R0002']]},
  ]);
  const rOk = ok(df, ['schedule-flex', mOk], '非法关系后可行请求');
  assertPlan(rOk, [{id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']}], '标识未消费');
});

// ---------------------------------------------------------------------------
// 7. 关系导致无整体解：退出 1、文件不变、标识不消费
// ---------------------------------------------------------------------------

test('关系无整体解：窗口钉死的两项无法满足间隔，退出 1 且不留部分预约', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');

  // 两项都被窗口钉死在 08:00-09:00（不同资源），minGap=0 要求后项开始 >= 前项结束
  const mBad = writeManifest(dir, 'bad.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0002']]},
    ],
    relations: [{predecessor: 1, successor: 2, minGap: 0, maxGap: 30}],
  });
  const bytesBefore = readFileSync(df);
  const r1 = bizFail(df, ['schedule-flex', mBad], '关系无解');
  assert.match(r1.stderr, /无整体解/, '明确提示无整体解');
  assertFileBytes(df, bytesBefore, '无解后文件不变');
  let store = readStore(df);
  assert.equal(store.bookings.length, 0, '不留部分预约');
  assert.equal(store.bookingSeq, 0, '计数不推进');

  // 逆清单方向同样无解：前项（第 2 项）窗口在更晚，后项（第 1 项）窗口在更早
  const mBad2 = writeManifest(dir, 'bad2.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T09:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T11:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
    ],
    // 2 是前项（11:00-12:00），1 是后项（只能 08:00 开始）：s1 >= e2=12:00 不可能
    relations: [{predecessor: 2, successor: 1, minGap: 0, maxGap: 120}],
  });
  const r2 = bizFail(df, ['schedule-flex', mBad2], '逆清单关系无解');
  assert.match(r2.stderr, /无整体解/);
  assertFileBytes(df, bytesBefore, '再次无解后文件不变');

  // 失败不消费标识
  const mOk = writeManifest(dir, 'ok.json', [
    {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
  ]);
  const r3 = ok(df, ['schedule-flex', mOk], '无解后的可行请求');
  assertPlan(r3, [{id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']}], '标识未消费');
  store = readStore(df);
  assert.equal(store.bookingSeq, 1);
});

// ---------------------------------------------------------------------------
// 8. 省略或空关系保持原行为
// ---------------------------------------------------------------------------

test('省略 relations 或为空数组：行为与原清单一致', (t) => {
  const dir = tempDir(t);

  const variants: Array<[string, Manifest]> = [
    ['省略', {
      items: [
        {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
        {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
      ],
    }],
    ['空数组', {
      items: [
        {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
        {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
      ],
      relations: [],
    }],
  ];

  variants.forEach(([label, manifest], vi) => {
    const df = join(dir, `empty-${vi}.json`);
    addResource(df, '甲');
    addResource(df, '乙');
    const m = writeManifest(dir, `plan-${vi}.json`, manifest);
    const r = ok(df, ['schedule-flex', m], `关系${label}`);
    // 无关系：两项各自最早 08:00（不同资源，可同时）
    assertPlan(
      r,
      [
        {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
        {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
      ],
      `关系${label}保持原行为`,
    );
  });
});

// ---------------------------------------------------------------------------
// 9. 真实保存失败与重试：退出 1、原文件逐字节保留、标识未消费；重试成功
// ---------------------------------------------------------------------------

test('关系清单保存失败：退出 1 且原数据逐字节保留，换可写位置重试成功且标识未消费', (t) => {
  const dir = tempDir(t);
  addResource(join(dir, 'seed.json'), '甲');
  const seed = readFileSync(join(dir, 'seed.json'));

  const manifest = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
    ],
    relations: [{predecessor: 1, successor: 2, minGap: 0, maxGap: 0}],
  });

  const longFile = join(dir, LONG_NAME);
  writeFileSync(longFile, seed);
  const origBytes = readFileSync(longFile);
  const r = bizFail(longFile, ['schedule-flex', manifest], '保存失败');
  assert.match(r.stderr, /保存数据文件 .* 失败/, '说明保存失败原因');
  assertFileBytes(longFile, origBytes, '保存失败逐字节保留');
  let store = JSON.parse(origBytes.toString('utf8'));
  assert.equal(store.bookingSeq, 0, '保存失败不推进计数');
  assert.equal(store.bookings.length, 0, '保存失败不留预约');

  // 换可写位置用同一清单重试：从零开始分配 B0001/B0002（标识未消费）
  const retryFile = join(dir, 'retry.json');
  writeFileSync(retryFile, seed);
  const r2 = ok(retryFile, ['schedule-flex', manifest], '保存失败后重试');
  assertPlan(
    r2,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T09:00', end: '2026-10-12T10:00', picks: ['R0001']},
    ],
    '重试成功且标识未消费',
  );
});

// ---------------------------------------------------------------------------
// 10. 持久化与创建后独立：新进程查询；改期/取消不再受关系约束；重复提交为新请求
// ---------------------------------------------------------------------------

test('持久结果新进程可查；创建后可独立改期/取消（关系不保留、不阻挡）；重复提交即新请求', (t) => {
  const dir = tempDir(t);
  const df = join(dir, 'data.json');
  addResource(df, '甲');
  addResource(df, '乙');
  addResource(df, '丙');

  const manifest = writeManifest(dir, 'plan.json', {
    items: [
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0001']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 60, groups: [['R0002']]},
      {window: '2026-10-12T08:00/2026-10-12T12:00', duration: 30, groups: [['R0003']]},
    ],
    relations: [
      {predecessor: 1, successor: 3, minGap: 30, maxGap: 120},
      {predecessor: 2, successor: 3, minGap: 30, maxGap: 120},
    ],
  });
  const r1 = ok(df, ['schedule-flex', manifest], '首次创建');
  assertPlan(
    r1,
    [
      {id: 'B0001', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0002', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
      {id: 'B0003', start: '2026-10-12T09:30', end: '2026-10-12T10:00', picks: ['R0003']},
    ],
    '首次创建',
  );

  // 新进程按日查询：三项均在，按开始时间、标识排序，都是无系列归属的普通预约
  const list = ok(df, ['list-bookings', '--date', '2026-10-12'], '新进程按日查询');
  for (const id of ['B0001', 'B0002', 'B0003']) {
    assert.match(list.stdout, new RegExp(id), `查询结果含 ${id}\nstdout:\n${list.stdout}`);
  }
  assert.ok(!list.stdout.includes('系列'), '关系排程产生的预约不挂系列');

  // 创建后关系不再约束：把 B0001 改到 12:00-13:00（与原关系到 B0003 的间隔完全不符），
  // 只改时间、资源保持 R0001，应成功
  const rs = ok(
    df,
    ['reschedule-booking', 'B0001', '--start', '2026-10-12T12:00', '--end', '2026-10-12T13:00'],
    '创建后独立改期不受关系阻挡',
  );
  assert.match(rs.stdout, /B0001/);
  assertBooking(df, 'B0001', '2026-10-12T12:00', '2026-10-12T13:00', ['R0001'], '改期后落盘');

  // 独立取消 B0002 同样成功
  const rc = ok(df, ['cancel-booking', 'B0002'], '创建后独立取消');
  assert.match(rc.stdout, /B0002/);
  const storeAfter = readStore(df);
  const b2 = (storeAfter.bookings as any[]).find((x) => x.id === 'B0002');
  assert.equal(b2.status, 'cancelled', 'B0002 已取消且记录保留');

  // 重复提交同一清单仍是新的创建请求：分配新标识 B0004..B0006，不去重。
  // 首批 B0003 仍有效并占用 R0003 的 09:30-10:00，故新第 3 项顺延到 10:00
  // （与新前项结束 09:00 的间隔 60 分钟仍在 [30,120] 内）
  const r2 = ok(df, ['schedule-flex', manifest], '重复提交为新请求');
  assertPlan(
    r2,
    [
      {id: 'B0004', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0001']},
      {id: 'B0005', start: '2026-10-12T08:00', end: '2026-10-12T09:00', picks: ['R0002']},
      {id: 'B0006', start: '2026-10-12T10:00', end: '2026-10-12T10:30', picks: ['R0003']},
    ],
    '重复提交分配新标识',
  );
  // 预约记录上不保留任何关系字段
  const finalStore = readStore(df);
  for (const b of finalStore.bookings as any[]) {
    assert.equal(b.relations, undefined, '预约记录不保留关系');
    assert.equal(b.relation, undefined, '预约记录不保留关系');
  }
});
