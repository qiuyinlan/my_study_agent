## 修复（1.3.5）

- 修复 Android 更新流程获取原生 `AppUpdater` 插件时使用错误 Capacitor 实例的问题。现在复用应用内已注入的原生插件桥接，检查、下载和安装更新保持在 Android 平台状态。
- 增加回归检查，确保读取更新插件后 Android 平台仍被正确识别。

## 验证

- `npm run test:updates` 通过
- `npm run check` 通过
- `gradlew assembleDebug` 通过
