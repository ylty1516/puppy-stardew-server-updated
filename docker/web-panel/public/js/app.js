/**
 * Main Application - Navigation, WebSocket, Dashboard, all page logic
 */

// ─── Auth Check ──────────────────────────────────────────────────
(function authCheck() {
  if (!API.token) {
    window.location.href = '/login.html';
    return;
  }
  // Verify token
  API.get('/api/auth/verify').then(data => {
    if (!data || !data.valid) {
      window.location.href = '/login.html';
      return;
    }
    document.getElementById('app').style.display = 'flex';
    init();
  }).catch(() => {
    window.location.href = '/login.html';
  });
})();

// ─── Global State ────────────────────────────────────────────────
let ws = null;
let currentPage = 'dashboard';
let logAutoScroll = true;
let statusInterval = null;
let playersInterval = null;
let lastStatusData = null;
let backupStatusPoll = null;
let lastBackupStatus = null;
let panelUpdatePoll = null;
let lastPanelUpdateStatus = null;
let lastChangelogData = null;
let factoryResetPoll = null;
let lastFactoryResetStatus = null;
let uninstallPoll = null;
let lastUninstallStatus = null;
let lastModsData = null;
let lastServerRecommendations = null;

const STATUS_REFRESH_MS = 20000;
const PLAYERS_REFRESH_MS = 20000;
const BACKUP_STATUS_POLL_MS = 2000;
const CONTAINER_RECONNECT_POLL_MS = 2000;
const PANEL_UPDATE_POLL_MS = 3000;
const FACTORY_RESET_POLL_MS = 3000;
const UNINSTALL_POLL_MS = 3000;
const MOD_UPLOAD_MAX_MB = 100;

