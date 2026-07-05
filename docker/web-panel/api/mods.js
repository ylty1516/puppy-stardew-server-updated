/**
 * Mods API - List, upload and delete mods
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('../server');
const { AppError, commandError, sendError } = require('../errors');

const CUSTOM_MODS_DIR = process.env.CUSTOM_MODS_DIR || '/home/steam/custom-mods';
const GAME_MODS_DIR = path.join(config.GAME_DIR, 'Mods');
const PREINSTALLED_MODS_DIR = process.env.PREINSTALLED_MODS_DIR || '/home/steam/preinstalled-mods';
const METADATA_SUFFIX = '.panel-meta.json';
const CLIENT_PACK_FILENAME = 'stardew-client-mods.zip';
const CLIENT_PACK_DIR = path.join(config.DATA_DIR, 'client-packs');
const CLIENT_PACK_PATH = path.join(CLIENT_PACK_DIR, CLIENT_PACK_FILENAME);
const CLIENT_PACK_METADATA_PATH = path.join(CLIENT_PACK_DIR, 'stardew-client-mods.json');
const MOD_BACKUPS_DIR = path.join(config.DATA_DIR, 'mod-backups');
const PUBLIC_MOD_MANIFEST_CACHE_MS = parseInt(process.env.PANEL_PUBLIC_MOD_MANIFEST_CACHE_MS || '120000', 10);
const MOD_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const MOD_UPLOAD_MAX_MB = Math.round(MOD_UPLOAD_MAX_BYTES / 1024 / 1024);
const MOD_ARCHIVE_EXTRACT_TIMEOUT_MS = parseInt(process.env.PANEL_MOD_EXTRACT_TIMEOUT_MS || '120000', 10);
const CLIENT_REQUIRED_MOD_IDS = new Set([
  'ylty.SinglePlayerPauseReporter',
]);
const CLIENT_REQUIRED_MOD_FOLDERS = new Set([
  'YltySinglePlayerPauseReporter',
]);
const SERVER_ONLY_MOD_IDS = new Set([
  'AIdev.AutoHideHost',
  'puppystardew.ServerAutoLoad',
  'mikko.Always_On_Server',
  'puppystardew.SkillLevelGuard',
]);
const SERVER_ONLY_MOD_FOLDERS = new Set([
  'AutoHideHost',
  'ServerAutoLoad',
  'AlwaysOnServer',
  'SkillLevelGuard',
]);

let publicModManifestCache = null;
let publicModManifestCacheTime = 0;

function isSuccessful(result) {
  return result && result.status === 0;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    ...options,
  });

  if (!isSuccessful(result)) {
    throw commandError(command, args, result);
  }

  return result.stdout || '';
}

function extractZipArchive(zipPath, destDir) {
  const args = ['-q', '-o', zipPath, '-d', destDir];
  const result = spawnSync('unzip', args, {
    encoding: 'utf-8',
    timeout: MOD_ARCHIVE_EXTRACT_TIMEOUT_MS,
  });

  if (isSuccessful(result)) {
    return;
  }

  const output = [
    result && result.stderr,
    result && result.stdout,
    result && result.error && result.error.message,
  ].filter(Boolean).join('\n');
  const isWindowsPathSeparatorWarning = result &&
    result.status === 1 &&
    /appears to use backslashes as path separators/i.test(output);

  if (isWindowsPathSeparatorWarning) {
    return;
  }

  throw commandError('unzip', args, result);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function getTreeMtimeMs(targetPath) {
  let maxMtime = 0;
  const visit = (itemPath) => {
    const stat = fs.statSync(itemPath);
    maxMtime = Math.max(maxMtime, stat.mtimeMs);
    if (!stat.isDirectory()) {
      return;
    }

    for (const child of fs.readdirSync(itemPath)) {
      visit(path.join(itemPath, child));
    }
  };

  visit(targetPath);
  return Math.round(maxMtime);
}

function assertSafeArchiveFilename(filename, extension = '.tar.gz') {
  const safeName = path.basename(filename || '');
  if (!safeName || safeName !== filename || !safeName.endsWith(extension)) {
    throw new AppError('Invalid archive filename', {
      status: 400,
      code: 'INVALID_ARCHIVE_FILENAME',
      cause: 'Archive filenames cannot contain path separators and must use the expected extension.',
      action: 'Refresh the page and choose an archive from the list.',
    });
  }

  return safeName;
}

function getDirectoryStats(targetPath) {
  const result = {
    size: 0,
    fileCount: 0,
    mtimeMs: 0,
  };

  const visit = (itemPath) => {
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
  };

  if (fs.existsSync(targetPath)) {
    visit(targetPath);
  }

  result.mtimeMs = Math.round(result.mtimeMs);
  return result;
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

function invalidatePublicModManifestCache() {
  publicModManifestCache = null;
  publicModManifestCacheTime = 0;
}

function hashDirectory(rootDir) {
  const hash = crypto.createHash('sha256');
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

    hash.update(relativePath);
    hash.update('\0');
    hash.update(hashFile(itemPath));
    hash.update('\0');
  }

  visit(root);
  return hash.digest('hex');
}

function readManifest(modDir, fallbackName) {
  const manifestPath = path.join(modDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    return {
      id: manifest.UniqueID || fallbackName,
      name: manifest.Name || fallbackName,
      version: manifest.Version || 'unknown',
      author: manifest.Author || 'unknown',
      description: manifest.Description || '',
    };
  } catch (error) {
    return {
      id: fallbackName,
      name: fallbackName,
      version: 'unknown',
      author: 'unknown',
      description: '',
    };
  }
}

function getPreinstalledModFolders() {
  const folders = new Set();

  if (!fs.existsSync(PREINSTALLED_MODS_DIR)) {
    return folders;
  }

  const entries = fs.readdirSync(PREINSTALLED_MODS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      folders.add(entry.name);
    }
  }

  return folders;
}

function getMetadataPath(baseName) {
  return path.join(CUSTOM_MODS_DIR, `${baseName}${METADATA_SUFFIX}`);
}

function isServerOnlyMod(manifest, folder, preinstalledFolders = new Set()) {
  const uniqueId = manifest && manifest.id;
  if (CLIENT_REQUIRED_MOD_IDS.has(uniqueId) || CLIENT_REQUIRED_MOD_FOLDERS.has(folder)) {
    return false;
  }

  return SERVER_ONLY_MOD_IDS.has(uniqueId) ||
    SERVER_ONLY_MOD_FOLDERS.has(folder) ||
    preinstalledFolders.has(folder);
}

function getClientCompatibility(manifest, folder, preinstalledFolders = new Set()) {
  const serverOnly = isServerOnlyMod(manifest, folder, preinstalledFolders);
  return {
    clientRequired: !serverOnly,
    clientCompatibility: serverOnly ? 'server-only' : 'client-required',
  };
}

function getInstalledModCompatibility(folder) {
  const modDir = path.join(GAME_MODS_DIR, folder);
  const manifest = readManifest(modDir, folder);
  if (!manifest) {
    return null;
  }

  return {
    manifest,
    ...getClientCompatibility(manifest, folder, getPreinstalledModFolders()),
  };
}

function loadMetadataByBaseName(baseName) {
  const metadataPath = getMetadataPath(baseName);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    metadata._path = metadataPath;
    return metadata;
  } catch (error) {
    return null;
  }
}

function loadAllMetadata() {
  if (!fs.existsSync(CUSTOM_MODS_DIR)) {
    return [];
  }

  return fs.readdirSync(CUSTOM_MODS_DIR)
    .filter(name => name.endsWith(METADATA_SUFFIX))
    .map(name => loadMetadataByBaseName(name.slice(0, -METADATA_SUFFIX.length)))
    .filter(Boolean);
}

function getMatchingMetadata(folder) {
  return loadAllMetadata().filter(entry =>
    entry.filename === `${folder}.zip` ||
    (Array.isArray(entry.installedFolders) && entry.installedFolders.includes(folder))
  );
}

function getUploadMetadata(filename) {
  const safeFilename = path.basename(filename || '');
  const baseName = safeFilename.replace(/\.zip$/i, '');
  const entries = [];
  const seenPaths = new Set();

  const add = (metadata) => {
    if (!metadata || !metadata._path || seenPaths.has(metadata._path)) {
      return;
    }

    entries.push(metadata);
    seenPaths.add(metadata._path);
  };

  add(loadMetadataByBaseName(baseName));
  for (const metadata of loadAllMetadata()) {
    if (path.basename(metadata.filename || '') === safeFilename) {
      add(metadata);
    }
  }

  return entries;
}

function getUploadTargets(filename) {
  const safeFilename = path.basename(filename || '');
  const baseName = safeFilename.replace(/\.zip$/i, '');
  const sourcePaths = new Set([
    path.join(CUSTOM_MODS_DIR, safeFilename),
    getMetadataPath(baseName),
  ]);
  const gamePaths = new Set();

  for (const metadata of getUploadMetadata(safeFilename)) {
    if (metadata.filename) {
      sourcePaths.add(path.join(CUSTOM_MODS_DIR, path.basename(metadata.filename)));
    }
    if (metadata._path) {
      sourcePaths.add(metadata._path);
    }
    if (Array.isArray(metadata.installedFolders)) {
      for (const installedFolder of metadata.installedFolders) {
        const safeFolder = path.basename(installedFolder || '');
        if (safeFolder) {
          gamePaths.add(path.join(GAME_MODS_DIR, safeFolder));
        }
      }
    }
  }

  return {
    sourcePaths: [...sourcePaths],
    gamePaths: [...gamePaths],
  };
}

function removeUploadTargets(filename) {
  const targets = getUploadTargets(filename);
  for (const target of [...targets.sourcePaths, ...targets.gamePaths]) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function removeInstalledFolderTargets(folder) {
  const safeFolder = path.basename(folder || '');
  if (!safeFolder) {
    return;
  }

  for (const metadata of getMatchingMetadata(safeFolder)) {
    if (metadata.filename) {
      removeUploadTargets(metadata.filename);
    }
    if (metadata._path) {
      fs.rmSync(metadata._path, { force: true });
    }
  }

  fs.rmSync(path.join(GAME_MODS_DIR, safeFolder), { recursive: true, force: true });
  fs.rmSync(path.join(CUSTOM_MODS_DIR, `${safeFolder}.zip`), { force: true });
  fs.rmSync(path.join(CUSTOM_MODS_DIR, safeFolder), { recursive: true, force: true });
}

function removeModImportConflicts(filename, folders) {
  removeUploadTargets(filename);
  for (const folder of folders) {
    removeInstalledFolderTargets(folder);
  }
}

function hasUploadTarget(filename) {
  const targets = getUploadTargets(filename);
  return [...targets.sourcePaths, ...targets.gamePaths].some(target => fs.existsSync(target));
}

function findManifestDirectories(rootDir, maxDepth = 3, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(rootDir)) {
    return [];
  }

  const manifestPath = path.join(rootDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    return [rootDir];
  }

  const found = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    found.push(...findManifestDirectories(path.join(rootDir, entry.name), maxDepth, depth + 1));
  }

  return found;
}

function sanitizeInstallFolderName(value, fallback) {
  const safeName = path.basename(String(value || '')).trim();
  if (safeName && safeName !== '.' && safeName !== '..') {
    return safeName;
  }

  const safeFallback = path.basename(String(fallback || 'uploaded-mod')).trim();
  return safeFallback && safeFallback !== '.' && safeFallback !== '..'
    ? safeFallback
    : 'uploaded-mod';
}

function getArchiveBaseName(filename) {
  return sanitizeInstallFolderName(path.basename(filename || '').replace(/\.zip$/i, ''), 'uploaded-mod');
}

function normalizeArchiveModEntries(manifestDirs, tempRoot, archiveBaseName) {
  const tempRootPath = path.resolve(tempRoot);
  const entries = manifestDirs.map(manifestDir => {
    const resolvedManifestDir = path.resolve(manifestDir);
    const rawFolderName = resolvedManifestDir === tempRootPath
      ? archiveBaseName
      : path.basename(manifestDir);

    return {
      manifestDir,
      installedFolder: sanitizeInstallFolderName(rawFolderName, archiveBaseName),
    };
  });

  const seenFolders = new Map();
  const duplicateFolders = [];
  for (const entry of entries) {
    const key = entry.installedFolder.toLowerCase();
    if (seenFolders.has(key)) {
      duplicateFolders.push(entry.installedFolder);
    }
    seenFolders.set(key, entry.installedFolder);
  }

  if (duplicateFolders.length > 0) {
    throw new AppError('Archive contains duplicate mod folder names', {
      status: 400,
      code: 'MOD_ARCHIVE_DUPLICATE_FOLDERS',
      cause: `The zip archive contains more than one mod that would install to: ${[...new Set(duplicateFolders)].join(', ')}.`,
      action: 'Rename the duplicated mod folders inside the zip, or upload those mods separately.',
      metadata: {
        duplicates: [...new Set(duplicateFolders)],
        installedFolders: entries.map(entry => entry.installedFolder),
      },
    });
  }

  return entries;
}

function withExtractedModArchive(zipPath, archiveBaseName, handler) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-mod-'));

  try {
    try {
      extractZipArchive(zipPath, tempRoot);
    } catch (error) {
      if (error.code === 'COMMAND_NOT_FOUND') {
        throw error;
      }

      throw new AppError('Cannot extract mod archive', {
        status: 400,
        code: 'MOD_ARCHIVE_EXTRACT_FAILED',
        cause: error.cause || 'The uploaded file is not a readable zip archive.',
        details: error.details || error.message,
        action: 'Upload a valid .zip file exported from a SMAPI mod or mod pack.',
      });
    }

    const manifestDirs = findManifestDirectories(tempRoot);
    const entries = normalizeArchiveModEntries(manifestDirs, tempRoot, archiveBaseName);
    return handler({
      tempRoot,
      entries,
      installedFolders: entries.map(entry => entry.installedFolder),
      hasManifest: entries.length > 0,
      bundle: entries.length > 1,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function getProtectedModFolderConflicts(folders) {
  const preinstalledFolders = getPreinstalledModFolders();
  return folders.filter(folder => preinstalledFolders.has(folder));
}

function getInstalledFolderConflicts(folders) {
  const conflicts = [];
  const seen = new Set();

  for (const folder of folders) {
    const safeFolder = path.basename(folder || '');
    if (!safeFolder || seen.has(safeFolder)) {
      continue;
    }

    const targets = [
      path.join(GAME_MODS_DIR, safeFolder),
      path.join(CUSTOM_MODS_DIR, `${safeFolder}.zip`),
      path.join(CUSTOM_MODS_DIR, safeFolder),
    ];
    const metadata = getMatchingMetadata(safeFolder);
    if (metadata.length > 0 || targets.some(target => fs.existsSync(target))) {
      conflicts.push(safeFolder);
      seen.add(safeFolder);
    }
  }

  return conflicts;
}

function getModImportConflicts(filename, installedFolders) {
  const existingUpload = hasUploadTarget(filename);
  const folderConflicts = getInstalledFolderConflicts(installedFolders);
  return {
    existingUpload,
    folderConflicts,
    hasConflict: existingUpload || folderConflicts.length > 0,
  };
}

function installArchiveEntriesToGameMods(entries) {
  ensureDir(GAME_MODS_DIR);

  const installedFolders = [];

  for (const entry of entries) {
    const destDir = assertManagedChildPath(
      GAME_MODS_DIR,
      path.join(GAME_MODS_DIR, entry.installedFolder),
      'GAME_MOD_INVALID_PATH'
    );
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.cpSync(entry.manifestDir, destDir, { recursive: true });
    installedFolders.push(entry.installedFolder);
  }

  return {
    installedFolders,
    hasManifest: installedFolders.length > 0,
    bundle: installedFolders.length > 1,
  };
}

function installArchiveToGameMods(zipPath, archiveBaseName = getArchiveBaseName(zipPath)) {
  return withExtractedModArchive(zipPath, archiveBaseName, extracted =>
    installArchiveEntriesToGameMods(extracted.entries)
  );
}

function resolveChildPath(rootDir, childName) {
  const root = path.resolve(rootDir);
  const target = path.resolve(rootDir, childName);
  if (!target.startsWith(root + path.sep)) {
    throw new AppError('Invalid mod path', {
      status: 400,
      code: 'MOD_INVALID_PATH',
      cause: 'The requested mod path is outside the allowed mod directory.',
      action: 'Refresh the Mods page and try again.',
    });
  }

  return target;
}

function assertManagedChildPath(rootDir, targetPath, code = 'MOD_INVALID_PATH') {
  const root = path.resolve(rootDir);
  const target = path.resolve(targetPath);
  if (!target.startsWith(root + path.sep)) {
    throw new AppError('Refusing to modify a path outside the managed mod directory', {
      status: 400,
      code,
      cause: 'A computed mod path escaped the allowed custom or game Mods directory.',
      action: 'Refresh the page and retry. If this repeats, check for invalid mod metadata files.',
    });
  }

  return target;
}

function getClearCustomModTargets() {
  const preinstalledFolders = getPreinstalledModFolders();
  const sourcePaths = [];
  const gamePaths = [];
  const sourceEntries = [];
  const installedFolders = [];

  if (fs.existsSync(CUSTOM_MODS_DIR)) {
    for (const entry of fs.readdirSync(CUSTOM_MODS_DIR, { withFileTypes: true })) {
      const target = assertManagedChildPath(CUSTOM_MODS_DIR, path.join(CUSTOM_MODS_DIR, entry.name), 'CUSTOM_MOD_INVALID_PATH');
      sourcePaths.push(target);
      sourceEntries.push(entry.name);
    }
  }

  if (fs.existsSync(GAME_MODS_DIR)) {
    for (const entry of fs.readdirSync(GAME_MODS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || preinstalledFolders.has(entry.name)) {
        continue;
      }

      const target = assertManagedChildPath(GAME_MODS_DIR, path.join(GAME_MODS_DIR, entry.name), 'GAME_MOD_INVALID_PATH');
      gamePaths.push(target);
      installedFolders.push(entry.name);
    }
  }

  return {
    sourcePaths,
    gamePaths,
    sourceEntries,
    installedFolders,
  };
}

function getModDownloadSource(folder, options = {}) {
  const safeFolder = path.basename(folder || '');
  if (!safeFolder) {
    throw new AppError('Mod folder name is required', {
      status: 400,
      code: 'MOD_FOLDER_REQUIRED',
      cause: 'The download request did not include a mod folder.',
      action: 'Download a mod from the Installed Mods list.',
    });
  }

  const preinstalledFolders = getPreinstalledModFolders();
  const compatibility = getInstalledModCompatibility(safeFolder);
  if (options.clientRequiredOnly && (!compatibility || compatibility.clientRequired !== true)) {
    throw new AppError('Mod is not required by players', {
      status: 403,
      code: 'MOD_NOT_CLIENT_REQUIRED',
      cause: 'The selected mod is server-only or not currently installed as a player-required mod.',
      action: 'Use the full player mod pack or choose a client-required mod from the public download page.',
    });
  }

  if (preinstalledFolders.has(safeFolder) && !(options.allowClientRequiredBuiltin && compatibility?.clientRequired === true)) {
    throw new AppError('Built-in mods cannot be downloaded individually', {
      status: 403,
      code: 'BUILT_IN_MOD_PROTECTED',
      cause: 'The selected mod is part of the preinstalled server mod stack.',
      action: 'Use the player mod pack for client-required mods, or download only uploaded custom mods.',
    });
  }

  const metadataEntries = getMatchingMetadata(safeFolder);
  const archiveNames = [
    ...metadataEntries.map(entry => path.basename(entry.filename || '')),
    `${safeFolder}.zip`,
  ].filter(Boolean);

  for (const archiveName of archiveNames) {
    const archivePath = resolveChildPath(CUSTOM_MODS_DIR, archiveName);
    if (fs.existsSync(archivePath) && fs.statSync(archivePath).isFile()) {
      return {
        type: 'file',
        path: archivePath,
        filename: archiveName,
        folder: safeFolder,
      };
    }
  }

  const customDir = resolveChildPath(CUSTOM_MODS_DIR, safeFolder);
  if (fs.existsSync(customDir) && fs.statSync(customDir).isDirectory()) {
    return {
      type: 'directory',
      root: CUSTOM_MODS_DIR,
      folder: safeFolder,
      filename: `${safeFolder}.zip`,
    };
  }

  const gameDir = resolveChildPath(GAME_MODS_DIR, safeFolder);
  if (fs.existsSync(gameDir) && fs.statSync(gameDir).isDirectory()) {
    return {
      type: 'directory',
      root: GAME_MODS_DIR,
      folder: safeFolder,
      filename: `${safeFolder}.zip`,
    };
  }

  throw new AppError('Custom mod not found', {
    status: 404,
    code: 'CUSTOM_MOD_NOT_FOUND',
    cause: 'The selected uploaded mod no longer exists on disk.',
    action: 'Refresh the Mods page and try again.',
  });
}

function createTemporaryModArchive(source) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-mod-download-'));
  const zipPath = path.join(tempDir, source.filename);

  try {
    runCommand('zip', ['-qr', zipPath, `./${source.folder}`], {
      cwd: source.root,
      timeout: 180000,
    });
    return { zipPath, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function getMods(req, res) {
  const mods = [];
  const seenFolders = new Set();
  const preinstalledFolders = getPreinstalledModFolders();

  // Scan installed game mods. Anything not in the preinstalled set is treated as custom.
  try {
    if (fs.existsSync(GAME_MODS_DIR)) {
      const entries = fs.readdirSync(GAME_MODS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const manifest = readManifest(path.join(GAME_MODS_DIR, entry.name), entry.name);
        if (!manifest) continue;

        mods.push({
          ...manifest,
          enabled: true,
          isCustom: !preinstalledFolders.has(entry.name),
          folder: entry.name,
          ...getClientCompatibility(manifest, entry.name, preinstalledFolders),
        });
        seenFolders.add(entry.name);
      }
    }
  } catch (e) {}

  // Scan pending custom source entries which are not already installed into the game Mods directory.
  try {
    if (fs.existsSync(CUSTOM_MODS_DIR)) {
      const entries = fs.readdirSync(CUSTOM_MODS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.endsWith(METADATA_SUFFIX)) {
          continue;
        }

        if (entry.isDirectory()) {
          if (seenFolders.has(entry.name)) continue;

          const manifest = readManifest(path.join(CUSTOM_MODS_DIR, entry.name), entry.name);
          if (!manifest) continue;

          mods.push({
            ...manifest,
            enabled: true,
            isCustom: true,
            folder: entry.name,
            ...getClientCompatibility(manifest, entry.name, preinstalledFolders),
          });
          seenFolders.add(entry.name);
        } else if (entry.name.endsWith('.zip')) {
          const baseName = entry.name.replace(/\.zip$/i, '');
          const metadata = loadMetadataByBaseName(baseName);
          if (metadata && Array.isArray(metadata.installedFolders) && metadata.installedFolders.every(folder => seenFolders.has(folder))) {
            continue;
          }

          mods.push({
            id: entry.name,
            name: baseName,
            version: 'zip',
            author: '',
            description: 'Uploaded mod archive (pending restart or manual setup)',
            enabled: true,
            isCustom: true,
            folder: baseName,
            clientRequired: true,
            clientCompatibility: 'client-required',
          });
        }
      }
    }
  } catch (e) {}

  res.json({ mods, total: mods.length, clientPack: getClientPackStatus() });
}

/**
 * GET /api/mods/download/:folder
 * Download one uploaded/custom mod archive.
 */
