# 重开应用后的验收清单

宿主这一代插件树已经不可挂载（任何新条目都报 `cannot create effect on inactive context`），只有重开 DeepSeek Harness 才能重建。重开后按下面的顺序跑一遍，任一项失败就回滚到对应备份。

## 0. 复活确认

1. `plugin_manager list_plugins`：`include:adb`、`include:crash-lore` 的 `fiberPhase` 是 `active`。
2. `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:62741/dsh-mobile-use/state` → `200`。
3. `adb_device` 能返回设备列表。

## 1. 点空归因（本轮新增，未在设备上验过）

- `adb_ui` 拿树 → `adb_tap {ref:n}` 点一个不可点的文字：回执应出现「目标不可点…」而不是泛泛的「界面没变化」。
- 打开输入框弹出键盘，`adb_tap {point:"540,2900"}` 点键盘覆盖区：回执应出现「键盘挡住了…」。
- 正常点一个能跳页的按钮：回执是「界面已变化 · 当前 …」，耗时比旧版（固定等 240ms）应该低 100ms 上下。

## 2. 横屏/分屏滚动（上一轮修的，未 E2E）

- 旋转成横屏后 `adb_scroll_to {text:"…"}`：不再原地空滑，`swipes` 次数正常。
- MIUI 设置分屏：`adb_do [{scroll_to:"关于手机",direction:"up"},{wait_idle:true},{assert_text:"关于手机"}]` 应通过。
- 收尾 `adb_action home`。

## 2.5 新等待/输入（本轮新增，未在设备上验过）

- `adb_do [{tap:"设置"},{wait_stable:true},{assert_text:"设置"}]`：每步回执里有「等静止 xxxms」。
- `adb_wait {text:"WLAN",timeout_ms:3000}` 与 `adb_wait {stable:true}`：命中时 `matched:true`，超时时带一次 OCR 兜底后的页面摘要。
- `adb_tap {ref:n,wait_stable:true}`：回执里除「界面已变化」外还有静止耗时。
- `adb_input {text:"hello",submit:"enter"}`：一次调用同时有输入回执和提交结果。
- `adb_input {text:"你好",ime:"adb"}`：改成 ADBKeyboard 上屏后切回原输入法（`settings get secure default_input_method` 复核）。
- 注意：共用宠物设备上不要跑 `ime set`，只跑只读的 `ime list` / 默认输入法查询。

## 2.6 失败取证（本轮新增，未在设备上验过）

- 故意 `adb_do [{tap:"不存在的按钮"}]`：报错末尾应带 `截图 ~/.dsh/adb-evidence/<序列号>/…jpg`，且文件真的存在、能打开。
- 同一设备连续失败 21 次：目录里只留最近 20 张。

## 3. 回归

- `npm test` → 21 项通过；`node ~/.dsh/tools/style-lint.mjs .` → 通过。
- `adb_shot` 一张，确认镜像/截图链路没被这一轮改动碰到。

## 回滚点

- `/tmp/index.bak9.js`：本轮「点空归因 + 自适应等待」之前。
- `/tmp/index.bak8.js`：横屏/分屏滚动修复之前。
- `/tmp/patch.bak-revive`：profile `cordis.patch.yml` 备份（已还原，无残留）。