function detectTheme() {
  const saved = localStorage.getItem('panel_theme');
  if (saved === 'dark' || saved === 'light') {
    return saved;
  }

  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

let currentTheme = detectTheme();
document.documentElement.dataset.theme = currentTheme;

// ─── i18n ────────────────────────────────────────────────────────
function detectLanguage() {
  const saved = localStorage.getItem('panel_lang');
  if (saved === 'zh' || saved === 'en') {
    return saved;
  }

  return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

let currentLang = detectLanguage();
const translations = {
  zh: {
    'nav.dashboard': '仪表盘', 'nav.logs': '日志', 'nav.changelog': '更新日志', 'nav.diagnostics': '诊断', 'nav.terminal': '终端',
    'nav.players': '玩家', 'nav.saves': '存档', 'nav.config': '配置', 'nav.mods': '模组',
    'dash.status': '服务器状态', 'dash.players': '在线玩家', 'dash.uptime': '运行时间',
    'dash.gameDay': '游戏日期', 'dash.backups': '备份数量', 'dash.mods': '已加载Mod',
    'dash.resources': '系统资源', 'dash.quickActions': '快捷操作',
    'dash.details': '服务器详情', 'dash.joinIp': '联机 IP', 'dash.joinPort': '联机端口',
    'dash.joinable': '可加入状态', 'dash.joinHandshake': '加入握手', 'dash.connectionFreshness': '人数刷新', 'dash.modRuntime': 'Mod 生效状态', 'dash.orchestration': '编排状态', 'dash.worldFingerprint': '世界指纹', 'dash.eventProxy': '玩家事件代理', 'dash.autoPause': '自动暂停', 'dash.timePause': '游戏时间状态', 'dash.localIps': '容器 IP', 'dash.version': '版本', 'dash.scriptHealth': '自动化脚本',
    'dash.metricsPort': '监控端口', 'dash.events': '自动化事件',
    'dash.passout': '昏倒处理', 'dash.readyCheck': '准备检查', 'dash.offlineEvents': '离线恢复',
    'dash.joinHint': '游戏内通常只需要输入 IP 地址。', 'dash.portHint': '星露谷联机输入框里不要追加端口号。',
    'dash.healthy': '正常', 'dash.unhealthy': '异常',
    'dash.paused': '暂停游戏',
    'join.ready': '可加入', 'join.blocked': '不可加入',
    'joinHandshake.none': '暂无连接',
    'joinHandshake.sent_farmhand_list': '已发送席位列表',
    'joinHandshake.farmhand_requested': '玩家已选择席位',
    'joinHandshake.approved': '加入已批准',
    'joinHandshake.rejected_no_slots': '无可用席位',
    'joinHandshake.disconnected_after_farmhand_list': '席位列表后断开',
    'join.reason.ready': '联机层已初始化，玩家现在应该可以加入。',
    'join.reason.game_process_stopped': '游戏进程未运行，请启动或重启容器。',
    'join.reason.state_bridge_missing': '正在等待 SMAPI 状态桥写入状态。',
    'join.reason.state_bridge_stale': 'SMAPI 状态桥已过期，游戏可能冻结或 Mod 未继续写入。',
    'join.reason.world_not_ready': '存档尚未加载完成。',
    'join.reason.not_main_server': '当前客户端不是主机服务器。',
    'join.reason.multiplayer_not_initialized': '多人联机层未初始化，需要通过 VNC 走 Co-op 重新载入存档。',
    'join.reason.saving': '游戏正在保存，完成后再加入。',
    'join.reason.blocking_event': '房主处于阻塞事件中，可能需要推进或跳过事件。',
    'join.reason.menu_open': '房主有菜单打开，自动化会尝试处理；若持续存在请用 VNC 查看。',
    'join.reason.unknown': '可加入状态未知，请查看 SMAPI 日志。',
    'mod.state.active': '已生效', 'mod.state.stale': '已过期', 'mod.state.missing': '未检测到',
    'mod.state.stopped': '游戏未运行', 'mod.state.unknown': '未知',
    'mod.reason.active': 'AutoHideHost 正在实时写入状态桥。',
    'mod.reason.stale': '状态桥已经超过刷新窗口，Mod 可能卡住或游戏冻结。',
    'mod.reason.missing': '还没有检测到 AutoHideHost 状态桥，请确认 Mod 已加载。',
    'mod.reason.stopped': '游戏进程未运行，SMAPI Mod 不会生效。',
    'mod.reason.unknown': '无法确认 Mod 状态。',
    'mod.age': '更新于 {seconds} 秒前', 'mod.lastAutomation': '最近自动化 {type}（{result}）',
    'mod.success': '成功', 'mod.failed': '失败', 'mod.hostHidden': '房主已隐藏',
    'orch.state.INIT': '初始化', 'orch.state.VERIFYING': '校验中',
    'orch.state.LOADING': '载入中', 'orch.state.STABILIZING': '稳定中',
    'orch.state.RUNNING': '运行中', 'orch.state.DEGRADED': '降级',
    'orch.state.RECOVERING': '恢复中', 'orch.state.STOPPED': '已停止',
    'orch.note': '阶段：{phase}',
    'orch.blockers': '阻塞：{blockers}',
    'world.note': 'Mod {mods} 个，存档 {save}，SMAPI {smapi}',
    'world.changed': '指纹变化，更新或换 Mod 后请确认已有快照。',
    'world.unavailable': '世界指纹暂不可用。',
    'world.accept': '接受基线',
    'world.acceptConfirm': '确认已经备份，并把当前存档、Mod 和 SMAPI 组合设为新的世界指纹基线吗？',
    'eventProxy.state.idle': '等待玩家', 'eventProxy.state.disabled': '已关闭',
    'eventProxy.state.blocked': '被阻止', 'eventProxy.state.warping': '代理进图',
    'eventProxy.state.checking': '检查事件', 'eventProxy.state.event_active': '事件进行中',
    'eventProxy.state.complete': '已完成', 'eventProxy.state.failed': '失败',
    'eventProxy.note.disabled': '事件代理未启用，玩家进图不会触发房主代理检查。',
    'eventProxy.note.idle': '玩家进入大型 Mod 事件地点时，隐藏房主会自动代入同地点检查房主侧事件。',
    'eventProxy.note.active': '{player} 正在 {location} 触发代理检查，已运行 {seconds} 秒。',
    'eventProxy.note.last': '上次：{result}，{player} / {location}，{message}',
    'eventProxy.note.none': '还没有代理记录。',
    'autoPause.state.paused': '已自动暂停', 'autoPause.state.waiting': '等待空服',
    'autoPause.state.online': '有人在线', 'autoPause.state.disabled': '已关闭',
    'autoPause.state.manual_pause': '手动暂停中', 'autoPause.state.not_ready': '未就绪',
    'autoPause.state.blocked': '暂不切换', 'autoPause.state.startup_grace': '启动保护',
    'autoPause.note.disabled': '自动空服暂停未开启。',
    'autoPause.note.paused': '服务器无人在线，游戏内时间已冻结。',
    'autoPause.note.online': '检测到玩家在线，会保持游戏时间正常流动。',
    'autoPause.note.waiting': '服务器无人在线，正在等待 {seconds}/{delay} 秒后暂停。',
    'autoPause.note.manual': '管理员手动暂停优先，自动暂停不会覆盖它。',
    'autoPause.note.blocked': '当前状态不适合切换暂停：{reason}',
    'timePause.running': '正常流动',
    'timePause.paused': '已暂停',
    'timePause.source.running': '游戏内时间正在正常流动。',
    'timePause.source.manual': '管理员手动暂停已开启，游戏内时间被冻结。',
    'timePause.source.auto_empty': '自动空服暂停正在接管，当前无人在线导致时间冻结。',
    'timePause.source.single_menu': '单个真实玩家打开背包，本地上报 Mod 触发时间冻结。',
    'timePause.source.game': 'SMAPI 报告 Game1.paused=true，但没有匹配到面板暂停来源。',
    'timePause.source.inferred': '面板从日志或控制文件推断为暂停，等待 SMAPI 状态桥确认。',
    'timePause.reason': '原因：{reason}',
    'dash.viewLogs': '查看日志', 'dash.restart': '重启服务器', 'dash.backup': '立即备份', 'dash.updatePanel': '更新面板',
    'dash.pauseTime': '暂停时间', 'dash.resumeTime': '恢复时间',
    'dash.enableAutoPause': '开启自动暂停', 'dash.disableAutoPause': '关闭自动暂停',
    'dash.expansionInit': '大型Mod初始化', 'dash.hideHost': '重新隐藏房主',
    'dash.pauseHint': '手动暂停会冻结游戏内时间，所有在线玩家都会停在当前时间，直到你恢复。',
    'dash.expansionHint': '大型内容 Mod 事件由玩家事件代理自动检查；只有诊断明确显示菜单或事件卡住时，才需要手动查看房主画面。',
    'dash.pauseActive': '手动暂停已开启，游戏内时间会保持冻结。',
    'dash.autoPauseActive': '自动空服暂停已开启，无人在线超过延迟后会冻结游戏时间。',
    'dash.autoPauseInactive': '自动空服暂停已关闭，无人在线时游戏时间也会继续流动。',
    'dash.connectionTrusted': '状态桥实时刷新',
    'dash.connectionUntrusted': '没有可信实时人数',
    'dash.connectionAge': '来源 {source}，更新于 {seconds} 秒前。',
    'dash.connectionNoTime': '来源 {source}，尚无刷新时间。',
    'diag.title': '服务器健康检查',
    'diag.refresh': '刷新',
    'diag.exportReport': '导出崩溃报告',
    'diag.repair': '一键安全修复',
    'diag.repairRunning': '正在执行安全修复...',
    'diag.repairOk': '安全修复完成：已修复 {fixed} 项，失败 {failed} 项。',
    'diag.repairFail': '安全修复失败',
    'diag.repairResultTitle': '最近一次修复结果',
    'diag.repairBeforeAfter': '修复前 {before}，修复后 {after}',
    'diag.repairStatus.fixed': '已修复',
    'diag.repairStatus.ok': '正常',
    'diag.repairStatus.skipped': '跳过',
    'diag.repairStatus.failed': '失败',
    'diag.overall.ok': '整体正常',
    'diag.overall.warn': '需要留意',
    'diag.overall.error': '发现问题',
    'diag.summary': '正常 {ok} · 警告 {warn} · 错误 {error}',
    'diag.noChecks': '暂无检查结果',
    'diag.status.ok': '正常',
    'diag.status.warn': '警告',
    'diag.status.error': '错误',
    'diag.largeMods': '大型内容 Mod 剧情兼容',
    'term.title': 'SMAPI 控制台（非系统终端）', 'term.hint': '点击“连接”后会附着到正在运行的 SMAPI 进程。这里只能输入 SMAPI 命令或 Steam Guard 验证码，不能执行 Linux 命令。',
    'term.connect': '连接', 'term.disconnect': '断开', 'term.send': '发送', 'term.input': '输入 SMAPI 命令或 Steam Guard 验证码...',
    'players.title': '在线玩家', 'players.loading': '加载中...',
    'players.none': '当前没有在线玩家', 'players.online': '在线：{online}/{max}', 'players.farm': '农场：{farm}',
    'saves.title': '存档文件', 'saves.backups': '备份列表', 'saves.noFiles': '未找到存档文件', 'saves.noBackups': '未找到备份',
    'saves.backupNow': '立即备份', 'saves.unknown': '未知',
    'saves.upload': '上传存档', 'saves.uploading': '上传中...', 'saves.uploadHint': '上传星露谷存档 zip。面板会校验并解压到服务器存档目录，重启容器后可自动加载。',
    'saves.setDefaultAfterUpload': '上传后设为默认存档', 'saves.setDefault': '设为默认', 'saves.defaultBadge': '默认自动载入',
    'saves.restartHint': '重启 Docker 容器后生效。', 'saves.overwriteBackup': '已为同名旧存档创建备份：{name}',
    'saves.multipleImported': '压缩包包含多个存档，已导入但未自动设置默认存档。',
    'saves.backupRunning': '备份进行中，请勿重复点击或反复刷新页面。',
    'saves.backupCompleted': '最近一次备份已完成。',
    'saves.backupFailed': '最近一次备份失败。',
    'saves.backupProgress': '进度 {current}/{total} · {percent}%',
    'saves.backupStartedAt': '开始于 {time}',
    'saves.backupCompletedAt': '完成于 {time}',
    'saves.backupFile': '文件 {name}',
    'saves.backupSize': '大小 {size}',
    'config.password': '修改面板密码', 'config.currentPassword': '当前密码', 'config.newPassword': '新密码',
    'config.update': '更新', 'config.saveChanges': '保存更改', 'config.saveHint': '修改配置后点击保存，重启容器后生效。', 'mods.title': '已安装模组', 'mods.none': '未找到模组',
    'mods.custom': '自定义', 'mods.builtin': '内置',
    'mods.upload': '上传模组', 'mods.download': '下载', 'mods.delete': '删除', 'mods.confirmDelete': '确定要删除模组 {name} 吗？',
    'mods.clearCustom': '清空上传Mod',
    'mods.confirmClearCustom': '这会删除全部上传 Mod、已安装的自定义 Mod 和玩家 Mod 下载包。内置服务端 Mod 会保留。请输入 DELETE 确认删除 {count} 个上传 Mod。',
    'mods.confirmClearMismatch': '未输入 DELETE，已取消清空上传 Mod。',
    'mods.clearCustomOk': '上传 Mod 已清空。重启服务器后完全生效。',
    'mods.clearCustomEmpty': '当前没有上传 Mod 需要清理。',
    'mods.uploadHint': '选择 .zip 模组文件或多个 Mod 组合包', 'mods.uploading': '上传中...',
    'mods.uploadTooLarge': '文件过大（最大 {max}MB）',
    'mods.overwriting': '正在覆盖旧模组...',
    'mods.confirmOverwrite': '已存在同名或同文件夹模组 {name}。是否先自动备份并覆盖旧模组？',
    'mods.confirmOverwriteConflicts': '压缩包里的这些 Mod 已存在：{names}。是否先自动备份并覆盖？',
    'mods.uploadInstalled': '模组已上传并安装到游戏目录。重启服务器后会加载新模组。',
    'mods.uploadReplaced': '同名旧模组已备份并覆盖。重启服务器后会加载新版本。',
    'mods.uploadBundleInstalled': '组合包已导入 {count} 个 Mod 并安装到游戏目录。重启服务器后会加载。',
    'mods.uploadBundleReplaced': '组合包已备份并覆盖旧 Mod，共导入 {count} 个 Mod。重启服务器后会加载。',
    'mods.bulkGuideTitle': '大量 Mod 一次性导入',
    'mods.bulkGuide': '把多个 Mod 文件夹一起压成一个 zip，压缩包内每个 Mod 文件夹都要包含 manifest.json。上传后服务器会自动解压、安装并重建玩家 Mod 包。',
    'mods.uploadNoManifest': '模组压缩包已上传，但未找到 manifest.json，请检查压缩包结构。',
    'mods.uploadFallback': '模组压缩包已上传，但自动安装失败。重启后仍会尝试从压缩包安装。',
    'mods.deleteNeedsRestart': '模组已删除。重启服务器后将完全卸载。',
    'mods.clientPack': '下载玩家 Mod 包',
    'mods.clientPackHint': '上传或删除 Mod 后会自动整合玩家下载包，服务器专用 Mod 会自动排除。',
    'mods.clientRequired': '玩家需安装',
    'mods.serverOnly': '服务器专用',
    'mods.clientPackEmpty': '当前没有需要玩家本地安装的 Mod。',
    'mods.clientPackReady': '玩家下载包已整理：{count} 个 Mod。',
    'mods.clientPackStale': '玩家下载包需要刷新，点击下载时会自动重建。',
    'mods.clientPackMissing': '玩家下载包会在上传 Mod 后自动生成。',
    'mods.clientPackRebuilt': '玩家下载包已自动更新。',
    'mods.clientPackBuildFail': '玩家下载包自动整理失败：{reason}',
    'mods.backups': 'Mod 备份与回滚',
    'mods.publicPage': '玩家下载页',
    'mods.noBackups': '还没有 Mod 备份。上传或删除 Mod 前会自动创建。',
    'mods.backupCreated': '已创建回滚备份：{name}',
    'mods.rollback': '回滚',
    'mods.confirmRollback': '确定要回滚到这个 Mod 备份吗？当前 Mod 状态会先自动保存一份安全备份。',
    'mods.rollbackOk': 'Mod 已回滚。请重启服务器后生效。',
    'mods.rollbackFail': 'Mod 回滚失败',
    'toast.modClearCustomFail': '清空上传 Mod 失败',
    'toast.modUploadOk': '模组上传成功！重启服务器后生效。', 'toast.modUploadFail': '模组上传失败',
    'toast.modDeleteOk': '模组已删除', 'toast.modDeleteFail': '模组删除失败',
    'toast.modDownloadOk': '模组下载已开始。',
    'toast.modDownloadFail': '模组下载失败',
    'toast.modClientPackOk': '玩家 Mod 包已开始下载。',
    'toast.modClientPackFail': '玩家 Mod 包下载失败',
    'toast.reportOk': '崩溃报告已开始下载。',
    'toast.reportFail': '崩溃报告导出失败',
    'config.group.Steam': 'Steam 设置', 'config.group.VNC': 'VNC 设置',
    'config.group.Display': '显示设置', 'config.group.Performance': '性能优化',
    'config.group.Backup': '备份设置', 'config.group.Stability': '稳定性',
    'config.group.Monitoring': '监控', 'config.group.Panel': '面板性能', 'config.group.Game': '游戏', 'config.group.Other': '其他',
    'config.autoDetect': '自动检测',
    'config.readonlySecret': '由 Docker Secrets 管理，面板中不可修改。',
    'config.help.SAVE_NAME': '选择要自动加载的现有存档。留空时将使用默认存档加载逻辑。',
    'config.help.BACKUP_COMPRESSION_LEVEL': 'gzip 压缩级别，范围 1-9。1 占用 CPU 最低、备份更快，但文件会更大。',
    'config.help.PUBLIC_IP': '公网联机时填写你的公网 IP 或域名。留空时仪表盘会显示当前访问面板所用的地址，或容器检测到的内网 IP。',
    'config.help.STEAM_USERNAME': '非 Docker Secrets 模式下可直接修改 Steam 登录账号。保存后重启容器生效。',
    'config.help.STEAM_PASSWORD': '可在这里写入新的 Steam 密码。出于安全原因不会回显旧密码；留空表示保持现有密码不变。',
    'config.help.PANEL_WORLD_HASH_MODE': 'manifest 只检查 Mod 清单和版本，适合小服务器；full 会遍历更多文件，适合排查兼容性。',
    'config.help.PANEL_STATUS_CACHE_MS': '状态接口缓存时间。数值越大，面板越省 CPU；数值越小，刷新更灵敏。',
    'config.help.PANEL_STATUS_HISTORY_LIMIT': '仪表盘资源历史保留点数。小服务器建议降低。',
    'config.help.PANEL_PLAYER_HISTORY_LIMIT': '在线人数历史保留点数。不会影响真实在线人数检测，只影响面板历史数据。',
    'config.help.PANEL_LOG_TAIL_BYTES': '单次读取日志尾部的字节数。大型日志上调会更完整，但会多占内存和 CPU。',
    'config.help.PANEL_LOG_DEFAULT_LINES': '日志页默认显示行数。',
    'config.help.PANEL_LOG_MAX_LINES': '日志页允许显示的最大行数。',
    'config.help.PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS': '玩家 Mod 公共清单缓存时间。数值越大，玩家下载页越省资源。',
    'config.help.PANEL_MOD_EXTRACT_TIMEOUT_MS': '上传 Mod 组合包时，面板等待解压完成的最长时间。服务器慢或组合包大时可以适当调高。',
    'config.help.PANEL_COMMAND_TIMEOUT_MS': '面板执行轻量诊断命令的超时时间。小服务器建议保持较低。',
    'recommend.title': '服务器配置推荐',
    'recommend.refresh': '重新检测',
    'recommend.apply': '应用到表单',
    'recommend.copy': '复制 .env',
    'recommend.loading': '正在检测服务器硬件和 Mod 压力...',
    'recommend.loadFail': '读取推荐配置失败',
    'recommend.generated': '生成于 {time}',
    'recommend.tier': '推荐档位',
    'recommend.cpu': 'CPU',
    'recommend.memory': '内存',
    'recommend.disk': '可用磁盘',
    'recommend.mods': 'Mod 压力',
    'recommend.modCount': '{count} 个 Mod',
    'recommend.largeMods': '大型 Mod：{mods}',
    'recommend.noLargeMods': '未检测到已知大型内容 Mod',
    'recommend.changeCount': '{count} 项建议与当前配置不同',
    'recommend.allApplied': '当前配置已经符合推荐项',
    'recommend.needsSave': '已应用到表单，点击“保存更改”并重启容器后生效。',
    'recommend.copyOk': '推荐配置已复制。',
    'recommend.copyFail': '复制失败，请手动选择 .env 内容。',
    'update.title': '面板一键更新',
    'update.button': '一键更新',
    'update.runningButton': '更新中',
    'update.refresh': '刷新状态',
    'update.idle': '当前没有更新任务',
    'update.hint': '会先备份关键配置和存档，再拉取最新版代码并重建 Docker，data 目录会保留。',
    'update.confirm': '确定现在更新面板吗？更新过程中面板可能短暂断开，稍等后会自动恢复。',
    'update.started': '更新任务已开始，请不要反复点击。',
    'update.startFail': '启动更新失败',
    'update.statusFail': '读取更新状态失败',
    'update.reconnecting': '更新过程中面板暂时断开，正在等待服务恢复。',
    'update.state.idle': '未开始',
    'update.state.running': '更新中',
    'update.state.succeeded': '更新完成',
    'update.state.failed': '更新失败',
    'update.state.unknown': '状态未知',
    'update.phase.idle': '空闲',
    'update.phase.queued': '排队中',
    'update.phase.queued_timeout': '排队超时',
    'update.phase.status_read_failed': '状态读取失败',
    'update.phase.manager_unavailable': '管理容器不可达',
    'update.phase.backup': '备份中',
    'update.phase.download': '拉取代码',
    'update.phase.prepare': '准备配置',
    'update.phase.rebuild': '重建服务',
    'update.phase.complete': '完成',
    'update.meta': '阶段：{phase} · 更新时间：{time}',
    'update.backupDir': '备份目录：{path}',
    'update.exitCode': '退出码：{code}',
    'update.managerUnavailable': '更新管理容器不可达',
    'maintenance.title': '危险操作',
    'maintenance.factoryReset': '出厂化重置游戏',
    'maintenance.runningButton': '重置中',
    'maintenance.refresh': '刷新状态',
    'maintenance.idle': '当前没有出厂化任务',
    'maintenance.hint': '会先备份存档和上传 Mod，再停止游戏容器、清理运行数据并重新创建服务器。',
    'maintenance.factoryResetHint': '会重置存档、游戏文件、上传 Mod、日志和运行控制文件；保留面板登录、Steam 缓存、备份和项目源码。',
    'maintenance.confirm': '危险操作：这会重置游戏运行数据并重启服务器。请输入 RESET 确认。',
    'maintenance.confirmMismatch': '未输入 RESET，已取消出厂化重置。',
    'maintenance.started': '出厂化重置已开始，面板可能会短暂断开。',
    'maintenance.startFail': '启动出厂化重置失败',
    'maintenance.statusFail': '读取出厂化状态失败',
    'maintenance.reconnecting': '出厂化重置过程中面板暂时断开，正在等待服务恢复。',
    'maintenance.uninstall': '卸载项目',
    'maintenance.uninstallRunningButton': '卸载中',
    'maintenance.uninstallRefresh': '刷新卸载状态',
    'maintenance.uninstallIdle': '当前没有卸载任务',
    'maintenance.uninstallHint': '只卸载本星露谷联机项目：停止并移除本项目容器、项目本地镜像和项目目录；不卸载 Docker，也不处理服务器其他项目。',
    'maintenance.uninstallConfirm': '危险操作：这会卸载整个星露谷联机项目并删除项目目录。Docker 和服务器其他项目不会被删除。请输入 UNINSTALL 确认。',
    'maintenance.uninstallConfirmMismatch': '未输入 UNINSTALL，已取消卸载。',
    'maintenance.uninstallStarted': '卸载任务已开始，面板随后会断开，这是正常现象。',
    'maintenance.uninstallStartFail': '启动卸载失败',
    'maintenance.uninstallStatusFail': '读取卸载状态失败',
    'maintenance.uninstallReconnecting': '卸载过程中面板会被移除，当前正在等待最后状态。',
    'maintenance.uninstall.state.idle': '未开始',
    'maintenance.uninstall.state.running': '卸载中',
    'maintenance.uninstall.state.succeeded': '卸载已执行',
    'maintenance.uninstall.state.failed': '卸载失败',
    'maintenance.uninstall.state.unknown': '状态未知',
    'maintenance.uninstall.phase.idle': '空闲',
    'maintenance.uninstall.phase.queued': '排队中',
    'maintenance.uninstall.phase.status_read_failed': '状态读取失败',
    'maintenance.uninstall.phase.manager_unavailable': '管理容器不可达',
    'maintenance.uninstall.phase.validate': '校验卸载范围',
    'maintenance.uninstall.phase.stop': '停止项目服务',
    'maintenance.uninstall.phase.remove_containers': '移除项目容器',
    'maintenance.uninstall.phase.remove_images': '移除项目镜像',
    'maintenance.uninstall.phase.remove_project': '删除项目目录',
    'maintenance.uninstall.phase.start_container': '启动执行容器',
    'maintenance.uninstall.phase.complete': '完成',
    'maintenance.state.idle': '未开始',
    'maintenance.state.running': '重置中',
    'maintenance.state.succeeded': '重置完成',
    'maintenance.state.failed': '重置失败',
    'maintenance.state.unknown': '状态未知',
    'maintenance.phase.idle': '空闲',
    'maintenance.phase.queued': '排队中',
    'maintenance.phase.status_read_failed': '状态读取失败',
    'maintenance.phase.manager_unavailable': '管理容器不可达',
    'maintenance.phase.backup': '备份中',
    'maintenance.phase.stop': '停止容器',
    'maintenance.phase.reset': '清理数据',
    'maintenance.phase.restart': '重启服务',
    'maintenance.phase.start_container': '启动执行容器',
    'maintenance.phase.complete': '完成',
    'login.subtitle': '服务器管理面板', 'login.password': '密码', 'login.button': '登录',
    'setup.title': '设置管理密码', 'setup.subtitle': '首次使用，请设置您的管理密码',
    'setup.password': '设置密码', 'setup.confirm': '确认密码', 'setup.button': '开始使用',
    'setup.minLength': '密码至少需要6个字符', 'setup.mismatch': '两次输入的密码不一致',
    'setup.success': '密码设置成功！', 'setup.failed': '设置失败',
    'status.running': '运行中', 'status.stopped': '已停止', 'status.checking': '检查中...',
    'logs.all': '全部', 'logs.errors': '错误', 'logs.mods': '模组', 'logs.server': '服务器', 'logs.game': '游戏',
    'logs.search': '搜索日志...', 'logs.auto': '自动', 'logs.clear': '清空',
    'logs.notFound': '日志文件尚未生成，服务器可能仍在启动中...',
    'logs.diagnostics': '诊断', 'logs.diagnosticsTitle': '日志诊断',
    'logs.noIssues': '未检测到已知问题', 'logs.issueCount': '{count} 个问题',
    'logs.cause': '原因', 'logs.action': '建议', 'logs.evidence': '证据',
    'logs.windowed': '显示最近日志窗口', 'logs.meta': '{shown}/{total} 行，来源 {file}',
    'changelog.title': '更新日志',
    'changelog.refresh': '刷新',
    'changelog.loading': '正在加载更新日志...',
    'changelog.empty': '暂时没有更新日志。',
    'changelog.meta': '来源 {file} · 更新于 {time}',
    'changelog.sourceFallback': 'Manager 暂不可用，显示本地缓存。',
    'changelog.loadFail': '更新日志加载失败',
    'toast.backupOk': '备份创建成功！', 'toast.backupFail': '备份失败',
    'toast.saveUploadOk': '存档上传成功。', 'toast.saveUploadDefaultOk': '存档上传成功，已设为默认自动载入存档。', 'toast.saveUploadFail': '存档上传失败',
    'toast.saveDefaultOk': '默认存档已更新。', 'toast.saveDefaultFail': '设置默认存档失败',
    'toast.backupStarted': '备份任务已在后台开始，可以离开当前页面。',
    'toast.backupRunning': '已有备份任务正在进行中。',
    'toast.restartOk': '重启指令已发送', 'toast.restartFail': '重启失败',
    'toast.containerRestarting': '容器正在重启，页面会自动重新连接。',
    'toast.containerRestartFail': '容器重启失败',
    'toast.pauseOn': '已开启手动暂停，游戏内时间即将冻结。',
    'toast.pauseOff': '已关闭手动暂停，游戏内时间将继续流动。',
    'toast.pauseFail': '切换手动暂停失败',
    'toast.autoPauseOn': '已开启自动空服暂停。',
    'toast.autoPauseOff': '已关闭自动空服暂停，若此前由自动暂停冻结会自动恢复。',
    'toast.autoPauseFail': '切换自动暂停失败',
    'toast.worldAcceptOk': '已接受当前世界指纹基线。',
    'toast.worldAcceptFail': '接受世界指纹基线失败',
    'toast.expansionInitOk': '已显示服务器房主并关闭自动跳过剧情。正常情况下优先使用玩家事件代理；此按钮只用于手动排障。',
    'toast.expansionInitFail': '大型Mod初始化启动失败',
    'toast.hideHostOk': '已发送重新隐藏房主命令。',
    'toast.hideHostFail': '重新隐藏房主失败',
    'toast.pwdOk': '密码修改成功', 'toast.pwdFail': '密码修改失败',
    'toast.configOk': '配置已保存，重启 Docker 容器后生效', 'toast.configFail': '配置保存失败',
    'toast.creatingBackup': '正在创建备份...', 'toast.passwordFields': '请填写两个密码字段',
    'actions.confirmRestart': '确定要重启服务器吗？',
    'config.restartTitle': '需要重启容器', 'config.restartMessage': '配置已保存。你可以现在直接重启 Docker 容器来应用这些更改；仪表盘里的“重启服务器”按钮仍然只负责重启游戏进程。', 'config.restartNow': '立即重启容器', 'config.restartLater': '稍后',
    'config.showPassword': '显示密码', 'config.hidePassword': '隐藏密码',
    'github.open': '打开项目 GitHub 仓库',
    'lang.toggle': '切换语言', 'logout.title': '退出登录',
    'theme.light': '切换到亮色模式', 'theme.dark': '切换到暗色模式',
  },
  en: {
    'nav.dashboard': 'Dashboard', 'nav.logs': 'Logs', 'nav.changelog': 'Changelog', 'nav.diagnostics': 'Diagnostics', 'nav.terminal': 'Terminal',
    'nav.players': 'Players', 'nav.saves': 'Saves', 'nav.config': 'Config', 'nav.mods': 'Mods',
    'dash.status': 'Server Status', 'dash.players': 'Online Players', 'dash.uptime': 'Uptime',
    'dash.gameDay': 'Game Day', 'dash.backups': 'Backups', 'dash.mods': 'Loaded Mods',
    'dash.resources': 'System Resources', 'dash.quickActions': 'Quick Actions',
    'dash.details': 'Server Details', 'dash.joinIp': 'Join IP', 'dash.joinPort': 'Join Port',
    'dash.joinable': 'Joinable', 'dash.joinHandshake': 'Join Handshake', 'dash.connectionFreshness': 'Player Refresh', 'dash.modRuntime': 'Mod Runtime', 'dash.orchestration': 'Orchestration', 'dash.worldFingerprint': 'World Fingerprint', 'dash.eventProxy': 'Player Event Proxy', 'dash.autoPause': 'Auto Pause', 'dash.timePause': 'Time State', 'dash.localIps': 'Container IPs', 'dash.version': 'Version', 'dash.scriptHealth': 'Automation',
    'dash.metricsPort': 'Metrics Port', 'dash.events': 'Automation Events',
    'dash.passout': 'Passout', 'dash.readyCheck': 'Ready Check', 'dash.offlineEvents': 'Offline Recovery',
    'dash.joinHint': 'In-game usually only needs the IP address.', 'dash.portHint': 'Do not append the port in Stardew\'s join field.',
    'dash.healthy': 'Healthy', 'dash.unhealthy': 'Unhealthy',
    'dash.paused': 'Paused',
    'join.ready': 'Ready', 'join.blocked': 'Not joinable',
    'joinHandshake.none': 'No attempt',
    'joinHandshake.sent_farmhand_list': 'Slot list sent',
    'joinHandshake.farmhand_requested': 'Farmhand requested',
    'joinHandshake.approved': 'Join approved',
    'joinHandshake.rejected_no_slots': 'No free slot',
    'joinHandshake.disconnected_after_farmhand_list': 'Disconnected after list',
    'join.reason.ready': 'The multiplayer layer is initialized. Players should be able to join now.',
    'join.reason.game_process_stopped': 'The game process is not running. Start or restart the container.',
    'join.reason.state_bridge_missing': 'Waiting for the SMAPI state bridge to write game state.',
    'join.reason.state_bridge_stale': 'The SMAPI state bridge is stale. The game may be frozen or the mod stopped writing state.',
    'join.reason.world_not_ready': 'The save has not finished loading.',
    'join.reason.not_main_server': 'This client is not acting as the main server.',
    'join.reason.multiplayer_not_initialized': 'The multiplayer layer is not initialized. Reload the save through Co-op via VNC.',
    'join.reason.saving': 'The game is saving. Wait for saving to finish.',
    'join.reason.blocking_event': 'The host is blocked by an event. Advance or skip it if players cannot move.',
    'join.reason.menu_open': 'The host has an open menu. Automation may handle it; use VNC if it persists.',
    'join.reason.unknown': 'Joinable state is unknown. Check SMAPI logs.',
    'mod.state.active': 'Active', 'mod.state.stale': 'Stale', 'mod.state.missing': 'Missing',
    'mod.state.stopped': 'Game stopped', 'mod.state.unknown': 'Unknown',
    'mod.reason.active': 'AutoHideHost is writing the state bridge in real time.',
    'mod.reason.stale': 'The state bridge is outside the refresh window. The mod may be stuck or the game may be frozen.',
    'mod.reason.missing': 'No AutoHideHost state bridge has been detected yet. Check whether the mod loaded.',
    'mod.reason.stopped': 'The game process is stopped, so SMAPI mods are not active.',
    'mod.reason.unknown': 'The mod runtime state cannot be confirmed.',
    'mod.age': 'updated {seconds}s ago', 'mod.lastAutomation': 'last automation {type} ({result})',
    'mod.success': 'success', 'mod.failed': 'failed', 'mod.hostHidden': 'host hidden',
    'orch.state.INIT': 'Init', 'orch.state.VERIFYING': 'Verifying',
    'orch.state.LOADING': 'Loading', 'orch.state.STABILIZING': 'Stabilizing',
    'orch.state.RUNNING': 'Running', 'orch.state.DEGRADED': 'Degraded',
    'orch.state.RECOVERING': 'Recovering', 'orch.state.STOPPED': 'Stopped',
    'orch.note': 'Phase: {phase}',
    'orch.blockers': 'Blockers: {blockers}',
    'world.note': '{mods} mod(s), save {save}, SMAPI {smapi}',
    'world.changed': 'Fingerprint changed; confirm a snapshot exists after updates or mod changes.',
    'world.unavailable': 'World fingerprint is unavailable.',
    'world.accept': 'Accept Baseline',
    'world.acceptConfirm': 'Confirm that a backup exists and accept the current save, mod and SMAPI combination as the new world fingerprint baseline?',
    'eventProxy.state.idle': 'Waiting', 'eventProxy.state.disabled': 'Disabled',
    'eventProxy.state.blocked': 'Blocked', 'eventProxy.state.warping': 'Proxy warp',
    'eventProxy.state.checking': 'Checking', 'eventProxy.state.event_active': 'Event active',
    'eventProxy.state.complete': 'Complete', 'eventProxy.state.failed': 'Failed',
    'eventProxy.note.disabled': 'Event proxy is disabled, so player warps will not proxy-check host events.',
    'eventProxy.note.idle': 'When a player enters a large-mod event location, the hidden host will proxy-check host-side events.',
    'eventProxy.note.active': '{player} is proxy-checking {location}; active for {seconds}s.',
    'eventProxy.note.last': 'Last: {result}, {player} / {location}, {message}',
    'eventProxy.note.none': 'No proxy attempt yet.',
    'autoPause.state.paused': 'Auto paused', 'autoPause.state.waiting': 'Waiting empty',
    'autoPause.state.online': 'Players online', 'autoPause.state.disabled': 'Disabled',
    'autoPause.state.manual_pause': 'Manual pause', 'autoPause.state.not_ready': 'Not ready',
    'autoPause.state.blocked': 'Blocked', 'autoPause.state.startup_grace': 'Startup grace',
    'autoPause.note.disabled': 'Automatic empty-server pause is disabled.',
    'autoPause.note.paused': 'No players are online, so in-game time is frozen.',
    'autoPause.note.online': 'Players are online, so in-game time keeps moving.',
    'autoPause.note.waiting': 'No players online. Pausing after {seconds}/{delay}s.',
    'autoPause.note.manual': 'Manual pause has priority and will not be overridden.',
    'autoPause.note.blocked': 'Pause switching is blocked by the current state: {reason}',
    'timePause.running': 'Time running',
    'timePause.paused': 'Paused',
    'timePause.source.running': 'In-game time is moving normally.',
    'timePause.source.manual': 'Manual pause is enabled by the panel, so in-game time is frozen.',
    'timePause.source.auto_empty': 'Automatic empty-server pause is holding the game time frozen.',
    'timePause.source.single_menu': 'A solo real player opened their backpack and the reporter mod froze time.',
    'timePause.source.game': 'SMAPI reports Game1.paused=true, but no panel pause owner claimed it.',
    'timePause.source.inferred': 'The panel inferred a pause from logs or control files while waiting for the state bridge.',
    'timePause.reason': 'Reason: {reason}',
    'dash.viewLogs': 'View Logs', 'dash.restart': 'Restart Server', 'dash.backup': 'Backup Now', 'dash.updatePanel': 'Update Panel',
    'dash.pauseTime': 'Pause Time', 'dash.resumeTime': 'Resume Time',
    'dash.enableAutoPause': 'Enable Auto Pause', 'dash.disableAutoPause': 'Disable Auto Pause',
    'dash.expansionInit': 'Large Mod Init', 'dash.hideHost': 'Hide Host',
    'dash.pauseHint': 'Manual pause freezes in-game time for all connected players until you resume it.',
    'dash.expansionHint': 'Large content mod events are checked through the player event proxy. Only inspect the host screen when diagnostics report a stuck menu or event.',
    'dash.pauseActive': 'Manual pause is enabled. In-game time will stay frozen.',
    'dash.autoPauseActive': 'Automatic empty-server pause is enabled. Time freezes after the empty delay.',
    'dash.autoPauseInactive': 'Automatic empty-server pause is disabled. Time keeps moving when empty.',
    'dash.connectionTrusted': 'Live state bridge',
    'dash.connectionUntrusted': 'No trusted live count',
    'dash.connectionAge': 'Source {source}, updated {seconds}s ago.',
    'dash.connectionNoTime': 'Source {source}, no refresh time yet.',
    'diag.title': 'Server Health Check',
    'diag.refresh': 'Refresh',
    'diag.exportReport': 'Export Report',
    'diag.repair': 'Safe Repair',
    'diag.repairRunning': 'Running safe repair...',
    'diag.repairOk': 'Safe repair finished: fixed {fixed}, failed {failed}.',
    'diag.repairFail': 'Safe repair failed',
    'diag.repairResultTitle': 'Latest Repair Result',
    'diag.repairBeforeAfter': 'Before {before}, after {after}',
    'diag.repairStatus.fixed': 'Fixed',
    'diag.repairStatus.ok': 'OK',
    'diag.repairStatus.skipped': 'Skipped',
    'diag.repairStatus.failed': 'Failed',
    'diag.overall.ok': 'Healthy',
    'diag.overall.warn': 'Needs attention',
    'diag.overall.error': 'Problems found',
    'diag.summary': 'OK {ok} · Warnings {warn} · Errors {error}',
    'diag.noChecks': 'No check results yet',
    'diag.status.ok': 'OK',
    'diag.status.warn': 'Warn',
    'diag.status.error': 'Error',
    'diag.largeMods': 'Large Content Mod Events',
    'term.title': 'SMAPI Console (Not a System Shell)', 'term.hint': 'Click "Connect" to attach to the running SMAPI process. This accepts SMAPI commands and Steam Guard codes, not Linux shell commands.',
    'term.connect': 'Connect', 'term.disconnect': 'Disconnect', 'term.send': 'Send', 'term.input': 'Type a SMAPI command or Steam Guard code...',
    'players.title': 'Online Players', 'players.loading': 'Loading...',
    'players.none': 'No players online', 'players.online': 'Online: {online}/{max}', 'players.farm': 'Farm: {farm}',
    'saves.title': 'Save Files', 'saves.backups': 'Backups', 'saves.noFiles': 'No save files found', 'saves.noBackups': 'No backups found',
    'saves.backupNow': 'Backup Now', 'saves.unknown': 'unknown',
    'saves.upload': 'Upload Save', 'saves.uploading': 'Uploading...', 'saves.uploadHint': 'Upload a Stardew Valley save zip. The panel will validate it, extract it into the server save directory, and it can auto-load after a container restart.',
    'saves.setDefaultAfterUpload': 'Set imported save as default', 'saves.setDefault': 'Set Default', 'saves.defaultBadge': 'Auto-load Default',
    'saves.restartHint': 'Takes effect after restarting the Docker container.', 'saves.overwriteBackup': 'Created a backup for overwritten saves: {name}',
    'saves.multipleImported': 'The archive contained multiple saves, so the default save was not changed automatically.',
    'saves.backupRunning': 'Backup is in progress. Avoid repeated clicks or refreshes.',
    'saves.backupCompleted': 'The latest backup completed successfully.',
    'saves.backupFailed': 'The latest backup failed.',
    'saves.backupProgress': 'Progress {current}/{total} · {percent}%',
    'saves.backupStartedAt': 'Started at {time}',
    'saves.backupCompletedAt': 'Completed at {time}',
    'saves.backupFile': 'File {name}',
    'saves.backupSize': 'Size {size}',
    'config.password': 'Change Panel Password', 'config.currentPassword': 'Current password', 'config.newPassword': 'New password',
    'config.update': 'Update', 'config.saveChanges': 'Save Changes', 'config.saveHint': 'Save changes after editing configuration, then restart the container to apply.', 'mods.title': 'Installed Mods', 'mods.none': 'No mods found',
    'mods.custom': 'Custom', 'mods.builtin': 'Built-in',
    'mods.upload': 'Upload Mod', 'mods.download': 'Download', 'mods.delete': 'Delete', 'mods.confirmDelete': 'Are you sure you want to delete mod {name}?',
    'mods.clearCustom': 'Clear Uploaded Mods',
    'mods.confirmClearCustom': 'This removes all uploaded mods, installed custom mods, and the client mod pack. Built-in server mods stay installed. Type DELETE to confirm removing {count} uploaded mod(s).',
    'mods.confirmClearMismatch': 'DELETE was not entered, so uploaded mods were not cleared.',
    'mods.clearCustomOk': 'Uploaded mods cleared. Restart the server to fully apply.',
    'mods.clearCustomEmpty': 'There are no uploaded mods to clear.',
    'mods.uploadHint': 'Select a .zip mod file or multi-mod pack', 'mods.uploading': 'Uploading...',
    'mods.uploadTooLarge': 'File too large (max {max}MB)',
    'mods.overwriting': 'Overwriting old mod...',
    'mods.confirmOverwrite': 'A mod with this name or folder already exists: {name}. Back it up and overwrite it now?',
    'mods.confirmOverwriteConflicts': 'These mods in the archive already exist: {names}. Back them up and overwrite them now?',
    'mods.uploadInstalled': 'Mod uploaded and installed into the game Mods directory. Restart the server to load it.',
    'mods.uploadReplaced': 'The old mod was backed up and overwritten. Restart the server to load the new version.',
    'mods.uploadBundleInstalled': 'Mod pack imported {count} mods into the game Mods directory. Restart the server to load them.',
    'mods.uploadBundleReplaced': 'Old mods were backed up and replaced. Imported {count} mods. Restart the server to load them.',
    'mods.bulkGuideTitle': 'Bulk Mod Import',
    'mods.bulkGuide': 'Put multiple mod folders into one zip. Each mod folder must contain manifest.json. After upload, the server extracts, installs, and rebuilds the player mod pack automatically.',
    'mods.uploadNoManifest': 'Mod archive uploaded, but no manifest.json was found. Check the archive structure.',
    'mods.uploadFallback': 'Mod archive uploaded, but automatic installation failed. Restart may still install it from the archive.',
    'mods.deleteNeedsRestart': 'Mod deleted. Restart the server to fully unload it.',
    'mods.clientPack': 'Download Client Mod Pack',
    'mods.clientPackHint': 'Uploads and deletes automatically rebuild the client download pack. Server-only mods are excluded.',
    'mods.clientRequired': 'Client required',
    'mods.serverOnly': 'Server only',
    'mods.clientPackEmpty': 'No client-side mods need to be downloaded.',
    'mods.clientPackReady': 'Client pack ready: {count} mod(s).',
    'mods.clientPackStale': 'Client pack needs refresh; download will rebuild it automatically.',
    'mods.clientPackMissing': 'Client pack will be generated automatically after uploading mods.',
    'mods.clientPackRebuilt': 'Client mod pack was updated automatically.',
    'mods.clientPackBuildFail': 'Client mod pack rebuild failed: {reason}',
    'mods.backups': 'Mod Backups and Rollback',
    'mods.publicPage': 'Player download page',
    'mods.noBackups': 'No mod backups yet. Uploads and deletes create one automatically.',
    'mods.backupCreated': 'Rollback backup created: {name}',
    'mods.rollback': 'Rollback',
    'mods.confirmRollback': 'Rollback to this mod backup? The current mod state will be saved as a safety backup first.',
    'mods.rollbackOk': 'Mods rolled back. Restart the server to apply.',
    'mods.rollbackFail': 'Mod rollback failed',
    'toast.modClearCustomFail': 'Failed to clear uploaded mods',
    'toast.modUploadOk': 'Mod uploaded! Restart server to apply.', 'toast.modUploadFail': 'Mod upload failed',
    'toast.modDeleteOk': 'Mod deleted', 'toast.modDeleteFail': 'Mod delete failed',
    'toast.modDownloadOk': 'Mod download started.',
    'toast.modDownloadFail': 'Mod download failed',
    'toast.modClientPackOk': 'Client mod pack download started.',
    'toast.modClientPackFail': 'Client mod pack download failed',
    'toast.reportOk': 'Crash report download started.',
    'toast.reportFail': 'Crash report export failed',
    'config.group.Steam': 'Steam', 'config.group.VNC': 'VNC',
    'config.group.Display': 'Display', 'config.group.Performance': 'Performance',
    'config.group.Backup': 'Backup', 'config.group.Stability': 'Stability',
    'config.group.Monitoring': 'Monitoring', 'config.group.Panel': 'Panel Performance', 'config.group.Game': 'Game', 'config.group.Other': 'Other',
    'config.autoDetect': 'Auto-detect',
    'config.readonlySecret': 'Managed by Docker Secrets and cannot be edited in the panel.',
    'config.help.SAVE_NAME': 'Choose an existing save to auto-load. Leave it empty to use the default save loading behavior.',
    'config.help.BACKUP_COMPRESSION_LEVEL': 'gzip compression level from 1 to 9. Level 1 uses the least CPU and finishes faster, but creates larger backups.',
    'config.help.PUBLIC_IP': 'Enter your public IP or domain for internet play. Leave it empty to show the current panel host or the container-detected LAN IP instead.',
    'config.help.STEAM_USERNAME': 'In non-Secrets mode, you can update the Steam login account here. Takes effect after a container restart.',
    'config.help.STEAM_PASSWORD': 'Write a new Steam password here. The current password is never shown back; leave it empty to keep the existing password.',
    'config.help.PANEL_WORLD_HASH_MODE': 'manifest checks only mod manifests and versions for small servers; full walks more files for compatibility troubleshooting.',
    'config.help.PANEL_STATUS_CACHE_MS': 'Status API cache time. Higher values use less CPU; lower values refresh faster.',
    'config.help.PANEL_STATUS_HISTORY_LIMIT': 'Dashboard resource history retention. Lower this on small servers.',
    'config.help.PANEL_PLAYER_HISTORY_LIMIT': 'Online-player history retention. This does not affect real player detection, only panel history.',
    'config.help.PANEL_LOG_TAIL_BYTES': 'Bytes read from the tail of logs per request. Larger values show more context but use more memory and CPU.',
    'config.help.PANEL_LOG_DEFAULT_LINES': 'Default number of lines shown on the logs page.',
    'config.help.PANEL_LOG_MAX_LINES': 'Maximum number of lines allowed on the logs page.',
    'config.help.PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS': 'Cache time for the public player mod manifest. Higher values reduce load on the player download page.',
    'config.help.PANEL_MOD_EXTRACT_TIMEOUT_MS': 'Maximum time the panel waits while extracting an uploaded mod pack. Raise this for slow servers or large packs.',
    'config.help.PANEL_COMMAND_TIMEOUT_MS': 'Timeout for lightweight diagnostic commands. Keep it low on small servers.',
    'recommend.title': 'Server Configuration Recommendation',
    'recommend.refresh': 'Detect Again',
    'recommend.apply': 'Apply to Form',
    'recommend.copy': 'Copy .env',
    'recommend.loading': 'Detecting server hardware and mod pressure...',
    'recommend.loadFail': 'Failed to load recommendations',
    'recommend.generated': 'Generated at {time}',
    'recommend.tier': 'Recommended tier',
    'recommend.cpu': 'CPU',
    'recommend.memory': 'Memory',
    'recommend.disk': 'Free disk',
    'recommend.mods': 'Mod pressure',
    'recommend.modCount': '{count} mod(s)',
    'recommend.largeMods': 'Large mods: {mods}',
    'recommend.noLargeMods': 'No known large content mods detected',
    'recommend.changeCount': '{count} recommendation(s) differ from current config',
    'recommend.allApplied': 'Current config already matches the recommendation',
    'recommend.needsSave': 'Applied to the form. Click "Save Changes" and restart the container to take effect.',
    'recommend.copyOk': 'Recommended config copied.',
    'recommend.copyFail': 'Copy failed. Select the .env text manually.',
    'update.title': 'Panel Update',
    'update.button': 'One-click Update',
    'update.runningButton': 'Updating',
    'update.refresh': 'Refresh Status',
    'update.idle': 'No update running',
    'update.hint': 'Backs up key config and saves, pulls the latest code, rebuilds Docker, and keeps the data directory.',
    'update.confirm': 'Update the panel now? The panel may disconnect briefly and reconnect after the rebuild.',
    'update.started': 'Update started. Avoid repeated clicks.',
    'update.startFail': 'Failed to start update',
    'update.statusFail': 'Failed to read update status',
    'update.reconnecting': 'The panel disconnected during update. Waiting for service recovery.',
    'update.state.idle': 'Idle',
    'update.state.running': 'Updating',
    'update.state.succeeded': 'Updated',
    'update.state.failed': 'Failed',
    'update.state.unknown': 'Unknown',
    'update.phase.idle': 'Idle',
    'update.phase.queued': 'Queued',
    'update.phase.queued_timeout': 'Queued timeout',
    'update.phase.status_read_failed': 'Status read failed',
    'update.phase.manager_unavailable': 'Manager unreachable',
    'update.phase.backup': 'Backing up',
    'update.phase.download': 'Pulling code',
    'update.phase.prepare': 'Preparing config',
    'update.phase.rebuild': 'Rebuilding services',
    'update.phase.complete': 'Complete',
    'update.meta': 'Phase: {phase} · Updated: {time}',
    'update.backupDir': 'Backup: {path}',
    'update.exitCode': 'Exit code: {code}',
    'update.managerUnavailable': 'Update manager is unreachable',
    'maintenance.title': 'Danger Zone',
    'maintenance.factoryReset': 'Factory Reset Game',
    'maintenance.runningButton': 'Resetting',
    'maintenance.refresh': 'Refresh Status',
    'maintenance.idle': 'No factory reset running',
    'maintenance.hint': 'Creates a safety backup, stops the game container, clears runtime data, and recreates the server.',
    'maintenance.factoryResetHint': 'Resets saves, game files, uploaded mods, logs, and runtime control files while preserving panel login, Steam cache, backups, and project code.',
    'maintenance.confirm': 'Danger: this resets game runtime data and restarts the server. Type RESET to confirm.',
    'maintenance.confirmMismatch': 'RESET was not entered, so factory reset was cancelled.',
    'maintenance.started': 'Factory reset started. The panel may disconnect briefly.',
    'maintenance.startFail': 'Failed to start factory reset',
    'maintenance.statusFail': 'Failed to read factory reset status',
    'maintenance.reconnecting': 'The panel disconnected during factory reset. Waiting for service recovery.',
    'maintenance.uninstall': 'Uninstall Project',
    'maintenance.uninstallRunningButton': 'Uninstalling',
    'maintenance.uninstallRefresh': 'Refresh Uninstall',
    'maintenance.uninstallIdle': 'No uninstall running',
    'maintenance.uninstallHint': 'Only removes this Stardew co-op project: project containers, local project images, and the project folder. Docker itself and other server projects are not touched.',
    'maintenance.uninstallConfirm': 'Danger: this uninstalls the whole Stardew co-op project and deletes the project folder. Docker and other server projects will not be deleted. Type UNINSTALL to confirm.',
    'maintenance.uninstallConfirmMismatch': 'UNINSTALL was not entered, so uninstall was cancelled.',
    'maintenance.uninstallStarted': 'Uninstall started. The panel will disconnect shortly; that is expected.',
    'maintenance.uninstallStartFail': 'Failed to start uninstall',
    'maintenance.uninstallStatusFail': 'Failed to read uninstall status',
    'maintenance.uninstallReconnecting': 'The panel is being removed during uninstall. Waiting for final status.',
    'maintenance.uninstall.state.idle': 'Idle',
    'maintenance.uninstall.state.running': 'Uninstalling',
    'maintenance.uninstall.state.succeeded': 'Uninstall scheduled',
    'maintenance.uninstall.state.failed': 'Uninstall failed',
    'maintenance.uninstall.state.unknown': 'Unknown',
    'maintenance.uninstall.phase.idle': 'Idle',
    'maintenance.uninstall.phase.queued': 'Queued',
    'maintenance.uninstall.phase.status_read_failed': 'Status read failed',
    'maintenance.uninstall.phase.manager_unavailable': 'Manager unreachable',
    'maintenance.uninstall.phase.validate': 'Validating scope',
    'maintenance.uninstall.phase.stop': 'Stopping project services',
    'maintenance.uninstall.phase.remove_containers': 'Removing project containers',
    'maintenance.uninstall.phase.remove_images': 'Removing project images',
    'maintenance.uninstall.phase.remove_project': 'Deleting project folder',
    'maintenance.uninstall.phase.start_container': 'Starting runner',
    'maintenance.uninstall.phase.complete': 'Complete',
    'maintenance.state.idle': 'Idle',
    'maintenance.state.running': 'Resetting',
    'maintenance.state.succeeded': 'Reset complete',
    'maintenance.state.failed': 'Reset failed',
    'maintenance.state.unknown': 'Unknown',
    'maintenance.phase.idle': 'Idle',
    'maintenance.phase.queued': 'Queued',
    'maintenance.phase.status_read_failed': 'Status read failed',
    'maintenance.phase.manager_unavailable': 'Manager unreachable',
    'maintenance.phase.backup': 'Backing up',
    'maintenance.phase.stop': 'Stopping container',
    'maintenance.phase.reset': 'Clearing data',
    'maintenance.phase.restart': 'Restarting services',
    'maintenance.phase.start_container': 'Starting runner',
    'maintenance.phase.complete': 'Complete',
    'login.subtitle': 'Server Management Panel', 'login.password': 'Password', 'login.button': 'Login',
    'setup.title': 'Set Admin Password', 'setup.subtitle': 'First time setup - please create your admin password',
    'setup.password': 'Password', 'setup.confirm': 'Confirm Password', 'setup.button': 'Get Started',
    'setup.minLength': 'Password must be at least 6 characters', 'setup.mismatch': 'Passwords do not match',
    'setup.success': 'Password set successfully!', 'setup.failed': 'Setup failed',
    'status.running': 'Running', 'status.stopped': 'Stopped', 'status.checking': 'Checking...',
    'logs.all': 'All', 'logs.errors': 'Errors', 'logs.mods': 'Mods', 'logs.server': 'Server', 'logs.game': 'Game',
    'logs.search': 'Search logs...', 'logs.auto': 'Auto', 'logs.clear': 'Clear',
    'logs.notFound': 'Log file not found yet. Server may still be starting...',
    'logs.diagnostics': 'Diagnostics', 'logs.diagnosticsTitle': 'Log Diagnostics',
    'logs.noIssues': 'No known issues detected', 'logs.issueCount': '{count} issue(s)',
    'logs.cause': 'Cause', 'logs.action': 'Action', 'logs.evidence': 'Evidence',
    'logs.windowed': 'Showing recent log window', 'logs.meta': '{shown}/{total} lines from {file}',
    'changelog.title': 'Update Log',
    'changelog.refresh': 'Refresh',
    'changelog.loading': 'Loading changelog...',
    'changelog.empty': 'No changelog entries yet.',
    'changelog.meta': 'Source {file} · updated {time}',
    'changelog.sourceFallback': 'Manager is unavailable, showing the local fallback.',
    'changelog.loadFail': 'Failed to load changelog',
    'toast.backupOk': 'Backup created!', 'toast.backupFail': 'Backup failed',
    'toast.saveUploadOk': 'Save uploaded.', 'toast.saveUploadDefaultOk': 'Save uploaded and set as the default auto-load save.', 'toast.saveUploadFail': 'Save upload failed',
    'toast.saveDefaultOk': 'Default save updated.', 'toast.saveDefaultFail': 'Failed to set default save',
    'toast.backupStarted': 'Backup started in the background. You can leave this page.',
    'toast.backupRunning': 'A backup is already in progress.',
    'toast.restartOk': 'Restart initiated', 'toast.restartFail': 'Restart failed',
    'toast.containerRestarting': 'Container is restarting. This page will reconnect automatically.',
    'toast.containerRestartFail': 'Container restart failed',
    'toast.pauseOn': 'Manual pause enabled. In-game time will freeze shortly.',
    'toast.pauseOff': 'Manual pause disabled. In-game time will resume.',
    'toast.pauseFail': 'Failed to toggle manual pause',
    'toast.autoPauseOn': 'Automatic empty-server pause enabled.',
    'toast.autoPauseOff': 'Automatic empty-server pause disabled. An auto-held pause will be released.',
    'toast.autoPauseFail': 'Failed to toggle auto pause',
    'toast.worldAcceptOk': 'World fingerprint baseline accepted.',
    'toast.worldAcceptFail': 'Failed to accept world fingerprint baseline',
    'toast.expansionInitOk': 'Host is visible and automatic event skipping is disabled. Prefer the player event proxy for normal large mod events; use this only for manual troubleshooting.',
    'toast.expansionInitFail': 'Failed to start large mod initialization',
    'toast.hideHostOk': 'Hide-host command sent.',
    'toast.hideHostFail': 'Failed to hide host',
    'toast.pwdOk': 'Password changed', 'toast.pwdFail': 'Password change failed',
    'toast.configOk': 'Config saved. Restart the Docker container to apply.', 'toast.configFail': 'Failed to save config',
    'toast.creatingBackup': 'Creating backup...', 'toast.passwordFields': 'Please fill in both password fields',
    'actions.confirmRestart': 'Are you sure you want to restart the server?',
    'config.restartTitle': 'Container Restart Required', 'config.restartMessage': 'Configuration has been saved. You can restart the Docker container now to apply these changes; the dashboard "Restart Server" button still only restarts the game process.', 'config.restartNow': 'Restart Container Now', 'config.restartLater': 'Later',
    'config.showPassword': 'Show password', 'config.hidePassword': 'Hide password',
    'github.open': 'Open project GitHub repository',
    'lang.toggle': 'Switch language', 'logout.title': 'Log out',
    'theme.light': 'Switch to light mode', 'theme.dark': 'Switch to dark mode',
  },
};

function t(key) {
  return (translations[currentLang] && translations[currentLang][key]) || key;
}

function tf(key, params = {}) {
  return Object.entries(params).reduce(
    (result, [param, value]) => result.replace(`{${param}}`, value),
    t(key)
  );
}

function icon(name, className = 'icon') {
  return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function statusOrb(state) {
  return `<span class="status-orb ${state}" aria-hidden="true"></span>`;
}

function statusDot(state) {
  return `<span class="status-dot ${state}" aria-hidden="true"></span>`;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function setTone(el, tone) {
  if (!el) return;
  el.classList.toggle('ok', tone === 'ok');
  el.classList.toggle('warn', tone === 'warn');
  el.classList.toggle('error', tone === 'error');
}

function applyTheme() {
  document.documentElement.dataset.theme = currentTheme;
  const themeIcon = document.querySelector('#themeToggle use');
  if (themeIcon) {
    themeIcon.setAttribute('href', currentTheme === 'dark' ? '#icon-theme-light' : '#icon-theme-dark');
  }
  const toggle = document.getElementById('themeToggle');
  if (toggle) {
    toggle.setAttribute('title', t(currentTheme === 'dark' ? 'theme.light' : 'theme.dark'));
  }
}

function applyTranslations() {
  document.documentElement.lang = currentLang === 'zh' ? 'zh-CN' : 'en';
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
  document.getElementById('pageTitle').textContent = t(`nav.${currentPage}`) || t('nav.dashboard');
  applyTheme();
  if (lastStatusData) {
    updateDashboardUI(lastStatusData);
  }
  if (lastBackupStatus) {
    renderBackupStatus(lastBackupStatus);
  }
  if (lastPanelUpdateStatus) {
    renderPanelUpdateStatus(lastPanelUpdateStatus);
  }
  if (lastFactoryResetStatus) {
    renderFactoryResetStatus(lastFactoryResetStatus);
  }
  if (lastUninstallStatus) {
    renderUninstallStatus(lastUninstallStatus);
  }
  if (lastChangelogData) {
    renderChangelog(lastChangelogData);
  }
  if (lastServerRecommendations) {
    renderServerRecommendations(lastServerRecommendations);
  }
}

// ─── Init ────────────────────────────────────────────────────────
function init() {
  applyTheme();
  applyTranslations();
  setupNavigation();
  setupWebSocket();
  loadDashboard();
  loadBackupStatus();
  loadPanelUpdateStatus(true);
  loadUninstallStatus(true);

  // Logout
  document.getElementById('logoutBtn').onclick = () => {
    localStorage.removeItem('panel_token');
    window.location.href = '/login.html';
  };

  // Language toggle
  document.getElementById('langToggle').onclick = () => {
    currentLang = currentLang === 'en' ? 'zh' : 'en';
    localStorage.setItem('panel_lang', currentLang);
    applyTranslations();
    reloadCurrentPage();
  };

  document.getElementById('themeToggle').onclick = () => {
    currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('panel_theme', currentTheme);
    applyTheme();
  };

  const acceptWorldFingerprintBtn = document.getElementById('acceptWorldFingerprintBtn');
  if (acceptWorldFingerprintBtn) {
    acceptWorldFingerprintBtn.onclick = acceptWorldFingerprint;
  }

  // Mobile menu toggle
  document.getElementById('menuToggle').onclick = () => {
    document.getElementById('sidebar').classList.toggle('open');
  };

  // Log controls
  document.getElementById('logAutoScroll').onclick = () => {
    logAutoScroll = !logAutoScroll;
    document.getElementById('logAutoScroll').style.opacity = logAutoScroll ? '1' : '0.5';
  };

  document.getElementById('logClear').onclick = () => {
    document.getElementById('logOutput').innerHTML = '';
  };

  // Log filters
  document.querySelectorAll('.log-filter').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.log-filter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadLogs(btn.dataset.filter);
      subscribeToLogs(btn.dataset.filter);
    };
  });

  // Log search
  let searchTimeout;
  document.getElementById('logSearch').oninput = (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const activeFilter = document.querySelector('.log-filter.active')?.dataset.filter || 'all';
      loadLogs(activeFilter, e.target.value);
    }, 300);
  };

  // Auto-refresh dashboard
  statusInterval = setInterval(loadDashboard, STATUS_REFRESH_MS);
}