function downloadMod(req, res) {
  let source;
  try {
    source = getModDownloadSource(req.params.folder);
  } catch (error) {
    return sendError(res, req, error, {
      status: error.status || 500,
      code: error.code || 'MOD_DOWNLOAD_LOOKUP_FAILED',
      message: 'Failed to find mod download',
      cause: error.cause || 'The panel could not find the selected uploaded mod.',
      details: error.details || error.message,
      action: error.action || 'Refresh the Mods page and try again.',
    });
  }

  if (source.type === 'file') {
    return res.download(source.path, source.filename, (error) => {
      if (error && !res.headersSent) {
        return sendError(res, req, error, {
          status: 500,
          code: 'MOD_DOWNLOAD_FAILED',
          message: 'Failed to download mod',
          cause: 'The mod archive exists, but the panel could not send it to the browser.',
          details: error.message,
          action: 'Retry the download and check panel logs if it fails again.',
        });
      }
    });
  }

  let tempArchive;
  try {
    tempArchive = createTemporaryModArchive(source);
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'MOD_ARCHIVE_CREATE_FAILED',
      message: 'Failed to package mod',
      cause: error.cause || 'The selected mod exists as a folder, but the panel could not create a zip download.',
      details: error.details || error.message,
      action: error.action || 'Rebuild the Docker image so the zip command is available, then retry.',
    });
  }

  return res.download(tempArchive.zipPath, source.filename, (error) => {
    fs.rmSync(tempArchive.tempDir, { recursive: true, force: true });
    if (error && !res.headersSent) {
      return sendError(res, req, error, {
        status: 500,
        code: 'MOD_DOWNLOAD_FAILED',
        message: 'Failed to download mod',
        cause: 'The temporary mod archive was created, but the panel could not send it to the browser.',
        details: error.message,
        action: 'Retry the download and check panel logs if it fails again.',
      });
    }
  });
}

