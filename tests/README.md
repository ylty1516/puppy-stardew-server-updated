# Test Suite

## 测试脚本说明

### test-steam-guard.sh
测试Steam Guard验证码输入流程

**用法：**
```bash
export STEAM_USERNAME="your_username"
export STEAM_PASSWORD="your_password"
./tests/test-steam-guard.sh
```

**测试内容：**
- 容器启动
- Steam Guard提示检测
- 验证码输入流程
- 游戏下载成功

### test-mod-loading.sh (TODO)
测试模组加载流程

### test-vnc-connection.sh (TODO)
测试VNC连接

### test-player-connection.sh (TODO)
测试玩家连接流程

## 运行所有测试

```bash
./tests/run-all-tests.sh
```

## 测试环境

测试需要：
- Docker
- 有效的Steam凭证
- 至少2GB磁盘空间
- 网络连接（下载游戏）

## 清理测试环境

```bash
./tests/cleanup-tests.sh
```