function reloadCurrentPage() {
  switch (currentPage) {
    case 'dashboard':
      if (lastStatusData) {
        updateDashboardUI(lastStatusData);
      } else {
        loadDashboard();
      }
      break;
    case 'logs':
      loadLogs(
        document.querySelector('.log-filter.active')?.dataset.filter || 'all',
        document.getElementById('logSearch')?.value || ''
      );
      break;
    case 'changelog':
      if (lastChangelogData) {
        renderChangelog(lastChangelogData);
      } else {
        loadChangelog();
      }
      break;
    case 'diagnostics':
      loadDiagnostics();
      break;
    case 'players':
      loadPlayers();
      break;
    case 'saves':
      loadSaves();
      break;
    case 'config':
      loadConfig();
      loadPanelUpdateStatus(true);
      loadFactoryResetStatus(true);
      loadUninstallStatus(true);
      break;
    case 'mods':
      loadMods();
      break;
    default:
      break;
  }
}

function startPlayersAutoRefresh() {
  stopPlayersAutoRefresh();
  loadPlayers();
  playersInterval = setInterval(() => {
    if (currentPage === 'players') {
      loadPlayers();
    }
  }, PLAYERS_REFRESH_MS);
}

function stopPlayersAutoRefresh() {
  if (playersInterval) {
    clearInterval(playersInterval);
    playersInterval = null;
  }
}