function downloadPublicMod(req, res) {
  let source;
  try {
    source = getModDownloadSource(req.params.folder, {
      allowClientRequiredBuiltin: true,
      clientRequiredOnly: true,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: error.status || 500,
      code: error.code || 'PUBLIC_MOD_DOWNLOAD_LOOKUP_FAILED',
      message: 'Failed to find player mod download',
      cause: error.cause || 'The panel could not find the selected player-required mod.',
      details: error.details || error.message,
      action: error.action || 'Refresh the player mod download page and try again.',
    });
  }

  if (source.type === 'file') {
    return res.download(source.path, source.filename, (error) => {
      if (error && !res.headersSent) {
        return sendError(res, req, error, {
          status: 500,
          code: 'PUBLIC_MOD_DOWNLOAD_FAILED',
          message: 'Failed to download player mod',
          cause: 'The mod archive exists, but the panel could not send it to the browser.',
          details: error.message,
          action: 'Retry the download and tell the server owner if it fails again.',
        });
      }
    });
  }

  let tempArchive;
  try {
    tempArchive = createTemporaryModArchive(source);
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'PUBLIC_MOD_ARCHIVE_CREATE_FAILED',
      message: 'Failed to package player mod',
      cause: error.cause || 'The selected mod exists as a folder, but the panel could not create a zip download.',
      details: error.details || error.message,
      action: error.action || 'Tell the server owner to rebuild the Docker image so the zip command is available.',
    });
  }

  return res.download(tempArchive.zipPath, source.filename, (error) => {
    fs.rmSync(tempArchive.tempDir, { recursive: true, force: true });
    if (error && !res.headersSent) {
      return sendError(res, req, error, {
        status: 500,
        code: 'PUBLIC_MOD_DOWNLOAD_FAILED',
        message: 'Failed to download player mod',
        cause: 'The temporary mod archive was created, but the panel could not send it to the browser.',
        details: error.message,
        action: 'Retry the download and tell the server owner if it fails again.',
      });
    }
  });
}

