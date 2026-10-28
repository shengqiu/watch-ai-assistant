# main 分支保护（2026-10-28 起）

两个仓库的 main 均已开启分支保护：

| 仓库 | 禁 force push | 禁删除 | 必需状态检查 | 管理员豁免 |
|---|---|---|---|---|
| watch-ai-devbot | ✅ | ✅ | Test | ✅（promote workflow 用） |
| watch-ai-assistant | ✅ | ✅ | 无 | ✅ |

## 为什么 devbot 不要求 PR

deploy.yml 的 promote job 用内置 GITHUB_TOKEN 从 dev 快进（普通 merge）到 main。
若开启「require pull request」，workflow 的直推会被拒绝，dev→main 自动晋升当场断掉。
所以采用折中：
- 禁 force push / 禁删除 —— 物理保护历史不被改写或抹掉
- Test 状态检查 —— main 上的直接 push 也必须绿（带 workflow 路径过滤）
- enforce_admins=false —— GITHUB_TOKEN 属于 workflow 身份，不受保护约束影响

## 为什么 watch-ai-assistant 没加状态检查

它的 deploy.yml 只在 push main 时跑（测试+部署 chatbot），没有从 dev 晋升的
workflow 推送路径；日常同步走 push-file.sh（Git Data API，非 fast-forward 的
PATCH refs 也会被「禁 force push」允许，因为它仍是 fast-forward 提交流）。
状态检查留给将来引入两分支模型时再加。

## 已验证

- 保护生效后，watch-ai-devbot 的 dev push → Test → promote（dev→main）→ Deploy
  全链路正常（run 40704861767 之后又跑通一轮）。