// ─── Navigation ──────────────────────────────────────────────────
function setupNavigation() {
  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.onclick = () => navigateTo(item.dataset.page);
  });
  // Mobile nav
  document.querySelectorAll('.mob-nav-item').forEach(item => {
    item.onclick = () => navigateTo(item.dataset.page);
  });
}

function navigateTo(page) {
  currentPage = page;
  stopPlayersAutoRefresh();

  // Update sidebar active
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  document.querySelectorAll('.mob-nav-item').forEach(i => i.classList.remove('active'));
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelector(`.mob-nav-item[data-page="${page}"]`)?.classList.add('active');

  // Show page
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`)?.classList.add('active');

  // Update title
  const titleMap = {
    dashboard: t('nav.dashboard'), logs: t('nav.logs'), changelog: t('nav.changelog'), diagnostics: t('nav.diagnostics'), terminal: t('nav.terminal'),
    players: t('nav.players'), saves: t('nav.saves'), config: t('nav.config'), mods: t('nav.mods'),
  };
  document.getElementById('pageTitle').textContent = titleMap[page] || page;

  // Close mobile sidebar
  document.getElementById('sidebar').classList.remove('open');

  // Load page data
  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'logs': loadLogs('all'); subscribeToLogs('all'); break;
    case 'changelog': loadChangelog(); break;
    case 'diagnostics': loadDiagnostics(); break;
    case 'players': startPlayersAutoRefresh(); break;
    case 'saves': loadSaves(); break;
    case 'config': loadConfig(); loadPanelUpdateStatus(true); loadFactoryResetStatus(true); loadUninstallStatus(true); break;
    case 'mods': loadMods(); break;
  }
}

// ─── WebSocket ───────────────────────────────────────────────────
function setupWebSocket() {
  if (ws) {
    ws.close();
  }

  ws = new WebSocket(API.getWsUrl());

  ws.onopen = () => {
    console.log('[WS] Connected');
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected, reconnecting in 5s...');
    setTimeout(setupWebSocket, 5000);
  };

  ws.onerror = () => {
    // Will trigger onclose
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'status':
      updateDashboardUI(msg.data);
      break;
    case 'log':
      appendLogLine(msg.line);
      break;
    case 'log:subscribed':
      // Already subscribed
      break;
    case 'terminal:output':
      appendTerminalOutput(msg.data);
      break;
    case 'terminal:opened':
      appendTerminalOutput(msg.data);
      document.getElementById('termInput').disabled = false;
      document.getElementById('termSendBtn').disabled = false;
      document.getElementById('termConnect').style.display = 'none';
      document.getElementById('termDisconnect').style.display = '';
      break;
    case 'terminal:closed':
      appendTerminalOutput(msg.data);
      document.getElementById('termInput').disabled = true;
      document.getElementById('termSendBtn').disabled = true;
      document.getElementById('termConnect').style.display = '';
      document.getElementById('termDisconnect').style.display = 'none';
      break;
    case 'terminal:error':
      appendTerminalOutput(`[Error] ${msg.data}\r\n`);
      break;
    case 'error':
      showToast(formatWsError(msg), 'error', 6500);
      break;
  }
}

// ─── Dashboard ───────────────────────────────────────────────────
async function loadDashboard() {
  const data = await API.get('/api/status');
  if (data) updateDashboardUI(data);
}

function updateDashboardUI(data) {
  lastStatusData = data;

  // Status
  const statusEl = document.getElementById('stat-status');
  const statusIcon = document.getElementById('stat-status-icon');
  const statusBadge = document.getElementById('serverStatus');

  if (data.gameRunning) {
    statusEl.textContent = t('status.running');
    statusIcon.innerHTML = statusOrb('online');
    statusBadge.innerHTML = `${statusDot('online')}<span>${t('status.running')}</span>`;
    statusBadge.className = 'status-badge online';
  } else {
    statusEl.textContent = t('status.stopped');
    statusIcon.innerHTML = statusOrb('offline');
    statusBadge.innerHTML = `${statusDot('offline')}<span>${t('status.stopped')}</span>`;
    statusBadge.className = 'status-badge offline';
  }

  // Players
  document.getElementById('stat-players').textContent =
    `${data.players?.online || 0}/${data.players?.max || 8}`;

  // Uptime
  document.getElementById('stat-uptime').textContent = formatUptime(data.uptime || 0);

  // Game day
  document.getElementById('stat-day').textContent = data.paused ? t('dash.paused') : (data.day || '--');

  // Backups & Mods
  document.getElementById('stat-backups').textContent = data.backupCount || 0;
  document.getElementById('stat-mods').textContent = data.modCount || 0;

  // CPU
  const cpu = Math.round(data.cpu || 0);
  document.getElementById('cpu-value').textContent = cpu + '%';
  const cpuBar = document.getElementById('cpu-bar');
  cpuBar.style.width = Math.min(cpu, 100) + '%';
  cpuBar.className = 'progress-fill' + (cpu > 80 ? ' danger' : cpu > 60 ? ' warn' : '');

  // RAM
  const memUsed = Math.round(data.memory?.used || 0);
  const memLimit = data.memory?.limit || 2048;
  const memPct = Math.round((memUsed / memLimit) * 100);
  document.getElementById('ram-value').textContent = `${memUsed} / ${memLimit} MB`;
  const ramBar = document.getElementById('ram-bar');
  ramBar.style.width = Math.min(memPct, 100) + '%';
  ramBar.className = 'progress-fill' + (memPct > 80 ? ' danger' : memPct > 60 ? ' warn' : '');

  const network = data.network || {};
  setText('detail-join-ip', network.joinIp || '--');
  setText('detail-join-port', `${network.joinPort || 24642}/UDP`);
  updateJoinabilityUI(data.joinability || { joinable: false, reason: 'unknown' });
  updateJoinHandshakeUI(data.joinHandshake || { stage: 'none' });
  updateConnectionFreshnessUI(data.connection || {});
  updateModRuntimeUI(data.modRuntime || { active: false, state: 'unknown' });
  updateOrchestrationUI(data.orchestration || { state: 'INIT', phase: 'initializing', blockers: [] });
  updateWorldFingerprintUI(data.worldState || { available: false });
  updateEventProxyUI(data.eventProxy || { enabled: false, state: 'unknown' });
  updateAutoPauseUI(data.autoPause || { enabled: false, state: 'unknown' });
  updateTimePauseUI(data.timePause || { paused: data.paused === true, source: data.paused ? 'inferred' : 'running' });
  setText('detail-local-ips', network.localIps && network.localIps.length ? network.localIps.join(', ') : '--');
  setText('detail-version', data.version || '--');
  setText('detail-script-health', data.scriptsHealthy ? t('dash.healthy') : t('dash.unhealthy'));
  setText('detail-metrics-port', network.metricsPort ? String(network.metricsPort) : '--');
  setText('detail-event-passout', String(data.events?.passout || 0));
  setText('detail-event-readycheck', String(data.events?.readycheck || 0));
  setText('detail-event-offline', String(data.events?.offline || 0));
  updateManualPauseUI(data.manualPause || { enabled: false });
}

function updateJoinabilityUI(joinability) {
  const value = document.getElementById('detail-joinable');
  const note = document.getElementById('detail-joinable-note');
  const joinable = joinability && joinability.joinable === true;
  const reason = joinability?.reason || 'unknown';
  const reasonText = translations[currentLang][`join.reason.${reason}`] || joinability?.label || reason;

  if (value) {
    value.textContent = joinable ? t('join.ready') : t('join.blocked');
    setTone(value, joinable ? 'ok' : 'warn');
  }

  if (note) {
    note.textContent = reasonText;
  }
}

function updateJoinHandshakeUI(handshake) {
  const value = document.getElementById('detail-join-handshake');
  const note = document.getElementById('detail-join-handshake-note');
  const stage = handshake?.stage || 'none';
  const label = translations[currentLang][`joinHandshake.${stage}`] || handshake?.label || stage;

  if (value) {
    value.textContent = label;
    const tone = stage === 'approved'
      ? 'ok'
      : (stage === 'rejected_no_slots' || stage === 'disconnected_after_farmhand_list' ? 'error' : 'warn');
    setTone(value, stage === 'none' ? '' : tone);
  }

  if (note) {
    const connectionId = handshake?.connectionId ? ` (${handshake.connectionId})` : '';
    note.textContent = `${handshake?.action || handshake?.label || '--'}${connectionId}`;
  }
}

function updateConnectionFreshnessUI(connection) {
  const value = document.getElementById('detail-connection-freshness');
  const note = document.getElementById('detail-connection-freshness-note');
  const trusted = connection && connection.trusted === true;
  const source = connection?.source || 'unknown';

  if (value) {
    value.textContent = trusted ? t('dash.connectionTrusted') : t('dash.connectionUntrusted');
    setTone(value, trusted ? 'ok' : 'warn');
  }

  if (note) {
    if (typeof connection?.ageSeconds === 'number') {
      note.textContent = tf('dash.connectionAge', {
        source,
        seconds: String(connection.ageSeconds),
      });
    } else {
      note.textContent = tf('dash.connectionNoTime', { source });
    }
  }
}

function updateModRuntimeUI(modRuntime) {
  const value = document.getElementById('detail-mod-runtime');
  const note = document.getElementById('detail-mod-runtime-note');
  const state = modRuntime?.state || 'unknown';
  const active = modRuntime && modRuntime.active === true;

  if (value) {
    value.textContent = t(`mod.state.${state}`);
    setTone(value, active ? 'ok' : state === 'stopped' ? 'error' : 'warn');
  }

  if (note) {
    const parts = [t(`mod.reason.${state}`)];
    if (typeof modRuntime?.ageSeconds === 'number') {
      parts.push(tf('mod.age', { seconds: modRuntime.ageSeconds }));
    }
    if (modRuntime?.lastAutomation?.type) {
      parts.push(tf('mod.lastAutomation', {
        type: modRuntime.lastAutomation.type,
        result: modRuntime.lastAutomation.success ? t('mod.success') : t('mod.failed'),
      }));
    }
    if (modRuntime?.hostHidden) {
      parts.push(t('mod.hostHidden'));
    }
    note.textContent = parts.filter(Boolean).join(' | ');
  }
}

function updateOrchestrationUI(orchestration) {
  const value = document.getElementById('detail-orchestration');
  const note = document.getElementById('detail-orchestration-note');
  const state = orchestration?.state || 'INIT';
  const blockers = Array.isArray(orchestration?.blockers) ? orchestration.blockers : [];
  const stateKey = `orch.state.${state}`;
  const stateLabel = t(stateKey) === stateKey ? state : t(stateKey);

  if (value) {
    value.textContent = stateLabel;
    setTone(value, state === 'RUNNING' ? 'ok' : (state === 'DEGRADED' || state === 'STOPPED' ? 'error' : 'warn'));
  }

  if (note) {
    const parts = [tf('orch.note', { phase: orchestration?.phase || '--' })];
    if (blockers.length > 0) {
      parts.push(tf('orch.blockers', { blockers: blockers.join(', ') }));
    }
    note.textContent = parts.join(' | ');
  }
}

function updateWorldFingerprintUI(worldState) {
  const value = document.getElementById('detail-world-fingerprint');
  const note = document.getElementById('detail-world-fingerprint-note');
  const button = document.getElementById('acceptWorldFingerprintBtn');
  const available = worldState && worldState.available === true;
  const changed = worldState?.binding?.changed === true;
  const fingerprint = worldState?.fingerprintShort || (worldState?.fingerprint ? String(worldState.fingerprint).slice(0, 12) : '');

  if (button) {
    button.hidden = !available || !changed;
    button.disabled = false;
  }

  if (value) {
    value.textContent = available ? (fingerprint || '--') : '--';
    setTone(value, !available ? 'warn' : changed ? 'warn' : 'ok');
  }

  if (note) {
    if (!available) {
      note.textContent = worldState?.error || t('world.unavailable');
      return;
    }

    const modCount = worldState?.modGraph?.modCount || 0;
    const selectedSave = worldState?.save?.selectedSave || '--';
    const smapiVersion = worldState?.smapiVersion || 'unknown';
    const parts = [tf('world.note', {
      mods: String(modCount),
      save: selectedSave,
      smapi: smapiVersion,
    })];
    if (changed) {
      parts.push(t('world.changed'));
    }
    note.textContent = parts.join(' | ');
  }
}

async function acceptWorldFingerprint() {
  if (!confirm(t('world.acceptConfirm'))) {
    return;
  }

  const button = document.getElementById('acceptWorldFingerprintBtn');
  if (button) button.disabled = true;

  try {
    const data = await API.post('/api/world/accept', {});
    if (data && data.success) {
      showToast(t('toast.worldAcceptOk'), 'success');
      if (data.worldState) {
        updateWorldFingerprintUI(data.worldState);
      }
      loadDashboard();
      return;
    }

    showToast(formatApiError(data, t('toast.worldAcceptFail')), 'error', 7000);
  } catch (error) {
    showToast(formatApiError({ error: error.message }, t('toast.worldAcceptFail')), 'error', 7000);
  } finally {
    if (button) button.disabled = false;
  }
}

function formatEventProxyState(state) {
  const key = `eventProxy.state.${state || 'unknown'}`;
  const label = t(key);
  return label === key ? (state || t('mod.state.unknown')) : label;
}

function updateEventProxyUI(eventProxy) {
  const value = document.getElementById('detail-event-proxy');
  const note = document.getElementById('detail-event-proxy-note');
  const enabled = eventProxy && eventProxy.enabled === true;
  const active = eventProxy && eventProxy.active === true;
  const state = enabled ? (eventProxy.state || 'idle') : 'disabled';

  if (value) {
    value.textContent = formatEventProxyState(state);
    setTone(value, !enabled ? 'warn' : active || state === 'complete' || state === 'idle' ? 'ok' : state === 'failed' ? 'error' : 'warn');
  }

  if (!note) return;

  if (!enabled) {
    note.textContent = t('eventProxy.note.disabled');
    return;
  }

  if (active) {
    note.textContent = tf('eventProxy.note.active', {
      player: eventProxy.playerName || '--',
      location: eventProxy.location || '--',
      seconds: String(Math.floor(eventProxy.activeSeconds || 0)),
    });
    return;
  }

  if (eventProxy.last) {
    note.textContent = tf('eventProxy.note.last', {
      result: eventProxy.last.success ? t('mod.success') : t('mod.failed'),
      player: eventProxy.last.playerName || '--',
      location: eventProxy.last.location || '--',
      message: eventProxy.last.message || eventProxy.reason || '--',
    });
    return;
  }

  note.textContent = state === 'idle' ? t('eventProxy.note.idle') : t('eventProxy.note.none');
}

function updateAutoPauseUI(autoPause) {
  const value = document.getElementById('detail-auto-pause');
  const note = document.getElementById('detail-auto-pause-note');
  const button = document.getElementById('autoPauseBtn');
  const label = document.getElementById('autoPauseBtnText');
  const state = autoPause?.state || (autoPause?.enabled ? 'waiting' : 'disabled');
  const enabled = autoPause?.enabled === true;
  const applied = autoPause?.applied === true;

  if (value) {
    const stateKey = `autoPause.state.${state}`;
    const stateLabel = t(stateKey);
    value.textContent = stateLabel === stateKey ? state : stateLabel;
    setTone(value, applied ? 'warn' : enabled ? 'ok' : 'warn');
  }

  if (button) {
    button.disabled = false;
    button.classList.toggle('auto-pause-active', enabled);
    button.classList.toggle('btn-success', enabled);
    button.classList.toggle('btn-warning', !enabled);
  }

  if (label) {
    label.textContent = enabled ? t('dash.disableAutoPause') : t('dash.enableAutoPause');
  }

  if (!note) return;

  if (!enabled || state === 'disabled') {
    note.textContent = t('dash.autoPauseInactive');
    return;
  }

  if (state === 'unknown' || state === 'startup_grace' || state === 'not_ready') {
    note.textContent = t('dash.autoPauseActive');
    return;
  }

  if (state === 'paused') {
    note.textContent = t('autoPause.note.paused');
    return;
  }

  if (state === 'online') {
    note.textContent = t('autoPause.note.online');
    return;
  }

  if (state === 'manual_pause') {
    note.textContent = t('autoPause.note.manual');
    return;
  }

  if (state === 'waiting') {
    note.textContent = tf('autoPause.note.waiting', {
      seconds: Math.floor(autoPause?.emptySeconds || 0),
      delay: autoPause?.delaySeconds || 0,
    });
    return;
  }

  note.textContent = tf('autoPause.note.blocked', {
    reason: autoPause?.controlError || autoPause?.reason || state,
  });
}

function updateTimePauseUI(timePause) {
  const value = document.getElementById('detail-time-pause');
  const note = document.getElementById('detail-time-pause-note');
  const paused = timePause && timePause.paused === true;
  const source = timePause?.source || (paused ? 'inferred' : 'running');
  const sourceKey = `timePause.source.${source}`;
  const sourceText = t(sourceKey) === sourceKey ? (timePause?.reason || source) : t(sourceKey);

  if (value) {
    value.textContent = paused ? t('timePause.paused') : t('timePause.running');
    setTone(value, paused ? 'warn' : 'ok');
  }

  if (note) {
    const parts = [sourceText];
    if (timePause?.reason && source !== 'running') {
      parts.push(tf('timePause.reason', { reason: timePause.reason }));
    }
    note.textContent = parts.filter(Boolean).join(' ');
  }
}

function updateManualPauseUI(manualPause) {
  const enabled = manualPause && manualPause.enabled === true;
  const button = document.getElementById('manualPauseBtn');
  const label = document.getElementById('manualPauseBtnText');
  const note = document.getElementById('manualPauseNote');

  if (button) {
    button.disabled = false;
    button.classList.toggle('manual-pause-active', enabled);
    button.dataset.enabled = enabled ? 'true' : 'false';
  }

  if (label) {
    label.textContent = enabled ? t('dash.resumeTime') : t('dash.pauseTime');
  }

  if (note) {
    note.classList.toggle('active', enabled);
    note.textContent = enabled ? t('dash.pauseActive') : t('dash.pauseHint');
  }
}

function formatUptime(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ─── Logs ────────────────────────────────────────────────────────
async function loadLogs(filter, search) {
  const params = new URLSearchParams({ type: filter || 'all', lines: 200 });
  if (search) params.set('search', search);

  const data = await API.get(`/api/logs?${params}`);
  if (!data) return;

  const output = document.getElementById('logOutput');
  const meta = document.getElementById('logMeta');
  output.innerHTML = '';

  if (data.error) {
    renderLogDiagnostics(null);
    if (meta) meta.textContent = '';
    output.innerHTML = `<div class="log-line error"><span class="log-text">${escapeHtml(formatApiError(data, 'Failed to load logs'))}</span></div>`;
    return;
  }

  renderLogDiagnostics(data.diagnostics);

  if (!data.exists) {
    if (meta) meta.textContent = '';
    output.innerHTML = `<div class="log-line info"><span class="log-text">${t('logs.notFound')}</span></div>`;
    return;
  }

  if (meta) {
    const shown = data.lines ? data.lines.length : 0;
    const total = data.total || 0;
    const base = tf('logs.meta', { shown: String(shown), total: String(total), file: data.file || '--' });
    meta.textContent = data.truncated ? `${base}. ${t('logs.windowed')}` : base;
  }

  for (const line of data.lines) {
    appendLogLine(line);
  }
}

function appendLogLine(line) {
  const output = document.getElementById('logOutput');
  const normalized = typeof line === 'string'
    ? { text: line, level: 'info', issueCode: '' }
    : (line || { text: '', level: 'info', issueCode: '' });
  const div = document.createElement('div');
  div.className = `log-line ${normalized.level || 'info'}`;

  if (normalized.issueCode) {
    const badge = document.createElement('span');
    badge.className = 'log-issue-badge';
    badge.textContent = normalized.issueCode;
    div.appendChild(badge);
  }

  const text = document.createElement('span');
  text.className = 'log-text';
  text.textContent = normalized.text || '';
  div.appendChild(text);
  output.appendChild(div);

  // Keep max 2000 lines
  while (output.children.length > 2000) {
    output.removeChild(output.firstChild);
  }

  if (logAutoScroll) {
    output.scrollTop = output.scrollHeight;
  }
}

function subscribeToLogs(filter) {
  wsSend({ type: 'subscribe', channel: 'logs', filter });
}

function renderLogDiagnostics(diagnostics) {
  const panel = document.getElementById('logDiagnostics');
  if (!panel) return;

  if (!diagnostics) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }

  const stats = diagnostics.stats || {};
  const issues = diagnostics.issues || [];
  const summary = document.createElement('div');
  summary.className = 'diagnostics-summary';
  summary.innerHTML =
    '<strong>' + escapeHtml(t('logs.diagnosticsTitle')) + '</strong>' +
    '<span class="diagnostics-counts">' +
      '<span>' + escapeHtml(tf('logs.issueCount', { count: String(issues.length) })) + '</span>' +
      '<span>errors ' + escapeHtml(String(stats.error || 0)) + '</span>' +
      '<span>warnings ' + escapeHtml(String(stats.warn || 0)) + '</span>' +
    '</span>';

  panel.innerHTML = '';
  panel.appendChild(summary);

  if (issues.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diagnostic-item info';
    empty.innerHTML =
      '<div class="diagnostic-title">' + escapeHtml(t('logs.noIssues')) + '</div>' +
      '<div class="diagnostic-body">' + escapeHtml(t('logs.action')) + ': ' +
      escapeHtml(currentLang === 'zh' ? '如果仍然异常，请查看 Errors 过滤器中的上下文。' : 'If behavior is still wrong, inspect the Errors filter for context.') +
      '</div>';
    panel.appendChild(empty);
  } else {
    issues.slice(0, 5).forEach(issue => panel.appendChild(renderDiagnosticIssue(issue)));
  }

  panel.hidden = false;
}

function renderDiagnosticIssue(issue) {
  const item = document.createElement('div');
  item.className = 'diagnostic-item ' + (issue.severity || 'info');
  const evidence = (issue.evidence || []).slice(0, 2).join('\n');
  item.innerHTML =
    '<div class="diagnostic-title">' +
      '<span>' + escapeHtml(issue.title || issue.code || 'Issue') + '</span>' +
      '<span class="diagnostic-code">' + escapeHtml(issue.code || '') + '</span>' +
      '<span class="diagnostic-code">x' + escapeHtml(String(issue.count || 1)) + '</span>' +
    '</div>' +
    '<div class="diagnostic-body">' +
      '<div><strong>' + escapeHtml(t('logs.cause')) + ':</strong> ' + escapeHtml(issue.cause || '') + '</div>' +
      '<div><strong>' + escapeHtml(t('logs.action')) + ':</strong> ' + escapeHtml(issue.action || '') + '</div>' +
      (evidence ? '<div><strong>' + escapeHtml(t('logs.evidence')) + ':</strong><div class="diagnostic-evidence">' + escapeHtml(evidence) + '</div></div>' : '') +
    '</div>';
  return item;
}

// ─── Changelog ──────────────────────────────────────────────────
async function loadChangelog() {
  const list = document.getElementById('changelogList');
  const meta = document.getElementById('changelogMeta');
  if (list) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t('changelog.loading')) + '</div>';
  }
  if (meta) {
    meta.textContent = '';
  }

  const data = await API.get('/api/changelog');
  if (!data) return;

  if (data.error) {
    lastChangelogData = null;
    if (list) {
      list.innerHTML = '<div class="empty-state">' + escapeHtml(formatApiError(data, t('changelog.loadFail'))) + '</div>';
    }
    return;
  }

  renderChangelog(data);
}

function renderChangelog(data) {
  lastChangelogData = data || null;
  const list = document.getElementById('changelogList');
  const meta = document.getElementById('changelogMeta');
  if (!list) return;

  const entries = Array.isArray(data?.entries) ? data.entries : [];
  if (meta) {
    const updatedAt = data?.updatedAt ? formatBackupTimestamp(data.updatedAt) : '--';
    const file = data?.file || 'CHANGELOG.md';
    const fallback = data?.managerError ? ' · ' + t('changelog.sourceFallback') : '';
    meta.textContent = tf('changelog.meta', { file, time: updatedAt }) + fallback;
  }

  if (entries.length === 0) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t('changelog.empty')) + '</div>';
    return;
  }

  list.innerHTML = entries.map(renderChangelogEntry).join('');
}

function renderChangelogEntry(entry) {
  const body = Array.isArray(entry.body) && entry.body.length > 0
    ? '<div class="changelog-body">' + entry.body.map(line => escapeHtml(line)).join('<br>') + '</div>'
    : '';
  const sections = Array.isArray(entry.sections)
    ? entry.sections.filter(section => section && Array.isArray(section.items) && section.items.length > 0)
    : [];

  return '<article class="changelog-entry">' +
    '<div class="changelog-entry-title">' + escapeHtml(entry.title || '--') + '</div>' +
    body +
    (sections.length > 0
      ? '<div class="changelog-sections">' + sections.map(renderChangelogSection).join('') + '</div>'
      : '') +
  '</article>';
}

function renderChangelogSection(section) {
  return '<section class="changelog-section">' +
    (section.title ? '<div class="changelog-section-title">' + escapeHtml(section.title) + '</div>' : '') +
    '<ul class="changelog-items">' +
      section.items.map(item => '<li class="changelog-item">' + escapeHtml(item) + '</li>').join('') +
    '</ul>' +
  '</section>';
}

// ─── Terminal ────────────────────────────────────────────────────
// Diagnostics
async function loadDiagnostics() {
  const data = await API.get('/api/health');
  const summary = document.getElementById('healthSummary');
  const list = document.getElementById('healthChecks');
  if (!data || !summary || !list) return;

  if (data.error) {
    summary.innerHTML = '';
    list.innerHTML = '<div class="empty-state">' + escapeHtml(formatApiError(data, 'Health check failed')) + '</div>';
    return;
  }

  const overall = data.overall || 'warn';
  const counts = data.summary || {};
  summary.className = 'health-summary ' + overall;
  summary.innerHTML =
    '<div class="health-summary-title">' + escapeHtml(t('diag.overall.' + overall)) + '</div>' +
    '<div class="health-summary-meta">' + escapeHtml(tf('diag.summary', {
      ok: String(counts.ok || 0),
      warn: String(counts.warn || 0),
      error: String(counts.error || 0),
    })) + '</div>';

  const checks = data.checks || [];
  if (checks.length === 0) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t('diag.noChecks')) + '</div>';
    return;
  }

  list.innerHTML = checks.map(check => {
    const status = check.status || 'warn';
    return '<div class="health-item ' + escapeHtml(status) + '">' +
      '<div class="health-item-main">' +
        '<div class="health-title">' +
          '<span>' + escapeHtml(check.label || check.id || '') + '</span>' +
          '<span class="health-badge">' + escapeHtml(t('diag.status.' + status)) + '</span>' +
        '</div>' +
        '<div class="health-detail">' + escapeHtml(check.detail || '') + '</div>' +
        (check.action ? '<div class="health-action">' + escapeHtml(check.action) + '</div>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderHealthRepairResult(data) {
  const panel = document.getElementById('healthRepairResult');
  if (!panel || !data || !data.repair) return;

  const steps = Array.isArray(data.repair.steps) ? data.repair.steps : [];
  const summary = data.repair.summary || {};
  const before = data.before?.overall ? t('diag.overall.' + data.before.overall) : '--';
  const after = data.after?.overall ? t('diag.overall.' + data.after.overall) : '--';

  panel.hidden = false;
  panel.innerHTML =
    '<div class="health-repair-title">' +
      '<strong>' + escapeHtml(t('diag.repairResultTitle')) + '</strong>' +
      '<span>' + escapeHtml(tf('diag.repairBeforeAfter', { before, after })) + '</span>' +
    '</div>' +
    '<div class="health-repair-summary">' +
      escapeHtml(tf('diag.repairOk', {
        fixed: String(summary.fixed || 0),
        failed: String(summary.failed || 0),
      })) +
    '</div>' +
    '<div class="health-repair-steps">' +
      steps.map(step => {
        const status = step.status || 'skipped';
        return '<div class="health-repair-step ' + escapeHtml(status) + '">' +
          '<span class="health-repair-badge">' + escapeHtml(t('diag.repairStatus.' + status)) + '</span>' +
          '<span class="health-repair-text">' +
            '<strong>' + escapeHtml(step.label || step.id || '') + '</strong>' +
            '<span>' + escapeHtml(step.detail || '') + '</span>' +
            (step.action ? '<em>' + escapeHtml(step.action) + '</em>' : '') +
          '</span>' +
        '</div>';
      }).join('') +
    '</div>';
}

async function repairHealth() {
  const button = document.getElementById('healthRepairBtn');
  if (button) {
    button.disabled = true;
  }
  showToast(t('diag.repairRunning'), 'info', 5000);

  const data = await API.post('/api/health/repair', {});
  if (button) {
    button.disabled = false;
  }

  if (data && data.repair) {
    if (data.after) {
      const summary = document.getElementById('healthSummary');
      const list = document.getElementById('healthChecks');
      const overall = data.after.overall || 'warn';
      const counts = data.after.summary || {};
      if (summary) {
        summary.className = 'health-summary ' + overall;
        summary.innerHTML =
          '<div class="health-summary-title">' + escapeHtml(t('diag.overall.' + overall)) + '</div>' +
          '<div class="health-summary-meta">' + escapeHtml(tf('diag.summary', {
            ok: String(counts.ok || 0),
            warn: String(counts.warn || 0),
            error: String(counts.error || 0),
          })) + '</div>';
      }
      if (list) {
        const checks = data.after.checks || [];
        list.innerHTML = checks.map(check => {
          const status = check.status || 'warn';
          return '<div class="health-item ' + escapeHtml(status) + '">' +
            '<div class="health-item-main">' +
              '<div class="health-title">' +
                '<span>' + escapeHtml(check.label || check.id || '') + '</span>' +
                '<span class="health-badge">' + escapeHtml(t('diag.status.' + status)) + '</span>' +
              '</div>' +
              '<div class="health-detail">' + escapeHtml(check.detail || '') + '</div>' +
              (check.action ? '<div class="health-action">' + escapeHtml(check.action) + '</div>' : '') +
            '</div>' +
          '</div>';
        }).join('');
      }
    }
    renderHealthRepairResult(data);
    showToast(tf('diag.repairOk', {
      fixed: String(data.repair.summary?.fixed || 0),
      failed: String(data.repair.summary?.failed || 0),
    }), data.success ? 'success' : 'warn', 8000);
    return;
  }

  showToast(formatApiError(data, t('diag.repairFail')), 'error', 8000);
}

async function downloadCrashReport() {
  const data = await API.download('/api/reports/crash');
  if (data && data.success) {
    showToast(t('toast.reportOk'), 'success');
    return;
  }

  showToast(formatApiError(data, t('toast.reportFail')), 'error', 7000);
}

function terminalConnect() {
  wsSend({ type: 'terminal:open' });
}

function terminalDisconnect() {
  wsSend({ type: 'terminal:close' });
  document.getElementById('termInput').disabled = true;
  document.getElementById('termSendBtn').disabled = true;
  document.getElementById('termConnect').style.display = '';
  document.getElementById('termDisconnect').style.display = 'none';
}

function terminalSend() {
  const input = document.getElementById('termInput');
  const text = input.value.trim();
  if (!text) return;

  wsSend({ type: 'terminal:input', data: text });
  input.value = '';
}

function appendTerminalOutput(text) {
  const output = document.getElementById('termOutput');
  // Remove hint on first output
  const hint = output.querySelector('.terminal-hint');
  if (hint) hint.remove();

  output.textContent += text;
  output.scrollTop = output.scrollHeight;
}

// ─── Players ─────────────────────────────────────────────────────
async function loadPlayers() {
  const data = await API.get('/api/players');
  if (!data) return;

  const list = document.getElementById('playersList');
  const refreshNote = data.trusted
    ? tf('dash.connectionAge', {
        source: data.source || 'unknown',
        seconds: typeof data.ageSeconds === 'number' ? String(data.ageSeconds) : '--',
      })
    : tf('dash.connectionNoTime', { source: data.source || 'unknown' });

  if (!data.players || data.players.length === 0) {
    list.innerHTML = `<div class="empty-state">
      ${icon('players', 'icon empty-icon')}
      <div>${t('players.none')}</div>
      <div class="players-online-note">${tf('players.online', { online: data.online, max: data.max })}</div>
      <div class="players-online-note">${escapeHtml(refreshNote)}</div>
    </div>`;
    return;
  }

  list.innerHTML = '<div class="players-online-note">' + escapeHtml(refreshNote) + '</div>' + data.players.map(p => `
    <div class="player-card">
      <div class="player-avatar">${icon('player', 'icon')}</div>
      <div>
        <div class="player-name">${escapeHtml(p.name)}</div>
        <div class="player-info">${p.farm ? tf('players.farm', { farm: escapeHtml(p.farm) }) : ''}</div>
      </div>
    </div>
  `).join('');
}

// ─── Saves ───────────────────────────────────────────────────────
async function loadSaves() {
  const [savesData, backupsData] = await Promise.all([
    API.get('/api/saves'),
    API.get('/api/saves/backups'),
  ]);

  if (savesData) {
    const list = document.getElementById('savesList');
    if (!savesData.saves || savesData.saves.length === 0) {
      list.innerHTML = `<div class="empty-state">${t('saves.noFiles')}</div>`;
    } else {
      list.innerHTML = savesData.saves.map(s => `
        <div class="save-item">
          <div class="save-info">
            <div class="save-name">${icon('sprout', 'icon save-name-icon')}<span>${escapeHtml(s.farm || s.name)}</span>${s.isDefault ? `<span class="save-badge">${t('saves.defaultBadge')}</span>` : ''}</div>
            <div class="save-meta">${formatSize(s.size)} · ${s.lastModified ? new Date(s.lastModified).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US') : t('saves.unknown')}</div>
          </div>
          <div class="save-actions">
            ${s.isDefault ? '' : `<button class="btn btn-sm save-default-btn" data-save-name="${escapeHtml(s.name)}">${t('saves.setDefault')}</button>`}
          </div>
        </div>
      `).join('');

      list.querySelectorAll('.save-default-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          setDefaultSave(btn.dataset.saveName);
        });
      });
    }
  }

  if (backupsData) {
    const list = document.getElementById('backupsList');
    if (!backupsData.backups || backupsData.backups.length === 0) {
      list.innerHTML = `<div class="empty-state">${t('saves.noBackups')}</div>`;
    } else {
      list.innerHTML = backupsData.backups.map(b => `
        <div class="backup-item">
          <div class="save-info">
            <div class="save-name">${icon('package', 'icon save-name-icon')}<span>${escapeHtml(b.filename)}</span></div>
            <div class="save-meta">${formatSize(b.size)} · ${new Date(b.date).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US')}</div>
          </div>
          <button class="btn btn-sm btn-primary backup-download-btn" type="button" data-filename="${escapeHtml(b.filename)}">${icon('download', 'icon')}</button>
        </div>
      `).join('');

      list.querySelectorAll('.backup-download-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          downloadBackup(btn.dataset.filename);
        });
      });
    }
  }
}

function getSaveUploadToast(data) {
  var parts = [];

  if (data && data.defaultApplied) {
    parts.push(t('toast.saveUploadDefaultOk'));
  } else if (data && data.defaultSkipped) {
    parts.push(t('saves.multipleImported'));
  } else {
    parts.push(t('toast.saveUploadOk'));
  }

  if (data && data.overwriteBackup) {
    parts.push(tf('saves.overwriteBackup', { name: data.overwriteBackup }));
  }

  parts.push(t('saves.restartHint'));
  return parts.join(' ');
}

async function handleSaveUpload(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];

  if (!file.name.endsWith('.zip')) {
    showToast('Only .zip files are supported', 'error');
    return;
  }

  if (file.size > 40 * 1024 * 1024) {
    showToast('File too large (max 40MB)', 'error');
    return;
  }

  var setAsDefault = document.getElementById('saveUploadSetDefault').checked;
  document.getElementById('saveUploadStatus').textContent = t('saves.uploading');

  var reader = new FileReader();
  reader.onload = async function() {
    var base64 = reader.result.split(',')[1];
    var data = await API.post('/api/saves/upload', {
      filename: file.name,
      data: base64,
      setAsDefault: setAsDefault,
    });

    document.getElementById('saveUploadStatus').textContent = '';
    input.value = '';

    if (data && data.success) {
      showToast(getSaveUploadToast(data), 'success');
      loadSaves();
      loadConfig();
    } else {
      showToast(formatApiError(data, t('toast.saveUploadFail')), 'error', 7000);
    }
  };
  reader.readAsDataURL(file);
}

async function setDefaultSave(saveName) {
  var data = await API.post('/api/saves/default', { saveName: saveName });
  if (data && data.success) {
    showToast(t('toast.saveDefaultOk') + ' ' + t('saves.restartHint'), 'success');
    loadSaves();
    loadConfig();
  } else {
    showToast(formatApiError(data, t('toast.saveDefaultFail')), 'error', 7000);
  }
}

function getBackupActionButtons() {
  return document.querySelectorAll('.backup-action-btn');
}

function formatBackupTimestamp(value) {
  if (!value) return '';
  return new Date(value).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US');
}

function setBackupButtonsDisabled(disabled) {
  getBackupActionButtons().forEach(function(btn) {
    btn.disabled = disabled;
  });
}

function buildBackupStatusMeta(status) {
  const meta = [];

  if (status.state === 'running' && status.totalEntries > 0) {
    meta.push(tf('saves.backupProgress', {
      current: String(status.processedEntries || 0),
      total: String(status.totalEntries || 0),
      percent: String(status.progress || 0),
    }));
  }

  if (status.startedAt) {
    meta.push(tf('saves.backupStartedAt', { time: formatBackupTimestamp(status.startedAt) }));
  }

  if (status.completedAt) {
    meta.push(tf('saves.backupCompletedAt', { time: formatBackupTimestamp(status.completedAt) }));
  }

  if (status.backupName) {
    meta.push(tf('saves.backupFile', { name: status.backupName }));
  }

  if (status.state === 'completed' && status.size) {
    meta.push(tf('saves.backupSize', { size: formatSize(status.size) }));
  }

  return meta;
}

function renderBackupStatus(status) {
  lastBackupStatus = status;

  const targets = [
    document.getElementById('dashboardBackupStatus'),
    document.getElementById('savesBackupStatus'),
  ];
  const active = status && status.state && status.state !== 'idle';

  setBackupButtonsDisabled(!!(status && status.state === 'running'));

  targets.forEach(function(el) {
    if (!el) return;

    if (!active) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }

    const tone = status.state === 'failed'
      ? 'error'
      : (status.state === 'completed' ? 'success' : 'running');
    const titleKey = status.state === 'failed'
      ? 'saves.backupFailed'
      : (status.state === 'completed' ? 'saves.backupCompleted' : 'saves.backupRunning');
    const meta = buildBackupStatusMeta(status);
    const failureDetails = [];
    if (status.state === 'failed' && status.error) {
      failureDetails.push(status.error);
    }
    if (status.state === 'failed' && status.cause) {
      failureDetails.push(t('logs.cause') + ': ' + status.cause);
    }
    if (status.state === 'failed' && status.action) {
      failureDetails.push(t('logs.action') + ': ' + status.action);
    }
    const errorText = failureDetails.length
      ? '<div class="backup-status-error">' + escapeHtml(failureDetails.join(' ')) + '</div>'
      : '';
    const progressHtml = status.state === 'running'
      ? '<div class="backup-progress"><div class="backup-progress-fill" style="width:' + Math.max(1, status.progress || 0) + '%"></div></div>'
      : '';

    el.className = 'backup-status ' + tone;
    el.style.display = '';
    el.innerHTML =
      '<div class="backup-status-title">' + escapeHtml(t(titleKey)) + '</div>' +
      progressHtml +
      (meta.length > 0 ? '<div class="backup-status-meta">' + escapeHtml(meta.join(' · ')) + '</div>' : '') +
      errorText;
  });
}

function stopBackupStatusPolling() {
  if (backupStatusPoll) {
    clearInterval(backupStatusPoll);
    backupStatusPoll = null;
  }
}

function startBackupStatusPolling() {
  if (backupStatusPoll) {
    return;
  }

  backupStatusPoll = setInterval(function() {
    loadBackupStatus(true);
  }, BACKUP_STATUS_POLL_MS);
}

function applyBackupStatus(status, silent) {
  const previousState = lastBackupStatus && lastBackupStatus.state;
  renderBackupStatus(status);

  if (status && status.state === 'running') {
    startBackupStatusPolling();
    return;
  }

  stopBackupStatusPolling();

  if (!silent && previousState === 'running' && status && status.state === 'completed') {
    showToast(t('toast.backupOk'), 'success');
  } else if (!silent && previousState === 'running' && status && status.state === 'failed') {
    showToast(status.error || t('toast.backupFail'), 'error', 7000);
  }

  if (status && status.state && status.state !== 'running') {
    loadDashboard();
    if (currentPage === 'saves') {
      loadSaves();
    }
  }
}

async function loadBackupStatus(silent) {
  const data = await API.get('/api/saves/backup/status');
  if (!data) return;
  applyBackupStatus(data, !!silent);
}

// ─── Config ──────────────────────────────────────────────────────
async function loadConfig() {
  const data = await API.get('/api/config');
  if (!data) return;

  const container = document.getElementById('configContainer');
  container.innerHTML = '';

  const recommendationCard = document.createElement('div');
  recommendationCard.id = 'serverRecommendationCard';
  recommendationCard.className = 'card recommendation-card';
  container.appendChild(recommendationCard);
  if (lastServerRecommendations) {
    renderServerRecommendations(lastServerRecommendations);
  } else {
    renderServerRecommendationLoading();
  }

  const saveToolbar = document.createElement('div');
  saveToolbar.id = 'configSaveToolbar';
  saveToolbar.className = 'card config-save-toolbar';
  saveToolbar.innerHTML =
    '<span class="config-save-hint">' + escapeHtml(t('config.saveHint')) + '</span>' +
    '<button class="btn btn-success save-config-btn" type="button" onclick="saveConfig()" disabled>' +
      icon('config', 'icon') +
      '<span>' + escapeHtml(t('config.saveChanges')) + '</span>' +
    '</button>';
  container.appendChild(saveToolbar);

  for (const group of data.groups) {
    const card = document.createElement('div');
    card.className = 'card config-group';
    var groupLabel = t('config.group.' + group.name) || group.name;
    card.innerHTML = '<div class="config-group-title">' + escapeHtml(groupLabel) + '</div>';

    for (const item of group.items) {
      const row = document.createElement('div');
      row.className = 'config-item';

      let valueHtml;
      if (item.readonly) {
        valueHtml = '<span class="config-readonly-value">' + (item.sensitive ? '••••••••' : escapeHtml(item.value || '--')) + '</span>';
      } else if (item.type === 'boolean') {
        const checked = item.value === 'true' || item.hasValue && item.value !== 'false' ? 'checked' : '';
        valueHtml = '<label class="toggle">' +
          '<input type="checkbox" data-key="' + item.key + '" ' + checked + ' onchange="configChanged()">' +
          '<span class="toggle-slider"></span>' +
        '</label>';
      } else if (item.options && item.options.length > 0) {
        valueHtml = '<select class="input config-select" data-key="' + item.key + '" onchange="configChanged()">' +
          item.options.map(function(option) {
            var selected = option === (item.value || '') ? ' selected' : '';
            var label = option === '' ? t('config.autoDetect') : option;
            return '<option value="' + escapeHtml(option) + '"' + selected + '>' + escapeHtml(label) + '</option>';
          }).join('') +
          '</select>';
      } else if (item.viewable) {
        // Viewable password field (e.g. VNC_PASSWORD) - show real value with toggle
        valueHtml = '<div class="password-wrapper">' +
          '<input type="password" class="input config-input" data-key="' + item.key + '"' +
          ' value="' + escapeHtml(item.value || '') + '"' +
          ' placeholder="' + escapeHtml(item.default || '') + '"' +
          (item.maxLength ? ' maxlength="' + item.maxLength + '"' : '') +
          ' onchange="configChanged()" oninput="configChanged()">' +
          '<button type="button" class="password-toggle" onclick="togglePasswordVisibility(this)" title="' + t('config.showPassword') + '">' +
          icon('eye', 'icon') +
          '</button>' +
        '</div>';
      } else if (item.sensitive) {
        // Truly sensitive fields (e.g. STEAM_PASSWORD) - never show value
        valueHtml = '<input type="password" class="input config-input" data-key="' + item.key + '" placeholder="••••••••" onchange="configChanged()">';
      } else {
        valueHtml = '<input type="' + (item.type === 'number' ? 'number' : 'text') + '" class="input config-input" data-key="' + item.key + '"' +
          ' value="' + escapeHtml(item.value || '') + '" placeholder="' + escapeHtml(item.default || '') + '"' +
          ' onchange="configChanged()" oninput="configChanged()">';
      }

      row.innerHTML =
        '<div>' +
          '<div class="config-label">' + escapeHtml(item.label) + '</div>' +
          '<div class="config-key">' + item.key + '</div>' +
          (item.descriptionKey ? '<div class="config-help">' + escapeHtml(t(item.descriptionKey)) + '</div>' : '') +
          (item.secretManaged ? '<div class="config-help">' + escapeHtml(t('config.readonlySecret')) + '</div>' : '') +
        '</div>' +
        '<div class="config-value">' + valueHtml + '</div>';
      card.appendChild(row);
    }

    container.appendChild(card);
  }

  // Add save button (always visible but starts hidden, shown on change)
  const saveBtn = document.createElement('div');
  saveBtn.className = 'config-save-row';
  saveBtn.innerHTML = '<button class="btn btn-success save-config-btn" type="button" onclick="saveConfig()" disabled>' + icon('config', 'icon') + '<span>' + escapeHtml(t('config.saveChanges')) + '</span></button>';
  container.appendChild(saveBtn);

  loadServerRecommendations(true);
}

function renderServerRecommendationLoading() {
  const card = document.getElementById('serverRecommendationCard');
  if (!card) return;
  card.innerHTML =
    '<div class="recommendation-header">' +
      '<div>' +
        '<div class="config-group-title">' + escapeHtml(t('recommend.title')) + '</div>' +
        '<div class="recommendation-summary">' + escapeHtml(t('recommend.loading')) + '</div>' +
      '</div>' +
      '<button class="btn btn-sm" type="button" onclick="loadServerRecommendations(false)" disabled>' + icon('refresh', 'icon') + '<span>' + escapeHtml(t('recommend.refresh')) + '</span></button>' +
    '</div>';
}

function formatRecommendationBytes(bytes) {
  return Number.isFinite(bytes) && bytes > 0 ? formatSize(bytes) : '--';
}

function escapeSelectorValue(value) {
  const str = String(value || '');
  if (window.CSS && typeof window.CSS.escape === 'function') {
    return window.CSS.escape(str);
  }
  return str.replace(/["\\]/g, '\\$&');
}

function getRecommendationReasonText(reason) {
  if (!reason) return '';
  return currentLang === 'zh'
    ? (reason.message || reason.messageEn || '')
    : (reason.messageEn || reason.message || '');
}

function getRecommendationTierLabel(tier) {
  if (!tier) return '--';
  return currentLang === 'zh'
    ? (tier.label || tier.labelEn || tier.key || '--')
    : (tier.labelEn || tier.label || tier.key || '--');
}

function getRecommendationTierSummary(tier) {
  if (!tier) return '';
  return currentLang === 'zh'
    ? (tier.summary || tier.summaryEn || '')
    : (tier.summaryEn || tier.summary || '');
}

function renderServerRecommendations(data) {
  const card = document.getElementById('serverRecommendationCard');
  if (!card) return;

  if (!data || data.error) {
    card.innerHTML =
      '<div class="recommendation-header">' +
        '<div>' +
          '<div class="config-group-title">' + escapeHtml(t('recommend.title')) + '</div>' +
          '<div class="recommendation-summary error">' + escapeHtml(formatApiError(data, t('recommend.loadFail'))) + '</div>' +
        '</div>' +
        '<button class="btn btn-sm" type="button" onclick="loadServerRecommendations(false)">' + icon('refresh', 'icon') + '<span>' + escapeHtml(t('recommend.refresh')) + '</span></button>' +
      '</div>';
    return;
  }

  const cpu = data.resources?.cpu || {};
  const memory = data.resources?.memory || {};
  const disk = data.resources?.disk || {};
  const workload = data.workload || {};
  const recommendations = data.recommendations || {};
  const reasons = Array.isArray(recommendations.reasons) ? recommendations.reasons : [];
  const changes = Array.isArray(recommendations.changes) ? recommendations.changes : [];
  const changedCount = typeof recommendations.changedCount === 'number'
    ? recommendations.changedCount
    : changes.filter(item => !item.alreadyApplied).length;
  const largeMods = Array.isArray(workload.largeContentMods) ? workload.largeContentMods : [];
  const generatedAt = data.generatedAt
    ? new Date(data.generatedAt).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US')
    : '--';

  const metrics = [
    { label: t('recommend.cpu'), value: (cpu.effectiveCores ? cpu.effectiveCores.toFixed(1) : '--') + ' / ' + (cpu.source || '--') },
    { label: t('recommend.memory'), value: formatRecommendationBytes(memory.effectiveBytes) },
    { label: t('recommend.disk'), value: formatRecommendationBytes(disk.availableBytes) },
    {
      label: t('recommend.mods'),
      value: tf('recommend.modCount', { count: String(workload.modCount || 0) }),
    },
  ];

  const modPressureText = largeMods.length > 0
    ? tf('recommend.largeMods', { mods: largeMods.map(item => item.label || item.key).join(', ') })
    : t('recommend.noLargeMods');
  const changeText = changedCount > 0
    ? tf('recommend.changeCount', { count: String(changedCount) })
    : t('recommend.allApplied');

  card.innerHTML =
    '<div class="recommendation-header">' +
      '<div>' +
        '<div class="config-group-title">' + escapeHtml(t('recommend.title')) + '</div>' +
        '<div class="recommendation-title-line">' +
          '<span>' + escapeHtml(t('recommend.tier')) + ': ' + escapeHtml(getRecommendationTierLabel(data.tier)) + '</span>' +
          '<span class="recommendation-pill">' + escapeHtml(changeText) + '</span>' +
        '</div>' +
        '<div class="recommendation-summary">' + escapeHtml(getRecommendationTierSummary(data.tier)) + '</div>' +
        '<div class="recommendation-generated">' + escapeHtml(tf('recommend.generated', { time: generatedAt })) + '</div>' +
      '</div>' +
      '<div class="recommendation-actions">' +
        '<button class="btn btn-sm" type="button" onclick="loadServerRecommendations(false)">' + icon('refresh', 'icon') + '<span>' + escapeHtml(t('recommend.refresh')) + '</span></button>' +
        '<button class="btn btn-sm btn-primary" type="button" onclick="applyServerRecommendations()">' + icon('config', 'icon') + '<span>' + escapeHtml(t('recommend.apply')) + '</span></button>' +
        '<button class="btn btn-sm btn-muted" type="button" onclick="copyServerRecommendationEnv()">' + icon('download', 'icon') + '<span>' + escapeHtml(t('recommend.copy')) + '</span></button>' +
      '</div>' +
    '</div>' +
    '<div class="recommendation-metrics">' +
      metrics.map(item =>
        '<div class="recommendation-metric">' +
          '<div class="recommendation-metric-label">' + escapeHtml(item.label) + '</div>' +
          '<div class="recommendation-metric-value">' + escapeHtml(item.value) + '</div>' +
        '</div>'
      ).join('') +
    '</div>' +
    '<div class="recommendation-summary">' + escapeHtml(modPressureText) + '</div>' +
    (reasons.length > 0
      ? '<div class="recommendation-reasons">' + reasons.map(reason =>
        '<div class="recommendation-reason ' + escapeHtml(reason.severity || 'info') + '">' + escapeHtml(getRecommendationReasonText(reason)) + '</div>'
      ).join('') + '</div>'
      : '') +
    '<div class="recommendation-env-list">' +
      changes.map(change =>
        '<div class="recommendation-env-row ' + (change.alreadyApplied ? 'applied' : '') + '">' +
          '<span class="recommendation-env-key">' + escapeHtml(change.key) + '</span>' +
          '<span class="recommendation-env-value">' + escapeHtml(change.recommended || '') + '</span>' +
        '</div>'
      ).join('') +
    '</div>';
}

async function loadServerRecommendations(silent) {
  if (!silent) {
    renderServerRecommendationLoading();
  }

  try {
    const data = await API.get('/api/recommendations/server');
    if (!data) return;
    lastServerRecommendations = data;
    renderServerRecommendations(data);
    if (data.error && !silent) {
      showToast(formatApiError(data, t('recommend.loadFail')), 'error', 7000);
    }
  } catch (error) {
    const failed = { error: error.message || t('recommend.loadFail') };
    lastServerRecommendations = failed;
    renderServerRecommendations(failed);
    if (!silent) {
      showToast(formatApiError(failed, t('recommend.loadFail')), 'error', 7000);
    }
  }
}

function applyServerRecommendations() {
  const env = lastServerRecommendations?.recommendations?.env;
  if (!env || typeof env !== 'object') return;

  let applied = 0;
  for (const [key, value] of Object.entries(env)) {
    const control = document.querySelector('[data-key="' + escapeSelectorValue(key) + '"]');
    if (!control) continue;

    if (control.type === 'checkbox') {
      control.checked = String(value) === 'true';
    } else {
      control.value = String(value);
    }
    applied += 1;
  }

  if (applied > 0) {
    configChanged();
    showToast(t('recommend.needsSave'), 'success', 6500);
  }
}

async function copyServerRecommendationEnv() {
  const text = lastServerRecommendations?.recommendations?.copyText || '';
  if (!text) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showToast(t('recommend.copyOk'), 'success');
  } catch (error) {
    showToast(t('recommend.copyFail'), 'error', 5000);
  }
}

function getPanelUpdateState(status) {
  if (!status || typeof status !== 'object') return 'idle';
  return status.state || (status.running ? 'running' : 'idle');
}

function getPanelUpdateTone(state) {
  if (state === 'running') return 'running';
  if (state === 'succeeded') return 'succeeded';
  if (state === 'failed') return 'failed';
  return 'idle';
}

function getPanelUpdatePhaseLabel(phase) {
  const key = 'update.phase.' + (phase || 'idle');
  const label = t(key);
  return label === key ? (phase || 'idle') : label;
}

function renderPanelUpdateStatus(status) {
  lastPanelUpdateStatus = status || null;
  const statusEl = document.getElementById('panelUpdateStatus');
  const logEl = document.getElementById('panelUpdateLog');
  const button = document.getElementById('panelUpdateBtn');
  const buttonText = document.getElementById('panelUpdateBtnText');
  if (!statusEl) return;

  const state = getPanelUpdateState(status);
  const phase = status?.phase || 'idle';
  const tone = getPanelUpdateTone(state);
  const titleKey = 'update.state.' + state;
  const title = t(titleKey) === titleKey ? (status?.messageKey ? t(status.messageKey) : state) : t(titleKey);
  const message = status?.messageKey
    ? t(status.messageKey)
    : (status?.message || (state === 'idle' ? t('update.hint') : ''));
  const updatedAt = status?.updatedAt ? formatBackupTimestamp(status.updatedAt) : '--';
  const meta = [
    tf('update.meta', {
      phase: getPanelUpdatePhaseLabel(phase),
      time: updatedAt,
    }),
  ];

  if (status?.backupDir) {
    meta.push(tf('update.backupDir', { path: status.backupDir }));
  }
  if (state === 'failed' && typeof status.exitCode !== 'undefined') {
    meta.push(tf('update.exitCode', { code: String(status.exitCode) }));
  }
  if (status?.managerError) {
    meta.push(`Manager: ${status.managerError}`);
  }
  if (status?.cause) {
    meta.push(`${t('logs.cause')}: ${status.cause}`);
  }
  if (status?.action) {
    meta.push(`${t('logs.action')}: ${status.action}`);
  }
  if (status?.code) {
    meta.push(`Code: ${status.code}`);
  }

  statusEl.className = 'update-status ' + tone;
  statusEl.innerHTML =
    '<div class="update-status-title">' + escapeHtml(title) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(message) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(meta.join(' · ')) + '</div>';

  if (logEl) {
    const logTail = status?.logTail || '';
    logEl.style.display = logTail ? '' : 'none';
    logEl.textContent = logTail;
    if (logTail) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  const running = state === 'running';
  const managerBlocked = status?.managerUnavailable === true || status?.canStart === false;
  if (button) {
    button.disabled = running || managerBlocked;
  }
  if (buttonText) {
    buttonText.textContent = running ? t('update.runningButton') : t('update.button');
  }

  if (running) {
    startPanelUpdatePolling();
  } else {
    stopPanelUpdatePolling();
  }
}

async function loadPanelUpdateStatus(silent) {
  try {
    const data = await API.get('/api/update/status');
    if (!data) return;
    if (data.error) {
      const failedStatus = {
        state: 'unknown',
        phase: 'status_read_failed',
        message: formatApiError(data, t('update.statusFail')),
        updatedAt: new Date().toISOString(),
        logTail: data.logTail || '',
        code: data.code || '',
        cause: data.cause || '',
        action: data.action || '',
        managerUnavailable: data.code && String(data.code).startsWith('MANAGER_'),
        canStart: !(data.code && String(data.code).startsWith('MANAGER_')),
      };
      renderPanelUpdateStatus(failedStatus);
      if (!silent) {
        showToast(formatApiError(data, t('update.statusFail')), 'error', 7000);
      }
      return;
    }
    renderPanelUpdateStatus(data.status || data);
  } catch (error) {
    if (!silent) {
      showToast(t('update.reconnecting'), 'warn', 5000);
    }
    startPanelUpdatePolling();
  }
}

function startPanelUpdatePolling() {
  if (panelUpdatePoll) return;
  panelUpdatePoll = setInterval(() => {
    loadPanelUpdateStatus(true);
  }, PANEL_UPDATE_POLL_MS);
}

function stopPanelUpdatePolling() {
  if (panelUpdatePoll) {
    clearInterval(panelUpdatePoll);
    panelUpdatePoll = null;
  }
}

async function startPanelUpdate() {
  if (!confirm(t('update.confirm'))) return;

  const button = document.getElementById('panelUpdateBtn');
  if (button) {
    button.disabled = true;
  }
  showToast(t('update.started'), 'warn', 5000);

  try {
    const data = await API.post('/api/update', {});
    if (data && data.success) {
      renderPanelUpdateStatus(data.status || data);
      startPanelUpdatePolling();
      return;
    }

    showToast(formatApiError(data, t('update.startFail')), 'error', 9000);
  } catch (error) {
    showToast(t('update.reconnecting'), 'warn', 6000);
    startPanelUpdatePolling();
    return;
  }

  if (button) {
    button.disabled = false;
  }
}

function getFactoryResetState(status) {
  if (!status || typeof status !== 'object') return 'idle';
  return status.state || (status.running ? 'running' : 'idle');
}

function getFactoryResetPhaseLabel(phase) {
  const key = 'maintenance.phase.' + (phase || 'idle');
  const label = t(key);
  return label === key ? (phase || 'idle') : label;
}

function renderFactoryResetStatus(status) {
  lastFactoryResetStatus = status || null;
  const statusEl = document.getElementById('factoryResetStatus');
  const logEl = document.getElementById('factoryResetLog');
  const button = document.getElementById('factoryResetBtn');
  const buttonText = document.getElementById('factoryResetBtnText');
  if (!statusEl) return;

  const state = getFactoryResetState(status);
  const phase = status?.phase || 'idle';
  const tone = getPanelUpdateTone(state);
  const titleKey = 'maintenance.state.' + state;
  const title = t(titleKey) === titleKey ? state : t(titleKey);
  const message = status?.message || (state === 'idle' ? t('maintenance.hint') : '');
  const updatedAt = status?.updatedAt ? formatBackupTimestamp(status.updatedAt) : '--';
  const meta = [
    tf('update.meta', {
      phase: getFactoryResetPhaseLabel(phase),
      time: updatedAt,
    }),
  ];

  if (status?.backupDir) {
    meta.push(tf('update.backupDir', { path: status.backupDir }));
  }
  if (state === 'failed' && typeof status.exitCode !== 'undefined') {
    meta.push(tf('update.exitCode', { code: String(status.exitCode) }));
  }
  if (status?.managerError) {
    meta.push(`Manager: ${status.managerError}`);
  }
  if (status?.cause) {
    meta.push(`${t('logs.cause')}: ${status.cause}`);
  }
  if (status?.action) {
    meta.push(`${t('logs.action')}: ${status.action}`);
  }
  if (status?.code) {
    meta.push(`Code: ${status.code}`);
  }

  statusEl.className = 'update-status ' + tone;
  statusEl.innerHTML =
    '<div class="update-status-title">' + escapeHtml(title) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(message) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(meta.join(' · ')) + '</div>';

  if (logEl) {
    const logTail = status?.logTail || '';
    logEl.style.display = logTail ? '' : 'none';
    logEl.textContent = logTail;
    if (logTail) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  const running = state === 'running';
  const managerBlocked = status?.managerUnavailable === true || status?.canStart === false;
  if (button) {
    button.disabled = running || managerBlocked;
  }
  if (buttonText) {
    buttonText.textContent = running ? t('maintenance.runningButton') : t('maintenance.factoryReset');
  }

  if (running) {
    startFactoryResetPolling();
  } else {
    stopFactoryResetPolling();
  }
}

async function loadFactoryResetStatus(silent) {
  try {
    const data = await API.get('/api/maintenance/factory-reset/status');
    if (!data) return;
    if (data.error) {
      const failedStatus = {
        state: 'unknown',
        phase: 'status_read_failed',
        message: formatApiError(data, t('maintenance.statusFail')),
        updatedAt: new Date().toISOString(),
        logTail: data.logTail || '',
        code: data.code || '',
        cause: data.cause || '',
        action: data.action || '',
        managerUnavailable: data.code && String(data.code).startsWith('MANAGER_'),
        canStart: !(data.code && String(data.code).startsWith('MANAGER_')),
      };
      renderFactoryResetStatus(failedStatus);
      if (!silent) {
        showToast(formatApiError(data, t('maintenance.statusFail')), 'error', 7000);
      }
      return;
    }
    renderFactoryResetStatus(data.status || data);
  } catch (error) {
    if (!silent) {
      showToast(t('maintenance.reconnecting'), 'warn', 5000);
    }
    startFactoryResetPolling();
  }
}

function startFactoryResetPolling() {
  if (factoryResetPoll) return;
  factoryResetPoll = setInterval(() => {
    loadFactoryResetStatus(true);
  }, FACTORY_RESET_POLL_MS);
}

function stopFactoryResetPolling() {
  if (factoryResetPoll) {
    clearInterval(factoryResetPoll);
    factoryResetPoll = null;
  }
}

async function startFactoryReset() {
  const typed = prompt(t('maintenance.confirm'));
  if (typed !== 'RESET') {
    showToast(t('maintenance.confirmMismatch'), 'warn', 5000);
    return;
  }

  const button = document.getElementById('factoryResetBtn');
  if (button) {
    button.disabled = true;
  }
  showToast(t('maintenance.started'), 'warn', 6000);

  try {
    const data = await API.post('/api/maintenance/factory-reset', { confirmation: 'RESET' });
    if (data && data.success) {
      renderFactoryResetStatus(data.status || data);
      startFactoryResetPolling();
      return;
    }

    showToast(formatApiError(data, t('maintenance.startFail')), 'error', 9000);
  } catch (error) {
    showToast(t('maintenance.reconnecting'), 'warn', 6000);
    startFactoryResetPolling();
    return;
  }

  if (button) {
    button.disabled = false;
  }
}

function getUninstallState(status) {
  if (!status || typeof status !== 'object') return 'idle';
  return status.state || (status.running ? 'running' : 'idle');
}

function getUninstallPhaseLabel(phase) {
  const key = 'maintenance.uninstall.phase.' + (phase || 'idle');
  const label = t(key);
  return label === key ? (phase || 'idle') : label;
}

function renderUninstallStatus(status) {
  lastUninstallStatus = status || null;
  const statusEl = document.getElementById('uninstallStatus');
  const logEl = document.getElementById('uninstallLog');
  const button = document.getElementById('uninstallBtn');
  const buttonText = document.getElementById('uninstallBtnText');
  if (!statusEl) return;

  const state = getUninstallState(status);
  const phase = status?.phase || 'idle';
  const tone = getPanelUpdateTone(state);
  const titleKey = 'maintenance.uninstall.state.' + state;
  const title = t(titleKey) === titleKey ? state : t(titleKey);
  const message = status?.message || (state === 'idle' ? t('maintenance.uninstallHint') : '');
  const updatedAt = status?.updatedAt ? formatBackupTimestamp(status.updatedAt) : '--';
  const meta = [
    tf('update.meta', {
      phase: getUninstallPhaseLabel(phase),
      time: updatedAt,
    }),
  ];

  if (state === 'failed' && typeof status.exitCode !== 'undefined') {
    meta.push(tf('update.exitCode', { code: String(status.exitCode) }));
  }
  if (status?.managerError) {
    meta.push(`Manager: ${status.managerError}`);
  }
  if (status?.cause) {
    meta.push(`${t('logs.cause')}: ${status.cause}`);
  }
  if (status?.action) {
    meta.push(`${t('logs.action')}: ${status.action}`);
  }
  if (status?.code) {
    meta.push(`Code: ${status.code}`);
  }

  statusEl.className = 'update-status ' + tone;
  statusEl.innerHTML =
    '<div class="update-status-title">' + escapeHtml(title) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(message) + '</div>' +
    '<div class="update-status-meta">' + escapeHtml(meta.join(' · ')) + '</div>';

  if (logEl) {
    const logTail = status?.logTail || '';
    logEl.style.display = logTail ? '' : 'none';
    logEl.textContent = logTail;
    if (logTail) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  const running = state === 'running';
  const managerBlocked = status?.managerUnavailable === true || status?.canStart === false;
  if (button) {
    button.disabled = running || managerBlocked;
  }
  if (buttonText) {
    buttonText.textContent = running ? t('maintenance.uninstallRunningButton') : t('maintenance.uninstall');
  }

  if (running) {
    startUninstallPolling();
  } else {
    stopUninstallPolling();
  }
}

async function loadUninstallStatus(silent) {
  try {
    const data = await API.get('/api/maintenance/uninstall/status');
    if (!data) return;
    if (data.error) {
      const failedStatus = {
        state: 'unknown',
        phase: 'status_read_failed',
        message: formatApiError(data, t('maintenance.uninstallStatusFail')),
        updatedAt: new Date().toISOString(),
        logTail: data.logTail || '',
        code: data.code || '',
        cause: data.cause || '',
        action: data.action || '',
        managerUnavailable: data.code && String(data.code).startsWith('MANAGER_'),
        canStart: !(data.code && String(data.code).startsWith('MANAGER_')),
      };
      renderUninstallStatus(failedStatus);
      if (!silent) {
        showToast(formatApiError(data, t('maintenance.uninstallStatusFail')), 'error', 7000);
      }
      return;
    }
    renderUninstallStatus(data.status || data);
  } catch (error) {
    if (!silent) {
      showToast(t('maintenance.uninstallReconnecting'), 'warn', 5000);
    }
    startUninstallPolling();
  }
}

function startUninstallPolling() {
  if (uninstallPoll) return;
  uninstallPoll = setInterval(() => {
    loadUninstallStatus(true);
  }, UNINSTALL_POLL_MS);
}

function stopUninstallPolling() {
  if (uninstallPoll) {
    clearInterval(uninstallPoll);
    uninstallPoll = null;
  }
}

async function startUninstall() {
  const typed = prompt(t('maintenance.uninstallConfirm'));
  if (typed !== 'UNINSTALL') {
    showToast(t('maintenance.uninstallConfirmMismatch'), 'warn', 5000);
    return;
  }

  const button = document.getElementById('uninstallBtn');
  if (button) {
    button.disabled = true;
  }
  showToast(t('maintenance.uninstallStarted'), 'warn', 8000);

  try {
    const data = await API.post('/api/maintenance/uninstall', { confirmation: 'UNINSTALL' });
    if (data && data.success) {
      renderUninstallStatus(data.status || data);
      startUninstallPolling();
      return;
    }

    showToast(formatApiError(data, t('maintenance.uninstallStartFail')), 'error', 9000);
  } catch (error) {
    showToast(t('maintenance.uninstallReconnecting'), 'warn', 8000);
    startUninstallPolling();
    return;
  }

  if (button) {
    button.disabled = false;
  }
}

function configChanged() {
  document.querySelectorAll('.save-config-btn').forEach(function(btn) {
    btn.disabled = false;
    btn.classList.add('attention');
  });
}

function togglePasswordVisibility(btn) {
  var wrapper = btn.parentElement;
  var input = wrapper.querySelector('input');
  if (input.type === 'password') {
    input.type = 'text';
    btn.innerHTML = icon('eye-off', 'icon');
    btn.title = t('config.hidePassword');
  } else {
    input.type = 'password';
    btn.innerHTML = icon('eye', 'icon');
    btn.title = t('config.showPassword');
  }
}

async function saveConfig() {
  const updates = {};
  document.querySelectorAll('[data-key]').forEach(function(el) {
    const key = el.dataset.key;
    if (el.type === 'checkbox') {
      updates[key] = el.checked ? 'true' : 'false';
    } else {
      // Include all values, even empty strings (to allow clearing fields)
      updates[key] = el.value;
    }
  });

  if (Object.keys(updates).length === 0) return;

  const data = await API.put('/api/config', updates);
  if (data && data.success) {
    document.querySelectorAll('.save-config-btn').forEach(function(btn) {
      btn.disabled = true;
      btn.classList.remove('attention');
    });
    // Show restart confirmation dialog instead of just a toast
    showRestartModal();
  } else {
    showToast(formatApiError(data, t('toast.configFail')), 'error', 7000);
  }
}

function showRestartModal() {
  var modal = document.getElementById('restartModal');
  var title = document.getElementById('restartModalTitle');
  var message = document.getElementById('restartModalMessage');
  var laterBtn = document.getElementById('restartLaterBtn');
  var restartBtn = document.getElementById('restartNowBtn');

  title.textContent = t('config.restartTitle');
  message.textContent = t('config.restartMessage');
  laterBtn.textContent = t('config.restartLater');
  restartBtn.textContent = t('config.restartNow');
  restartBtn.style.display = '';
  restartBtn.disabled = false;

  modal.style.display = '';

  // Close on overlay click
  modal.onclick = function(e) {
    if (e.target === modal) closeRestartModal();
  };
}

function closeRestartModal(silent) {
  document.getElementById('restartModal').style.display = 'none';
  if (!silent) {
    showToast(t('toast.configOk'), 'success');
  }
}

async function confirmRestart() {
  var restartBtn = document.getElementById('restartNowBtn');
  if (restartBtn) {
    restartBtn.disabled = true;
  }

  try {
    const data = await API.post('/api/container/restart');
    if (data && data.success) {
      showToast(t('toast.containerRestarting'), 'success');
      startContainerReconnectPolling();
      return;
    }
    showToast(formatApiError(data, t('toast.containerRestartFail')), 'error', 7000);
  } catch (error) {
    // If the container stopped before the response fully returned, assume restart is underway.
    showToast(t('toast.containerRestarting'), 'success');
    startContainerReconnectPolling();
    return;
  }

  if (restartBtn) {
    restartBtn.disabled = false;
  }
}

let containerReconnectPoll = null;

function startContainerReconnectPolling() {
  closeRestartModal(true);

  if (containerReconnectPoll) {
    clearInterval(containerReconnectPoll);
  }

  const startedAt = Date.now();
  containerReconnectPoll = setInterval(async function() {
    try {
      const resp = await fetch('/api/auth/status', { cache: 'no-store' });
      if (resp && resp.ok) {
        clearInterval(containerReconnectPoll);
        containerReconnectPoll = null;
        window.location.reload();
        return;
      }
    } catch (error) {}

    if (Date.now() - startedAt > 120000) {
      clearInterval(containerReconnectPoll);
      containerReconnectPoll = null;
      window.location.reload();
    }
  }, CONTAINER_RECONNECT_POLL_MS);
}

// ─── Mods ────────────────────────────────────────────────────────
async function loadMods() {
  const [data, backupsData] = await Promise.all([
    API.get('/api/mods'),
    API.get('/api/mods/backups'),
  ]);
  if (!data) return;
  lastModsData = data;
  renderModBackups(backupsData);

  const list = document.getElementById('modsList');
  const customModCount = Array.isArray(data.mods) ? data.mods.filter(mod => mod && mod.isCustom).length : 0;

  // Upload section
  var uploadHtml = `
    <div class="card mod-upload-panel">
      <div class="mod-upload-actions">
        <input type="file" id="modFileInput" class="hidden-file" accept=".zip" onchange="handleModUpload(this)">
        <button class="btn btn-primary" type="button" onclick="document.getElementById('modFileInput').click()">
          ${icon('mods', 'icon')} <span>${t('mods.upload')}</span>
        </button>
        <button class="btn btn-success" type="button" onclick="downloadClientModPack()">
          ${icon('download', 'icon')} <span>${t('mods.clientPack')}</span>
        </button>
        <button class="btn btn-danger" type="button" onclick="clearCustomMods()" ${customModCount > 0 ? '' : 'disabled'}>
          ${icon('trash', 'icon')} <span>${t('mods.clearCustom')}</span>
        </button>
      </div>
      <div class="mod-upload-copy">
        <span class="mod-upload-hint">${t('mods.uploadHint')}</span>
        <span class="mod-upload-hint">${t('mods.clientPackHint')}</span>
        <span class="mod-upload-hint">${formatClientPackStatus(data.clientPack)}</span>
        <span id="modUploadStatus" class="mod-upload-status"></span>
      </div>
      <div class="mod-bulk-guide">
        <strong>${t('mods.bulkGuideTitle')}</strong>
        <span>${t('mods.bulkGuide')}</span>
      </div>
    </div>
  `;

  if (!data.mods || data.mods.length === 0) {
    list.innerHTML = uploadHtml + '<div class="empty-state">' + t('mods.none') + '</div>';
    return;
  }

  list.innerHTML = uploadHtml + data.mods.map(function(m) {
    var downloadBtn = m.isCustom
      ? '<button class="btn btn-sm btn-muted mod-download-btn" type="button" data-folder="' + escapeHtml(m.folder) + '" data-name="' + escapeHtml(m.name) + '">' + icon('download', 'icon') + ' <span>' + t('mods.download') + '</span></button>'
      : '';
    var deleteBtn = m.isCustom
      ? '<button class="btn btn-sm btn-danger-outline mod-delete-btn" data-folder="' + escapeHtml(m.folder) + '" data-name="' + escapeHtml(m.name) + '">' + icon('trash', 'icon') + ' <span>' + t('mods.delete') + '</span></button>'
      : '';
    var clientBadge = m.clientRequired
      ? '<span class="mod-badge client-required">' + t('mods.clientRequired') + '</span>'
      : '<span class="mod-badge server-only">' + t('mods.serverOnly') + '</span>';
    return '<div class="mod-item">' +
      '<div class="mod-info">' +
        '<div class="mod-name">' + escapeHtml(m.name) + '</div>' +
        '<div class="mod-meta">v' + escapeHtml(m.version) + ' · ' + escapeHtml(m.author || '') + ' · ' + escapeHtml(m.id) + '</div>' +
        (m.description ? '<div class="mod-meta">' + escapeHtml(m.description) + '</div>' : '') +
      '</div>' +
      '<div class="mod-actions">' +
        '<span class="mod-badge ' + (m.isCustom ? 'custom' : '') + '">' + (m.isCustom ? t('mods.custom') : t('mods.builtin')) + '</span>' +
        clientBadge +
        downloadBtn +
        deleteBtn +
      '</div>' +
    '</div>';
  }).join('');

  list.querySelectorAll('.mod-download-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      downloadMod(btn.dataset.folder, btn.dataset.name);
    });
  });

  list.querySelectorAll('.mod-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      deleteMod(btn.dataset.folder, btn.dataset.name);
    });
  });
}

function renderModBackups(data) {
  const list = document.getElementById('modBackupsList');
  if (!list) return;

  if (!data || !data.backups || data.backups.length === 0) {
    list.innerHTML = '<div class="empty-state">' + escapeHtml(t('mods.noBackups')) + '</div>';
    return;
  }

  list.innerHTML = data.backups.map(backup => `
    <div class="backup-item">
      <div class="save-info">
        <div class="save-name">${icon('package', 'icon save-name-icon')}<span>${escapeHtml(backup.filename)}</span></div>
        <div class="save-meta">${formatSize(backup.size)} · ${backup.createdAt ? new Date(backup.createdAt).toLocaleString(currentLang === 'zh' ? 'zh-CN' : 'en-US') : '--'} · ${escapeHtml(backup.reason || '')}</div>
      </div>
      <div class="save-actions">
        <button class="btn btn-sm btn-primary mod-backup-download-btn" type="button" data-filename="${escapeHtml(backup.filename)}">${icon('download', 'icon')}<span>${t('mods.download')}</span></button>
        <button class="btn btn-sm btn-warning mod-rollback-btn" type="button" data-filename="${escapeHtml(backup.filename)}">${icon('refresh', 'icon')}<span>${t('mods.rollback')}</span></button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('.mod-backup-download-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      downloadModBackup(btn.dataset.filename);
    });
  });

  list.querySelectorAll('.mod-rollback-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      rollbackModBackup(btn.dataset.filename);
    });
  });
}

