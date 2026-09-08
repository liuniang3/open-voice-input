# Meeting Stage 4A — 会议工作台 UI

Status: **foundation UI**（无 OSS、无媒体导入、无播放器/说话人重命名）

Date: 2026-07-20

## 目标

在现有无边框 Electron 壳内增加独立窗口模式 `meeting`（约 1180×760，最小约 960×640），对接 Stage 0B/2B/3A IPC，完成：

- 会话列表 / 新建 / 刷新 / 搜索  
- 双轨或麦克风录制控制台（会议设备与短语音麦克风分离）  
- **停止仅本地**；显式「生成原文」「校订并总结」  
- 结果页签：原始转写 / 校订 / 结构化总结（`textContent` 安全渲染）  
- 设置第五页「会议」：Qwen 与 Analysis 独立凭证字段  

## 入口

- 顶栏按钮「会议工作台」  
- 托盘「会议工作台」  
- IPC：`window:meeting` / preload `openMeetingWorkspace`  

## 行为约束

- 不与 compact/recording/result/settings 短语音模式串状态  
- 处理中轮询，settled 或离开 meeting 模式停止  
- 请求 token 防止陈旧响应  
- 不自动在 stop 后联网  

## 测试

```powershell
npm run test:meeting:ui
```

## 明确未做

- 音频回放时间轴  
- 说话人重命名 UI  
- 媒体文件导入  
- 会话删除  

## 相关

- [MEETING_STAGE_3A.md](./MEETING_STAGE_3A.md)
- [MEETING_STAGE_2B.md](./MEETING_STAGE_2B.md)
