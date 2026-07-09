# AD Management

基于 Go 的 Active Directory 域用户管理系统。前后端一体化部署：Go 服务同时提供 REST API、静态前端托管、SQLite 管理员库与审计日志，开箱即用。

---

## 目录

- [功能特性](#功能特性)
- [技术栈](#技术栈)
- [系统架构](#系统架构)
- [目录结构](#目录结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置项](#配置项)
- [部署教程](#部署教程)
  - [方式一：源码编译安装](#方式一源码编译安装)
  - [方式二：二进制安装](#方式二二进制安装)
  - [方式三：Docker 部署](#方式三docker-部署)
- [生产部署建议](#生产部署建议)
- [API 接口](#api-接口)
- [权限模型](#权限模型)
- [安全说明](#安全说明)
- [管理员密码重置](#管理员密码重置)
- [常见问题](#常见问题)

---

## 功能特性

### 普通用户（自助端 `/`）

- 搜索 AD 账号信息（支持飞书 OAuth 登录后操作）
- 账号锁定后**自助解锁**
- **自助重置密码**（重置后强制首次登录修改）
- 飞书 OAuth 单点登录，会话时效可配置

### 管理员（控制台 `/admin`）

- **账号全生命周期管理**：创建 / 删除 / 禁用 / 启用 / 解锁 / 重置密码 / 离职处理
- **定时禁用**：指定未来时间自动禁用账号（支持取消）
- **用户详情**：一览账号状态、所属组、最近操作记录、定时任务、密码到期时间
- **组管理**：为用户添加 / 移除 AD 组
- **域控配置**：在页面中维护 AD 连接信息（无需改配置文件重启）
- **飞书配置**：维护飞书 OAuth 应用参数
- **管理员管理**：创建管理员、分配角色与权限、重置密码（需 `adminMgmt` 权限）
- **审计日志**：完整记录所有操作，支持按操作者 / 动作 / 目标 / 时间筛选
- **RBAC 权限**：14 项细粒度权限 + 4 种预设角色

### 安全特性

- bcrypt 管理员密码哈希
- 登录失败锁定（5 次失败锁 30 分钟）
- JWT-free Bearer Token 会话，支持会话时效配置
- 完整审计日志（含 IP、UA、成功/失败、耗时）
- XSS 防护（escHTML / escAttr / escJS 三级转义）
- 安全响应头（CSP / X-Frame-Options / X-Content-Type-Options）
- 密码重置走 LDAPS（636 端口），TLS 1.2+
- 域控密码 / 飞书 Secret 不回传前端
- 创建用户事务性回滚（避免脏账号）

---

## 技术栈

| 层 | 技术 |
|---|---|
| 后端语言 | Go 1.22+ |
| LDAP 客户端 | `github.com/go-ldap/ldap/v3` |
| 数据库 | SQLite（`modernc.org/sqlite`，**纯 Go 实现，无 CGO 依赖**） |
| 密码哈希 | `golang.org/x/crypto/bcrypt` |
| 前端 | 原生 HTML / CSS / JavaScript（ES Module，无构建工具） |
| 日志 | `log/slog`（JSON 格式，控制台 + 文件双输出） |
| 飞书集成 | 飞书开放平台 OAuth 2.0 |

> **纯 Go SQLite** 意味着编译产物是单一静态二进制，可跨平台交叉编译，无需安装 C 编译器，非常适合容器化和二进制分发。

---

## 系统架构

```
┌─────────────────────────────────────────────────────┐
│                    浏览器 / 客户端                    │
│  ┌──────────────┐         ┌────────────────────┐    │
│  │ 自助端 /      │         │ 管理控制台 /admin   │    │
│  │ 飞书 OAuth    │         │ Bearer Token 认证  │    │
│  └──────┬───────┘         └─────────┬──────────┘    │
└─────────┼───────────────────────────┼───────────────┘
          │                           │
          ▼                           ▼
┌─────────────────────────────────────────────────────┐
│              Go HTTP Server  (:8080)                │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ 静态文件托管  │  │ REST API 路由 │  │ 中间件链   │  │
│  │ (frontend/) │  │ (/api/*)     │  │ 日志/安全  │  │
│  └─────────────┘  └──────┬───────┘  └───────────┘  │
│                          │                          │
│         ┌────────────────┼────────────────┐         │
│         ▼                ▼                ▼         │
│  ┌─────────────┐  ┌─────────────┐  ┌───────────┐   │
│  │ AD 域控     │  │ SQLite 库   │  │ 飞书 OAuth │   │
│  │ LDAP/LDAPS  │  │ 管理员/审计  │  │ 用户信息   │   │
│  └─────────────┘  └─────────────┘  └───────────┘   │
└─────────────────────────────────────────────────────┘
```

- **查询 / 解锁**：走 LDAP（389）
- **重置密码**：强制走 LDAPS（636），TLS 1.2+
- **域控连接信息**：管理员在页面配置后存入 SQLite，运行时动态读取

---

## 目录结构

```
AD Management/
├── cmd/
│   ├── server/              # 主服务入口
│   │   └── main.go
│   └── adcheck/             # AD 连接调试 CLI 工具
│       └── main.go
├── internal/
│   ├── ad/                  # AD/LDAP 客户端封装
│   │   ├── client.go        #   查询/创建/删除/禁用/解锁/改密/离职/加组
│   │   ├── types.go         #   User 结构与 LDAP 字段映射
│   │   └── errors.go
│   ├── api/                 # HTTP 路由与处理器
│   │   ├── router.go        #   路由注册 + 管理员接口
│   │   ├── auth.go          #   登录/会话/Token 中间件
│   │   ├── auth_feishu.go   #   飞书 OAuth 回调
│   │   ├── middleware_selfservice.go  # 自助端双轨限流
│   │   ├── scheduler.go     #   定时禁用调度器
│   │   ├── safety.go        #   删除保护
│   │   ├── options.go       #   OU/组下拉
│   │   ├── static.go        #   静态文件托管
│   │   ├── ratelimit.go     #   令牌桶限流
│   │   ├── oauth_state.go   #   OAuth state 存储
│   │   ├── feishu_settings.go
│   │   └── router_test.go
│   ├── config/              # 环境变量配置加载
│   ├── store/               # SQLite 数据访问层
│   │   ├── store.go         #   管理员/会话/审计/AD设置/飞书设置
│   │   └── store_test.go
│   ├── feishu/              # 飞书 OAuth 客户端
│   ├── security/            # 密码生成
│   └── envfile/             # .env 文件加载（adcheck 用）
├── frontend/                # 前端静态资源
│   ├── index.html           #   自助端入口
│   ├── admin.html           #   管理端入口
│   └── assets/
│       ├── tokens.css       #   CSS 变量
│       ├── components.css   #   通用组件
│       ├── admin.css        #   管理端布局
│       ├── selfservice.css  #   自助端布局
│       ├── icons.js         #   Lucide 图标库
│       └── admin/           #   管理端 ES Module
│           ├── app.js       #     入口
│           ├── api.js       #     fetch 封装
│           ├── ui.js        #     toast/modal/转义
│           ├── users.js     #     用户列表
│           ├── user-detail.js
│           ├── settings.js
│           ├── audit.js
│           ├── admin-mgmt.js
│           ├── state.js
│           └── shared.js
├── go.mod
├── go.sum
├── .env.example             # 环境变量示例
├── Dockerfile               # Docker 构建文件
├── docker-compose.yml       # Docker Compose 编排
└── README.md
```

---

## 环境要求

| 组件 | 版本要求 | 说明 |
|---|---|---|
| Go | ≥ 1.22 | 源码编译需要；运行时不需要 |
| AD 域控 | Windows Server 2008+ | 支持 LDAP / LDAPS |
| 操作系统 | Linux / macOS / Windows | 纯 Go 编译，跨平台 |
| 网络 | 域控 389(LDAP) / 636(LDAPS) 可达 | 改密必须 LDAPS |

---

## 快速开始

### 方式 A：直接运行预编译二进制（最快）

项目根目录已附带编译好的 `ad-server` 二进制，无需安装 Go 环境即可运行：

```bash
cd ad-management

# 配置环境变量（可选，不配会用默认值）
cp .env.example .env
# 编辑 .env，至少修改 BOOTSTRAP_ADMIN_PASSWORD

# 直接运行
./ad-server
```

> **修改源码后需重新编译**：
> ```bash
> # macOS / Linux（本机架构）
> CGO_ENABLED=0 go build -ldflags="-s -w" -trimpath -o ad-server ./cmd/server
>
> # 交叉编译到其他平台（示例：Linux amd64 服务器）
> CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ad-server ./cmd/server
> ```
> `-ldflags="-s -w"` 去除调试信息可减小体积约 30%；本项目使用纯 Go SQLite（无 CGO），可生成单一静态二进制。

### 方式 B：源码直接运行（开发调试）

需要本机安装 Go 1.22+：

```bash
# 1. 克隆项目
git clone <repo-url> ad-management
cd ad-management

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，至少修改 BOOTSTRAP_ADMIN_PASSWORD

# 3. 启动服务
go run ./cmd/server
```

### 访问

启动后默认监听 `:8080`：

- 管理控制台：`http://localhost:8080/admin`
- 自助端：`http://localhost:8080/`
- 健康检查：`http://localhost:8080/healthz`（返回 `{"status":"ok"}`）

首次启动后，在管理控制台「域控配置」页面填入 AD 连接信息并保存即可。

> **复用已有数据库**：直接运行会复用当前目录的 `ad-management.db`（管理员、域控配置、审计日志等均保留），无需重新初始化。首次部署时数据库会自动创建。

---

## 配置项

所有配置通过环境变量传入。复制 `.env.example` 为 `.env` 并按需修改：

### 基础配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `HTTP_ADDR` | `:8080` | HTTP 监听地址 |
| `FRONTEND_DIR` | `frontend` | 前端静态文件目录 |
| `DB_PATH` | `ad-management.db` | SQLite 数据库文件路径 |
| `LOG_DIR` | `logs` | 日志文件输出目录 |

### 管理员配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `BOOTSTRAP_ADMIN_USERNAME` | `admin` | 首个管理员用户名 |
| `BOOTSTRAP_ADMIN_PASSWORD` | `admin` | 首个管理员密码（**务必修改**） |
| `ADMIN_SESSION_DURATION` | `12h` | 管理员会话有效期 |
| `ADMIN_RESET_PASSWORD` | — | 设置后启动时重置管理员密码（一次性） |

### 安全配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `AD_DELETE_PROTECTED_ACCOUNTS` | — | 禁止删除的保护账号，逗号分隔，如 `administrator,krbtgt` |

### 飞书 OAuth 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `FEISHU_APP_ID` | — | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | — | 飞书应用 App Secret |
| `FEISHU_REDIRECT_URI` | — | OAuth 回调地址，如 `https://ad.example.com/api/auth/feishu/callback` |
| `SELF_SERVICE_SESSION_DURATION` | `8h` | 自助端会话有效期 |

> **域控连接信息**（Host / Port / BaseDN / Bind 账号等）不通过环境变量配置，而是在管理控制台「域控配置」页面维护，保存后存入 SQLite。

---

## 部署教程

提供三种部署方式，按需选择：

| 方式 | 适用场景 | 优点 |
|---|---|---|
| [源码编译安装](#方式一源码编译安装) | 开发 / 自定义修改 | 可修改源码，调试方便 |
| [二进制安装](#方式二二进制安装) | 生产快速部署 | 无需 Go 环境，单文件运行 |
| [Docker 部署](#方式三docker-部署) | 容器化环境 | 环境隔离，易扩展，一键部署 |

---

### 方式一：源码编译安装

#### 1. 安装 Go

从 [Go 官网](https://go.dev/dl/) 下载并安装 Go 1.22 或更高版本：

```bash
# macOS (Homebrew)
brew install go

# 或手动下载
# https://go.dev/dl/
```

验证安装：

```bash
go version
# go version go1.22.x ...
```

#### 2. 获取源码

```bash
git clone <repo-url> ad-management
cd ad-management
```

#### 3. 安装依赖

```bash
go mod download
```

#### 4. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env`，至少修改以下项：

```bash
# 必改：管理员初始密码
BOOTSTRAP_ADMIN_PASSWORD=your-strong-password-here

# 可选：监听端口
HTTP_ADDR=:8080

# 可选：数据库路径
DB_PATH=/var/lib/ad-management/ad-management.db
```

#### 5. 编译

```bash
# 直接运行（开发模式）
go run ./cmd/server

# 或编译为二进制
go build -o ad-server ./cmd/server
```

#### 6. 使用 systemd 托管（Linux 生产环境）

创建 `/etc/systemd/system/ad-management.service`：

```ini
[Unit]
Description=AD Management Service
After=network.target

[Service]
Type=simple
User=admgmt
Group=admgmt
WorkingDirectory=/opt/ad-management
EnvironmentFile=/opt/ad-management/.env
ExecStart=/opt/ad-management/ad-server
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

启动并设为开机自启：

```bash
sudo systemctl daemon-reload
sudo systemctl enable ad-management
sudo systemctl start ad-management
sudo systemctl status ad-management
```

查看日志：

```bash
# 服务日志
journalctl -u ad-management -f

# 应用日志（文件）
tail -f /opt/ad-management/logs/server-$(date +%Y-%m-%d).log
```

#### 7. 验证

```bash
curl http://localhost:8080/healthz
# {"status":"ok"}
```

---

### 方式二：二进制安装

适用于不安装 Go 环境的生产服务器。本项目使用纯 Go SQLite（无 CGO），编译产物为单一静态二进制，可直接分发。

#### 1. 编译二进制（在有 Go 环境的机器上）

在开发机或其他有 Go 环境的机器上交叉编译：

```bash
# 克隆并进入项目
git clone <repo-url> ad-management
cd ad-management

# 编译 Linux amd64（最常见服务器环境）
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o ad-server ./cmd/server

# 编译 Linux arm64（如树莓派 / ARM 服务器）
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o ad-server ./cmd/server

# 编译 macOS arm64 (Apple Silicon)
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -ldflags="-s -w" -o ad-server ./cmd/server

# 编译 Windows
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o ad-server.exe ./cmd/server
```

> `-ldflags="-s -w"` 去除调试信息，二进制体积可减小约 30%。
> `CGO_ENABLED=0` 确保纯静态链接，无外部 C 库依赖。

编译产物 `ad-server`（约 10-15 MB）连同 `frontend/` 目录一起分发即可。

#### 2. 分发到目标服务器

```bash
# 打包需要的文件
tar -czf ad-management.tar.gz \
    ad-server \
    frontend/ \
    .env.example

# 传输到服务器
scp ad-management.tar.gz user@your-server:/tmp/

# 在服务器上解压
ssh user@your-server
sudo mkdir -p /opt/ad-management
sudo tar -xzf /tmp/ad-management.tar.gz -C /opt/ad-management
cd /opt/ad-management
```

#### 3. 配置环境变量

```bash
cp .env.example .env
vim .env
```

至少修改：

```bash
BOOTSTRAP_ADMIN_PASSWORD=your-strong-password-here
DB_PATH=/var/lib/ad-management/ad-management.db
LOG_DIR=/var/log/ad-management
```

#### 4. 创建运行用户与目录

```bash
# 创建专用用户
sudo useradd -r -s /sbin/nologin -d /opt/ad-management admgmt

# 创建数据 / 日志目录
sudo mkdir -p /var/lib/ad-management /var/log/ad-management
sudo chown -R admgmt:admgmt /opt/ad-management /var/lib/ad-management /var/log/ad-management

# 赋予二进制执行权限
sudo chmod +x /opt/ad-management/ad-server
```

#### 5. 配置 systemd 并启动

编辑 `.env` 中的路径后，创建 systemd 服务（参考 [方式一第 6 步](#6-使用-systemd-托管linux-生产环境)），或直接前台运行验证：

```bash
# 前台运行验证
sudo -u admgmt /opt/ad-management/ad-server

# 后台运行
sudo -u admgmt nohup /opt/ad-management/ad-server > /var/log/ad-management/stdout.log 2>&1 &
```

#### 6. 验证

```bash
curl http://localhost:8080/healthz
# {"status":"ok"}
```

---

### 方式三：Docker 部署

项目根目录已包含 `Dockerfile`（多阶段构建）和 `docker-compose.yml`。

#### 方式 3a：使用 Docker Compose（推荐）

```bash
# 1. 克隆项目
git clone <repo-url> ad-management
cd ad-management

# 2. 配置环境变量
cp .env.example .env
vim .env  # 修改 BOOTSTRAP_ADMIN_PASSWORD 等

# 3. 一键启动
docker compose up -d

# 4. 查看日志
docker compose logs -f ad-management

# 5. 验证
curl http://localhost:8080/healthz

# 停止
docker compose down
```

数据持久化：SQLite 数据库与日志通过 volume 挂载到宿主机 `./data/` 和 `./logs/` 目录。

#### 方式 3b：使用 Docker 命令

```bash
# 1. 构建镜像
docker build -t ad-management:latest .

# 2. 运行容器
docker run -d \
  --name ad-management \
  -p 8080:8080 \
  -v $(pwd)/data:/var/lib/ad-management \
  -v $(pwd)/logs:/app/logs \
  -e BOOTSTRAP_ADMIN_USERNAME=admin \
  -e BOOTSTRAP_ADMIN_PASSWORD=your-strong-password-here \
  -e AD_DELETE_PROTECTED_ACCOUNTS=administrator,krbtgt \
  --restart unless-stopped \
  ad-management:latest

# 3. 验证
docker logs -f ad-management
curl http://localhost:8080/healthz
```

#### Dockerfile 说明

项目使用多阶段构建：

- **构建阶段**：基于 `golang:1.22-alpine`，编译静态二进制
- **运行阶段**：基于 `alpine`，仅包含二进制 + 前端静态文件 + CA 证书（LDAPS 需要）

```dockerfile
# ---- 构建阶段 ----
FROM golang:1.22-alpine AS builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o ad-server ./cmd/server

# ---- 运行阶段 ----
FROM alpine:3.19
RUN apk add --no-cache ca-certificates tzdata
WORKDIR /app
COPY --from=builder /build/ad-server .
COPY --from=builder /build/frontend ./frontend
EXPOSE 8080
VOLUME ["/var/lib/ad-management", "/app/logs"]
ENTRYPOINT ["./ad-server"]
```

#### 自定义 Docker Compose 配置

如需调整端口或挂载路径，编辑 `docker-compose.yml`：

```yaml
services:
  ad-management:
    build: .
    image: ad-management:latest
    container_name: ad-management
    ports:
      - "8080:8080"           # 修改左侧端口即可换端口
    volumes:
      - ./data:/var/lib/ad-management
      - ./logs:/app/logs
    environment:
      - BOOTSTRAP_ADMIN_USERNAME=admin
      - BOOTSTRAP_ADMIN_PASSWORD=change-this
      - DB_PATH=/var/lib/ad-management/ad-management.db
      - LOG_DIR=/app/logs
      - AD_DELETE_PROTECTED_ACCOUNTS=administrator,krbtgt
    restart: unless-stopped
```

#### 配合 Nginx 反向代理（HTTPS）

生产环境建议在 Docker 前加 Nginx 做 HTTPS 终止：

```nginx
server {
    listen 443 ssl http2;
    server_name ad.example.com;

    ssl_certificate     /etc/ssl/certs/ad.example.com.pem;
    ssl_certificate_key /etc/ssl/private/ad.example.com.key;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 通过 Nginx 反代时，应用会自动从 `X-Forwarded-For` / `X-Real-IP` 获取真实客户端 IP，审计日志记录的是真实 IP 而非 `127.0.0.1`。

---

## 生产部署建议

1. **HTTPS**：务必通过 Nginx / Caddy 等反向代理启用 HTTPS，飞书 OAuth 回调要求 HTTPS。
2. **数据备份**：定期备份 SQLite 数据库文件（`ad-management.db`）。
3. **日志轮转**：应用按日期生成日志文件，建议配合 logrotate 轮转。
4. **防火墙**：仅开放 80/443 端口，域控 389/636 仅限本服务器访问。
5. **最小权限**：AD Bind 账号使用最小权限的服务账号，仅授予必要的 OU 读写权限。
6. **密码策略**：`BOOTSTRAP_ADMIN_PASSWORD` 使用强密码，部署后立即在控制台修改。
7. **会话时效**：根据安全要求调整 `ADMIN_SESSION_DURATION`（默认 12h）。

---

## API 接口

### 认证

管理员接口使用 Bearer Token 认证：

```http
Authorization: Bearer <token>
Content-Type: application/json
```

登录获取 Token：

```http
POST /api/admin/login

{"username":"admin","password":"your-password"}
```

响应：

```json
{
  "token": "xxx",
  "username": "admin",
  "role": "super_admin",
  "permissions": ["search","create",...],
  "expiresAt": "2026-07-10T05:00:00Z"
}
```

### 飞书 OAuth（无需认证）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/feishu/login` | 发起飞书 OAuth 登录，302 重定向 |
| GET | `/api/auth/feishu/callback` | 飞书回调，设置会话 Cookie |
| GET | `/api/auth/feishu/session` | 查询当前自助端会话 |
| POST | `/api/auth/feishu/logout` | 退出自助端会话 |

### 自助端接口（飞书认证后，Cookie-based）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me/users?q=` | 搜索账号（只能操作自己的账号） |
| POST | `/api/me/users/unlock` | 自助解锁 |
| POST | `/api/me/users/password` | 自助重置密码（强制首次登录修改） |

### 管理员接口

| 方法 | 路径 | 所需权限 | 说明 |
|---|---|---|---|
| GET | `/api/admin/me` | 任意 | 获取当前管理员信息 |
| PUT | `/api/admin/me/password` | 任意 | 修改自己的密码 |
| GET | `/api/admin/users?q=` | search | 搜索用户 |
| GET | `/api/admin/users/detail?account=` | search | 用户详情（含定时任务、近期日志） |
| POST | `/api/admin/users` | create | 创建账号 |
| DELETE | `/api/admin/users?account=` | delete | 删除账号 |
| POST | `/api/admin/users/disable` | disable | 禁用 / 定时禁用 |
| POST | `/api/admin/users/enable` | disable | 启用账号 |
| POST | `/api/admin/users/unlock` | unlock | 解锁账号 |
| POST | `/api/admin/users/password` | resetPwd | 重置密码 |
| POST | `/api/admin/users/offboard` | offboard | 离职处理（禁用 + 移 OU） |
| PUT | `/api/admin/users/update` | modifyUser | 修改用户属性 |
| POST | `/api/admin/users/add-group` | addGroup | 加入组 |
| POST | `/api/admin/users/remove-group` | addGroup | 移除组 |
| GET | `/api/admin/ous` | create | 发现 OU |
| GET | `/api/admin/groups` | create,addGroup | 发现组 |
| GET | `/api/admin/options` | search,create | 获取 OU/组下拉选项 |
| GET | `/api/admin/ad-settings` | search,adSettings | 获取域控配置 |
| PUT | `/api/admin/ad-settings` | adSettings | 保存域控配置 |
| POST | `/api/admin/ad-settings/test` | adSettings | 测试域控连接 |
| GET | `/api/admin/ad-settings/connectivity` | search,adSettings | 检查连接状态 |
| GET | `/api/admin/feishu-settings` | feishuSettings | 获取飞书配置 |
| PUT | `/api/admin/feishu-settings` | feishuSettings | 保存飞书配置 |
| POST | `/api/admin/feishu-settings/test` | feishuSettings | 测试飞书配置 |
| GET | `/api/admin/audit-logs` | audit | 查询审计日志 |
| GET | `/api/admin/scheduled-tasks` | tasks | 查询定时任务 |
| DELETE | `/api/admin/scheduled-tasks?id=` | tasks | 取消定时任务 |
| GET | `/api/admin/admins` | adminMgmt | 管理员列表 |
| POST | `/api/admin/admins` | adminMgmt | 创建管理员 |
| DELETE | `/api/admin/admins?username=` | adminMgmt | 删除管理员 |
| POST | `/api/admin/admins/reset-password` | adminMgmt | 重置管理员密码 |
| PUT | `/api/admin/admins/permissions` | adminMgmt | 修改管理员权限 |
| GET | `/healthz` | — | 健康检查 |

#### 接口示例

创建账号：

```http
POST /api/admin/users

{
  "cn": "张三",
  "displayName": "张三",
  "samAccountName": "zhangsan",
  "userPrincipalName": "zhangsan@example.com",
  "mail": "zhangsan@example.com",
  "password": "Password123!",
  "mustChange": true,
  "ou": "OU=Users,DC=example,DC=com"
}
```

定时禁用：

```http
POST /api/admin/users/disable

{"account":"zhangsan","disableAt":"2026-05-20T18:00:00+08:00"}
```

重置密码（不传 password 则自动生成）：

```http
POST /api/admin/users/password

{"account":"zhangsan","password":"NewPass123!","mustChange":false}
```

---

## 权限模型

### 4 种预设角色

| 角色 | 说明 | 默认权限 |
|---|---|---|
| `super_admin` | 超级管理员 | 全部 14 项权限 |
| `hr_admin` | HR 管理员 | search, create, disable, offboard, modifyUser, addGroup, audit, tasks |
| `helpdesk` | 运维台 | search, unlock, resetPwd, audit |
| `custom` | 自定义 | 由 `permissions` 字段决定 |

### 14 项细粒度权限

| 权限项 | 说明 |
|---|---|
| `search` | 搜索用户 |
| `create` | 创建用户 |
| `delete` | 删除用户 |
| `disable` | 禁用 / 启用用户 |
| `unlock` | 解锁用户 |
| `resetPwd` | 重置用户密码 |
| `offboard` | 离职处理 |
| `modifyUser` | 修改用户属性 |
| `addGroup` | 加入 / 移除组 |
| `adSettings` | 域控配置 |
| `feishuSettings` | 飞书配置 |
| `audit` | 查看审计日志 |
| `tasks` | 管理定时任务 |
| `adminMgmt` | 管理员管理 |

> 安全约束：不允许删除最后一个拥有 `adminMgmt` 权限的管理员；不允许移除自己的 `adminMgmt` 权限（防止自我锁死）。

---

## 安全说明

- **密码重置走 LDAPS**：重置密码强制使用 LDAPS（636 端口），要求域控配置有效证书。默认 TLS 1.2+。
- **域控密码不回传**：`GET /api/admin/ad-settings` 返回时清空 `bindPassword`。
- **飞书 Secret 不回传**：`GET /api/admin/feishu-settings` 返回时清空 `appSecret`。
- **登录锁定**：连续 5 次密码错误锁定 30 分钟。
- **审计日志**：所有管理操作均记录审计日志，含操作者、动作、目标、IP、UA、成功/失败。
- **删除保护**：`AD_DELETE_PROTECTED_ACCOUNTS` 中的账号无法被删除。
- **CSP 安全头**：`Content-Security-Policy` 限制脚本/样式来源。
- **创建用户事务性**：创建后若 ResetPassword / Enable / AddGroups 失败，自动删除已建用户，避免脏账号。

---

## 管理员密码重置

如果管理员忘记密码，可通过环境变量重置：

```bash
# 设置环境变量后重启服务
export ADMIN_RESET_PASSWORD="新的强密码123"
# 重启服务（systemd / docker / 直接运行均可）

# Docker
docker run -e ADMIN_RESET_PASSWORD="新的强密码123" ... ad-management

# systemd
# 在 .env 或 EnvironmentFile 中加入 ADMIN_RESET_PASSWORD=新的强密码123
# 然后 sudo systemctl restart ad-management
```

服务启动时会自动重置管理员密码并在日志输出：

```
{"level":"INFO","msg":"admin password reset completed","username":"admin"}
```

重置完成后环境变量会被自动清除，下次启动不再重置。

> **安全提示**：请使用强密码（至少 8 位），重置后及时在控制台修改，不要将密码写入脚本。

---

## 常见问题

### Q: 重置密码时报 LDAPS 连接失败？

重置密码强制走 LDAPS（636 端口）。请确认：
1. 域控已启用 LDAPS（需安装域控制器证书）
2. 网络防火墙开放 636 端口
3. 域控配置中 `insecureSkipVerify` 设为 `false` 时，证书需被服务端信任；测试环境可设为 `true`

### Q: 飞书登录后无法操作自己的账号？

飞书 OAuth 返回的 `account` 必须与 AD 中的 `sAMAccountName` 一致。请在飞书管理后台确保用户字段映射正确。

### Q: 定时禁用任务重启后丢失？

当前定时禁用使用进程内调度器，服务重启后未完成的定时任务不会自动恢复。生产环境如需持久化，建议升级为数据库任务表 + 后台 worker（已列入路线图）。

### Q: SQLite 数据库如何备份？

直接复制 `.db` 文件即可。建议在低峰期操作或使用 `sqlite3 ad-management.db ".backup '/path/to/backup.db'"`。

### Q: 如何修改监听端口？

设置环境变量 `HTTP_ADDR=:9090`（示例），重启服务即可。Docker 部署时同时修改端口映射 `-p 9090:8080`。

### Q: 前端如何单独部署？

可将 `frontend/` 目录放到 Nginx / CDN 托管，并将 `/api/*` 反向代理到 Go 服务。在 `.env` 中设置 `FRONTEND_DIR=`（留空）可关闭 Go 内置的静态文件托管。

---

## 许可证

本项目为内部使用，未公开开源许可。