async function handleModUpload(input) {
  if (!input.files || !input.files[0]) return;
  var file = input.files[0];

  if (!/\.zip$/i.test(file.name)) {
    showToast('Only .zip files are supported', 'error');
    return;
  }

  if (file.size > MOD_UPLOAD_MAX_MB * 1024 * 1024) {
    showToast(tf('mods.uploadTooLarge', { max: MOD_UPLOAD_MAX_MB }), 'error');
    return;
  }

  document.getElementById('modUploadStatus').textContent = t('mods.uploading');

  var reader = new FileReader();
  reader.onload = async function() {
    var base64 = reader.result.split(',')[1];
    var data = await uploadModArchive(file.name, base64, false);

    if (isOverwriteableModUploadError(data)) {
      const overwrite = confirm(getModOverwriteConfirmMessage(data, file.name));
      if (overwrite) {
        document.getElementById('modUploadStatus').textContent = t('mods.overwriting');
        data = await uploadModArchive(file.name, base64, true);
      } else {
        document.getElementById('modUploadStatus').textContent = '';
        input.value = '';
        return;
      }
    }

    document.getElementById('modUploadStatus').textContent = '';
    input.value = '';
    if (data && data.success) {
      showToast(getModUploadToast(data), 'success');
      loadMods();
    } else {
      showToast(formatApiError(data, t('toast.modUploadFail')), 'error', 7000);
    }
  };
  reader.readAsDataURL(file);
}