function getClientPackEntries() {
  const packEntries = [];
  const preinstalledFolders = getPreinstalledModFolders();

  if (!fs.existsSync(GAME_MODS_DIR)) {
    return packEntries;
  }

  const root = path.resolve(GAME_MODS_DIR);
  const entries = fs.readdirSync(GAME_MODS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const modDir = path.resolve(GAME_MODS_DIR, entry.name);
    if (!modDir.startsWith(root + path.sep)) {
      continue;
    }

    const manifest = readManifest(modDir, entry.name);
    if (!manifest) {
      continue;
    }

    const compatibility = getClientCompatibility(manifest, entry.name, preinstalledFolders);
    if (!compatibility.clientRequired) {
      continue;
    }

    packEntries.push({
      folder: entry.name,
      name: manifest.name,
      id: manifest.id,
      version: manifest.version,
    });
  }

  return packEntries.sort((a, b) => a.folder.localeCompare(b.folder));
}

function getPublicModManifest(req = null, options = {}) {
  const cacheMs = Number.isFinite(PUBLIC_MOD_MANIFEST_CACHE_MS) && PUBLIC_MOD_MANIFEST_CACHE_MS > 0
    ? PUBLIC_MOD_MANIFEST_CACHE_MS
    : 120000;
  if (!options.force && publicModManifestCache && Date.now() - publicModManifestCacheTime < cacheMs) {
    return publicModManifestCache;
  }

  const entries = getClientPackEntries();
  const mods = entries.map(entry => {
    const modDir = path.join(GAME_MODS_DIR, entry.folder);
    const stats = getDirectoryStats(modDir);
    const hash = hashDirectory(modDir);

    return {
      ...entry,
      size: stats.size,
      fileCount: stats.fileCount,
      updatedAt: stats.mtimeMs ? new Date(stats.mtimeMs).toISOString() : '',
      sha256: hash,
      downloadUrl: `/api/public/mods/download/${encodeURIComponent(entry.folder)}`,
    };
  });

  publicModManifestCache = {
    generatedAt: new Date().toISOString(),
    cacheTtlMs: cacheMs,
    clientPack: {
      ...getClientPackStatus(),
      downloadUrl: '/api/public/mods/client-pack',
    },
    manifestUrl: '/api/public/mods/manifest.json',
    mods,
    total: mods.length,
  };
  publicModManifestCacheTime = Date.now();
  return publicModManifestCache;
}

