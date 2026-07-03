# Development Guide

## 项目架构

### 核心组件

```
puppy-stardew-server/
├── docker/
│   ├── Dockerfile              # 镜像构建定义
│   ├── mods/                   # 预装模组
│   │   ├── AlwaysOnServer/     # 24/7运行模组
│   │   ├── AutoHideHost/       # 自动隐藏主机模组
│   │   └── ServerAutoLoad/     # 自动加载存档模组
│   └── scripts/
│       ├── entrypoint.sh       # 容器启动脚本（主要逻辑）
│       ├── log-monitor.sh      # 日志监控
│       ├── log-manager.sh      # 日志轮转
│       └── view-logs.sh        # 日志查看工具
├── tests/                      # 测试脚本
│   └── test-steam-guard.sh     # Steam Guard测试
├── quick-start.sh              # 一键部署脚本
├── verify-deployment.sh        # 部署验证脚本
└── docker-compose.yml          # Docker编排配置
```

### 启动流程

```
1. entrypoint.sh 启动
   ↓
2. 验证Steam凭证
   ↓
3. 修复libcurl兼容性
   ↓
4. 下载游戏（如果需要）
   ├─→ 需要Steam Guard？
   │   └─→ 等待用户通过docker attach输入验证码
   └─→ 直接下载
   ↓
5. 安装SMAPI
   ↓
6. 复制预装模组
   ↓
7. 启动Xvfb虚拟显示
   ↓
8. 启动VNC服务器（可选）
   ↓
9. 启动日志监控（可选）
   ↓
10. 启动游戏服务器（./StardewModdingAPI --server）
```

## 关键设计决策

### 1. Steam Guard处理

**v1.0.34及之前的问题：**
```bash
# ❌ 错误：使用管道阻断了stdin
steamcmd.sh ... 2>&1 | tee /tmp/log
```

**v1.0.35修复：**
```bash
# ✓ 正确：直接运行，保留stdin
steamcmd.sh ...
```

**原理：**
- Bash管道会重定向stdin到管道输入端
- steamcmd需要从终端读取验证码
- `docker attach`将用户终端连接到容器stdin
- 如果stdin被管道阻断，用户输入无法到达steamcmd

### 2. 用户权限

- 容器以`steam`用户（UID 1000）运行
- 数据卷必须由UID 1000:1000所有
- `init.sh`脚本负责初始化权限

### 3. 模组管理

**Always On Server：**
- 使游戏在没有玩家时继续运行
- 配置时间流速、睡眠时间等

**AutoHideHost：**
- 自动将主机玩家传送到沙漠(0,0)
- 避免主机角色影响游戏体验

**ServerAutoLoad：**
- 自动检测并加载Co-op存档
- 重启后自动恢复游戏状态
- ⚠️ 已知限制：需要VNC手动重新加载以初始化多人服务器

## 开发工作流

### 本地测试

```bash
# 1. 构建镜像
cd /root/github-puppy-stardew
docker build -t test-stardew:dev -f docker/Dockerfile docker/

# 2. 运行测试容器
docker run -it --rm \
  -e STEAM_USERNAME="test_user" \
  -e STEAM_PASSWORD="test_pass" \
  -e ENABLE_VNC=true \
  test-stardew:dev

# 3. 查看日志
docker logs -f <container_id>
```

### 测试Steam Guard流程

```bash
export STEAM_USERNAME="your_username"
export STEAM_PASSWORD="your_password"
./tests/test-steam-guard.sh
```

### 验证部署

```bash
# 运行验证脚本
./verify-deployment.sh

# 手动检查关键指标
docker logs puppy-stardew | grep -i "error"
docker logs puppy-stardew | grep "mod loaded"
docker exec puppy-stardew ps aux | grep -i smapi
```

## 常见问题排查

### Steam Guard卡住

**症状：** 输入验证码后无响应

**原因：** entrypoint.sh使用了管道（`| tee`），阻断stdin

**解决：** 使用v1.0.35+，已移除管道

### 游戏下载失败

**可能原因：**
1. Steam API速率限制
2. 网络超时
3. 磁盘空间不足
4. 权限问题（UID不是1000）

**排查步骤：**
```bash
# 检查磁盘空间
df -h

# 检查权限
ls -la data/

# 查看详细日志
docker logs puppy-stardew 2>&1 | grep -A 10 "download"
```

### 模组未加载

**检查步骤：**
```bash
# 1. 确认模组文件存在
docker exec puppy-stardew ls -la /home/steam/stardewvalley/Mods/

# 2. 查看SMAPI日志
docker exec puppy-stardew cat /home/steam/.config/StardewValley/ErrorLogs/SMAPI-latest.txt

# 3. 检查模组配置
docker exec puppy-stardew cat /home/steam/stardewvalley/Mods/AutoHideHost/manifest.json
```