async function uploadModArchive(filename, base64, overwrite) {
  return API.post('/api/mods/upload', {
    filename,
    data: base64,
    overwrite,
  });
}

function isOverwriteableModUploadError(data) {
  return data &&
    data.code === 'MOD_ALREADY_EXISTS' &&
    data.metadata &&
    data.metadata.canOverwrite === true;
}

function getModOverwriteConfirmMessage(data, filename) {
  const conflicts = Array.isArray(data?.metadata?.conflicts)
    ? data.metadata.conflicts.filter(Boolean)
    : [];

  if (conflicts.length > 0) {
    const names = conflicts.slice(0, 8).join(', ') + (conflicts.length > 8 ? ` +${conflicts.length - 8}` : '');
    return tf('mods.confirmOverwriteConflicts', { names });
  }

  return tf('mods.confirmOverwrite', { name: filename });
}

async function deleteMod(folder, name) {
  if (!confirm(tf('mods.confirmDelete', { name: name }))) return;

  var data = await API.del('/api/mods/' + encodeURIComponent(folder));
  if (data && data.success) {
    showToast(getModDeleteToast(data), 'success');
    loadMods();
  } else {
    showToast(formatApiError(data, t('toast.modDeleteFail')), 'error', 7000);
  }
}

async function clearCustomMods() {
  const customCount = Array.isArray(lastModsData?.mods)
    ? lastModsData.mods.filter(mod => mod && mod.isCustom).length
    : 0;
  const typed = prompt(tf('mods.confirmClearCustom', { count: String(customCount) }));
  if (typed !== 'DELETE') {
    showToast(t('mods.confirmClearMismatch'), 'warn', 5000);
    return;
  }

  const data = await API.del('/api/mods/custom');
  if (data && data.success) {
    if (data.removed && (data.removed.sourceEntries || data.removed.installedFolders)) {
      showToast(getModClearCustomToast(data), 'success', 8000);
    } else {
      showToast(t('mods.clearCustomEmpty'), 'warn', 5000);
    }
    loadMods();
    loadDashboard();
    return;
  }

  showToast(formatApiError(data, t('toast.modClearCustomFail')), 'error', 8000);
}

