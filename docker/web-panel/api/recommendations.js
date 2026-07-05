/**
 * Server recommendation API - lightweight hardware/workload detection.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('../server');
const { sendError } = require('../errors');

const COMMAND_TIMEOUT_MS = 1200;

const LARGE_CONTENT_MOD_PATTERNS = [
  { key: 'ridgeside', label: 'Ridgeside Village', patterns: ['ridgeside', 'rafseazz.ridgeside'] },
  { key: 'sve', label: 'Stardew Valley Expanded', patterns: ['stardew valley expanded', 'stardewvalleyexpanded', 'flashshifter.stardewvalleyexpanded'] },
  { key: 'eastscarp', label: 'East Scarp', patterns: ['east scarp', 'eastscarp'] },
  { key: 'downtown_zuzu', label: 'Downtown Zuzu', patterns: ['downtown zuzu', 'downtownzuzu'] },
  { key: 'boarding_house', label: 'Boarding House', patterns: ['boarding house', 'boardinghouse'] },
  { key: 'adventurers_guild_expanded', label: 'Adventurer Guild Expanded', patterns: ['adventurer guild expanded', 'adventurers guild expanded', 'adventurerguildexpanded'] },
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readFileTrim(file) {
  try {
    return fs.readFileSync(file, 'utf-8').trim();
  } catch (error) {
    return '';
  }
}

function readPositiveInteger(file) {
  const raw = readFileTrim(file);
  if (!raw || raw === 'max') return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function detectCpu() {
  const hostCores = os.cpus().length || 1;

  const cpuMax = readFileTrim('/sys/fs/cgroup/cpu.max');
  if (cpuMax) {
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    const quota = quotaRaw === 'max' ? null : parseInt(quotaRaw, 10);
    const period = parseInt(periodRaw, 10);
    if (Number.isFinite(quota) && quota > 0 && Number.isFinite(period) && period > 0) {
      const quotaCores = quota / period;
      return {
        hostCores,
        quotaCores,
        effectiveCores: Math.max(0.1, Math.min(hostCores, quotaCores)),
        source: 'cgroup-v2',
      };
    }
  }

  const quota = readPositiveInteger('/sys/fs/cgroup/cpu/cpu.cfs_quota_us');
  const period = readPositiveInteger('/sys/fs/cgroup/cpu/cpu.cfs_period_us');
  if (quota && period) {
    const quotaCores = quota / period;
    return {
      hostCores,
      quotaCores,
      effectiveCores: Math.max(0.1, Math.min(hostCores, quotaCores)),
      source: 'cgroup-v1',
    };
  }

  return {
    hostCores,
    quotaCores: null,
    effectiveCores: hostCores,
    source: 'os',
  };
}

function detectMemory() {
  const hostBytes = os.totalmem();
  const candidates = [
    { source: 'cgroup-v2', bytes: readPositiveInteger('/sys/fs/cgroup/memory.max') },
    { source: 'cgroup-v1', bytes: readPositiveInteger('/sys/fs/cgroup/memory/memory.limit_in_bytes') },
  ].filter(item => item.bytes && item.bytes > 0);

  for (const candidate of candidates) {
    // Docker may expose a very large sentinel value when memory is unlimited.
    if (candidate.bytes <= hostBytes * 1.25) {
      return {
        hostBytes,
        limitBytes: candidate.bytes,
        effectiveBytes: candidate.bytes,
        source: candidate.source,
      };
    }
  }

  return {
    hostBytes,
    limitBytes: null,
    effectiveBytes: hostBytes,
    source: 'os',
  };
}

function detectDisk() {
  const target = [config.DATA_DIR, config.GAME_DIR, process.cwd()].find(item => item && fs.existsSync(item)) || process.cwd();
  const result = spawnSync('df', ['-Pk', target], {
    encoding: 'utf-8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024,
  });

  if (result.status !== 0 || !result.stdout) {
    return {
      path: target,
      availableBytes: null,
      totalBytes: null,
      usedPercent: null,
      error: result.stderr || (result.error && result.error.message) || 'df failed',
    };
  }

  const lines = result.stdout.trim().split('\n');
  const fields = (lines[lines.length - 1] || '').trim().split(/\s+/);
  const totalKb = parseInt(fields[1], 10);
  const availableKb = parseInt(fields[3], 10);
  const usedPercent = parseInt(String(fields[4] || '').replace('%', ''), 10);

  return {
    path: target,
    totalBytes: Number.isFinite(totalKb) ? totalKb * 1024 : null,
    availableBytes: Number.isFinite(availableKb) ? availableKb * 1024 : null,
    usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
  };
}

function readManifest(modDir, folder) {
  const manifestPath = path.join(modDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return {
      folder,
      id: manifest.UniqueID || folder,
      name: manifest.Name || folder,
      description: manifest.Description || '',
    };
  } catch (error) {
    return {
      folder,
      id: folder,
      name: folder,
      description: '',
      error: error.message,
    };
  }
}

function scanMods() {
  const modsDir = path.join(config.GAME_DIR, 'Mods');
  if (!fs.existsSync(modsDir)) {
    return {
      modsDir,
      modCount: 0,
      largeContentMods: [],
      manifestErrors: 0,
      missingDir: true,
    };
  }

  const largeContentMods = [];
  let modCount = 0;
  let manifestErrors = 0;

  let entries = [];
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch (error) {
    return {
      modsDir,
      modCount: 0,
      largeContentMods: [],
      manifestErrors: 0,
      missingDir: false,
      error: error.message,
    };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    modCount += 1;

    const manifest = readManifest(path.join(modsDir, entry.name), entry.name);
    if (manifest && manifest.error) {
      manifestErrors += 1;
    }

    const haystack = [
      manifest && manifest.id,
      manifest && manifest.name,
      manifest && manifest.folder,
      manifest && manifest.description,
      entry.name,
    ].filter(Boolean).join(' ').toLowerCase();

    const matched = LARGE_CONTENT_MOD_PATTERNS.find(item =>
      item.patterns.some(pattern => haystack.includes(pattern))
    );

    if (matched && !largeContentMods.some(item => item.key === matched.key)) {
      largeContentMods.push({ key: matched.key, label: matched.label });
    }
  }

  return {
    modsDir,
    modCount,
    largeContentMods,
    manifestErrors,
    missingDir: false,
  };
}

function parseEnvFile() {
  const env = {};
  const candidates = [
    config.ENV_FILE,
    '/home/steam/.env',
    path.join(process.cwd(), '.env'),
  ];

  for (const envPath of candidates) {
    if (!envPath || !fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = parseEnvValue(trimmed.slice(index + 1));
      if (key) env[key] = value;
    }
  }

  return env;
}

function parseEnvValue(rawValue) {
  const raw = String(rawValue ?? '').trim();
  if (raw === '') return '';

  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\'/g, "'");
  }

  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  return raw.replace(/\s+#.*$/, '').trim();
}

function classifyServer(cpu, memory, workload) {
  const cores = cpu.effectiveCores || 1;
  const memoryMb = (memory.effectiveBytes || 0) / 1024 / 1024;
  const largeMods = workload.largeContentMods.length;
  const manyMods = workload.modCount >= 35 || largeMods >= 2;

  if (cores < 1.8 || memoryMb < 1800) {
    return {
      key: 'tiny',
      label: '极低配置',
      labelEn: 'Very Low',
      summary: '只能测试或轻量游玩，建议减少在线人数和大型 Mod。',
      summaryEn: 'Suitable only for testing or light play; reduce players and large mods.',
      confidence: 'high',
    };
  }

  if (cores <= 2.5 || memoryMb < 3200) {
    return {
      key: manyMods ? 'small-heavy' : 'small',
      label: manyMods ? '2核2G 大型Mod压力档' : '2核2G 标准档',
      labelEn: manyMods ? '2C2G Heavy-Mod' : '2C2G Standard',
      summary: manyMods
        ? '可以运行，但大型 Mod 会明显吃内存，建议低 FPS、少玩家、关闭 VNC。'
        : '适合小型联机，建议低占用配置，优先保证稳定。',
      summaryEn: manyMods
        ? 'Usable, but large mods are memory-heavy; use low FPS, fewer players, and disable VNC.'
        : 'Good for small co-op; prefer low-overhead settings for stability.',
      confidence: 'high',
    };
  }

  if (cores <= 4.5 || memoryMb < 6500) {
    return {
      key: manyMods ? 'medium-heavy' : 'medium',
      label: manyMods ? '4核4G 大型Mod档' : '4核4G 标准档',
      labelEn: manyMods ? '4C4G Heavy-Mod' : '4C4G Standard',
      summary: '适合中等规模联机，可以保留较好的面板体验。',
      summaryEn: 'Suitable for medium co-op with a comfortable panel experience.',
      confidence: 'high',
    };
  }

  return {
    key: 'large',
    label: '高配置档',
    labelEn: 'High',
    summary: '可以使用更高 FPS、更多玩家和更完整的日志保留。',
    summaryEn: 'Can use higher FPS, more players, and richer log retention.',
    confidence: 'medium',
  };
}

function buildPreset(tier, resources, workload) {
  const memoryMb = Math.floor((resources.memory.effectiveBytes || 0) / 1024 / 1024);
  const availableGb = resources.disk.availableBytes ? resources.disk.availableBytes / 1024 / 1024 / 1024 : null;
  const largeMods = workload.largeContentMods.length;

  const env = {
    USE_GPU: 'false',
    ENABLE_LOG_MONITOR: 'true',
    BACKUP_COMPRESSION_LEVEL: '1',
    PANEL_WORLD_HASH_MODE: 'manifest',
  };

  if (tier.key === 'tiny') {
    Object.assign(env, {
      LOW_PERF_MODE: 'true',
      TARGET_FPS: '20',
      RESOLUTION_WIDTH: '854',
      RESOLUTION_HEIGHT: '480',
      REFRESH_RATE: '30',
      ENABLE_VNC: 'false',
      MAX_PLAYERS: largeMods > 0 ? '2' : '3',
      ENABLE_AUTO_BACKUP: availableGb !== null && availableGb >= 12 ? 'true' : 'false',
      MAX_BACKUPS: '2',
      PANEL_STATUS_CACHE_MS: '7000',
      PANEL_STATUS_HISTORY_LIMIT: '90',
      PANEL_STATUS_LOG_TAIL_BYTES: '65536',
      PANEL_PLAYER_HISTORY_LIMIT: '72',
      PANEL_PLAYER_LOG_TAIL_BYTES: '65536',
      PANEL_LOG_TAIL_BYTES: '262144',
      PANEL_LOG_DEFAULT_LINES: '120',
      PANEL_LOG_MAX_LINES: '300',
      PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS: '180000',
      PANEL_HEALTH_COMMAND_TIMEOUT_MS: '1200',
      PANEL_COMMAND_TIMEOUT_MS: '1200',
    });
  } else if (tier.key === 'small' || tier.key === 'small-heavy') {
    Object.assign(env, {
      LOW_PERF_MODE: 'true',
      TARGET_FPS: '30',
      RESOLUTION_WIDTH: largeMods > 0 ? '960' : '1024',
      RESOLUTION_HEIGHT: largeMods > 0 ? '540' : '576',
      REFRESH_RATE: '30',
      ENABLE_VNC: 'false',
      MAX_PLAYERS: largeMods > 0 ? '3' : '4',
      ENABLE_AUTO_BACKUP: 'true',
      MAX_BACKUPS: availableGb !== null && availableGb < 12 ? '3' : '5',
      PANEL_STATUS_CACHE_MS: '5000',
      PANEL_STATUS_HISTORY_LIMIT: '120',
      PANEL_STATUS_LOG_TAIL_BYTES: '131072',
      PANEL_PLAYER_HISTORY_LIMIT: '144',
      PANEL_PLAYER_LOG_TAIL_BYTES: '131072',
      PANEL_LOG_TAIL_BYTES: '524288',
      PANEL_LOG_DEFAULT_LINES: '200',
      PANEL_LOG_MAX_LINES: '600',
      PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS: '120000',
      PANEL_HEALTH_COMMAND_TIMEOUT_MS: '1500',
      PANEL_COMMAND_TIMEOUT_MS: '1500',
    });
  } else if (tier.key === 'medium' || tier.key === 'medium-heavy') {
    Object.assign(env, {
      LOW_PERF_MODE: largeMods >= 2 ? 'true' : 'false',
      TARGET_FPS: largeMods >= 2 ? '30' : '45',
      RESOLUTION_WIDTH: '1280',
      RESOLUTION_HEIGHT: '720',
      REFRESH_RATE: '45',
      ENABLE_VNC: 'false',
      MAX_PLAYERS: largeMods >= 2 ? '6' : '8',
      ENABLE_AUTO_BACKUP: 'true',
      MAX_BACKUPS: availableGb !== null && availableGb < 16 ? '5' : '7',
      PANEL_STATUS_CACHE_MS: '4000',
      PANEL_STATUS_HISTORY_LIMIT: '180',
      PANEL_STATUS_LOG_TAIL_BYTES: '196608',
      PANEL_PLAYER_HISTORY_LIMIT: '180',
      PANEL_PLAYER_LOG_TAIL_BYTES: '196608',
      PANEL_LOG_TAIL_BYTES: '786432',
      PANEL_LOG_DEFAULT_LINES: '250',
      PANEL_LOG_MAX_LINES: '800',
      PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS: '90000',
      PANEL_HEALTH_COMMAND_TIMEOUT_MS: '1800',
      PANEL_COMMAND_TIMEOUT_MS: '1800',
    });
  } else {
    Object.assign(env, {
      LOW_PERF_MODE: 'false',
      TARGET_FPS: '60',
      RESOLUTION_WIDTH: '1280',
      RESOLUTION_HEIGHT: '720',
      REFRESH_RATE: '60',
      ENABLE_VNC: 'false',
      MAX_PLAYERS: '8',
      ENABLE_AUTO_BACKUP: 'true',
      MAX_BACKUPS: availableGb !== null && availableGb < 20 ? '7' : '10',
      PANEL_STATUS_CACHE_MS: '3000',
      PANEL_STATUS_HISTORY_LIMIT: '240',
      PANEL_STATUS_LOG_TAIL_BYTES: '262144',
      PANEL_PLAYER_HISTORY_LIMIT: '240',
      PANEL_PLAYER_LOG_TAIL_BYTES: '262144',
      PANEL_LOG_TAIL_BYTES: '1048576',
      PANEL_LOG_DEFAULT_LINES: '300',
      PANEL_LOG_MAX_LINES: '1000',
      PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS: '60000',
      PANEL_HEALTH_COMMAND_TIMEOUT_MS: '2000',
      PANEL_COMMAND_TIMEOUT_MS: '2000',
    });
  }

  const reasons = [
    {
      severity: 'info',
      message: `检测到约 ${resources.cpu.effectiveCores.toFixed(1)} 核、${memoryMb}MB 可用内存，归类为 ${tier.label}。`,
      messageEn: `Detected about ${resources.cpu.effectiveCores.toFixed(1)} CPU core(s) and ${memoryMb}MB usable memory; classified as ${tier.labelEn}.`,
    },
    {
      severity: largeMods > 0 ? 'warn' : 'info',
      message: largeMods > 0
        ? `检测到 ${largeMods} 个大型内容 Mod，建议降低 FPS 和同时在线人数。`
        : `当前大型内容 Mod 压力不高，按常规档位推荐。`,
      messageEn: largeMods > 0
        ? `Detected ${largeMods} large content mod(s); lower FPS and player count are recommended.`
        : 'Large content mod pressure looks low, using the standard preset.',
    },
  ];

  if (availableGb !== null && availableGb < 10) {
    reasons.push({
      severity: 'warn',
      message: `数据盘可用空间不足 ${availableGb.toFixed(1)}GB，建议减少备份数量并清理旧日志。`,
      messageEn: `Data disk has less than ${availableGb.toFixed(1)}GB free; reduce backups and clear old logs.`,
    });
  }

  if (memoryMb < 2048 && largeMods > 0) {
    reasons.push({
      severity: 'warn',
      message: '内存低于 2GB 且安装了大型 Mod，玩家人数建议控制在 2 人左右。',
      messageEn: 'Memory is below 2GB with large mods installed; keep real players around 2.',
    });
  }

  return { env, reasons };
}

function buildChanges(env, currentEnv) {
  return Object.entries(env).map(([key, recommended]) => {
    const current = Object.prototype.hasOwnProperty.call(currentEnv, key)
      ? currentEnv[key]
      : (process.env[key] || '');
    return {
      key,
      current,
      recommended,
      alreadyApplied: String(current) === String(recommended),
    };
  });
}

function getServerRecommendations(req, res) {
  try {
    const cpu = detectCpu();
    const memory = detectMemory();
    const disk = detectDisk();
    const workload = scanMods();
    const tier = classifyServer(cpu, memory, workload);
    const preset = buildPreset(tier, { cpu, memory, disk }, workload);
    const currentEnv = parseEnvFile();
    const changes = buildChanges(preset.env, currentEnv);
    const copyText = Object.entries(preset.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    res.json({
      generatedAt: new Date().toISOString(),
      host: {
        platform: os.platform(),
        arch: os.arch(),
        uptimeSeconds: Math.floor(os.uptime()),
      },
      resources: {
        cpu,
        memory,
        disk,
      },
      workload,
      tier,
      recommendations: {
        env: preset.env,
        reasons: preset.reasons,
        changes,
        changedCount: changes.filter(item => !item.alreadyApplied).length,
        copyText,
      },
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'SERVER_RECOMMENDATION_FAILED',
      message: 'Failed to build server recommendations',
      cause: error.cause || 'The panel could not read one or more local resource indicators.',
      details: error.message,
      action: error.action || 'Refresh the page or run health-check.sh to inspect container permissions.',
    });
  }
}

module.exports = { getServerRecommendations };
