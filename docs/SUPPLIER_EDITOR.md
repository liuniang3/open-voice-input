# 供应商添加与管理

## 设计参考

2026-10-02 检查 CC Switch 官方仓库 `farion1231/cc-switch` 的以下组件（通过 GitHub Contents API 获取源码）：

- [ProviderPresetSelector](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/ProviderPresetSelector.tsx)：可搜索的预设网格、始终可选的自定义入口、选中状态。
- [AddProviderDialog](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/AddProviderDialog.tsx)：独立新增面板、固定提交和取消区域。
- [ProviderForm](https://github.com/farion1231/cc-switch/blob/main/src/components/providers/forms/ProviderForm.tsx)：预设驱动连接字段、明确提交、草稿与持久化分离。

本项目仅借鉴交互组织，不复制 CC Switch 的供应商名单、赞助标记、JSON/TOML 配置编辑、跨 coding-agent 同步和账户管理功能。

## 当前实现

- 设置中的“语音识别供应商”与“语言处理供应商”是两个独立分类，不按品牌混在同一张表中。MiMo / 阿里云语音适配器读取 `asrConnections`；表达整理及会议、文件摘要读取 `textSuppliers` 与 `textModelSelections`。同一品牌的两类连接可使用不同地址与 Key。
- `ensureConnectionProfiles` 仅把 ASR 连接映射给短语音、会议、文件识别配置；旧 `providerConnections` 保留为只读兼容数据。`ensureTextSuppliers` 一次性迁移旧语言处理连接、模型目录和用途选择，随后不再自动重建或回退借用旧连接。迁移不删除凭证、音频或历史文件。
- 首次引导和主设置页保存 ASR 时不写入语言处理连接。ASR Key 明确清空后不从旧模型配置补回；未选择语言处理供应商时，语音输入安全保留原文，摘要提示配置错误。MiMo / 阿里 ASR 连接测试使用音频请求，语言处理测试只发送测试文本。
- `text-supplier-ui.js` 保存连接模板及纯校验函数，模板不包含 Key 或固定模型 ID。
- `text-supplier-manager.js` 管理新增/编辑草稿、弹窗焦点、取消确认、同步模型、连接测试与删除状态。
- 主 renderer 仅接收成功保存的配置，未保存草稿不进入其他设置或录音任务。
- 模型请求身份始终为 `(supplierId, modelId)`。认证方式单独保存，默认 Bearer；MiMo 模板采用 api-key，不按模型名猜测供应商。
- Key 默认隐藏，仅在本机授权显示/复制。关闭编辑器会清空其输入框；持久化凭证和 ASR 连接不被清空。
- 模型同步失败不覆盖现有缓存。手动添加只更新此供应商的目录，不修改其他连接或用途选择。
- 使用中的供应商先切换用途再删除。已删除的旧供应商迁移记录写入 `textSupplierDismissedMigrations`，防止再次迁移创建。

## 验证边界

共享测试 `scripts/test-supplier-manager.js` 由现有 Windows/macOS CI 矩阵的 `npm run test:all` 自动纳入。`--browser` 使用模拟连接、合成 Key 与响应验证交互，不调用真实供应商；截图只写入 Git 忽略的 `output/playwright/supplier-cc-switch/`。

本机为 Windows。浏览器中模拟 macOS 页面只验证共享 UI；Mac 原生捕获、权限和粘贴不因此视为已通过硬件验收。未推送本次工作区前，远程 CI 不包含这些改动。