async function downloadMod(folder, name) {
  var data = await API.download('/api/mods/download/' + encodeURIComponent(folder));
  if (data && data.success) {
    showToast(t('toast.modDownloadOk'), 'success');
    return;
  }

  showToast(formatApiError(data, t('toast.modDownloadFail')), 'error', 7000);
}

async function downloadModBackup(filename) {
  const data = await API.download('/api/mods/backups/download/' + encodeURIComponent(filename), filename);
  if (data && data.success) {
    showToast(t('toast.modDownloadOk'), 'success');
    return;
  }

  showToast(formatApiError(data, t('toast.modDownloadFail')), 'error', 7000);
}

async function rollbackModBackup(filename) {
  if (!confirm(t('mods.confirmRollback'))) return;

  const data = await API.post('/api/mods/rollback/' + encodeURIComponent(filename), {});
  if (data && data.success) {
    showToast(t('mods.rollbackOk'), 'success', 7000);
    loadMods();
    loadDashboard();
    return;
  }

  showToast(formatApiError(data, t('mods.rollbackFail')), 'error', 8000);
}

async function downloadClientModPack() {
  const data = await API.download('/api/mods/client-pack', 'stardew-client-mods.zip');

  if (data && data.success) {
    showToast(t('toast.modClientPackOk'), 'success');
    return;
  }

  if (data && data.code === 'MOD_CLIENT_PACK_EMPTY') {
    showToast(t('mods.clientPackEmpty'), 'warn', 5000);
    return;
  }

  showToast(formatApiError(data, t('toast.modClientPackFail')), 'error', 7000);
}

