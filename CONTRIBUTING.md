# Contributing to Puppy Stardew Server

感谢您对Puppy Stardew Server项目的关注！

## 如何贡献

### 报告Bug

在提交Bug前，请：

1. **搜索现有Issue** - 确认问题未被报告
2. **收集信息**：
   - 完整的错误日志：`docker logs puppy-stardew > logs.txt`
   - Docker版本：`docker --version`
   - 操作系统信息
   - docker-compose.yml配置（删除敏感信息）
3. **创建Issue** - 使用Bug模板

### 提交功能请求

请说明：
- 功能的具体用途
- 为什么需要这个功能
- 可能的实现方案（可选）

### 提交Pull Request

1. **Fork项目**
2. **创建功能分支**：`git checkout -b feature/my-feature`
3. **开发并测试**
4. **提交变更**：遵循提交规范（见下文）
5. **推送到Fork**：`git push origin feature/my-feature`
6. **创建Pull Request**

## 开发环境设置

```bash
# 1. Clone仓库
git clone https://github.com/AmigaMeow/puppy-stardew-server.git
cd puppy-stardew-server

# 2. 设置Steam凭证（用于测试）
export STEAM_USERNAME="your_test_account"
export STEAM_PASSWORD="your_password"

# 3. 构建测试镜像
docker build -t test-stardew:dev -f docker/Dockerfile docker/

# 4. 运行测试
./tests/test-steam-guard.sh
```

## 代码规范

### Shell脚本

```bash
# ✓ 好的实践
function_name() {
    local variable="$1"

    if [ -z "$variable" ]; then
        log_error "Variable is empty"
        return 1
    fi

    echo "$variable"
}

# ❌ 避免
# - 不加引号的变量：echo $variable
# - 使用set -e而不是显式错误处理
# - 没有函数封装的长脚本
# - 缺少注释的复杂逻辑
```

### Dockerfile

```dockerfile
# ✓ 好的实践
RUN apt-get update && \
    apt-get install -y package && \
    rm -rf /var/lib/apt/lists/*

# ❌ 避免
# - 分开的RUN命令（增加层数）
# - 不清理apt缓存
# - 使用latest标签（无版本控制）
```

### 提交规范

```
类型(范围): 简短描述

详细描述（可选）

关联Issue: #123
```

**类型：**
- `feat`: 新功能
- `fix`: Bug修复
- `docs`: 文档更新
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例：**
```
fix(entrypoint): remove pipe to fix stdin blocking

Steam Guard input was blocked by pipe redirection.
Removed '| tee' to preserve stdin for user input.

Fixes: #42
```

## 测试要求

提交PR前请确保：

- [ ] 代码通过基本测试
- [ ] 添加了必要的注释
- [ ] 更新了相关文档
- [ ] 测试了Steam Guard流程（如果修改了entrypoint.sh）
- [ ] 测试了模组加载（如果修改了模组配置）

### 运行测试

```bash
# Steam Guard测试
./tests/test-steam-guard.sh

# 部署验证
./verify-deployment.sh

# 清理测试环境
./tests/cleanup-tests.sh
```

## 文档要求

修改代码时，请同时更新：

- **DEVELOPMENT.md** - 开发文档
- **README.md** - 用户文档
- **代码注释** - 复杂逻辑的说明

## 问题排查

遇到问题？查看：

1. **DEVELOPMENT.md** - 常见问题排查
2. **GitHub Issues** - 已知问题
3. **Docker logs** - `docker logs puppy-stardew`

## 行为准则

- 尊重所有贡献者
- 保持讨论专业和建设性
- 接受建设性批评
- 关注项目最佳利益

## 许可证

提交贡献表示您同意按照项目的MIT许可证授权您的贡献。

## 联系方式

- **Issues**: https://github.com/AmigaMeow/puppy-stardew-server/issues
- **Docker Hub**: https://hub.docker.com/r/truemanlive/puppy-stardew-server

---

感谢您的贡献！🎮
