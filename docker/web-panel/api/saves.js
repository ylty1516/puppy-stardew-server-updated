/**
 * Saves API - Save file and backup management
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('../server');
const { AppError, commandError, inferCause, sendError } = require('../errors');

const BACKUP_STATUS_FILE = path.join(config.DATA_DIR, 'backup-status.json');
let activeBackup = null;

function readFreshGameState(maxAgeSeconds = 15) {
  if (!config.GAME_STATE_FILE || !fs.existsSync(config.GAME_STATE_FILE)) {
    return null;
  }

  const data = JSON.parse(fs.readFileSync(config.GAME_STATE_FILE, 'utf-8'));
  const updatedAtMs = Date.parse(data.updatedAt || '');
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
  if (ageSeconds > maxAgeSeconds) {
    return null;
  }

  return { ...data, ageSeconds };
}

function assertBackupSafeToStart() {
  let gameState = null;
  try {
    gameState = readFreshGameState();
  } catch (error) {
    throw new AppError('Failed to read game state before backup', {
      status: 503,
      code: 'GAME_STATE_READ_FAILED',
      cause: 'The panel could not read the SMAPI game-state bridge before starting a backup.',
      details: error.message,
      action: 'Check AutoHideHost and web-panel/data permissions, then retry the backup.',
    });
  }

  if (gameState && gameState.saving === true) {
    throw new AppError('Game is saving', {
      status: 409,
      code: 'GAME_SAVE_IN_PROGRESS',
      cause: 'Stardew Valley is currently writing save data, so a backup could capture a partial save.',
      action: 'Wait until saving finishes, then start the backup again.',
    });
  }
}

function isSuccessful(result) {
  return result && result.status === 0;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
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

function removePath(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  runCommand('rm', ['-rf', targetPath]);
}

function getBackupCompressionLevel() {
  const raw = parseInt(process.env.BACKUP_COMPRESSION_LEVEL || '1', 10);
  if (Number.isNaN(raw)) {
    return 1;
  }

  return Math.min(9, Math.max(1, raw));
}

function getTarGzipArgs(outputPath, sourceBaseDir, sourceNames, verbose) {
  const level = getBackupCompressionLevel();
  const args = ['-I', `gzip -${level}`];

  if (verbose) {
    args.push('-cvf');
  } else {
    args.push('-cf');
  }

  args.push(outputPath, '-C', sourceBaseDir);
  return args.concat(sourceNames);
}

function parseEnvFile() {
  const envPath = findEnvFile();
  if (!envPath || !fs.existsSync(envPath)) return {};

  const content = fs.readFileSync(envPath, 'utf-8');
  const env = {};

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const value = parseEnvValue(trimmed.slice(eqIndex + 1));
    env[key] = value;
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

function formatEnvValue(value) {
  const text = String(value ?? '');
  return `'${text.replace(/'/g, "\\'")}'`;
}

function findEnvFile() {
  const candidates = [
    config.ENV_FILE,
    '/home/steam/.env',
    path.join(process.cwd(), '.env'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return config.ENV_FILE || '/home/steam/.env';
}

function writeEnvFile(envData) {
  const envPath = findEnvFile();
  const envDir = path.dirname(envPath);

  ensureDir(envDir);

  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, '# Managed by Puppy Stardew Server web panel\n', 'utf-8');
  }

  const original = fs.readFileSync(envPath, 'utf-8');
  const lines = original.split('\n');
  const updatedKeys = new Set();

  const newLines = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return line;

    const key = trimmed.slice(0, eqIndex).trim();
    if (Object.prototype.hasOwnProperty.call(envData, key)) {
      updatedKeys.add(key);
      return `${key}=${formatEnvValue(envData[key])}`;
    }

    return line;
  });

  Object.keys(envData).forEach(key => {
    if (!updatedKeys.has(key)) {
      newLines.push(`${key}=${formatEnvValue(envData[key])}`);
    }
  });

  fs.writeFileSync(envPath, newLines.join('\n'), 'utf-8');
}

function getSelectedSaveName() {
  try {
    const markerPath = path.join(config.SAVES_DIR, '.selected_save');
    if (fs.existsSync(markerPath)) {
      const selected = fs.readFileSync(markerPath, 'utf-8').trim();
      if (selected) {
        return selected;
      }
    }
  } catch (error) {}

  try {
    const env = parseEnvFile();
    if (env.SAVE_NAME) {
      return env.SAVE_NAME;
    }
  } catch (error) {}

  return '';
}

function setSelectedSaveName(saveName) {
  if (!saveName) {
    throw new AppError('Save name is required', {
      status: 400,
      code: 'SAVE_NAME_REQUIRED',
      cause: 'The request did not include a save name.',
      action: 'Choose a save from the Saves page before setting the default.',
    });
  }

  ensureDir(config.SAVES_DIR);

  const saveDir = path.join(config.SAVES_DIR, saveName);
  if (!fs.existsSync(saveDir)) {
    throw new AppError('Selected save does not exist', {
      status: 404,
      code: 'SAVE_NOT_FOUND',
      cause: 'The selected save folder is not present in the Stardew Valley Saves directory.',
      action: 'Upload the save again or clear SAVE_NAME to use auto-detection.',
    });
  }

  writeEnvFile({ SAVE_NAME: saveName });
  fs.writeFileSync(path.join(config.SAVES_DIR, '.selected_save'), `${saveName}\n`, 'utf-8');
}

function isValidSaveDirectory(saveDir) {
  if (!fs.existsSync(saveDir)) {
    return false;
  }

  const folderName = path.basename(saveDir);
  return fs.existsSync(path.join(saveDir, 'SaveGameInfo')) &&
    fs.existsSync(path.join(saveDir, folderName));
}

function findSaveDirectories(rootDir, maxDepth = 4, depth = 0) {
  if (depth > maxDepth || !fs.existsSync(rootDir)) {
    return [];
  }

  if (isValidSaveDirectory(rootDir)) {
    return [rootDir];
  }

  const found = [];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      continue;
    }

    found.push(...findSaveDirectories(path.join(rootDir, entry.name), maxDepth, depth + 1));
  }

  return found;
}

function createOverwriteBackup(saveNames) {
  if (!saveNames || saveNames.length === 0) {
    return '';
  }

  ensureDir(config.BACKUPS_DIR);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `pre-upload-overwrite-${timestamp}.tar.gz`;
  const backupPath = path.join(config.BACKUPS_DIR, backupName);
  const existingNames = saveNames.filter(name => fs.existsSync(path.join(config.SAVES_DIR, name)));

  if (existingNames.length === 0) {
    return '';
  }

  runCommand('tar', getTarGzipArgs(backupPath, config.SAVES_DIR, existingNames, false), {
    timeout: 30000,
  });

  return backupName;
}

function installSaveArchive(zipPath, setAsDefault) {
  ensureDir(config.SAVES_DIR);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'puppy-save-'));
  try {
    runCommand('unzip', ['-q', '-o', zipPath, '-d', tempRoot], { timeout: 30000 });

    const saveDirs = findSaveDirectories(tempRoot);
    if (saveDirs.length === 0) {
      throw new AppError('No valid Stardew Valley save folders were found in the archive', {
        status: 400,
        code: 'SAVE_ARCHIVE_INVALID',
        cause: 'The zip did not contain folders with both SaveGameInfo and the matching save file.',
        action: 'Zip the farm save folder itself, then upload that zip again.',
      });
    }

    const importedSaves = [];
    const overwrittenSaves = [];
    const collidingNames = [];

    saveDirs.forEach(saveDir => {
      const saveName = path.basename(saveDir);
      if (fs.existsSync(path.join(config.SAVES_DIR, saveName))) {
        collidingNames.push(saveName);
      }
    });

    const overwriteBackup = createOverwriteBackup(collidingNames);

    saveDirs.forEach(saveDir => {
      const saveName = path.basename(saveDir);
      const destDir = path.join(config.SAVES_DIR, saveName);

      if (fs.existsSync(destDir)) {
        overwrittenSaves.push(saveName);
        removePath(destDir);
      }

      runCommand('cp', ['-a', saveDir, destDir], { timeout: 30000 });
      importedSaves.push(saveName);
    });

    let defaultSaveName = '';
    let defaultApplied = false;
    let defaultSkipped = false;

    if (setAsDefault && importedSaves.length === 1) {
      defaultSaveName = importedSaves[0];
      setSelectedSaveName(defaultSaveName);
      defaultApplied = true;
    } else if (setAsDefault) {
      defaultSkipped = true;
    }

    return {
      importedSaves,
      overwrittenSaves,
      overwriteBackup,
      defaultSaveName,
      defaultApplied,
      defaultSkipped,
    };
  } finally {
    removePath(tempRoot);
  }
}

function createEmptyStatus() {
  return {
    id: null,
    state: 'idle',
    progress: 0,
    processedEntries: 0,
    totalEntries: 0,
    backupName: '',
    backupPath: '',
    startedAt: null,
    completedAt: null,
    message: '',
    error: '',
    cause: '',
    action: '',
    pid: null,
    size: 0,
  };
}

function readBackupStatus() {
  try {
    if (!fs.existsSync(BACKUP_STATUS_FILE)) {
      return createEmptyStatus();
    }

    const data = JSON.parse(fs.readFileSync(BACKUP_STATUS_FILE, 'utf-8'));
    return { ...createEmptyStatus(), ...data };
  } catch (error) {
    return createEmptyStatus();
  }
}

function writeBackupStatus(status) {
  ensureDir(config.DATA_DIR);
  fs.writeFileSync(BACKUP_STATUS_FILE, JSON.stringify({
    ...createEmptyStatus(),
    ...status,
  }, null, 2));
}

function isProcessRunning(pid) {
  if (!pid || Number.isNaN(Number(pid))) {
    return false;
  }

  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return false;
  }
}

function countEntries(rootDir) {
  let total = 0;

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      total += 1;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      }
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return total;
}

function cleanupOldBackups() {
  const maxBackups = parseInt(process.env.MAX_BACKUPS || '7', 10);
  if (!maxBackups || maxBackups < 1 || !fs.existsSync(config.BACKUPS_DIR)) {
    return;
  }

  const backupFiles = fs.readdirSync(config.BACKUPS_DIR)
    .filter(file => file.endsWith('.tar.gz') || file.endsWith('.zip'))
    .map(file => {
      const fullPath = path.join(config.BACKUPS_DIR, file);
      return {
        file,
        fullPath,
        mtimeMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  backupFiles.slice(maxBackups).forEach(item => {
    try {
      fs.unlinkSync(item.fullPath);
    } catch (error) {}
  });
}

function getBackupStatusSnapshot() {
  const status = readBackupStatus();

  if (status.state === 'running' && status.pid && !isProcessRunning(status.pid)) {
    if (status.backupPath && fs.existsSync(status.backupPath)) {
      const stat = fs.statSync(status.backupPath);
      const completedStatus = {
        ...status,
        state: 'completed',
        progress: 100,
        completedAt: status.completedAt || new Date().toISOString(),
        message: status.message || 'Backup completed',
        size: stat.size,
        pid: null,
        error: '',
      };
      writeBackupStatus(completedStatus);
      return completedStatus;
    }

    const failedStatus = {
      ...status,
      state: 'failed',
      progress: status.progress || 0,
      completedAt: new Date().toISOString(),
      message: 'Backup process stopped unexpectedly',
      error: status.error || 'Backup process stopped unexpectedly',
      cause: status.cause || 'The backup worker process is no longer running and no archive was produced.',
      action: status.action || 'Check disk space and permissions, then start a new backup.',
      pid: null,
    };
    writeBackupStatus(failedStatus);
    return failedStatus;
  }

  return status;
}

function startBackupJob() {
  assertBackupSafeToStart();

  if (!fs.existsSync(config.SAVES_DIR)) {
    throw new AppError('Save directory not found', {
      status: 404,
      code: 'SAVE_DIRECTORY_MISSING',
      cause: 'The Stardew Valley save directory has not been created yet or is not mounted.',
      action: 'Start the game once, check the data/saves bind mount, then retry the backup.',
    });
  }

  ensureDir(config.BACKUPS_DIR);
  ensureDir(config.DATA_DIR);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `manual-backup-${timestamp}.tar.gz`;
  const backupPath = path.join(config.BACKUPS_DIR, backupName);
  const totalEntries = Math.max(1, countEntries(config.SAVES_DIR) + 1);
  const taskId = `backup-${Date.now()}`;

  const initialStatus = {
    id: taskId,
    state: 'running',
    progress: 1,
    processedEntries: 0,
    totalEntries,
    backupName,
    backupPath,
    startedAt: new Date().toISOString(),
    completedAt: null,
    message: 'Preparing backup',
    error: '',
    pid: null,
    size: 0,
  };
  writeBackupStatus(initialStatus);

  const tarProc = spawn('tar', getTarGzipArgs(
    backupPath,
    path.dirname(config.SAVES_DIR),
    [path.basename(config.SAVES_DIR)],
    true
  ), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeBackup = { id: taskId, pid: tarProc.pid, backupPath };
  writeBackupStatus({
    ...initialStatus,
    pid: tarProc.pid,
    message: 'Archiving save files',
  });

  let processedEntries = 0;
  let stdoutBuffer = '';
  let stderrOutput = '';
  let lastPersistAt = 0;

  function persistRunningStatus(force) {
    const now = Date.now();
    if (!force && now - lastPersistAt < 250) {
      return;
    }
    lastPersistAt = now;

    writeBackupStatus({
      ...initialStatus,
      pid: tarProc.pid,
      state: 'running',
      processedEntries,
      totalEntries,
      progress: Math.min(99, Math.max(1, Math.round((processedEntries / totalEntries) * 100))),
      message: 'Archiving save files',
    });
  }

  function processStdoutChunk(chunk) {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) {
        processedEntries += 1;
      }
    }

    persistRunningStatus(false);
  }

  tarProc.stdout.on('data', processStdoutChunk);
  tarProc.stderr.on('data', chunk => {
    stderrOutput += chunk.toString();
    if (stderrOutput.length > 4000) {
      stderrOutput = stderrOutput.slice(-4000);
    }
  });

  tarProc.on('error', error => {
    activeBackup = null;
    try {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    } catch (unlinkError) {}

    writeBackupStatus({
      ...initialStatus,
      state: 'failed',
      progress: 0,
      completedAt: new Date().toISOString(),
      message: 'Backup failed to start',
      error: error.message,
      cause: inferCause(error) || 'The tar process could not be started.',
      action: 'Check that tar and gzip are installed and the backup directory is writable.',
      pid: null,
    });
  });

  tarProc.on('close', code => {
    if (stdoutBuffer.trim()) {
      processedEntries += 1;
    }

    activeBackup = null;

    if (code === 0 && fs.existsSync(backupPath)) {
      const stat = fs.statSync(backupPath);
      cleanupOldBackups();
      writeBackupStatus({
        ...initialStatus,
        state: 'completed',
        progress: 100,
        processedEntries: totalEntries,
        totalEntries,
        completedAt: new Date().toISOString(),
        message: 'Backup completed',
        pid: null,
        size: stat.size,
        error: '',
      });
      return;
    }

    try {
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
    } catch (unlinkError) {}

    writeBackupStatus({
      ...initialStatus,
      state: 'failed',
      progress: Math.min(99, Math.max(0, Math.round((processedEntries / totalEntries) * 100))),
      processedEntries,
      totalEntries,
      completedAt: new Date().toISOString(),
      message: 'Backup failed',
      error: stderrOutput.trim() || `tar exited with code ${code}`,
      cause: inferCause({ message: stderrOutput }) || 'The tar process exited before producing a valid backup archive.',
      action: 'Check save directory permissions, backup disk space, and whether files changed while archiving.',
      pid: null,
    });
  });

  return getBackupStatusSnapshot();
}

function getSaves(req, res) {
  try {
    if (!fs.existsSync(config.SAVES_DIR)) {
      return res.json({ saves: [], defaultSaveName: '' });
    }

    const entries = fs.readdirSync(config.SAVES_DIR, { withFileTypes: true });
    const saves = [];
    const defaultSaveName = getSelectedSaveName();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const saveDir = path.join(config.SAVES_DIR, entry.name);
      const saveFile = path.join(saveDir, entry.name);

      const info = {
        name: entry.name,
        farm: entry.name.split('_')[0] || entry.name,
        size: 0,
        lastModified: null,
        files: 0,
        isDefault: entry.name === defaultSaveName,
      };

      try {
        if (fs.existsSync(saveFile)) {
          const stat = fs.statSync(saveFile);
          info.size = stat.size;
          info.lastModified = stat.mtime.toISOString();
        }
        info.files = fs.readdirSync(saveDir).length;
      } catch (e) {}

      saves.push(info);
    }

    // Sort by last modified
    saves.sort((a, b) => {
      if (!a.lastModified) return 1;
      if (!b.lastModified) return -1;
      return new Date(b.lastModified) - new Date(a.lastModified);
    });

    res.json({ saves, defaultSaveName });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'LIST_SAVES_FAILED',
      message: 'Failed to list saves',
      cause: 'The panel could not read the Stardew Valley save directory.',
      details: e.message,
      action: 'Check the data/saves mount and file permissions.',
    });
  }
}

function getBackups(req, res) {
  try {
    if (!fs.existsSync(config.BACKUPS_DIR)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(config.BACKUPS_DIR);
    const backups = files
      .filter(f => f.endsWith('.tar.gz') || f.endsWith('.zip'))
      .map(f => {
        const stat = fs.statSync(path.join(config.BACKUPS_DIR, f));
        return {
          filename: f,
          size: stat.size,
          date: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ backups });
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'LIST_BACKUPS_FAILED',
      message: 'Failed to list backups',
      cause: 'The panel could not read the backups directory.',
      details: e.message,
      action: 'Check the data/backups mount and file permissions.',
    });
  }
}

function getBackupStatus(req, res) {
  try {
    res.json(getBackupStatusSnapshot());
  } catch (e) {
    return sendError(res, req, e, {
      status: 500,
      code: 'BACKUP_STATUS_READ_FAILED',
      message: 'Failed to read backup status',
      cause: 'The panel could not parse or read the backup status file.',
      details: e.message,
      action: 'Check web-panel/data permissions or remove a corrupt backup-status.json file.',
    });
  }
}

function createBackup(req, res) {
  try {
    const currentStatus = getBackupStatusSnapshot();
    if (currentStatus.state === 'running') {
      return res.status(202).json({
        success: true,
        alreadyRunning: true,
        message: 'Backup already in progress',
        status: currentStatus,
      });
    }

    const status = startBackupJob();
    res.status(202).json({
      success: true,
      accepted: true,
      message: 'Backup started',
      status,
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: e.status || 500,
      code: e.code || 'CREATE_BACKUP_FAILED',
      message: 'Failed to create backup',
      cause: e.cause || 'The backup job could not start.',
      details: e.details || e.message,
      action: e.action || 'Check save directory permissions and available disk space, then retry.',
    });
  }
}

function uploadSave(req, res) {
  try {
    const body = req.body || {};
    let filename = body.filename;
    const data = body.data;
    const setAsDefault = body.setAsDefault === true || body.setAsDefault === 'true';

    if (!filename || !data) {
      return sendError(res, req, new AppError('Missing filename or data', {
        status: 400,
        code: 'SAVE_UPLOAD_MISSING_DATA',
        cause: 'The upload request did not include both filename and archive data.',
        action: 'Select a save zip file and upload it again.',
      }));
    }

    filename = path.basename(filename);
    if (!/\.zip$/i.test(filename)) {
      return sendError(res, req, new AppError('Only .zip save archives are supported', {
        status: 400,
        code: 'SAVE_UPLOAD_UNSUPPORTED_TYPE',
        cause: 'The selected file is not a zip archive.',
        action: 'Compress the Stardew Valley save folder as a .zip file.',
      }));
    }

    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) {
      return sendError(res, req, new AppError('Invalid archive data', {
        status: 400,
        code: 'SAVE_UPLOAD_INVALID_DATA',
        cause: 'The uploaded archive payload was empty or not valid base64.',
        action: 'Select the zip file again and retry the upload.',
      }));
    }
    if (buffer.length > 40 * 1024 * 1024) {
      return sendError(res, req, new AppError('File too large (max 40MB)', {
        status: 413,
        code: 'SAVE_UPLOAD_TOO_LARGE',
        cause: 'The save archive exceeds the web panel upload limit.',
        action: 'Remove unnecessary files from the archive or upload the save directly to the data volume.',
      }));
    }

    const tempZip = path.join(os.tmpdir(), `puppy-save-upload-${Date.now()}.zip`);
    fs.writeFileSync(tempZip, buffer);

    try {
      const result = installSaveArchive(tempZip, setAsDefault);
      const messageParts = [
        result.importedSaves.length === 1
          ? `Imported save ${result.importedSaves[0]}`
          : `Imported ${result.importedSaves.length} save folders`,
      ];

      if (result.overwrittenSaves.length > 0) {
        messageParts.push(`overwrote ${result.overwrittenSaves.length} existing save(s)`);
      }
      if (result.overwriteBackup) {
        messageParts.push(`backup created: ${result.overwriteBackup}`);
      }
      if (result.defaultApplied) {
        messageParts.push(`default save set to ${result.defaultSaveName}`);
      } else if (result.defaultSkipped) {
        messageParts.push('default save was not changed because the archive contained multiple saves');
      }

      res.json({
        success: true,
        message: messageParts.join(', '),
        importedSaves: result.importedSaves,
        overwrittenSaves: result.overwrittenSaves,
        overwriteBackup: result.overwriteBackup,
        defaultSaveName: result.defaultSaveName,
        defaultApplied: result.defaultApplied,
        defaultSkipped: result.defaultSkipped,
        needsRestart: true,
      });
    } finally {
      removePath(tempZip);
    }
  } catch (e) {
    return sendError(res, req, e, {
      status: e.status || 500,
      code: e.code || 'SAVE_UPLOAD_FAILED',
      message: 'Failed to upload save',
      cause: e.cause || 'The panel could not import the save archive.',
      details: e.details || e.message,
      action: e.action || 'Check that the zip contains a valid Stardew Valley save folder and retry.',
    });
  }
}

function setDefaultSave(req, res) {
  try {
    const saveName = req.body && typeof req.body.saveName === 'string'
      ? req.body.saveName.trim()
      : '';

    if (!saveName) {
      return sendError(res, req, new AppError('Missing saveName', {
        status: 400,
        code: 'SAVE_NAME_REQUIRED',
        cause: 'No save name was sent in the request.',
        action: 'Choose a save from the Saves page.',
      }));
    }

    if (saveName.includes('..') || saveName.includes('/')) {
      return sendError(res, req, new AppError('Invalid save name', {
        status: 400,
        code: 'INVALID_SAVE_NAME',
        cause: 'Save names cannot contain path traversal characters.',
        action: 'Choose an existing save folder from the Saves page.',
      }));
    }

    setSelectedSaveName(saveName);
    res.json({
      success: true,
      message: `Default save set to ${saveName}`,
      saveName,
      needsRestart: true,
    });
  } catch (e) {
    return sendError(res, req, e, {
      status: e.status || 500,
      code: e.code || 'SET_DEFAULT_SAVE_FAILED',
      message: 'Failed to set default save',
      cause: e.cause || 'The panel could not write SAVE_NAME or the selected save marker.',
      details: e.details || e.message,
      action: e.action || 'Check the save folder exists and web-panel/data is writable.',
    });
  }
}

function downloadBackup(req, res) {
  const filename = req.params.filename;

  // Security: prevent path traversal
  if (filename.includes('..') || filename.includes('/')) {
    return sendError(res, req, new AppError('Invalid filename', {
      status: 400,
      code: 'INVALID_BACKUP_FILENAME',
      cause: 'Backup download filenames cannot contain path separators.',
      action: 'Download a backup from the Backups list.',
    }));
  }

  const filePath = path.join(config.BACKUPS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return sendError(res, req, new AppError('Backup not found', {
      status: 404,
      code: 'BACKUP_NOT_FOUND',
      cause: 'The requested backup file no longer exists.',
      action: 'Refresh the Backups list and try again.',
    }));
  }

  res.download(filePath, filename);
}

module.exports = {
  getSaves,
  getBackups,
  getBackupStatus,
  createBackup,
  uploadSave,
  setDefaultSave,
  downloadBackup,
};
