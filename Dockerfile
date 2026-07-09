# ────────────────────────────────────────────────────────────
# AD Management — 多阶段 Dockerfile
# 纯 Go SQLite (modernc.org/sqlite)，无 CGO 依赖，可生成静态二进制
# ────────────────────────────────────────────────────────────

# ---- 构建阶段 ----
FROM golang:1.22-alpine AS builder

# 安装 git（go mod 可能需要）并设置工作目录
RUN apk add --no-cache git ca-certificates

WORKDIR /build

# 先复制依赖文件，利用 Docker 层缓存
COPY go.mod go.sum ./
RUN go mod download

# 复制源码
COPY . .

# 静态编译：CGO_ENABLED=0 确保纯静态链接（无 libc 依赖）
# -ldflags="-s -w" 去除调试信息，减小体积约 30%
# -trimpath 移除编译机路径信息
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags="-s -w" \
    -o ad-server \
    ./cmd/server

# 验证二进制
RUN ls -lh ad-server && ./ad-server -h 2>/dev/null || true

# ---- 运行阶段 ----
FROM alpine:3.19

# 安装运行时依赖：
# - ca-certificates: LDAPS 证书验证必需
# - tzdata: 时区数据，确保日志时间正确
RUN apk add --no-cache ca-certificates tzdata && \
    update-ca-certificates

# 创建非 root 运行用户
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# 复制二进制
COPY --from=builder /build/ad-server ./

# 复制前端静态资源
COPY --from=builder /build/frontend ./frontend

# 创建数据与日志目录（挂载点）
RUN mkdir -p /var/lib/ad-management /app/logs && \
    chown -R app:app /app /var/lib/ad-management

# 切换非 root 用户
USER app

# 暴露端口
EXPOSE 8080

# 声明数据卷（SQLite 数据库 + 日志）
VOLUME ["/var/lib/ad-management", "/app/logs"]

# 默认环境变量（可在 docker run / compose 中覆盖）
ENV HTTP_ADDR=:8080 \
    FRONTEND_DIR=frontend \
    DB_PATH=/var/lib/ad-management/ad-management.db \
    LOG_DIR=/app/logs \
    BOOTSTRAP_ADMIN_USERNAME=admin \
    BOOTSTRAP_ADMIN_PASSWORD=change-this-password

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

# 启动
ENTRYPOINT ["./ad-server"]