function getModUploadToast(data) {
  if (data && data.success) {
    var clientPackText = appendSentence(getModBackupResultText(data.backup), getClientPackResultText(data.clientPack));
    var installedCount = data.installedCount || (Array.isArray(data.installedFolders) ? data.installedFolders.length : 0);
    if (data.bundle && data.hasManifest) {
      var bundleText = data.overwritten
        ? tf('mods.uploadBundleReplaced', { count: installedCount })
        : tf('mods.uploadBundleInstalled', { count: installedCount });
      return appendSentence(bundleText, clientPackText);
    }
    if (data.overwritten && data.hasManifest) {
      return appendSentence(t('mods.uploadReplaced'), clientPackText);
    }
    if (data.hasManifest) {
      return appendSentence(t('mods.uploadInstalled'), clientPackText);
    }
    if (data.noManifest) {
      return appendSentence(t('mods.uploadNoManifest'), clientPackText);
    }
    if (data.autoInstallFailed) {
      var fallback = data.installError
        ? t('mods.uploadFallback') + ' ' + data.installError
        : t('mods.uploadFallback');
      return appendSentence(fallback, clientPackText);
    }
    return appendSentence(t('toast.modUploadOk'), clientPackText);
  }

  return t('toast.modUploadOk');
}

function getModDeleteToast(data) {
  var clientPackText = appendSentence(getModBackupResultText(data?.backup), getClientPackResultText(data?.clientPack));
  if (data && data.success && data.needsRestart) {
    return appendSentence(t('mods.deleteNeedsRestart'), clientPackText);
  }

  return appendSentence(t('toast.modDeleteOk'), clientPackText);
}

function getModClearCustomToast(data) {
  var clientPackText = appendSentence(getModBackupResultText(data?.backup), getClientPackResultText(data?.clientPack));
  return appendSentence(t('mods.clearCustomOk'), clientPackText);
}

function formatClientPackStatus(clientPack) {
  if (!clientPack) return t('mods.clientPackMissing');
  if (clientPack.error || clientPack.cause) {
    return tf('mods.clientPackBuildFail', {
      reason: clientPack.cause || clientPack.error,
    });
  }
  if (clientPack.available) {
    return tf('mods.clientPackReady', { count: clientPack.modCount || 0 });
  }
  if (clientPack.stale) {
    return t('mods.clientPackStale');
  }
  return t('mods.clientPackMissing');
}

function getClientPackResultText(clientPack) {
  if (!clientPack) return '';
  if (clientPack.error || clientPack.cause) {
    return tf('mods.clientPackBuildFail', {
      reason: clientPack.cause || clientPack.error,
    });
  }
  if (clientPack.rebuilt) {
    return t('mods.clientPackRebuilt');
  }
  return '';
}

function getModBackupResultText(backup) {
  if (!backup || !backup.filename) return '';
  return tf('mods.backupCreated', { name: backup.filename });
}

function appendSentence(base, extra) {
  if (!base) return extra || '';
  return extra ? `${base} ${extra}` : base;
}

// ─── Actions ─────────────────────────────────────────────────────
async function restartServer() {
  if (!confirm(t('actions.confirmRestart'))) return;
  const data = await API.post('/api/server/restart');
  if (data && data.success) {
    showToast(t('toast.restartOk'), 'success');
  } else {
    showToast(formatApiError(data, t('toast.restartFail')), 'error', 7000);
  }
}

async function toggleManualPause() {
  const current = lastStatusData?.manualPause?.enabled === true;
  const button = document.getElementById('manualPauseBtn');
  if (button) {
    button.disabled = true;
  }

  const data = await API.post('/api/game/pause', {
    enabled: !current,
    reason: 'dashboard-toggle',
  });

  if (data && data.success) {
    const manualPause = data.manualPause || { enabled: !current };
    if (!lastStatusData) {
      lastStatusData = {};
    }
    lastStatusData.manualPause = manualPause;
    if (manualPause.enabled) {
      lastStatusData.paused = true;
    }
    updateManualPauseUI(manualPause);
    showToast(manualPause.enabled ? t('toast.pauseOn') : t('toast.pauseOff'), 'success');
    loadDashboard();
  } else {
    showToast(formatApiError(data, t('toast.pauseFail')), 'error', 7000);
    updateManualPauseUI(lastStatusData?.manualPause || { enabled: current });
  }
}

async function toggleAutoPause() {
  const current = lastStatusData?.autoPause?.enabled === true;
  const button = document.getElementById('autoPauseBtn');
  if (button) {
    button.disabled = true;
  }

  const data = await API.post('/api/game/auto-pause', {
    enabled: !current,
    reason: 'dashboard-toggle',
  });

  if (data && data.success) {
    const autoPause = {
      ...(lastStatusData?.autoPause || {}),
      ...(data.autoPause || {}),
      enabled: data.autoPause?.enabled === true,
      control: data.autoPauseControl || data.autoPause?.control || null,
    };
    if (!lastStatusData) {
      lastStatusData = {};
    }
    lastStatusData.autoPause = autoPause;
    updateAutoPauseUI(autoPause);
    showToast(autoPause.enabled ? t('toast.autoPauseOn') : t('toast.autoPauseOff'), 'success');
    loadDashboard();
  } else {
    showToast(formatApiError(data, t('toast.autoPauseFail')), 'error', 7000);
    updateAutoPauseUI(lastStatusData?.autoPause || { enabled: current });
  }
}

async function startExpansionModInit() {
  const button = document.getElementById('expansionInitBtn');
  if (button) button.disabled = true;

  try {
    const data = await API.post('/api/host/expansion-init/start', {});
    if (data && data.success) {
      showToast(t('toast.expansionInitOk'), 'success', 7000);
      loadDashboard();
      return;
    }

    showToast(formatApiError(data, t('toast.expansionInitFail')), 'error', 8000);
  } finally {
    if (button) button.disabled = false;
  }
}

async function finishExpansionModInit() {
  const button = document.getElementById('hideHostBtn');
  if (button) button.disabled = true;

  try {
    const data = await API.post('/api/host/expansion-init/finish', {});
    if (data && data.success) {
      showToast(t('toast.hideHostOk'), 'success');
      loadDashboard();
      return;
    }

    showToast(formatApiError(data, t('toast.hideHostFail')), 'error', 8000);
  } finally {
    if (button) button.disabled = false;
  }
}

async function createBackup() {
  if (lastBackupStatus && lastBackupStatus.state === 'running') {
    showToast(t('toast.backupRunning'), 'warn');
    startBackupStatusPolling();
    return;
  }

  showToast(t('toast.backupStarted'), 'warn');
  const data = await API.post('/api/saves/backup');
  if (data && data.success && data.status) {
    applyBackupStatus(data.status, true);
    startBackupStatusPolling();
    if (data.alreadyRunning) {
      showToast(t('toast.backupRunning'), 'warn');
    }
  } else {
    showToast(formatApiError(data, t('toast.backupFail')), 'error', 7000);
  }
}

async function downloadBackup(filename) {
  if (!filename) return;

  const data = await API.download('/api/saves/download/' + encodeURIComponent(filename), filename);
  if (data && data.success) {
    return;
  }

  showToast(formatApiError(data, t('toast.backupFail')), 'error', 7000);
}

async function changePassword() {
  const oldPwd = document.getElementById('oldPassword').value;
  const newPwd = document.getElementById('newPassword').value;

  if (!oldPwd || !newPwd) {
    showToast(t('toast.passwordFields'), 'error');
    return;
  }

  const data = await API.post('/api/auth/password', { oldPassword: oldPwd, newPassword: newPwd });
  if (data && data.success) {
    showToast(t('toast.pwdOk'), 'success');
    // Update token
    if (data.token) {
      API.token = data.token;
      localStorage.setItem('panel_token', data.token);
    }
    document.getElementById('oldPassword').value = '';
    document.getElementById('newPassword').value = '';
  } else {
    showToast(formatApiError(data, t('toast.pwdFail')), 'error', 7000);
  }
}

// ─── Utilities ───────────────────────────────────────────────────
function formatApiError(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;

  const parts = [];
  parts.push(data.error || fallback);
  if (data.cause) parts.push(`${t('logs.cause')}: ${data.cause}`);
  if (data.action) parts.push(`${t('logs.action')}: ${data.action}`);
  if (data.details) parts.push(`Details: ${data.details}`);
  if (data.requestId) parts.push(`Request ID: ${data.requestId}`);
  return parts.filter(Boolean).join(' ');
}

function formatWsError(msg) {
  if (!msg || typeof msg !== 'object') return 'WebSocket error';
  return [msg.message || 'WebSocket error', msg.cause, msg.code ? `Code: ${msg.code}` : '']
    .filter(Boolean)
    .join(' ');
}

function showToast(message, type = 'info', timeoutMs = 3000) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  setTimeout(() => toast.classList.remove('show'), timeoutMs);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}
