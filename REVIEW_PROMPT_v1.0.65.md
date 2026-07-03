# Code Review Request - v1.0.65 (Issue #17 Fix)

## 审查目标

请审查 **v1.0.65** 版本的代码修改，重点关注 **Issue #17（凌晨2点晕倒导致主机卡住）** 的修复方案。

## 修改内容

### 1. 新增文件
- `docker/scripts/auto-handle-passout.sh` - 监控并自动处理凌晨2点晕倒事件

### 2. 修改文件
- `docker/Dockerfile` - 添加 auto-handle-passout.sh 的 COPY，版本号更新到 1.0.65
- `docker/scripts/entrypoint.sh` - 启动 auto-handle-passout.sh 后台脚本，版本号更新到 1.0.65
- `docker-compose.yml` - 镜像版本更新到 v1.0.65

## 审查重点

### ✅ 功能正确性
1. **日志监控逻辑**
   - 检测关键字是否准确：`passed out|exhausted|collapsed|fell asleep`
   - tail -50 行数是否足够捕获事件
   - grep 正则表达式是否正确

2. **自动处理流程**
   - F9 → 方向键移动 → Enter 的顺序是否合理
   - sleep 延迟时间是否合适（1s, 0.3s, 0.5s）
   - 是否会干扰正常游戏流程

3. **防重复机制**
   - 30 秒冷却时间是否足够
   - LAST_HANDLE_TIME 逻辑是否正确

### ⚠️ 潜在问题
1. **竞态条件**
   - 多个后台脚本同时按 F9 是否会冲突？
   - xdotool 并发调用是否安全？

2. **误触发风险**
   - 关键字检测是否会误判其他事件？
   - 是否需要更精确的时间判断（2AM = 2600）？

3. **资源占用**
   - 每 5 秒 tail + grep 是否会影响性能？
   - 是否需要优化为 inotify 监控？

4. **错误处理**
   - xdotool 不存在时的处理是否充分？
   - SMAPI 日志文件不存在时的处理？

### 🔍 代码质量
1. **脚本健壮性**
   - 是否需要添加更多错误处理？
   - 日志输出是否清晰？

2. **与其他脚本的协同**
   - 与 auto-enable-server.sh 的 F9 是否冲突？
   - 与 auto-handle-readycheck.sh 的 Enter 是否冲突？
   - 与 auto-reconnect-server.sh 的 F9 是否冲突？

3. **配置灵活性**
   - 是否需要环境变量控制启用/禁用？
   - CHECK_INTERVAL 是否需要可配置？

## 审查输出格式

请按以下格式输出审查结果：

```
### ✅ 通过项
- [项目名称]: 说明

### ⚠️ 需要注意
- [项目名称]: 问题描述 + 建议

### ❌ 必须修复
- [项目名称]: 严重问题 + 修复方案

### 💡 优化建议
- [项目名称]: 改进建议
```

## 相关文件路径

```
/root/puppy-stardew-server/docker/scripts/auto-handle-passout.sh
/root/puppy-stardew-server/docker/Dockerfile
/root/puppy-stardew-server/docker/scripts/entrypoint.sh
/root/puppy-stardew-server/docker-compose.yml
```

## 参考信息

- **Issue #17**: https://github.com/AmigaMeow/puppy-stardew-server/issues/17
- **用户反馈**: 凌晨2点时，加入的玩家会自动休息，但主机不会，导致游戏卡住
- **解决方案**: 按 F9 + 移动角色可以触发主机休息
