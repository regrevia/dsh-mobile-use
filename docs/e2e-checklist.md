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

## 3. 回归

- `npm test` → 21 项通过；`node ~/.dsh/tools/style-lint.mjs .` → 通过。
- `adb_shot` 一张，确认镜像/截图链路没被这一轮改动碰到。

## 回滚点

- `/tmp/index.bak9.js`：本轮「点空归因 + 自适应等待」之前。
- `/tmp/index.bak8.js`：横屏/分屏滚动修复之前。
- `/tmp/patch.bak-revive`：profile `cordis.patch.yml` 备份（已还原，无残留）。
