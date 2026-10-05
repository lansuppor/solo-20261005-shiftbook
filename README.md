# shiftbook

本地多资源单次预约命令行工具：登记场地 / 设备 / 人员及其开放区间，对多个资源一次性创建预约，并支持改期、取消与按日查询。数据保存在同一个本地 JSON 文件中。

需要 Node.js 24，无外部运行依赖（直接运行 TypeScript，无需构建或安装依赖）。

## 运行

```sh
node app.ts                 # 无参数：显示帮助
node app.ts -h              # 显示帮助
node app.ts --help          # 显示帮助
```

所有命令可用 `-f/--file <路径>` 指定同一个本地 JSON 数据文件（默认 `./shiftbook-data.json`）。文件不存在时按空数据处理；文件损坏或结构非法时会明确报错并保留原文件，不会按空数据覆盖。

```sh
# 登记资源（类型：venue 场地 / equipment 设备 / person 人员；至少一个开放区间，可重复 --open）
node app.ts -f shop.json resource-add venue 网球场 \
  --open 2026-10-05T08:00~2026-10-05T12:00 --open 2026-10-05T13:00~2026-10-05T22:00
node app.ts -f shop.json resource-add equipment 投影仪 --open 2026-10-05T08:00~2026-10-06T22:00
node app.ts -f shop.json resource-add person 张教练 --open 2026-10-05T09:00~2026-10-05T18:00

# 查看资源（稳定且不复用的 res_xxxxxxxx 标识、名称、开放区间）
node app.ts -f shop.json resource-list

# 创建预约：一次占用全部资源，时间必须被每个资源的开放区间完整覆盖
node app.ts -f shop.json book --start 2026-10-05T09:00 --end 2026-10-05T10:30 \
  --resource res_00000001 --resource res_00000002

# 改期（可只改时间、只改资源或两者都改；--resource 整体替换原资源，标识保持不变）
node app.ts -f shop.json reschedule bk_00000001 --start 2026-10-05T11:00 --end 2026-10-05T12:00
node app.ts -f shop.json reschedule bk_00000001 --resource res_00000002,res_00000003

# 取消（释放全部资源但保留已取消记录；重复取消成功且不变）
node app.ts -f shop.json cancel bk_00000001

# 按日查询（含跨日与已取消记录，按开始时间与标识排序）
node app.ts -f shop.json query 2026-10-05
```

## 规则要点

- 时间格式 `YYYY-MM-DDTHH:mm`，查询日期 `YYYY-MM-DD`；为与机器时区无关的营业地时间，日期必须真实有效，结束必须晚于开始，允许跨日。
- 区间左闭右开：一个预约的结束恰等于另一个的开始时不冲突；只有共同资源且时间重叠才冲突，冲突时列出全部冲突预约标识与共同资源。
- 开放区间重叠或首尾相接视为连续开放；预约时段必须被所有所选资源的开放区间完整覆盖，否则拒绝且不产生部分预约。
- 校验或保存失败时，数据文件与全部业务记录保持不变。

## 退出码

- `0`：成功
- `1`：业务失败（冲突、开放时间不足、未知标识、数据文件损坏等，原因输出到 stderr）
- `2`：参数用法错误，包括未知参数
