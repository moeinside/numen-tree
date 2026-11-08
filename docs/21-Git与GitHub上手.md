# Git / GitHub 上手（本仓库专用速查）

> 面向从没用过 Git 的人。本仓库的地址：<https://github.com/moeinside/numen-tree>
> 本机已配置好的东西：Git 2.48、凭据管理器（推送自动登录）、提交身份、`.gitignore`、`.gitattributes`。

---

## 0. 只记住三件事

Git 就是给文件夹**拍快照**的工具。三步循环：

```
改文件  →  git add  →  git commit（本地快照）  →  git push（传到 GitHub）
```

- **add**：挑出这次想存档的改动
- **commit**：把改动存成一个带说明的快照（存在本地 `.git` 里）
- **push**：把本地快照同步到 GitHub

没 push 之前，GitHub 上什么都不会变；push 失败也不影响本地文件。

---

## 1. 日常最常用（复制粘贴即可）

在项目目录打开 PowerShell：

```powershell
cd E:\game\HMCL\numen-tree

git status                 # ① 看改了什么（红=没暂存，绿=已暂存）
git add -A                 # ② 把所有改动加入这次快照
git commit -m "说明这次改了什么"   # ③ 存快照
git push                   # ④ 传到 GitHub
```

一句话版本（改完直接全存全传）：

```powershell
cd E:\game\HMCL\numen-tree; git add -A; git commit -m "更新"; git push
```

---

## 2. 看东西

```powershell
git log --oneline -10            # 最近 10 次快照
git diff                          # 还没暂存的改动内容
git diff --cached                 # 已暂存、即将提交的改动内容
git show HEAD                     # 最近一次快照的完整改动
git log --oneline -- src/lane.mjs # 只看某个文件的历史
```

在 GitHub 网页上也能看：`Commits`、每个文件的 `History` 按钮。

---

## 3. 常见情况怎么办

| 情况 | 做法 |
|---|---|
| 提交说明写错了（还没 push） | `git commit --amend -m "新说明"` |
| 漏了一个文件 | `git add 漏掉的文件; git commit --amend --no-edit` |
| 想撤销所有没提交的改动 | `git checkout -- .`（**不可恢复，慎用**） |
| 想撤销上一次 commit 但保留改动 | `git reset --soft HEAD~1` |
| 某个文件不想再被 Git 管 | 写进 `.gitignore`，再 `git rm --cached 文件名` |
| 想看远程和本地差多少 | `git status -sb`（`ahead N` 表示本地有 N 个未推送） |
| 换电脑拉代码 | `git clone https://github.com/moeinside/numen-tree.git` |

---

## 4. 本仓库的特殊约定

**不会上传的东西**（写在 `.gitignore` 里，属运行数据）：

- `logs/` —— trace 日志（体积大，且有游戏内数据）
- `places.json` —— 地点簿，跟着存档走，不是代码
- `patcher/build/` —— mod 构建中间物和 jar，用 `patcher/build.ps1` 重建
- `node_modules/` —— 依赖

想确认某个文件会不会被上传：

```powershell
git check-ignore -v 文件名      # 有输出=会被忽略
git ls-files 文件名             # 有输出=已被 Git 跟踪
```

---

## 5. 安全红线

- **永远不要把 token / 密码 / API key 提交进去。** 公开仓库里的密钥等于公开。
  提交前扫一眼：`git diff --cached | Select-String -Pattern "sk-|ghp_|api_key|password"`
- 已经推送出去的密钥要立刻作废重置，并从历史里删（只删文件不够，历史里还在）。
- 提交身份用的是 GitHub 免回复邮箱（`17335086+moeinside@users.noreply.github.com`），不会暴露真实邮箱。

---

## 6. 出问题

| 症状 | 处置 |
|---|---|
| 推送时要求登录 | 正常，浏览器会弹 GitHub 授权页，登录一次后自动记住 |
| 登录错了账号 | `git credential-manager logout` 后在 Windows「凭据管理器」删掉 github.com 条目，再 push 重新登录 |
| `Updates were rejected` | 远程有你本地没有的提交：`git pull --rebase` 后再 push |
| 卡在 `git commit` 的编辑器里 | 那是 Vim：按 `Esc`，输入 `:wq` 回车 |
| 慌乱中 | `git status` 永远无害，先看它说什么 |

---

## 7. 以后想让别人也能用

- 加 `LICENSE`（MIT / Apache-2.0 最常见）——**没有许可证 = 保留所有权利**，别人不能合法复用。
- 加仓库简介和 topics：GitHub 仓库页右上角 ⚙️ → Description / Topics。
