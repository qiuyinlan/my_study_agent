## 修复（1.3.2）

### 用流量点「下载更新」没反应

原生那边把下载写死成 `NETWORK_WIFI`：

```java
.setAllowedNetworkTypes(DownloadManager.Request.NETWORK_WIFI)
```

所以连着流量时点下载，任务会一直排队等 Wi-Fi —— 状态显示「正在下载」，其实一个字节都没动。这就是"点了没反应"。

现在区分两种场景：

- **自动更新**（启动时 / 每天后台）→ 仍然只走 Wi-Fi，不烧你的流量
- **手动点「下载更新」** → 允许移动网络，立刻就用当前网络下
- 若之前有个在等 Wi-Fi 的任务，会先取消它再开新任务，不会重复下载
- 下载状态新增 `waitingForNetwork`：等 Wi-Fi 时界面会写「v1.3.2 正在等你连 Wi-Fi」，并把按钮换成「**用流量下载**」，不再假装正在下载

### 检查更新显示 HTTP 403

GitHub 的 Releases API **未登录每小时只有 60 次，按出口 IP 算**（响应头 `x-ratelimit-limit: 60`）。挂 VPN / 运营商 NAT 时出口 IP 是几千人共享的，几乎必然被打满 → 403；关掉 VPN 用自己的 IP 才有配额。所以"外网 403、内网正常"不是玄学，是配额归属问题。

现在加了两个**不消耗 API 配额**的备用版本源（静态文件 + CORS）：

1. `cdn.jsdelivr.net/gh/qiuyinlan/my_study_agent@main/package.json`
2. `fastly.jsdelivr.net/...`
3. `raw.githubusercontent.com/.../package.json`

API 403/429 时自动降级，用版本号拼出 APK 地址继续工作，界面上注明"已改用备用版本源"。若连备用源都读不到，也不只甩一句 403，而是给出**可点击的 Releases 页手动下载链接**。

另外：撞到限流后 30 分钟内不再碰 API（免得越试越黑），后台的 WorkManager 每日检查同样加了这套兜底。

## 装这一版

https://github.com/qiuyinlan/my_study_agent/releases/download/v1.3.2/MyStudyAgent.apk

## 验证

- `tools/update-test.mjs` 扩到 7 组：API 正常 / 403 降级 / 限流冷却 / 全挂给手动入口 / jsDelivr 挂了落到 raw / **自动下载必须 `allowMobileData: false`** / 已在下载不重复排队
- 三个备用源已实测：均 HTTP 200、`Access-Control-Allow-Origin: *`、version=1.3.2
- `npm run check` / `notification-test` / `update-test` 全绿
