# Yahoo Finance fixture

- 接口：`GET https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1&period2&interval=1d`
- 采集日期：2026-09-26（行情截至 2026-09-25 收盘）
- 全量日线必须用 `period1=0&period2=now` —— `range=max&interval=1d` 实测被降级成月线（169 行）。

| 文件 | 来源 | 说明 |
|---|---|---|
| `gspc-daily.json` | `^GSPC` 全量日线（14305 行 / 1.5 MB） | 保留首 3 + 末 7 行；验证纽约时区日期换算与 1970 起始历史 |
| `n225-daily.json` | `^N225` 全量日线 | 保留首 3 + 末 7 行；验证 Asia/Tokyo 日期换算 |
| `null-rows.json` | 改编自 `gspc-dummy` 真实响应 | 第 2 根 K 线 OHLC 置 null，模拟缺失行 → 跳过并计数 |
| `not-found.json` | `^TPX`（Yahoo 无此符号）实测响应 | `result: null, error: {...}` → 抛 UpstreamError（交给备源） |

重新采集后 diff 并同步更新解析测试与 `docs/design/global-index-data-sources.md` §9 快照。