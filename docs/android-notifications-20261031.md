# Android 通知稳定性修复记录

日期：2026-10-31；版本保持 0.3.0，本次为代码修复，未发布稳定版。

## 改动

- Relay 持久化任务完成 watcher，并在进程启动时恢复轮询；发送和重试接口等待 watcher 保存后返回。
- 完成通知按设备、Thread、Turn 去重，完成后移除 watcher。
- 增加 `/api/push/status`；Android 恢复前台时校验通知凭证，失效后重新注册。
- 注册接口返回当前设备的通知游标，后台服务从该游标继续；Java 插件及 Intent 使用 64 位整数传递毫秒时间戳，避免 32 位截断。
- 通知初始化增加并发锁；Android 前台服务收到系统超时回调时停止，避免超时崩溃。
- Relay 回归覆盖 watcher 落盘、通知单次投递及游标过滤。

## 验证

本次提交前通过：

- `npm run test:relay`
- `npm run build`
- `npm run build:relay`
- `android/gradlew.bat :app:assembleDebug --console=plain`，Java 21。
- `git diff --check`

MuMu Android 15 已安装并运行上一轮测试 APK，但手机配对返回配对码无效或已过期。用户要求停止模拟器验收并先提交推送，因此后台、锁屏、划掉应用、系统回收进程后的通知及点击返回 Thread 尚未完成端到端验收，不能据构建成功认定通知已稳定。

## 交付边界与后续

本次不部署线上，不创建 Tag 或 GitHub Release。Android 构建产物位于 `android/app/build/outputs/apk/debug/app-debug.apk`，不加入 Git。

当前仍使用 `dataSync` 前台服务和鉴权 long-poll。系统服务时限后的长期通知能力仍需继续评估；超时自停只处理崩溃，不证明服务能无限期运行。后续验收应使用隔离测试会话，确认离开 App 后出现系统通知并正确跳转，再分别检查重启和恢复行为。
