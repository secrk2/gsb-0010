# 专利云 · 案件全生命周期管理

所内自研的专利案件管理平台。当前里程碑：**整体骨架 + 案件作战台 + 委托与客户**。

## 一键启动

```bash
docker compose up -d --build
```

打开 **http://localhost:8103** 即是真实在办业务（首次启动自动灌入演示数据）。

| 服务 | 端口 | 说明 |
|---|---|---|
| frontend (Nginx) | **8103** | 静态资源 + `/api` 反代到 backend:7103 |
| backend (Express) | **7103** | REST API |
| mysql | 3316 → 3306 | 调试用暴露，生产可删 |
| redis | 6383 → 6379 | 调试用暴露，生产可删 |

## 演示账号（密码均为 `Patent@123`）

| 账号 | 姓名 | 角色 | 能做什么 |
|---|---|---|---|
| `admin` | 周正 | 管理员 | 客户建档、签合同、立项派代理人、全部案件 |
| `agent01` / `agent02` | 李慕华 / 陈远 | 代理人 | 办理名下案件、脱敏案件填理由看全称 |
| `reviewer01` | 郑严 | 审核员 | 授权/驳回/复审登记、查看留痕 |
| `client01/02/03` | 王工/陈博士/赵经理 | 客户管理员 | 仅本客户的案件/合同/费用（越权访问返回 403 错误态） |

预置数据：3 家客户（华芯半导体/蓝湾生物/星野智能）、3 份委托合同、12 件案件（覆盖委托中/已立项/实审中/授权/驳回/复审中）、11 条官文期限（含临近与逾期）、7 条费用（3 笔逾期红点）。

## 业务规则

### 委托链路（建档 → 签约 → 立项）
1. 管理员「客户建档」→ 2. 签订委托合同（客户状态→已签约）→ 3. 案件立项并指派代理人。
状态机统一拦截非法操作并说明原因：未签约立项 → `409 该客户尚未签署委托合同`；**非法回退**（如实审中→已立项）→ `409 非法回退：…流程单向推进，已完成阶段不可重置`；跳级 → 提示当前可执行的下一步；越权角色 → `403`。

### 脱敏与留痕
- 案件立项后，所内人员看到的客户名一律为 **缩写·编号**（如 `HX·KH-0001`）；委托中的案件不脱敏；客户管理员看本客户始终明文。
- 查看全称必须二次确认 + 填写理由 → 每次查看写入 `unmask_logs`（查看人/理由/IP/时间），管理员与审核员在「留痕」页可审计。

### 客户隔离
`client_admin` 绑定 `client_id`，所有查询按租户过滤；直接访问他人客户/案件返回 `403 FORBIDDEN`，前端渲染带说明的错误页（非空白页）。

### 离线（代理人出差场景）
- **不拿旧状态糊弄**：断网时顶部横幅明示「离线模式」，所有缓存数据带「更新于 HH:mm，可能已过期」标记；无缓存则明确报错而非空白。
- 变更进入 IndexedDB 待同步队列（页面可见「待同步」条目），恢复网络后自动提交 `/api/sync/batch` 合并。
- **幂等不产生重复案件**：案件创建携带客户端 `client_uuid`（数据库唯一约束兜底）+ 每次变更带 `Idempotency-Key`（Redis + MySQL 双存储，重放返回首次结果）；状态流转按服务器当前状态重新校验——仍合法则合并执行，目标已达成视为重复，非法则标记 `conflict` 并保留服务器状态。

## 本地开发（无 Docker）

```bash
# 后端：内置 sqlite + 内存 Redis，零依赖起服务（与生产同一套可移植 SQL）
cd backend && npm install && npm run dev        # :7103

# 前端
cd frontend && npm install && npm run dev       # :5173，/api 代理到 7103
```

## 测试

```bash
cd backend && npm test
```

26 个用例：状态机单测（回退/跳级/角色/前置条件）、脱敏单测，以及真实 HTTP 集成测试（全链路立项、非法回退 409、越权 403、脱敏留痕、幂等重放、离线合并去重与冲突、缓存失效）。

## API 概览

```
POST /api/auth/login|logout        GET /api/auth/me
GET  /api/dashboard                作战台聚合（Redis 缓存 20s，写操作即失效）
GET|POST /api/clients              GET /api/clients/:id
POST /api/clients/:id/contracts    签约（重复签约 409）
POST /api/clients/:id/reveal       查看全称（理由必填，留痕）
GET|POST /api/cases                GET /api/cases/:id
POST /api/cases/:id/transition     状态流转（状态机校验）
POST /api/cases/:id/deadlines|fees
POST /api/ops/deadlines/:id/complete   POST /api/ops/fees/:id/pay   （幂等）
GET  /api/ops/agents               GET /api/logs/unmask|events
POST /api/sync/batch               离线变更批量合并
GET  /api/health
```

所有变更类 `POST` 支持 `Idempotency-Key` 请求头：相同 key 重放返回首次响应（`X-Idempotent-Replay: true`）。

## 目录结构

```
├── docker-compose.yml        # mysql / redis / backend:7103 / frontend:8103
├── mysql/init.sql            # 建库建表（种子数据由后端首启写入）
├── backend/
│   ├── src/lib/              # 状态机、脱敏（纯函数，可单测）
│   ├── src/middleware/       # JWT 鉴权、租户隔离、幂等
│   ├── src/services/         # 业务核心（路由与离线合并共用）
│   ├── src/routes/           # REST 路由
│   ├── src/drivers/          # mysql（生产）/ sqlite（开发测试）
│   └── test/                 # node:test 单元 + 集成
└── frontend/
    ├── src/views/            # 作战台 / 委托与客户 / 案件 / 留痕
    ├── src/offline.js        # IndexedDB 缓存 + 待同步队列
    └── public/sw.js          # 应用外壳离线缓存
```