function getPublicMods(req, res) {
  try {
    res.json(getPublicModManifest(req));
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'PUBLIC_MOD_MANIFEST_FAILED',
      message: 'Failed to build player mod manifest',
      cause: error.cause || 'The panel could not inspect the player-required mods.',
      details: error.details || error.message,
      action: error.action || 'Ask the server owner to check mod directory permissions and refresh the page.',
    });
  }
}

function getClientPackSnapshot(entries) {
  return entries.map(entry => ({
    folder: entry.folder,
    id: entry.id,
    version: entry.version,
    mtimeMs: getTreeMtimeMs(path.join(GAME_MODS_DIR, entry.folder)),
  }));
}

function readClientPackMetadata() {
  try {
    if (!fs.existsSync(CLIENT_PACK_METADATA_PATH)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(CLIENT_PACK_METADATA_PATH, 'utf-8'));
  } catch (error) {
    return null;
  }
}

function isClientPackCurrent(metadata, entries) {
  if (!metadata || !fs.existsSync(CLIENT_PACK_PATH)) {
    return false;
  }

  try {
    return JSON.stringify(metadata.sources || []) === JSON.stringify(getClientPackSnapshot(entries));
  } catch (error) {
    return false;
  }
}

function removeClientPackFiles() {
  fs.rmSync(CLIENT_PACK_PATH, { force: true });
  fs.rmSync(CLIENT_PACK_METADATA_PATH, { force: true });
}

function getSafeClientPackEntryCount() {
  try {
    return getClientPackEntries().length;
  } catch (error) {
    return 0;
  }
}

function getClientPackStatus() {
  try {
    const entries = getClientPackEntries();
    const metadata = readClientPackMetadata();
    const current = isClientPackCurrent(metadata, entries);
    const zipExists = fs.existsSync(CLIENT_PACK_PATH);
    const zipStat = zipExists ? fs.statSync(CLIENT_PACK_PATH) : null;

    return {
      available: entries.length > 0 && zipExists && current,
      stale: entries.length > 0 && zipExists && !current,
      filename: CLIENT_PACK_FILENAME,
      modCount: entries.length,
      mods: entries,
      size: zipStat ? zipStat.size : 0,
      rebuiltAt: metadata?.rebuiltAt || '',
    };
  } catch (error) {
    return {
      available: false,
      stale: false,
      filename: CLIENT_PACK_FILENAME,
      modCount: 0,
      mods: [],
      size: 0,
      rebuiltAt: '',
      error: error.message,
      cause: error.cause || '',
      details: error.details || '',
      action: error.action || 'Check game Mods directory permissions and refresh the Mods page.',
    };
  }
}

function rebuildClientPack(reason = 'manual') {
  ensureDir(CLIENT_PACK_DIR);
  invalidatePublicModManifestCache();

  const entries = getClientPackEntries();
  if (entries.length === 0) {
    removeClientPackFiles();
    return {
      available: false,
      rebuilt: true,
      filename: CLIENT_PACK_FILENAME,
      modCount: 0,
      mods: [],
      reason,
    };
  }

  const tempZip = path.join(CLIENT_PACK_DIR, `${CLIENT_PACK_FILENAME}.tmp-${process.pid}-${Date.now()}`);
  fs.rmSync(tempZip, { force: true });

  try {
    const zipTargets = entries.map(entry => `./${entry.folder}`);
    runCommand('zip', ['-qr', tempZip, ...zipTargets], {
      cwd: GAME_MODS_DIR,
      timeout: 180000,
    });

    fs.renameSync(tempZip, CLIENT_PACK_PATH);

    const metadata = {
      filename: CLIENT_PACK_FILENAME,
      rebuiltAt: new Date().toISOString(),
      reason,
      modCount: entries.length,
      mods: entries,
      sources: getClientPackSnapshot(entries),
      size: fs.statSync(CLIENT_PACK_PATH).size,
    };
    fs.writeFileSync(CLIENT_PACK_METADATA_PATH, JSON.stringify(metadata, null, 2), 'utf-8');

    return {
      available: true,
      rebuilt: true,
      filename: CLIENT_PACK_FILENAME,
      modCount: entries.length,
      mods: entries,
      size: metadata.size,
      rebuiltAt: metadata.rebuiltAt,
      reason,
    };
  } catch (error) {
    fs.rmSync(tempZip, { force: true });
    throw error;
  }
}

function safeRebuildClientPack(reason) {
  try {
    return rebuildClientPack(reason);
  } catch (error) {
    return {
      available: false,
      rebuilt: false,
      filename: CLIENT_PACK_FILENAME,
      modCount: getSafeClientPackEntryCount(),
      error: error.message,
      cause: error.cause || '',
      details: error.details || '',
      action: error.action || 'Check that zip is installed and the web-panel data directory is writable.',
    };
  }
}

