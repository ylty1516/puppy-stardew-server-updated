# GPU 渲染支持修改审查提示词 (Issue #19)

## 审查背景

我们为 Stardew Valley 服务器添加了 GPU 硬件加速支持，以降低云服务器上的 CPU 占用。当前使用 Xvfb（软件渲染）导致 CPU 占用极高，现在支持通过 Xorg + GPU 进行硬件加速渲染。

## 修改目标

1. 支持 GPU 硬件加速（通过 Xorg + modesetting 驱动）
2. 保持向后兼容（自动回退到 Xvfb 软件渲染）
3. 用户可通过 `USE_GPU=true` 环境变量启用
4. 支持自定义分辨率（RESOLUTION_WIDTH/HEIGHT/REFRESH_RATE）

## 核心逻辑流程

```
启动流程：
1. Root 阶段：
   - 如果 USE_GPU=true 且 /dev/dri 可用 → 启动 Xorg :99
   - 否则 → 跳过，等待 steam 阶段

2. Steam 阶段：
   - 检测 Xorg 进程是否运行
   - 如果运行 → 使用 Xorg（GPU 加速）
   - 如果未运行 → 启动 Xvfb（软件渲染回退）

3. VNC 连接到当前 DISPLAY（:99）
```

## 需要审查的关键点

### 1. Dockerfile 审查要点

**文件路径**: `docker/Dockerfile`

检查项：
- [ ] 版本号是否正确更新为 1.0.64
- [ ] GPU 相关依赖包是否完整：
  - libgl1-mesa-dri, libgl1-mesa-glx, mesa-utils, libegl1-mesa
  - xserver-xorg-core, xserver-xorg-video-modesetting
  - x11-xserver-utils, x11-apps
- [ ] steam 用户是否加入 video 组：`usermod -aG video steam`
- [ ] 20-modesetting.conf 配置是否正确创建（modesetting 驱动 + glamor + DRI3）
- [ ] set-resolution.sh 是否正确 COPY
- [ ] 10-monitor.conf 是否正确 COPY 到 /etc/X11/xorg.conf.d/

**潜在问题**：
- 依赖包是否会导致镜像体积过大？
- 20-modesetting.conf 的 EOF heredoc 语法是否正确？

---

### 2. entrypoint.sh 审查要点

**文件路径**: `docker/scripts/entrypoint.sh`

检查项：
- [ ] 版本号是否更新为 1.0.64
- [ ] 分辨率环境变量默认值是否合理（1280x720@60Hz）
- [ ] `start_gpu_xorg()` 函数逻辑：
  - [ ] USE_GPU != true 时是否正确返回并跳过
  - [ ] /dev/dri 检测逻辑是否正确
  - [ ] Xorg 启动命令是否正确（-noreset +extension GLX +extension RANDR :99）
  - [ ] set-resolution.sh 调用是否正确传递参数
  - [ ] glxinfo 检测 OpenGL renderer 是否正确
- [ ] Root 阶段是否正确调用 `start_gpu_xorg "root"`
- [ ] `exec runuser` 是否正确传递 DISPLAY 环境变量
- [ ] Steam 阶段虚拟显示逻辑：
  - [ ] 是否正确检测 Xorg 进程（pgrep -x Xorg）
  - [ ] 回退到 Xvfb 的逻辑是否正确
  - [ ] Xvfb 启动命令是否使用动态分辨率变量
- [ ] VNC 启动是否使用动态 DISPLAY 变量（不再硬编码 :99）

**潜在问题**：
- Xorg 启动失败时是否会导致容器退出？（应该回退到 Xvfb）
- DISPLAY 环境变量传递是否会在 runuser 切换用户时丢失？
- set-resolution.sh 失败是否会阻塞启动？（应该只是警告）

---

### 3. docker-compose.yml 审查要点

**文件路径**: `docker-compose.yml`

