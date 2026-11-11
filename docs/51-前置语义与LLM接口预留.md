# 51. 前置语义匹配与 LLM 配合：预留接口

> 2026-11-10。结论：当前只有薄别名入口，没有体系化语义/LLM 接口；必须在 P0 schema 里预留，否则后续返工。

## 1. 当前现状

- `tree_task` 有 intent 别名精确匹配（如“钓鱼”）；
- 配方有少量别名；
- 没有通用语义解析器；
- 没有 LLM 顾问的结构化上下文/提案接口；
- planner/milestone 的 `requires` 还是内部字段，未定义“自然语言 → 规范事实”的边界。

## 2. 要预留的三层接口

### A. GoalIngress（目标入口）

```text
rawText / structuredIntent
  → normalize
  → alias / semantic resolve
  → GoalProposal {
      intent, params,
      confidence,
      source: player|llm|auto,
      raw,
      unresolved[]
    }
  → validator
  → Arbiter / ProfileManager
```

要求：

- 语义匹配在入口层，不进入 Planner；
- Planner 只接收规范 ID/参数；
- 低置信度 → 澄清/候选/求助，不硬猜；
- 保留 raw 文本用于审计。

### B. SemanticResolver（前置语义匹配）

```text
resolve(text, domain) -> {
  candidates: [{id, kind, confidence, reason}],
  canonical: id|null,
  requires: [...]   // 规范前置，不是自然语言
}
```

规范前置只允许：

```
{ kind: 'item'|'fact'|'site'|'tag'|'action', key, count? }
```

语义层负责：

- 同义词/别名（钓竿、fishing rod）；
- 物品 tag（能砍树的工具 → axe tag）；
- 目标 → Profile/Milestone（“升级铁器” → iron_age）；
- 不确定 → 多个候选，不自动选最高。

### C. LLM Advisor 接口

```text
advisor.context() -> AdvisorContext {
  factsSummary, profiles, milestones, candidates,
  recentFailures, helpNeeded, constraints
}

advisor.propose(context) -> AdvisorProposal {
  goals?: GoalProposal[],
  methodHints?: [...],
  explanation,
  confidence,
  source: 'llm'
}
```

硬规则：

- LLM 只读上下文、只提目标/方法建议；
- 不直接执行动作、不绕过 Arbiter/Reflex/Readiness；
- 提案必须过 validator/合约/预算；
- 不实时微操；
- 有 rate limit、审计、可拒绝；
- 上下文是摘要，不是全量 trace。

## 3. 在架构中的位置

```
玩家/LLM
  → GoalIngress / SemanticResolver
  → AdvisorProposal（仅 LLM）
  → Validator
  → Arbiter
  → Profile/Milestone
  → Planner（只吃规范前置）
  → Executor
```

## 4. 现在要预留的字段/接口

### P0 schema 加字段

```text
milestone {
  ...
  intentId, params,
  source: player|llm|auto,
  origin: { raw, confidence }
}
```

- 不要求现在实现语义解析；
- 但字段要留，避免后续迁移。

### 接口占位

```text
GoalIngress.submit(raw, meta) -> GoalProposal
SemanticResolver.resolve(text, domain) -> candidates
Advisor.context() / Advisor.propose()
```

- P0 可只实现别名/精确匹配；
- P1 接语义解析；
- P2 接 LLM 顾问。

## 5. 验收

- 相同意图的不同说法 → 能映射到同一 canonical intent；
- 低置信度 → 不硬执行，返回候选/求助；
- LLM 提案无法绕过安全/仲裁；
- 语义解析失败可回退到 raw + 求助；
- 所有 LLM 建议有 source/confidence/audit。

## 6. 一句话

> **语义匹配放在入口/前置层，Planner 只吃规范事实；LLM 只读上下文、提建议、过仲裁。接口现在留，实现可以后置。**