function getOrRebuildClientPack(reason) {
  const entries = getClientPackEntries();
  const metadata = readClientPackMetadata();
  if (isClientPackCurrent(metadata, entries)) {
    return {
      available: entries.length > 0,
      rebuilt: false,
      filename: CLIENT_PACK_FILENAME,
      modCount: entries.length,
      mods: entries,
      size: fs.existsSync(CLIENT_PACK_PATH) ? fs.statSync(CLIENT_PACK_PATH).size : 0,
      rebuiltAt: metadata?.rebuiltAt || '',
    };
  }

  return rebuildClientPack(reason);
}

/**
 * GET /api/mods/client-pack
 * Download a zip containing only mods that players may need locally.
 */
function downloadClientPack(req, res) {
  let clientPack;
  try {
    clientPack = getOrRebuildClientPack('download');
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'MOD_CLIENT_PACK_CREATE_FAILED',
      message: 'Failed to create client mod pack',
      cause: error.cause || 'The panel could not package the client-required mods.',
      details: error.details || error.message,
      action: error.action || 'Rebuild the Docker image so the zip command is available, then retry.',
    });
  }

  if (!clientPack.available) {
    return sendError(res, req, new AppError('No client-side mods need packaging', {
      status: 404,
      code: 'MOD_CLIENT_PACK_EMPTY',
      cause: 'The server currently has no custom or content mods that players need to install locally.',
      action: 'Upload a client/content mod first, or let players use the server without an extra mod pack.',
    }));
  }

  res.setHeader('X-Client-Mod-Count', String(clientPack.modCount));
  res.setHeader('X-Client-Pack-Rebuilt', clientPack.rebuilt ? 'true' : 'false');
  res.download(CLIENT_PACK_PATH, CLIENT_PACK_FILENAME, (error) => {
    if (error && !res.headersSent) {
      return sendError(res, req, error, {
        status: 500,
        code: 'MOD_CLIENT_PACK_DOWNLOAD_FAILED',
        message: 'Failed to download client mod pack',
        cause: 'The zip file was created, but the panel could not send it to the browser.',
        details: error.message,
        action: 'Retry the download and check panel logs if it fails again.',
      });
    }
  });
}