检查项：
- [ ] 镜像版本是否仍为 v1.0.61（需要手动更新为 v1.0.64）
- [ ] 新增环境变量是否正确：
  - [ ] USE_GPU=${USE_GPU:-false}
  - [ ] RESOLUTION_WIDTH=${RESOLUTION_WIDTH:-1280}
  - [ ] RESOLUTION_HEIGHT=${RESOLUTION_HEIGHT:-720}
  - [ ] REFRESH_RATE=${REFRESH_RATE:-60}
- [ ] /dev/dri 设备映射注释是否清晰
- [ ] 注释是否说明需要取消注释才能启用 GPU

**潜在问题**：
- 镜像版本号是否需要更新？（当前仍为 v1.0.61）

---

### 4. .env.example 审查要点

**文件路径**: `.env.example`

检查项：
- [ ] USE_GPU 说明是否清晰（默认 false，需要 /dev/dri）
- [ ] 分辨率设置说明是否清晰
- [ ] 是否说明了启用 GPU 的要求（宿主机 /dev/dri + docker-compose.yml 映射）

**潜在问题**：
- 用户是否能清楚理解如何启用 GPU？

---

### 5. 已存在文件检查

**文件路径**:
- `docker/scripts/set-resolution.sh`
- `docker/config/10-monitor.conf`

检查项：
- [ ] set-resolution.sh 是否有执行权限
- [ ] set-resolution.sh 逻辑是否正确（xrandr 设置分辨率 + cvt 回退）
- [ ] 10-monitor.conf 配置是否正确（1280x720_60.00 + modesetting + glamor）

---

## 兼容性检查

### 向后兼容性
- [ ] USE_GPU 未设置或为 false 时，是否正常使用 Xvfb？
- [ ] /dev/dri 不存在时，是否正常回退到 Xvfb？
- [ ] 现有用户升级后是否无需修改配置即可正常运行？

### 错误处理
- [ ] Xorg 启动失败时是否有明确日志？
- [ ] set-resolution.sh 失败时是否只是警告而不阻塞？
- [ ] /dev/dri 权限不足时是否有清晰提示？

---

## 测试场景

### 场景 1: 默认行为（不启用 GPU）
```bash
# .env 中不设置 USE_GPU 或 USE_GPU=false
# docker-compose.yml 不映射 /dev/dri
docker compose up -d
```
**预期**：使用 Xvfb 软件渲染，与之前版本行为一致

### 场景 2: 启用 GPU（有 /dev/dri）
```bash
# .env 中设置 USE_GPU=true
# docker-compose.yml 取消注释 devices: - /dev/dri:/dev/dri
docker compose up -d
```
**预期**：使用 Xorg + GPU 硬件加速，日志显示 OpenGL renderer

### 场景 3: 启用 GPU（无 /dev/dri）
```bash
# .env 中设置 USE_GPU=true
# docker-compose.yml 不映射 /dev/dri
docker compose up -d
```
**预期**：检测到 /dev/dri 不可用，回退到 Xvfb，日志有警告

### 场景 4: 自定义分辨率
```bash
# .env 中设置
RESOLUTION_WIDTH=1920
RESOLUTION_HEIGHT=1080
REFRESH_RATE=60
docker compose up -d
```
**预期**：虚拟显示使用 1920x1080@60Hz

---

## 审查输出格式

请按以下格式输出审查结果：

```
## 审查结果

### ✅ 通过的检查项
- [列出所有通过的检查项]

### ⚠️ 需要注意的问题
- [列出潜在问题或改进建议]

### ❌ 发现的错误
- [列出明确的错误，需要修复]

### 📝 建议
- [其他建议或优化方向]

### 总体评价
[PASS / NEEDS_FIX / NEEDS_IMPROVEMENT]
```

---

## 参考实现

参考分支：`dezhishen/puppy-stardew-server` 的 `feat/xorg` 分支
- Dockerfile: https://github.com/dezhishen/puppy-stardew-server/blob/feat/xorg/docker/Dockerfile
- entrypoint.sh: https://github.com/dezhishen/puppy-stardew-server/blob/feat/xorg/docker/scripts/entrypoint.sh
