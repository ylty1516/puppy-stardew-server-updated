/**
 * World state model for the host orchestration architecture.
 *
 * The panel intentionally hashes lightweight manifests by default so a 2c/2g
 * server is not forced to walk and hash every mod asset on each status poll.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../server');

const CACHE_TTL_MS = parseInt(process.env.PANEL_WORLD_STATE_CACHE_MS || '60000', 10);
const META_DIR = config.META_DIR || path.join(config.DATA_DIR, 'meta');
const MOD_GRAPH_FILE = config.MOD_GRAPH_FILE || path.join(META_DIR, 'mod_graph.json');
const WORLD_FINGERPRINT_FILE = config.WORLD_FINGERPRINT_FILE || path.join(META_DIR, 'world_fingerprint.json');
const ORCHESTRATION_STATE_FILE = config.ORCHESTRATION_STATE_FILE || path.join(META_DIR, 'orchestration-state.json');
const HASH_MODE = String(process.env.PANEL_WORLD_HASH_MODE || 'manifest').toLowerCase();

let cachedWorldState = null;
let cachedAt = 0;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalize(value[key]);
        return acc;
      }, {});
  }

  return value;
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function readJson(filePath, fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    return {
      error: error.message,
      file: filePath,
    };
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  const fd = fs.openSync(filePath, 'r');

  try {
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }

  return hash.digest('hex');
}

function getDirectoryStats(targetPath) {
  const result = {
    size: 0,
    fileCount: 0,
    mtimeMs: 0,
  };

  function visit(itemPath) {
    const stat = fs.statSync(itemPath);
    result.mtimeMs = Math.max(result.mtimeMs, stat.mtimeMs);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(itemPath).sort()) {
        visit(path.join(itemPath, child));
      }
      return;
    }

    result.size += stat.size;
    result.fileCount += 1;
  }

  if (targetPath && fs.existsSync(targetPath)) {
    visit(targetPath);
  }

  result.mtimeMs = Math.round(result.mtimeMs);
  return result;
}

function getShallowDirectoryStats(targetPath, markerPath = '') {
  const result = {
    size: 0,
    fileCount: 0,
    mtimeMs: 0,
  };

  try {
    if (!targetPath || !fs.existsSync(targetPath)) {
      return result;
    }

    const targetStat = fs.statSync(targetPath);
    result.mtimeMs = Math.round(targetStat.mtimeMs);

    if (markerPath && fs.existsSync(markerPath)) {
      const markerStat = fs.statSync(markerPath);
      result.size = markerStat.size;
      result.fileCount = 1;
      result.mtimeMs = Math.max(result.mtimeMs, Math.round(markerStat.mtimeMs));
    }
  } catch (error) {
    return result;
  }

  return result;
}

function hashDirectoryMetadata(rootDir) {
  const entries = [];
  const root = path.resolve(rootDir);

  function visit(itemPath) {
    const stat = fs.statSync(itemPath);
    const relativePath = path.relative(root, itemPath).replace(/\\/g, '/');
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(itemPath).sort()) {
        visit(path.join(itemPath, child));
      }
      return;
    }

    entries.push({
      path: relativePath,
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
    });
  }

  if (fs.existsSync(root)) {
    visit(root);
  }

  return sha256(stableJson(entries));
}

function readManifest(modDir, folder) {
  const manifestPath = path.join(modDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(raw);
    const dependencies = Array.isArray(manifest.Dependencies)
      ? manifest.Dependencies
        .filter(dep => dep && dep.UniqueID)
        .map(dep => ({
          id: String(dep.UniqueID).trim(),
          required: dep.IsRequired !== false,
          minimumVersion: dep.MinimumVersion || '',
        }))
        .filter(dep => dep.id)
      : [];
    const contentPackFor = manifest.ContentPackFor && manifest.ContentPackFor.UniqueID
      ? String(manifest.ContentPackFor.UniqueID).trim()
      : '';

    if (contentPackFor) {
      dependencies.push({
        id: contentPackFor,
        required: true,
        minimumVersion: manifest.ContentPackFor.MinimumVersion || '',
      });
    }

    return {
      folder,
      id: manifest.UniqueID || folder,
      name: manifest.Name || folder,
      version: manifest.Version || 'unknown',
      author: manifest.Author || '',
      contentPackFor,
      dependencies,
      manifestHash: sha256(raw),
      manifestPath,
    };
  } catch (error) {
    return {
      folder,
      id: folder,
      name: folder,
      version: 'unknown',
      author: '',
      contentPackFor: '',
      dependencies: [],
      manifestHash: '',
      manifestPath,
      error: error.message,
    };
  }
}

function hashModManifestIdentity(manifest) {
  return sha256(stableJson({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    contentPackFor: manifest.contentPackFor,
    dependencies: manifest.dependencies,
    manifestHash: manifest.manifestHash,
  }));
}

function buildModGraph() {
  const modsDir = path.join(config.GAME_DIR, 'Mods');
  const graph = {
    generatedAt: new Date().toISOString(),
    modsDir,
    integrityMode: HASH_MODE === 'full' ? 'full-directory-sha256' : 'manifest-lock',
    mods: [],
    dependencies: [],
    missingDependencies: [],
    optionalMissingDependencies: [],
    conflicts: [],
    errors: [],
    graphHash: '',
    status: 'unknown',
  };

  if (!fs.existsSync(modsDir)) {
    graph.status = 'missing_mods_dir';
    graph.errors.push({
      code: 'MODS_DIR_MISSING',
      message: `${modsDir} does not exist`,
    });
    graph.graphHash = sha256(stableJson({
      modsDir,
      status: graph.status,
    }));
    return graph;
  }

  const byId = new Map();
  const aliases = new Set();
  const entries = fs.readdirSync(modsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const modDir = path.join(modsDir, entry.name);
    const manifest = readManifest(modDir, entry.name);
    if (!manifest) {
      continue;
    }

    const stats = HASH_MODE === 'full'
      ? getDirectoryStats(modDir)
      : getShallowDirectoryStats(modDir, manifest.manifestPath);
    const contentHash = HASH_MODE === 'full'
      ? hashFileOrDirectory(modDir)
      : hashModManifestIdentity(manifest);
    const mod = {
      ...manifest,
      path: modDir,
      fileCount: stats.fileCount,
      size: stats.size,
      updatedAt: stats.mtimeMs ? new Date(stats.mtimeMs).toISOString() : '',
      contentHash,
    };

    graph.mods.push(mod);

    const normalizedId = normalizeId(mod.id);
    const existing = byId.get(normalizedId);
    if (existing) {
      graph.conflicts.push({
        code: 'DUPLICATE_MOD_ID',
        id: mod.id,
        folders: [existing.folder, mod.folder],
      });
    } else {
      byId.set(normalizedId, mod);
    }

    aliases.add(normalizeId(mod.id));
    aliases.add(normalizeId(mod.name));
    aliases.add(normalizeId(mod.folder));
  }

  graph.mods.sort((a, b) => a.id.localeCompare(b.id) || a.folder.localeCompare(b.folder));

  for (const mod of graph.mods) {
    for (const dep of mod.dependencies) {
      const dependency = {
        from: mod.id,
        to: dep.id,
        required: dep.required !== false,
        minimumVersion: dep.minimumVersion || '',
        present: aliases.has(normalizeId(dep.id)),
      };
      graph.dependencies.push(dependency);
      if (!dependency.present) {
        (dependency.required ? graph.missingDependencies : graph.optionalMissingDependencies).push(dependency);
      }
    }

    if (mod.error) {
      graph.errors.push({
        code: 'MOD_MANIFEST_INVALID',
        folder: mod.folder,
        message: mod.error,
      });
    }
  }

  graph.dependencies.sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`));
  graph.status = graph.errors.length > 0 || graph.conflicts.length > 0 || graph.missingDependencies.length > 0
    ? 'invalid'
    : 'valid';
  graph.graphHash = sha256(stableJson({
    mods: graph.mods.map(mod => ({
      id: mod.id,
      folder: mod.folder,
      version: mod.version,
      manifestHash: mod.manifestHash,
      contentHash: mod.contentHash,
      dependencies: mod.dependencies,
    })),
    dependencies: graph.dependencies,
    conflicts: graph.conflicts,
    errors: graph.errors,
  }));

  return graph;
}

function hashFileOrDirectory(targetPath) {
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return hashFile(targetPath);
  }

  const hashes = [];
  const root = path.resolve(targetPath);

  function visit(itemPath) {
    const itemStat = fs.statSync(itemPath);
    if (itemStat.isDirectory()) {
      for (const child of fs.readdirSync(itemPath).sort()) {
        visit(path.join(itemPath, child));
      }
      return;
    }

    hashes.push({
      path: path.relative(root, itemPath).replace(/\\/g, '/'),
      hash: hashFile(itemPath),
    });
  }

  visit(root);
  return sha256(stableJson(hashes));
}

function normalizeId(value) {
  return String(value || '').trim().toLowerCase();
}

function buildSaveState() {
  const savesDir = config.SAVES_DIR;
  const saveState = {
    savesDir,
    selectedSave: process.env.SAVE_NAME || '',
    saves: [],
    status: 'unknown',
    errors: [],
    saveHash: '',
  };

  if (!fs.existsSync(savesDir)) {
    saveState.status = 'missing_saves_dir';
    saveState.errors.push({
      code: 'SAVES_DIR_MISSING',
      message: `${savesDir} does not exist`,
    });
    saveState.saveHash = sha256(stableJson({
      status: saveState.status,
      savesDir,
    }));
    return saveState;
  }

  const entries = fs.readdirSync(savesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const saveDir = path.join(savesDir, entry.name);
    const mainSavePath = path.join(saveDir, entry.name);
    const stats = getShallowDirectoryStats(saveDir, mainSavePath);
    const hasInfo = fs.existsSync(path.join(saveDir, 'SaveGameInfo'));
    const hasSaveFile = fs.existsSync(mainSavePath);
    const save = {
      name: entry.name,
      path: saveDir,
      fileCount: stats.fileCount,
      size: stats.size,
      updatedAt: stats.mtimeMs ? new Date(stats.mtimeMs).toISOString() : '',
      hasSaveGameInfo: hasInfo,
      hasMainSaveFile: hasSaveFile,
      integrity: hasInfo && hasSaveFile ? 'ok' : 'invalid',
      metadataHash: '',
    };
    saveState.saves.push(save);
  }

  saveState.saves.sort((a, b) => {
    if (a.name === saveState.selectedSave) return -1;
    if (b.name === saveState.selectedSave) return 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });

  const selected = saveState.selectedSave
    ? saveState.saves.find(save => save.name === saveState.selectedSave)
    : saveState.saves[0];

  if (!selected) {
    saveState.status = 'no_saves';
    saveState.saveHash = sha256(stableJson({
      status: saveState.status,
      savesDir,
    }));
    return saveState;
  }

  saveState.selectedSave = selected.name;
  const selectedStats = getDirectoryStats(selected.path);
  selected.fileCount = selectedStats.fileCount;
  selected.size = selectedStats.size;
  selected.updatedAt = selectedStats.mtimeMs ? new Date(selectedStats.mtimeMs).toISOString() : selected.updatedAt;
  selected.metadataHash = hashDirectoryMetadata(selected.path);

  if (selected.integrity !== 'ok') {
    saveState.status = 'invalid';
    saveState.errors.push({
      code: 'SAVE_INTEGRITY_FAILED',
      save: selected.name,
      message: 'SaveGameInfo or the matching main save file is missing.',
    });
  } else {
    saveState.status = 'valid';
  }

  saveState.saveHash = sha256(stableJson({
    selectedSave: selected.name,
    metadataHash: selected.metadataHash,
    fileCount: selected.fileCount,
    size: selected.size,
  }));
  return saveState;
}

function detectSmapiVersion() {
  try {
    if (!fs.existsSync(config.SMAPI_LOG)) {
      return 'unknown';
    }

    const stat = fs.statSync(config.SMAPI_LOG);
    const bytesToRead = Math.min(stat.size, 128 * 1024);
    const fd = fs.openSync(config.SMAPI_LOG, 'r');
    let content = '';
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
      content = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }

    const match = content.match(/\bSMAPI\s+v?(\d+\.\d+(?:\.\d+)?)/i);
    return match ? match[1] : 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function getAcceptedFingerprint(previous, fingerprint) {
  if (!previous || previous.error) {
    return fingerprint;
  }

  return previous.acceptedFingerprint ||
    previous.lastAcceptedFingerprint ||
    previous.fingerprint ||
    fingerprint;
}

function buildWorldState(options = {}) {
  const now = Date.now();
  if (!options.force && cachedWorldState && now - cachedAt < CACHE_TTL_MS) {
    return cachedWorldState;
  }

  const previous = readJson(WORLD_FINGERPRINT_FILE, null);
  const modGraph = buildModGraph();
  const saveState = buildSaveState();
  const smapiVersion = detectSmapiVersion();
  const fingerprintInput = {
    saveHash: saveState.saveHash,
    modGraphHash: modGraph.graphHash,
    smapiVersion,
  };
  const fingerprint = sha256(stableJson(fingerprintInput));
  const acceptedFingerprint = getAcceptedFingerprint(previous, fingerprint);
  const changed = !!acceptedFingerprint && acceptedFingerprint !== fingerprint;
  const observedAt = new Date().toISOString();
  const binding = {
    state: changed ? 'changed' : 'current',
    changed,
    acceptedFingerprint,
    previousFingerprint: changed ? acceptedFingerprint : '',
    observedAt,
    acceptedAt: previous && !previous.error ? (previous.acceptedAt || previous.generatedAt || observedAt) : observedAt,
  };

  const worldState = {
    generatedAt: observedAt,
    fingerprint,
    fingerprintInput,
    smapiVersion,
    modGraph: {
      file: MOD_GRAPH_FILE,
      status: modGraph.status,
      graphHash: modGraph.graphHash,
      modCount: modGraph.mods.length,
      dependencyCount: modGraph.dependencies.length,
      missingDependencyCount: modGraph.missingDependencies.length,
      optionalMissingDependencyCount: modGraph.optionalMissingDependencies.length,
      conflictCount: modGraph.conflicts.length,
      errorCount: modGraph.errors.length,
      integrityMode: modGraph.integrityMode,
    },
    save: {
      status: saveState.status,
      selectedSave: saveState.selectedSave,
      saveHash: saveState.saveHash,
      saveCount: saveState.saves.length,
      errorCount: saveState.errors.length,
    },
    binding,
    files: {
      modGraph: MOD_GRAPH_FILE,
      fingerprint: WORLD_FINGERPRINT_FILE,
      orchestrationState: ORCHESTRATION_STATE_FILE,
    },
    issues: [
      ...modGraph.errors,
      ...modGraph.conflicts,
      ...modGraph.missingDependencies.map(dep => ({
        code: 'MOD_DEPENDENCY_MISSING',
        message: `${dep.from} requires ${dep.to}`,
      })),
      ...saveState.errors,
    ],
  };

  if (options.persist !== false) {
    writeJson(MOD_GRAPH_FILE, modGraph);
    writeJson(WORLD_FINGERPRINT_FILE, {
      fingerprint,
      currentFingerprint: fingerprint,
      acceptedFingerprint,
      input: fingerprintInput,
      generatedAt: worldState.generatedAt,
      previousFingerprint: binding.previousFingerprint,
      changed: binding.changed,
      acceptedAt: binding.acceptedAt,
    });
  }

  cachedWorldState = worldState;
  cachedAt = now;
  return worldState;
}

function readRuntimeState() {
  const state = readJson(ORCHESTRATION_STATE_FILE, null);
  if (!state || state.error) {
    return {
      available: false,
      state: '',
      phase: '',
      message: '',
      updatedAt: '',
      file: ORCHESTRATION_STATE_FILE,
      error: state && state.error ? state.error : '',
    };
  }

  return {
    available: true,
    file: ORCHESTRATION_STATE_FILE,
    ...state,
  };
}

function deriveOrchestration(status, worldState) {
  const runtime = readRuntimeState();
  const blockers = [];
  let state = 'INIT';
  let phase = runtime.phase || 'init';

  if (worldState.modGraph.status === 'invalid') {
    blockers.push('mod_graph_invalid');
  }
  if (worldState.save.status === 'invalid') {
    blockers.push('save_integrity_failed');
  }
  if (worldState.binding.changed) {
    blockers.push('world_fingerprint_changed');
  }

  if (!status.gameRunning) {
    state = runtime.state || 'STOPPED';
    phase = runtime.phase || 'stopped';
  } else if (!status.gameState || !status.gameState.available) {
    state = 'LOADING';
    phase = status.serverAutoload?.available
      ? `autoload_${status.serverAutoload.phase || 'unknown'}`
      : 'waiting_for_smapi_state_bridge';
  } else if (status.gameState.stale) {
    state = 'DEGRADED';
    phase = 'stale_state_bridge';
    blockers.push('state_bridge_stale');
  } else if (status.gameState.worldReady !== true) {
    state = 'LOADING';
    phase = status.serverAutoload?.available
      ? `autoload_${status.serverAutoload.phase || 'save_not_loaded'}`
      : 'save_not_loaded';
  } else if (status.gameState.multiplayerReady !== true) {
    state = 'STABILIZING';
    phase = 'multiplayer_handshake';
  } else if (status.gameState.joinable !== true) {
    state = 'STABILIZING';
    phase = status.gameState.joinableReason || 'joinability_gate';
  } else if (blockers.length > 0) {
    state = 'DEGRADED';
    phase = blockers[0];
  } else {
    state = 'RUNNING';
    phase = 'stable';
  }

  return {
    state,
    phase,
    explicit: true,
    blockers: Array.from(new Set(blockers)),
    runtime,
    worldFingerprint: worldState.fingerprint,
    worldFingerprintShort: worldState.fingerprint.slice(0, 12),
    modGraphHash: worldState.modGraph.graphHash,
    modGraphHashShort: worldState.modGraph.graphHash.slice(0, 12),
    updatedAt: worldState.generatedAt,
  };
}

function getWorldState(req, res) {
  try {
    res.json(buildWorldState({ force: req.query && req.query.force === 'true' }));
  } catch (error) {
    res.status(500).json({
      error: 'Failed to build world state',
      cause: error.message,
      action: 'Check game, save and panel metadata directory permissions.',
    });
  }
}

function acceptWorldFingerprint(req, res) {
  try {
    const current = buildWorldState({ force: true, persist: false });
    const previous = readJson(WORLD_FINGERPRINT_FILE, null);
    const acceptedAt = new Date().toISOString();

    writeJson(WORLD_FINGERPRINT_FILE, {
      fingerprint: current.fingerprint,
      currentFingerprint: current.fingerprint,
      acceptedFingerprint: current.fingerprint,
      previousAcceptedFingerprint: previous && !previous.error
        ? (previous.acceptedFingerprint || previous.fingerprint || '')
        : '',
      input: current.fingerprintInput,
      generatedAt: current.generatedAt,
      acceptedAt,
      changed: false,
    });

    cachedWorldState = null;
    cachedAt = 0;

    res.json({
      success: true,
      acceptedAt,
      worldState: buildWorldState({ force: true }),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to accept world fingerprint',
      cause: error.message,
      action: 'Check panel metadata directory permissions, then retry after creating a backup.',
    });
  }
}

module.exports = {
  acceptWorldFingerprint,
  buildWorldState,
  deriveOrchestration,
  getWorldState,
  readRuntimeState,
};
