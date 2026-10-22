# Mac 版（macOS）独立发布

本协作只承接 Mac。Windows 专用实现、原 `release.yml` 和 `v*` 发布标签由原维护者管理。普通分支 push、PR 和 CI 都不会发布更新；正式标签仍须维护者授权。

## 更新通道

| 项目 | Mac 独立发布约定 |
| --- | --- |
| 标签 | `macos-vX.Y.Z`，必须匹配 `package.json` 的稳定版本号 |
| 工作流 | `.github/workflows/release-macos.yml`，仅构建 Intel x64 和 Apple Silicon arm64 |
| 更新源 | GitHub Release `macos-updates` 中的 `latest-x64-mac.yml` / `latest-arm64-mac.yml` |
| 安装包 | `macos-vX.Y.Z` Release 中的 `Open-Voice-Input-macOS-X.Y.Z-架构.dmg` / `.zip` |
| 更新说明 | `docs/releases/macOS-vX.Y.Z.md`，标题明确写 **Mac 版（macOS）**，说明具体改善、验证及已知限制 |
| GitHub 标记 | 版本 Release 和通道 Release 都保持 `prerelease=true`、`latest=false` |

GitHub 的 prerelease 标记用于隔离已有 Windows 更新器的全局 stable/latest 查询。Mac 应用通过 GenericProvider 直接读取独立清单，使用清单内的稳定版本号比较更新，不启用 `allowPrerelease`，不允许降级。架构清单包含完整 Mac 更新说明和带版本标签的绝对下载 URL；ZIP、DMG、blockmap 和校验值对应同一版本。

Mac 应用不会查询仓库全局 latest；Windows 继续读取原来的 `latest.yml`。Mac 独立流程不上传 `latest.yml`、EXE 或 Windows 校验文件，也不改全局 latest，因此发布 Mac 修复不会给现有 Windows 用户发送应用内更新提醒。GitHub 网站的仓库订阅通知由用户自己的订阅设置控制。

## 维护者发布步骤

1. 通常先合并通过检查的 Mac PR，再协调下一个 Mac 版本号并同步 `package.json` 与锁文件；不要重新使用已发布版本号。用户明确要求分发候选安装包时，可从通过检查的 `codex/macos-*` 分支创建 Mac 候选标签，保留 PR 的验收状态，main 仍单独维护。两个平台仍共用仓库版本字段，但 Mac 标签不会触发 Windows 构建或发布。
2. 填写 Mac 版更新说明，更新 `CHANGELOG.md` 和开发记录，区分合成回归、打包和真机结果。完成签名/公证时记录实际状态，不能把未签名开发包说成正式签名包。
3. 经授权推送 `macos-vX.Y.Z` 标签。工作流构建两架构，分别执行共享回归、敏感信息检查、原生资源检查和打包。
4. 两架构都成功后，发布任务校验 ZIP/DMG 的 SHA-256、清单 SHA-512、尺寸、版本、架构和 ZIP blockmap 是否存在。任一失败不写新的通道清单。已有通道版本必须低于本次版本，防止排队或重跑的旧任务回退通道。
5. 工作流先上传并发布完整 Mac 版本 Release，再更新 `macos-updates` 的两个清单。两者始终使用 GitHub prerelease，禁止设为全局 latest。通道 Release 的清单需要允许更新；若仓库启用了不可变发布，先协调可更新的通道存储方式。
6. 用上一独立通道版本的打包 app 验证检查、版本/说明、下载哈希和实际安装；两架构各验收。检查原 Windows latest 指向没有变化即可，不在此协作发布 Windows 版本。

若上传通道时失败，已发布的版本包仍可手动下载；某架构可能暂时留在上一个有效版本。核对已发布文件后恢复缺失清单，不重新打包并覆盖同版本安装包。正常的新版本必须向前递增；客户端禁止降级。

## 首次迁移

v0.4.25 及此前的 Mac 更新器使用仓库全局 latest，无法自动知道新增的独立通道。首次使用本机制，需要手动安装接入独立通道的 Mac 版本；之后才会只收到 Mac 通道中的后续更新。不能通过将 Mac Release 设成全局 latest 来绕过迁移，否则会影响旧 Windows 客户端。

首个独立通道候选版本为 Mac 版 v0.4.26，按用户的安装包分发请求准备。真实发布结果见 `MACOS_DEVELOPMENT.md` 和 GitHub Actions。未签名包沿用已校验安装包的手动打开/替换逻辑，签名错误的回退和录音期间禁止安装的保护继续保留。