function cleanupOldModBackups() {
  const maxBackups = parseInt(process.env.MAX_MOD_BACKUPS || '10', 10);
  if (!maxBackups || maxBackups < 1 || !fs.existsSync(MOD_BACKUPS_DIR)) {
    return;
  }

  const backups = fs.readdirSync(MOD_BACKUPS_DIR)
    .filter(file => file.endsWith('.tar.gz'))
    .map(file => {
      const fullPath = path.join(MOD_BACKUPS_DIR, file);
      return {
        file,
        fullPath,
        metaPath: `${fullPath}.json`,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  backups.slice(maxBackups).forEach(item => {
    try {
      fs.rmSync(item.fullPath, { force: true });
      fs.rmSync(item.metaPath, { force: true });
    } catch (error) {}
  });
}

function createModBackup(reason = 'manual') {
  ensureDir(MOD_BACKUPS_DIR);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `mod-backup-${reason}-${timestamp}.tar.gz`.replace(/[^A-Za-z0-9_.-]/g, '-');
  const backupPath = path.join(MOD_BACKUPS_DIR, backupName);
  const metadataPath = `${backupPath}.json`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-mod-backup-'));

  try {
    const metadata = {
      filename: backupName,
      reason,
      createdAt: new Date().toISOString(),
      customModsExists: fs.existsSync(CUSTOM_MODS_DIR),
      gameModsExists: fs.existsSync(GAME_MODS_DIR),
      customModsDir: 'custom-mods',
      gameModsDir: 'Mods',
    };

    if (metadata.customModsExists) {
      fs.cpSync(CUSTOM_MODS_DIR, path.join(tempRoot, 'custom-mods'), { recursive: true });
    }
    if (metadata.gameModsExists) {
      fs.cpSync(GAME_MODS_DIR, path.join(tempRoot, 'Mods'), { recursive: true });
    }

    fs.writeFileSync(path.join(tempRoot, 'mod-backup.json'), JSON.stringify(metadata, null, 2), 'utf-8');
    runCommand('tar', ['-czf', backupPath, '-C', tempRoot, '.'], {
      timeout: 180000,
    });

    const stat = fs.statSync(backupPath);
    const result = {
      ...metadata,
      size: stat.size,
    };
    fs.writeFileSync(metadataPath, JSON.stringify(result, null, 2), 'utf-8');
    cleanupOldModBackups();
    return result;
  } catch (error) {
    fs.rmSync(backupPath, { force: true });
    fs.rmSync(metadataPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function readModBackupMetadata(filename) {
  const safeName = assertSafeArchiveFilename(filename);
  const backupPath = path.join(MOD_BACKUPS_DIR, safeName);
  const metadataPath = `${backupPath}.json`;
  let metadata = {};

  try {
    if (fs.existsSync(metadataPath)) {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    }
  } catch (error) {
    metadata = {};
  }

  const stat = fs.statSync(backupPath);
  return {
    filename: safeName,
    reason: metadata.reason || '',
    createdAt: metadata.createdAt || stat.mtime.toISOString(),
    size: stat.size,
  };
}

function listModBackups(req, res) {
  try {
    if (!fs.existsSync(MOD_BACKUPS_DIR)) {
      return res.json({ backups: [] });
    }

    const backups = fs.readdirSync(MOD_BACKUPS_DIR)
      .filter(file => file.endsWith('.tar.gz'))
      .map(file => readModBackupMetadata(file))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ backups });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'MOD_BACKUP_LIST_FAILED',
      message: 'Failed to list mod backups',
      cause: 'The panel could not read the mod backup directory.',
      details: error.message,
      action: 'Check web-panel data permissions and refresh the Mods page.',
    });
  }
}

function downloadModBackup(req, res) {
  let filename;
  try {
    filename = assertSafeArchiveFilename(req.params.filename);
  } catch (error) {
    return sendError(res, req, error);
  }

  const backupPath = path.join(MOD_BACKUPS_DIR, filename);
  if (!fs.existsSync(backupPath)) {
    return sendError(res, req, new AppError('Mod backup not found', {
      status: 404,
      code: 'MOD_BACKUP_NOT_FOUND',
      cause: 'The requested mod backup archive no longer exists.',
      action: 'Refresh the Mods page and choose another backup.',
    }));
  }

  res.download(backupPath, filename);
}

function rollbackModBackup(req, res) {
  let filename;
  try {
    filename = assertSafeArchiveFilename(req.params.filename);
  } catch (error) {
    return sendError(res, req, error);
  }

  const backupPath = path.join(MOD_BACKUPS_DIR, filename);
  if (!fs.existsSync(backupPath)) {
    return sendError(res, req, new AppError('Mod backup not found', {
      status: 404,
      code: 'MOD_BACKUP_NOT_FOUND',
      cause: 'The requested mod backup archive no longer exists.',
      action: 'Refresh the Mods page and choose another backup.',
    }));
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-mod-rollback-'));
  try {
    const safetyBackup = createModBackup('pre-rollback');
    runCommand('tar', ['-xzf', backupPath, '-C', tempRoot], {
      timeout: 180000,
    });

    const restoredCustomMods = path.join(tempRoot, 'custom-mods');
    const restoredGameMods = path.join(tempRoot, 'Mods');

    fs.rmSync(CUSTOM_MODS_DIR, { recursive: true, force: true });
    fs.rmSync(GAME_MODS_DIR, { recursive: true, force: true });
    ensureDir(path.dirname(CUSTOM_MODS_DIR));
    ensureDir(path.dirname(GAME_MODS_DIR));

    if (fs.existsSync(restoredCustomMods)) {
      fs.cpSync(restoredCustomMods, CUSTOM_MODS_DIR, { recursive: true });
    } else {
      ensureDir(CUSTOM_MODS_DIR);
    }

    if (fs.existsSync(restoredGameMods)) {
      fs.cpSync(restoredGameMods, GAME_MODS_DIR, { recursive: true });
    } else {
      ensureDir(GAME_MODS_DIR);
    }

    const clientPack = safeRebuildClientPack('rollback');
    invalidatePublicModManifestCache();
    res.json({
      success: true,
      message: 'Mod backup restored',
      restored: filename,
      safetyBackup,
      clientPack,
      needsRestart: true,
    });
  } catch (error) {
    return sendError(res, req, error, {
      status: 500,
      code: 'MOD_ROLLBACK_FAILED',
      message: 'Failed to rollback mod backup',
      cause: error.cause || 'The panel could not restore the selected mod backup.',
      details: error.details || error.message,
      action: error.action || 'Use the backup archive manually or choose the pre-rollback safety backup.',
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/**
 * POST /api/mods/upload
 * Upload a mod zip file to custom-mods directory
 * Expects multipart/form-data with a 'modfile' field
 */
function uploadMod(req, res) {
  try {
    var body = req.body || {};
    var filename = body.filename;
    var data = body.data;
    var overwrite = body.overwrite === true || body.overwrite === 'true' || body.overwrite === 1 || body.overwrite === '1';

    if (!filename || !data) {
      return sendError(res, req, new AppError('Missing filename or data', {
        status: 400,
        code: 'MOD_UPLOAD_MISSING_DATA',
        cause: 'The upload request did not include both filename and archive data.',
        action: 'Select a mod zip file and upload it again.',
      }));
    }

    // Sanitize filename
    filename = path.basename(filename);
    if (!/\.zip$/i.test(filename) || filename.replace(/\.zip$/i, '').trim() === '') {
      return sendError(res, req, new AppError('Only .zip files are supported', {
        status: 400,
        code: 'MOD_UPLOAD_UNSUPPORTED_TYPE',
        cause: 'The selected file is not a zip archive.',
        action: 'Upload a SMAPI mod packaged as a .zip file.',
      }));
    }

    try {
      ensureDir(CUSTOM_MODS_DIR);
      ensureDir(GAME_MODS_DIR);
    } catch (e) {
      return sendError(res, req, e, {
        status: 500,
        code: 'MOD_DIRECTORY_CREATE_FAILED',
        message: 'Cannot create mods directory',
        cause: 'The custom mods or game Mods directory is not writable.',
        details: e.message,
        action: 'Check the custom mods bind mount and container file permissions.',
      });
    }

    // Write file from base64
    var buffer = Buffer.from(data, 'base64');

    // Size limit: keep base64 uploads safe for 2C/2G servers.
    if (buffer.length > MOD_UPLOAD_MAX_BYTES) {
      return sendError(res, req, new AppError(`File too large (max ${MOD_UPLOAD_MAX_MB}MB)`, {
        status: 413,
        code: 'MOD_UPLOAD_TOO_LARGE',
        cause: 'The mod archive exceeds the panel upload limit.',
        action: 'Remove extra files from the mod archive or copy it directly into data/custom-mods.',
      }));
    }

    var archiveBaseName = getArchiveBaseName(filename);
    var destPath = path.join(CUSTOM_MODS_DIR, filename);
    var metadataPath = getMetadataPath(archiveBaseName);
    var tempUploadPath = path.join(os.tmpdir(), `puppy-mod-upload-${process.pid}-${Date.now()}-${filename}`);
    fs.writeFileSync(tempUploadPath, buffer);

    try {
      return withExtractedModArchive(tempUploadPath, archiveBaseName, (extracted) => {
        const protectedConflicts = getProtectedModFolderConflicts(extracted.installedFolders);
        if (protectedConflicts.length > 0) {
          throw new AppError('Uploaded archive would overwrite built-in server mods', {
            status: 403,
            code: 'BUILT_IN_MOD_PROTECTED',
            cause: `The archive contains folder(s) reserved for built-in server mods: ${protectedConflicts.join(', ')}.`,
            action: 'Rename or remove those folders from the zip. Built-in server mods must be updated through the panel release, not by upload.',
            metadata: {
              protectedFolders: protectedConflicts,
              installedFolders: extracted.installedFolders,
            },
          });
        }

        const conflicts = getModImportConflicts(filename, extracted.installedFolders);
        if (conflicts.hasConflict && !overwrite) {
          throw new AppError('One or more uploaded mods already exist', {
            status: 409,
            code: 'MOD_ALREADY_EXISTS',
            cause: conflicts.folderConflicts.length > 0
              ? `The archive would overwrite installed mod folder(s): ${conflicts.folderConflicts.join(', ')}.`
              : 'The uploaded filename, metadata file, or previously installed folders already exist.',
            action: 'Choose overwrite in the panel to create a backup and replace the existing uploaded mod(s), or rename/remove the conflicting mods first.',
            metadata: {
              canOverwrite: true,
              filename,
              existingFilename: conflicts.existingUpload,
              conflicts: conflicts.folderConflicts,
              installedFolders: extracted.installedFolders,
              installedCount: extracted.installedFolders.length,
              bundle: extracted.bundle,
            },
          });
        }

        const preChangeBackup = conflicts.hasConflict
          ? createModBackup('pre-overwrite')
          : null;
        if (conflicts.hasConflict || overwrite) {
          removeModImportConflicts(filename, conflicts.folderConflicts);
        }

        fs.copyFileSync(tempUploadPath, destPath);

        try {
          const installResult = installArchiveEntriesToGameMods(extracted.entries);

          if (installResult.installedFolders.length > 0) {
            fs.writeFileSync(metadataPath, JSON.stringify({
              filename: filename,
              installedFolders: installResult.installedFolders,
              uploadedAt: new Date().toISOString(),
              overwritten: conflicts.hasConflict,
              bundle: installResult.bundle,
              importedModCount: installResult.installedFolders.length,
              size: buffer.length,
            }, null, 2));
          }

          const clientPack = safeRebuildClientPack('upload');
          invalidatePublicModManifestCache();
          return res.json({
            success: true,
            message: installResult.hasManifest
              ? 'Mod archive uploaded and installed. Restart the server to load it.'
              : 'Mod archive uploaded, but no manifest.json was found. Check the archive structure.',
            filename: filename,
            extracted: installResult.hasManifest,
            hasManifest: installResult.hasManifest,
            noManifest: !installResult.hasManifest,
            autoInstallFailed: false,
            needsRestart: true,
            installedFolders: installResult.installedFolders,
            installedCount: installResult.installedFolders.length,
            bundle: installResult.bundle,
            overwritten: conflicts.hasConflict,
            conflicts: conflicts.folderConflicts,
            backup: preChangeBackup,
            clientPack,
          });
        } catch (e) {
          fs.rmSync(metadataPath, { force: true });
          const clientPack = safeRebuildClientPack('upload-install-failed');
          invalidatePublicModManifestCache();
          return res.json({
            success: true,
            message: 'Mod archive uploaded, but automatic installation failed. Restart may still install it from the archive.',
            filename: filename,
            extracted: false,
            hasManifest: false,
            noManifest: false,
            autoInstallFailed: true,
            installError: e.cause || e.message,
            installDetails: e.details || '',
            needsRestart: true,
            installedFolders: extracted.installedFolders,
            installedCount: extracted.installedFolders.length,
            bundle: extracted.bundle,
            overwritten: conflicts.hasConflict,
            conflicts: conflicts.folderConflicts,
            backup: preChangeBackup,
            clientPack,
          });
        }
      });
    } finally {
      fs.rmSync(tempUploadPath, { force: true });
    }
  } catch (e) {
    return sendError(res, req, e, {
      status: e.status || 500,
      code: e.code || 'MOD_UPLOAD_FAILED',
      message: 'Upload failed',
      cause: e.cause || 'The panel could not store or inspect the uploaded mod archive.',
      details: e.details || e.message,
      action: e.action || 'Check that the upload is a valid .zip mod archive and that custom mod directories are writable.',
    });
  }
}

/**
 * DELETE /api/mods/:folder
 * Delete a custom mod (only custom mods can be deleted)
 */
function deleteMod(req, res) {
  var folder = req.params.folder;
  if (!folder) {
    return sendError(res, req, new AppError('Mod folder name is required', {
      status: 400,
      code: 'MOD_FOLDER_REQUIRED',
      cause: 'The delete request did not include a mod folder.',
      action: 'Delete a mod from the Installed Mods list.',
    }));
  }

  folder = path.basename(folder);
  const preinstalledFolders = getPreinstalledModFolders();
  if (preinstalledFolders.has(folder)) {
    return sendError(res, req, new AppError('Built-in mods cannot be deleted from the web panel', {
      status: 403,
      code: 'BUILT_IN_MOD_PROTECTED',
      cause: 'The selected mod is part of the preinstalled server mod stack.',
      action: 'Only uploaded custom mods can be removed from the web panel.',
    }));
  }

  const matchingMetadata = getMatchingMetadata(folder);

  const sourcePaths = new Set([
    path.join(CUSTOM_MODS_DIR, folder),
    path.join(CUSTOM_MODS_DIR, `${folder}.zip`),
  ]);
  const gamePaths = new Set([
    path.join(GAME_MODS_DIR, folder),
  ]);

  for (const metadata of matchingMetadata) {
    sourcePaths.add(path.join(CUSTOM_MODS_DIR, metadata.filename));
    sourcePaths.add(metadata._path);

    if (Array.isArray(metadata.installedFolders)) {
      for (const installedFolder of metadata.installedFolders) {
        gamePaths.add(path.join(GAME_MODS_DIR, installedFolder));
      }
    }
  }

  const hasExistingTarget = [...sourcePaths, ...gamePaths].some(target => fs.existsSync(target));
  if (!hasExistingTarget) {
    return sendError(res, req, new AppError('Custom mod not found', {
      status: 404,
      code: 'CUSTOM_MOD_NOT_FOUND',
      cause: 'The mod folder or uploaded archive no longer exists.',
      action: 'Refresh the Mods page and try again.',
    }));
  }

  try {
    const preChangeBackup = createModBackup('pre-delete');
    for (const target of [...sourcePaths, ...gamePaths]) {
      fs.rmSync(target, { recursive: true, force: true });
    }

    const clientPack = safeRebuildClientPack('delete');
    invalidatePublicModManifestCache();
    res.json({ success: true, message: 'Mod deleted successfully', needsRestart: true, backup: preChangeBackup, clientPack });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'MOD_DELETE_FAILED',
      message: 'Failed to delete mod',
      cause: 'The panel could not remove one or more mod files.',
      details: e.message,
      action: 'Check custom mod and game Mods directory permissions, then retry.',
    });
  }
}

/**
 * DELETE /api/mods/custom
 * Remove every uploaded/custom mod while preserving bundled server mods.
 */
function clearCustomMods(req, res) {
  try {
    ensureDir(CUSTOM_MODS_DIR);
    ensureDir(GAME_MODS_DIR);

    const targets = getClearCustomModTargets();
    const allTargets = [...targets.sourcePaths, ...targets.gamePaths];
    const existingTargets = allTargets.filter(target => fs.existsSync(target));

    if (existingTargets.length === 0) {
      const clientPack = safeRebuildClientPack('clear-custom-empty');
      invalidatePublicModManifestCache();
      return res.json({
        success: true,
        message: 'No uploaded custom mods were found.',
        needsRestart: false,
        removed: {
          sourceEntries: 0,
          installedFolders: 0,
          names: [],
        },
        backup: null,
        clientPack,
      });
    }

    const preChangeBackup = createModBackup('pre-clear-custom');
    for (const target of existingTargets) {
      fs.rmSync(target, { recursive: true, force: true });
    }

    const clientPack = safeRebuildClientPack('clear-custom');
    invalidatePublicModManifestCache();
    res.json({
      success: true,
      message: 'All uploaded custom mods were removed.',
      needsRestart: true,
      removed: {
        sourceEntries: targets.sourceEntries.length,
        installedFolders: targets.installedFolders.length,
        names: [...new Set([...targets.sourceEntries, ...targets.installedFolders])],
      },
      backup: preChangeBackup,
      clientPack,
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: e.status || 500,
      code: e.code || 'MOD_CLEAR_CUSTOM_FAILED',
      message: 'Failed to clear uploaded mods',
      cause: e.cause || 'The panel could not remove all uploaded custom mod files.',
      details: e.details || e.message,
      action: e.action || 'Check custom mod and game Mods directory permissions, then retry.',
    });
  }
}

module.exports = {
  getMods,
  getPublicModManifest,
  getPublicMods,
  safeRebuildClientPack,
  uploadMod,
  deleteMod,
  clearCustomMods,
  downloadClientPack,
  downloadMod,
  downloadPublicMod,
  listModBackups,
  downloadModBackup,
  rollbackModBackup,
};
