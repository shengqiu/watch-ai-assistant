# 通道调研：WhatsApp vs iMessage（2026-10-25）

> 目标：Apple Watch 语音 → AI 编程助手，评估 Telegram 之外的新通道。
> 结论先行：**WhatsApp Cloud API 可行且推荐**（待连通性探针确认）；**iMessage 对个人不可行**。

## 一、WhatsApp Cloud API（Meta 官方）— 推荐

### 架构（与现有系统同构）

```
Apple Watch 发语音/文字
  → WhatsApp（watchOS 官方客户端，支持语音消息）
  → Meta Cloud API webhook（Meta 推事件到我们）
  → CF Worker（GET echostr 验证 + POST HMAC-SHA256 验签）
  → 现有 Durable Object / LLM 路由 / 会话 / 限流（全复用）
  → 语音消息：webhook 收 media id → 换临时 URL 下载 → 现有 STT 链路转写
  → Cloud API 发回消息（24h 客服窗口内免费）
```

### 关键事实（2026-10 已核实）

| 维度 | 事实 |
|---|---|
| 费用 | Cloud API 无平台费；**每月 1000 次客服对话免费**（用户主动发起的场景全免费，个人用量远超） |
| 语音入站 | ✅ webhook 收 audio 消息（带 `voice` 标志、mime、media id）——两阶段：事件通知 → media id 换 5 分钟有效下载 URL |
| watchOS | ✅ 官方手表客户端，支持发语音消息 |
| webhook 验证 | GET `echostr` + verify token（回显验证）；POST 事件带 `X-Hub-Signature-256`（HMAC-SHA256，app secret 签名）——标准成熟 |
| 备案/域名 | **无备案要求** |
| Markdown | 消息格式：`*粗体*` `_斜体_` `~删除线~` `` `等宽` `` ```` ```代码块``` ````——与 Telegram MarkdownV2 几乎一致，转换层可大比例复用 |
| 主动发消息 | 24h 窗口外需模板消息（要审批）；我们的场景全是用户发起，窗口内回复，**用不到模板** |

### 门槛（需要用户操作）

1. Meta 开发者账号（developers.facebook.com，个人账号即可）
2. Meta Business 账号（business.facebook.com，免费创建）
3. **一个专用手机号**（未注册过个人 WhatsApp/Business App 的号，或愿意迁移）——可用测试号（Meta 提供，免费用）
4. 开发期：测试号 + 预置 recipient 白名单（加自己的号），免企业验证

### 待验证（唯一不确定项）

**CF Workers 出口 → `graph.facebook.com` 可达性**。webhook 方向（Meta → workers.dev）全球可达无疑；但反方向（CF 出口调 Meta API 发消息、下载媒体）是否被挡，必须实测——探针 `wa-probe` 已部署，等结果。

### 风险

- Meta 对企业验证的要求：正式给非测试用户发消息需过 Business Verification（个人开发者测试号够用）
- 手机号是硬门槛：需要一个干净号码
- Meta 政策风险：Cloud API 是官方通道，政策稳定（对比 iMessage 见下）

## 二、iMessage — 不可行，不碰

### 核心事实：Apple 没有官方 API

- 无 iMessage Business API、无 Messages 开发者计划（Apple 官方 Messages framework 只是 iMessage App 贴纸扩展，不是收发接口）
- 程序化收发 iMessage 的唯一路径：**实体 Mac + 配对 iPhone + Apple ID + 私有框架 daemon**（监控 chat.db、注入消息）

### 行业教训（Lindy 2026-03 实战复盘）

- Lindy（AI 公司）自建 Mac Mini + Swift daemon + Private Frameworks → 上线 12 小时发 1 万条 → **Apple 账号永久封禁**
- 后转第三方托管（Sendblue 等，~$100/月起），本质是租别人机房里的 Mac Mini + iPhone

### 结论

违背「CF Workers 免费档 + 全球可达」的架构初衷（要养硬件），且有封号风险。**不投入**。

## 三、决策建议

1. **先开探针**（30 秒）：https://wa-probe.<你的子域>.workers.dev/ —— 看 `graph.facebook.com` 是否 HTTP 可达
2. **可达** → 开工 WhatsApp 通道：协议标准成熟，现有 DO/STT/LLM 路由全复用，Markdown 转换层大比例复用 Telegram 版
3. **不可达** → 维持 Telegram（已全功能在线），WhatsApp 留档待将来网络环境变化

## 附：三通道对比总表

| | Telegram（现役） | WhatsApp（候选） | iMessage（否） |
|---|---|---|---|
| 官方 API | ✅ | ✅ | ❌ 无 |
| 语音入站 | ✅ | ✅ | ✅（但无 API） |
| watchOS 客户端 | ✅ | ✅ | ✅ |
| 免费额度 |  unlimited | 1000 次/月 | — |
| 域名备案 | 不需要 | 不需要 | — |
| CF Workers 适配 | ✅ 已验证 | 待探针 | 架构不匹配 |
| 代码状态 | 在线 | 未开始 | — |