## 发布流程

### 版本号规范

- v1.0.X：补丁版本（bug修复、小改进）
- v1.X.0：次版本（新功能、模组更新）
- vX.0.0：主版本（重大变更、架构改动）

### 发布检查清单

- [ ] 更新Dockerfile中的version标签
- [ ] 更新CLAUDE.md中的版本信息
- [ ] 测试Steam Guard流程
- [ ] 测试模组加载
- [ ] 测试VNC连接
- [ ] 验证玩家能够连接
- [ ] 更新README.md（如有文档变更）
- [ ] Git提交（不包含AI标记）
- [ ] 构建Docker镜像
- [ ] 推送到Docker Hub
- [ ] 创建GitHub Release（可选）

### 发布命令

```bash
VERSION="1.0.36"

# 1. Git提交
git add [files]
git commit -m "v${VERSION}: description"
git push origin main

# 2. 构建镜像
docker build -t truemanlive/puppy-stardew-server:v${VERSION} -f docker/Dockerfile docker/
docker tag truemanlive/puppy-stardew-server:v${VERSION} truemanlive/puppy-stardew-server:latest

# 3. 推送到Docker Hub
docker push truemanlive/puppy-stardew-server:v${VERSION}
docker push truemanlive/puppy-stardew-server:latest
```

## 代码规范

### Shell脚本

```bash
# 1. 使用明确的错误处理（不要用set -e）
if ! command; then
    log_error "Command failed"
    return 1
fi

# 2. 所有变量加引号
echo "$VARIABLE"

# 3. 使用函数封装重复逻辑
download_game() {
    local username="$1"
    # ...
}

# 4. 添加注释解释复杂逻辑
# This handles Steam Guard by preserving stdin
# 通过保留stdin处理Steam Guard
steamcmd.sh ...

# 5. 统一日志函数
log_info "Information message"
log_warn "Warning message"
log_error "Error message"
```

### Docker最佳实践

```dockerfile
# 1. 合并RUN命令减少层数
RUN apt-get update && \
    apt-get install -y package && \
    rm -rf /var/lib/apt/lists/*

# 2. 固定版本号
RUN wget -qO smapi.zip 'https://.../SMAPI-4.3.2-installer.zip'

# 3. 使用非root用户
USER steam

# 4. 清理缓存
RUN ... && rm -rf /tmp/*
```

## 性能优化

### 资源使用

- **内存：** ~1.5-2GB（基础）+ 玩家数×200MB
- **CPU：** 1-2核心
- **磁盘：** ~2GB游戏文件 + ~500MB SMAPI/mods
- **网络：** 上传 50-100 Kbps/玩家

### 优化建议

1. 禁用VNC可节省~50MB内存
2. 调整资源限制在docker-compose.yml
3. 使用SSD提升游戏加载速度
4. 考虑CDN加速客户端连接

## 安全考虑

### 敏感信息处理

- ❌ 永远不要将Steam凭证提交到Git
- ✓ 使用环境变量传递凭证
- ✓ .gitignore包含.env文件
- ✓ CLAUDE.md在.gitignore中

### 容器安全

- ✓ 以非root用户运行
- ✓ 只开放必要端口
- ✓ 使用只读挂载（如果可能）
- ⚠️ 定期更新基础镜像

## 贡献指南

### 提交Bug报告

请包含：
1. 完整的docker logs输出
2. docker-compose.yml配置
3. 系统信息（OS、Docker版本）
4. 复现步骤

### 提交功能请求

请说明：
1. 功能描述
2. 使用场景
3. 预期行为
4. 可选实现方案

### Pull Request规范

1. 描述清楚修改内容
2. 包含测试步骤
3. 更新相关文档
4. 遵循代码规范

## 未来改进计划

### 短期（已完成✓）

- [x] 修复stdin阻断问题
- [x] 简化entrypoint.sh逻辑
- [x] 添加部署验证脚本
- [x] 创建Steam Guard测试脚本

### 中期（进行中）

- [ ] 模块化entrypoint.sh（拆分为多个函数）
- [ ] 添加自动化测试CI/CD
- [ ] 改进错误消息（更友好的提示）
- [ ] 统一日志格式

### 长期（计划中）

- [ ] 支持多架构（ARM64）
- [ ] Web管理界面
- [ ] 自动备份系统
- [ ] 性能监控仪表板
- [ ] 插件系统（动态加载模组）

---

**最后更新：** 2025-11-04
**当前版本：** v1.0.35
