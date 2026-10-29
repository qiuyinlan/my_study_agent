## 新增（1.3.4）

### 导出备份 / 导入备份，就在设置里

以前这两个动作藏在「设置 → 备份与恢复」的二级弹窗里，而且手机上经常点了没反应：WebView 里的 `<input type=file>` 在不少国产 ROM 上不弹选择器，`<a download>` 也不会真的把文件落盘。

现在：

- 设置页「数据与导出」第一行直接是 **「导出备份（JSON）」** 和 **「导入备份（JSON）」**，不用再进二级弹窗。
- Android 端走系统文件选择器（SAF）：
  - 导出 → `ACTION_CREATE_DOCUMENT`，你自己挑存在哪（下载目录、网盘、微信…），文件名 `学习助手备份-YYYY-MM-DD.json`
  - 导入 → `ACTION_OPEN_DOCUMENT`，你自己挑文件
  - 都不需要申请存储权限，行为和文件管理器一致
- 网页端仍走浏览器下载 + 文件选择框。
- 导入前会显示这个文件里有什么（任务 / 知识点 / 消息 / 日志 / 记忆各多少条），确认后按**合并**写入：同 id 以文件为准，不删除现有数据，导入完立刻刷新界面。
- 选错文件会直说：「不像是本应用的备份」「不是合法 JSON」，不会静默合并出半套数据。
- 旧版 APK 里没有新插件时自动退回系统分享面板，不会让按钮白点。

新增原生插件 `AppFiles`（`android/.../AppFilesPlugin.java`）；单文件上限 64MB，且只在用户点击时才打开对话框。

## 修复（通知）

- **点「启用手机通知」现在立刻有字**：点下去第一瞬间就把状态写进开关下面那行小字、状态行，再等系统回调。之前要等原生接口返回才有反馈，桥卡住时看着像"没反应"。
- 申请权限的超时从 60 秒改成 12 秒；超时会明确说「系统已经不再弹权限框，点『打开系统通知设置』手动允许」，并把这个按钮亮出来。
- 新增独立原生权限插件 `NotificationPermission`（自己声明 `POST_NOTIFICATIONS` 的 alias），不再依赖本地通知插件内部的权限注解，弹框出现的路径更短。
- 检查区新增「最近一次点击：时:分:秒」一行，用来区分"点了但失败"和"根本没点到"。
- 顺手修掉一个隐患：`import('@capacitor/core')` 会把 `window.Capacitor` 换成它自己那份实例，在测试或别的宿主里会把平台判断从 android 打回 web。现在统一走 `nativePlugin()`，优先用桥已注入的 `Capacitor.Plugins`。

## 装这一版

https://github.com/qiuyinlan/my_study_agent/releases/download/v1.3.4/MyStudyAgent.apk

覆盖安装即可，数据保留（同一签名）。

## 验证

- `npm run check`：导入/导出一致性、DOM id 引用全过（新增 2 个 id）
- `tools/notification-test.mjs`：排期参数、一次性提醒、保存校验全过
- `tools/dom-test.mjs` 新增 5 项断言：设置里直接有导出/导入备份按钮、备份文件名带日期、选错文件与非法 JSON 都会被拦住、网页端导出走浏览器下载并带回统计
- `gradlew assembleDebug` 通过：`AppFiles`、`AppSettings`、`NotificationPermission` 三个自定义插件都能编译进 APK
