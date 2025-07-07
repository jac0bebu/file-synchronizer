const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const colors = require('colors');
const readline = require('readline');

class SyncManager {
    constructor(apiClient, syncFolder, options = {}) {
        this.api = apiClient;
        this.syncFolder = path.resolve(syncFolder);
        this.clientId = options.clientId || `client-${crypto.randomBytes(4).toString('hex')}`;
        this.pollInterval = options.pollInterval || 2000;
        this.syncIntervalId = null;
        this.pendingUploads = new Map();
        this.pendingDownloads = new Map();
        this.fileSyncStatus = new Map();
        this.recentlyDeleted = new Set();
        this.pendingDeletions = new Set();
        this.recentlyUploaded = new Map(); // Track recently uploaded files

        this.pendingConflicts = new Map(); // Track unresolved conflicts
        this.conflictHistory = new Map(); // Track resolved conflicts

        this.serverOnline = true; // Track server status
        this.offlineQueue = [];   // Queue for offline changes (add/change/delete/rename)
        this.lastServerStatus = true;

        this.isFirstSync = true; // Flag for first sync after startup

        console.log('Sync Manager initialized'.green);
        console.log(`Client ID: ${this.clientId}`.cyan);
        console.log(`Sync folder: ${this.syncFolder}`.cyan);
    }

    async start() {
        try {
            // Ensure sync folder exists
            await fs.ensureDir(this.syncFolder);

            // Test connection to server
            await this.api.getHealth();

            // Initial sync
            await this.performFullSync();

            // Start periodic sync
            this.startPeriodicSync();

            console.log('Sync manager started successfully'.green.bold);
            return true;

        } catch (error) {
            // Only log errors that are NOT connection errors
            if (
                error.message &&
                (error.message.includes('ECONNREFUSED') ||
                 error.message.includes('ENOTFOUND') ||
                 error.message.includes('Server connection failed') ||
                 error.message.includes('ETIMEDOUT'))
            ) {
                // Silent fail for connection errors, let app.js handle user prompt
                return false;
            } else {
                // Log other errors
                console.error('Failed to start sync manager:'.red, error.message);
                return false;
            }
        }
    }

    async checkServerStatus(isStartup = false) {
        try {
            await this.api.getHealth();
            if (!this.serverOnline) {
                this.serverOnline = true;
                console.log('\n✅ Server is ONLINE'.green.bold);
                if (!isStartup) {
                    await this.processOfflineQueue();
                    await this.performFullSync();
                }
            }
        } catch (error) {
            if (this.serverOnline) {
                this.serverOnline = false;
            }
        }
    }

    // Add method to mark file for deletion on server
    markForDeletion(fileName) {
        this.pendingDeletions.add(fileName);
        console.log(`Marked ${fileName} for server deletion`.gray);
    }

    // Add method to mark file as recently deleted
    markAsDeleted(fileName) {
        this.recentlyDeleted.add(fileName);
        this.pendingDeletions.delete(fileName); // Remove from pending
        // Remove from tracking after 30 seconds
        setTimeout(() => {
            this.recentlyDeleted.delete(fileName);
        }, 30000);
    }

    async handleFileChange(fileEvent) {
        const { type, path: filePath, fileName } = fileEvent;
        if (!fileName) {
            console.warn('File event missing fileName, skipping:', fileEvent);
            return;
        }
        try {
            this.updateSyncStatus(fileName, 'processing');
            if (!this.serverOnline) {
                // Queue the change
                this.offlineQueue.push({ type, filePath, fileName, timestamp: Date.now() });
                this.updateSyncStatus(fileName, 'queued-offline');
                console.log(`Queued ${type} for ${fileName} (offline)`.yellow);
                return;
            }

            if (type === 'delete' || type === 'unlink') {
                // Handle file deletion - mark for server deletion
                console.log(`File deleted locally: ${fileName}`.red);
                this.markForDeletion(fileName);
                this.updateSyncStatus(fileName, 'deleted');
                return;
            }

            if (['add', 'change'].includes(type)) {
                await this.uploadFile(filePath);
            }

        } catch (error) {
            console.error(`Error handling file change for ${fileName}:`.red, error.message);
            this.updateSyncStatus(fileName, 'error', error.message);

            if (error.conflict) {
                await this.handleConflict(fileName, filePath, error.details);
            }
        }
    }

    async uploadFile(filePath) {
        const fileName = path.basename(filePath);
        try {
            if (this.pendingUploads.has(fileName)) {
                console.log(`Upload already in progress for ${fileName}`.yellow);
                return;
            }

            // Check if file was recently uploaded by this client
            const recentUpload = this.recentlyUploaded.get(fileName);
            if (recentUpload) {
                const timeSinceUpload = Date.now() - recentUpload.timestamp;
                if (timeSinceUpload < 30000) { // 30 seconds
                    console.log(`File ${fileName} was recently uploaded, skipping`.gray);
                    return;
                }
            }

            this.pendingUploads.set(fileName, filePath);
            this.updateSyncStatus(fileName, 'uploading');

            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB

            console.log(`Uploading ${fileName} (${fileSize} bytes)`.cyan);

            let result;
            if (fileSize > CHUNK_SIZE) {
                // Alert user in CLI about chunked upload
                console.log(`⚠️  File "${fileName}" is larger than 10MB. Using chunked upload...`.yellow.bold);
                result = await this.api.uploadChunkedFile(filePath, this.clientId);
                
                // Mark as recently uploaded to prevent re-upload
                this.recentlyUploaded.set(fileName, {
                    timestamp: Date.now(),
                    fileId: result.fileId,
                    type: 'chunked'
                });
                
                console.log(`Successfully uploaded all chunks for ${fileName}`.green);
                this.updateSyncStatus(fileName, 'synced', {
                    lastSync: new Date().toISOString(),
                    uploadType: 'chunked'
                });
            } else {
                // Use normal upload for small files
                result = await this.api.uploadFile(filePath, this.clientId);
                
                // Mark as recently uploaded
                this.recentlyUploaded.set(fileName, {
                    timestamp: Date.now(),
                    version: result.version,
                    type: 'normal'
                });
                
                console.log(`Successfully uploaded ${fileName} (version ${result.version})`.green);
                this.updateSyncStatus(fileName, 'synced', {
                    version: result.version,
                    lastSync: new Date().toISOString(),
                    uploadType: 'normal'
                });
            }

            // Clean up old recent uploads
            setTimeout(() => {
                this.recentlyUploaded.delete(fileName);
            }, 60000); // Remove after 60 seconds

        } catch (error) {
            if (error.conflict) {
                // --- FIX: Read and store local content before any overwrite ---
                let localContent = '';
                let localStats = null;
                try {
                    localStats = await fs.stat(filePath);
                    localContent = await fs.readFile(filePath, 'utf-8');
                } catch { }
                this.updateSyncStatus(fileName, 'conflict');
                try {
                    const serverFiles = await this.api.listFiles();
                    const serverFile = serverFiles.find(f => (f.name || f.fileName) === fileName);
                    if (serverFile) {
                        if (this.fileWatcher && typeof this.fileWatcher.ignoreFile === 'function') {
                            this.fileWatcher.ignoreFile(fileName);
                        }
                        console.log(`Conflict detected. Downloading latest server version of ${fileName}...`.yellow);
                        await this.downloadFile(serverFile);
                        await new Promise(res => setTimeout(res, 500));
                        if (this.fileWatcher && typeof this.fileWatcher.unignoreFile === 'function') {
                            this.fileWatcher.unignoreFile(fileName);
                        }
                        console.log(`Local file ${fileName} updated to latest server version after conflict.`.green);
                        this.updateSyncStatus(fileName, 'synced', {
                            version: serverFile.version,
                            lastSync: new Date().toISOString()
                        });
                    }
                } catch (downloadErr) {
                    console.error(`Failed to update local file after conflict:`, downloadErr.message);
                }
                // --- Store the original local content for preview ---
                this.lastConflictLocalInfo = {
                    fileName,
                    size: localStats ? localStats.size : undefined,
                    lastModified: localStats ? localStats.mtime.toISOString() : undefined,
                    content: localContent
                };
                throw error; // Re-throw to be handled by caller
            } else {
                console.error(`Upload failed for ${fileName}:`.red, error.message);
                this.updateSyncStatus(fileName, 'error', error.message);
                throw error;
            }
        } finally {
            this.pendingUploads.delete(fileName);
        }
    }

    // Enhanced handleConflict method
    async handleConflict(fileName, localPath, conflictDetails) {
        // Only print a simple message for conflict
        console.log(`Conflict detected for file "${fileName}".`.yellow);
        this.updateSyncStatus(fileName, 'conflict', {
            detectedAt: new Date().toISOString(),
            details: conflictDetails
        });
        // No preview or content shown
    }

    displayConflictVersions(fileName, localInfo, serverInfo) {
        // Only print a simple message for conflict
        console.log(`Conflict detected for file "${fileName}".`.yellow);
    }

    // Show full content comparison
    showFullComparison(localInfo, serverInfo) {
        console.log('\n' + '='.repeat(80).cyan);
        console.log('FULL CONTENT COMPARISON'.cyan.bold);
        console.log('='.repeat(80).cyan);

        console.log('\n🏠 LOCAL CONTENT:'.green.bold);
        console.log('-'.repeat(40).green);
        console.log(localInfo.content);
        console.log('-'.repeat(40).green);

        console.log('\n🌐 SERVER CONTENT:'.blue.bold);
        console.log('-'.repeat(40).blue);
        console.log(serverInfo.content);
        console.log('-'.repeat(40).blue);

        console.log('\n' + '='.repeat(80).cyan);
    }

    async createMergedVersion(fileName, localInfo, serverInfo) {
        try {
            const mergedPath = path.join(this.syncFolder, `.conflict_merged_${fileName}`);

            // Create a merged file with both versions
            const mergedContent = `
    <<<<<<< LOCAL VERSION (${new Date(localInfo.lastModified).toLocaleString()})
    ${localInfo.content}
    =======
    >>>>>>> SERVER VERSION (${new Date(serverInfo.lastModified).toLocaleString()}) - Version ${serverInfo.version}
    ${serverInfo.content}
    >>>>>>>

    // INSTRUCTIONS:
    // 1. Edit this file to create your desired merged version
    // 2. Remove the conflict markers (<<<<<<, =======, >>>>>>>)
    // 3. Save and close the file
    // 4. Press Enter in the terminal to continue
    `;

            await fs.writeFile(mergedPath, mergedContent);

            console.log(`\n📝 Created merged file: ${mergedPath}`.yellow);
            console.log('Opening in default editor...'.yellow);

            // Try to open in default editor
            const { exec } = require('child_process');
            const platform = process.platform;

            let command;
            if (platform === 'win32') {
                command = `notepad "${mergedPath}"`;
            } else if (platform === 'darwin') {
                command = `open -t "${mergedPath}"`;
            } else {
                command = `nano "${mergedPath}"`;
            }

            exec(command);

            // Wait for user to finish editing
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            await new Promise(resolve => {
                rl.question('\nPress Enter when you have finished editing the merged file...', () => {
                    rl.close();
                    resolve();
                });
            });

            return mergedPath;

        } catch (error) {
            console.error('Failed to create merged version:'.red, error.message);
            return null;
        }
    }


    // Method to list pending conflicts
    listPendingConflicts() {
        console.log('\n📋 PENDING CONFLICTS'.yellow.bold);
        console.log('='.repeat(40));

        if (this.pendingConflicts.size === 0) {
            console.log('No pending conflicts ✅'.green);
            return;
        }

        this.pendingConflicts.forEach((conflict, fileName) => {
            console.log(`⚠️  ${fileName}`.yellow);
            console.log(`   Detected: ${conflict.detectedAt.toLocaleString()}`);
            console.log(`   Local: ${conflict.localInfo.size} bytes, modified ${new Date(conflict.localInfo.lastModified).toLocaleString()}`);
            if (conflict.serverInfo) {
                console.log(`   Server: ${conflict.serverInfo.size} bytes, modified ${new Date(conflict.serverInfo.lastModified).toLocaleString()}`);
            }
            console.log('');
        });
    }

    // Method to resolve pending conflicts
    async resolvePendingConflict(fileName) {
        if (!this.pendingConflicts.has(fileName)) {
            console.log(`No pending conflict found for ${fileName}`.yellow);
            return;
        }

        const conflict = this.pendingConflicts.get(fileName);
        console.log(`\nResolving pending conflict for ${fileName}...`.blue);

        // Display the conflict again
        this.displayConflictVersions(fileName, conflict.localInfo, conflict.serverInfo);
        

    
        // Apply resolution
    }

    async downloadFile(serverFile) {
        try {
            const fileName = serverFile.name || serverFile.fileName;
            const localPath = path.join(this.syncFolder, fileName);

            // CRITICAL: Ignore this file during download to prevent loop
            if (this.fileWatcher) {
                this.fileWatcher.ignoreFile(fileName);
            }

            this.updateSyncStatus(fileName, 'downloading');
            console.log(`Downloading ${fileName}`.blue);

            const result = await this.api.downloadFile(fileName, localPath);

            if (result.success) {
                // Set file timestamp to match server timestamp
                const serverTime = new Date(serverFile.lastModified);
                await fs.utimes(localPath, serverTime, serverTime);

                console.log(`Successfully downloaded ${fileName}`.green);
                this.updateSyncStatus(fileName, 'synced');
            }

            // Wait a bit before resuming file watching for this file
            setTimeout(() => {
                if (this.fileWatcher) {
                    this.fileWatcher.unignoreFile(fileName);
                }
            }, 2000); // 2 second delay

            return result;
        } catch (error) {
            console.error(`Failed to download ${fileName}:`.red, error.message);
            this.updateSyncStatus(fileName, 'error', error.message);

            // Resume file watching even on error
            if (this.fileWatcher) {
                this.fileWatcher.unignoreFile(fileName);
            }
            throw error;
        }
    }

    async performFullSync() {
        console.log('Starting full synchronization...'.blue);

        try {
            // Get server files
            const serverFiles = await this.api.listFiles();
            console.log(`Found ${serverFiles.length} files on server`.cyan);

            // Get local files
            const localFiles = await this.getLocalFiles();
            console.log(`Found ${localFiles.length} files locally`.cyan);

            // Pass the flag to compareAndSync
            await this.compareAndSync(localFiles, serverFiles, true, this.isFirstSync);

            this.isFirstSync = false; // <-- Only the first sync after startup

            console.log('Full synchronization completed'.green.bold);

        } catch (error) {
            console.error('Full sync failed:'.red, error.message);
        }
    }

    async performSyncQuietly() {
        try {
            // Get server files
            const serverFiles = await this.api.listFiles();

            // Get local files
            const localFiles = await this.getLocalFiles();

            // Compare and sync without verbose logging
            let updatesFound = await this.compareAndSync(localFiles, serverFiles, false);

            // Only log if something actually changed
            if (updatesFound > 0) {
                console.log(`Sync completed: ${updatesFound} updates processed`.green);
            }

        } catch (error) {
            // Only log errors
            console.error('Sync error:'.red, error.message);
            throw error;
        }
    }

    async getLocalFiles() {
        try {
            const files = [];
            const fileNames = await fs.readdir(this.syncFolder);

            for (const name of fileNames) {
                const filePath = path.join(this.syncFolder, name);
                const stats = await fs.stat(filePath);

                if (stats.isFile()) {
                    files.push({
                        name,
                        path: filePath,
                        size: stats.size,
                        lastModified: stats.mtime.toISOString()
                    });
                }
            }

            return files;
        } catch (error) {
            console.error('Error reading local files:'.red, error.message);
            return [];
        }
    }

    pauseSync() {
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            this.isPaused = true;
            console.log('Periodic sync paused'.yellow);
            return true;
        } else {
            console.log('Sync is not currently running'.yellow);
            return false;
        }
    }

    resumeSync() {
        if (this.isPaused || !this.syncIntervalId) {
            this.startPeriodicSync();
            this.isPaused = false;
            console.log('Periodic sync resumed'.green);
            return true;
        } else {
            console.log('Sync is already running'.yellow);
            return false;
        }
    }

    async compareAndSync(localFiles, serverFiles, verbose = true, isFirstSync = false) {
        const serverFileMap = new Map();
        serverFiles.forEach(file => serverFileMap.set(file.name || file.fileName, file));

        const localFileMap = new Map();
        localFiles.forEach(file => localFileMap.set(file.name, file));

        let updatesFound = 0;

        // 1. Handle pending deletions
        for (const fileName of this.pendingDeletions) {
            if (serverFileMap.has(fileName)) {
                if (verbose) console.log(`Deleting ${fileName} from server`.red);
                try {
                    await this.api.deleteFile(fileName);
                    console.log(`✅ File ${fileName} deleted from server`.green);
                    this.markAsDeleted(fileName);
                    updatesFound++;
                } catch (error) {
                    console.error(`Failed to delete ${fileName} from server:`.red, error.message);
                }
            } else {
                this.markAsDeleted(fileName);
            }
        }

        // 2. Files to download (on server but not local or server is newer)
        for (const serverFile of serverFiles) {
            const fileName = serverFile.name || serverFile.fileName;

            if (this.recentlyDeleted.has(fileName)) {
                if (verbose) console.log(`Skipping recently deleted file: ${fileName}`.gray);
                continue;
            }

            // Skip if recently uploaded by this client
            const recentUpload = this.recentlyUploaded.get(fileName);
            if (recentUpload && Date.now() - recentUpload.timestamp < 30000) {
                if (verbose) console.log(`Skipping recently uploaded file: ${fileName}`.gray);
                continue;
            }

            const localFile = localFileMap.get(fileName);

            if (!localFile) {
                // File does not exist locally, download it
                if (verbose) console.log(`New server file: ${fileName}`.blue);
                await this.downloadFile(serverFile);
                updatesFound++;
            } else {
                // File exists locally, check if update is needed
                let shouldDownload = false;
                let shouldUpload = false;

                // Compare version if available
                const serverVersion = typeof serverFile.version !== 'undefined' ? Number(serverFile.version) : undefined;
                const localVersion = typeof localFile.version !== 'undefined' ? Number(localFile.version) : undefined;

                if (
                    typeof serverVersion !== 'undefined' &&
                    typeof localVersion !== 'undefined'
                ) {
                    if (serverVersion > localVersion) {
                        shouldDownload = true;
                    } else if (localVersion > serverVersion) {
                        shouldUpload = true;
                    }
                } else if (serverFile.checksum) {
                    // Compare checksum if available
                    try {
                        const localContent = await fs.readFile(localFile.path);
                        const localHash = require('crypto').createHash('md5').update(localContent).digest('hex');
                        if (serverFile.checksum !== localHash) {
                            // Compare lastModified to decide which is newer
                            const serverTime = new Date(serverFile.lastUpdated || serverFile.lastModified || 0);
                            const localTime = new Date(localFile.lastModified);
                            if (localTime > serverTime) {
                                shouldUpload = true;
                            } else {
                                shouldDownload = true;
                            }
                        }
                    } catch {
                        shouldDownload = true; // Missing file locally? Force download
                    }
                } else {
                    // Fallback: compare lastModified
                    const serverTime = new Date(serverFile.lastUpdated || serverFile.lastModified || 0);
                    const localTime = new Date(localFile.lastModified);
                    if (localTime > serverTime) {
                        shouldUpload = true;
                    } else if (serverTime > localTime) {
                        shouldDownload = true;
                    }
                }

                if (shouldUpload && !this.recentlyUploaded.has(fileName)) {
                    if (verbose) console.log(`Local file modified after server: uploading ${fileName}`.green);
                    try {
                        await this.uploadFile(localFile.path);
                        updatesFound++;
                    } catch (error) {
                        console.error(`Failed to upload ${fileName}:`.red, error.message);
                    }
                } else if (shouldDownload) {
                    if (verbose) console.log(`Overwriting local file with server version: ${fileName}`.cyan);
                    await this.downloadFile(serverFile);
                    updatesFound++;
                }
            }
        }

        // 3. Clean up temp conflict_server_ files
        for (const localFile of localFiles) {
            if (/^\.conflict_server_/.test(localFile.name)) {
                try {
                    await fs.remove(localFile.path);
                    if (verbose) console.log(`Removed temp conflict file: ${localFile.name}`.gray);
                } catch { }
            }
        }

        // 4. Local files not on server (upload or delete)
        for (const localFile of localFiles) {
            if (
                !serverFileMap.has(localFile.name) &&
                !this.recentlyDeleted.has(localFile.name) &&
                !this.pendingDeletions.has(localFile.name)
            ) {
                if (isFirstSync) {
                    if (verbose) console.log(`First sync: uploading local file: ${localFile.name}`.green);
                    try {
                        await this.uploadFile(localFile.path);
                        updatesFound++;
                    } catch (error) {
                        console.error(`Failed to upload ${localFile.name}:`.red, error.message);
                    }
                } else {
                    // Normal logic (existing code)
                    const fileAge = Date.now() - new Date(localFile.lastModified).getTime();
                    const isNewFile = fileAge < 60000;
                    if (isNewFile) {
                        if (verbose) console.log(`New local file to upload: ${localFile.name}`.green);
                        try {
                            await this.uploadFile(localFile.path);
                            updatesFound++;
                        } catch (error) {
                            console.error(`Failed to upload ${localFile.name}:`.red, error.message);
                        }
                    } else {
                        if (verbose) console.log(`File deleted from server by another client: ${localFile.name}`.red);
                        try {
                            await fs.remove(localFile.path);
                            console.log(`🗑️ Removed local file: ${localFile.name}`.yellow);
                            this.updateSyncStatus(localFile.name, 'deleted');
                            updatesFound++;
                        } catch (error) {
                            console.error(`Failed to remove local file ${localFile.name}:`.red, error.message);
                        }
                    }
                }
            }
        }

        // Detect possible renames (simple heuristic: same size and similar mtime)
        const unmatchedLocal = localFiles.filter(f =>
            !serverFileMap.has(f.name) &&
            !this.recentlyDeleted.has(f.name) &&
            !this.pendingDeletions.has(f.name)
        );
        const unmatchedServer = serverFiles.filter(f =>
            !localFileMap.has(f.name || f.fileName)
        );

        for (const localFile of unmatchedLocal) {
            for (const serverFile of unmatchedServer) {
                if (
                    localFile.size === serverFile.size &&
                    Math.abs(new Date(localFile.lastModified) - new Date(serverFile.lastModified || serverFile.lastUpdated)) < 10000
                ) {
                    if (verbose) console.log(`Detected rename: ${serverFile.name} -> ${localFile.name}`.magenta);
                    try {
                        await this.api.renameFile(serverFile.name, localFile.name);
                        updatesFound++;
                        unmatchedServer.splice(unmatchedServer.indexOf(serverFile), 1);
                        break;
                    } catch (err) {
                        console.error(`Failed to sync rename from ${serverFile.name} to ${localFile.name}:`, err.message);
                    }
                }
            }
        }

        return updatesFound;
    }


    updateSyncStatus(fileName, status, details = {}) {
        const currentStatus = this.fileSyncStatus.get(fileName) || {};

        this.fileSyncStatus.set(fileName, {
            ...currentStatus,
            status,
            updatedAt: new Date().toISOString(),
            ...details
        });
    }

    getSyncStatus() {
        const result = [];

        this.fileSyncStatus.forEach((status, fileName) => {
            result.push({
                fileName,
                ...status
            });
        });

        return result;
    }

    startPeriodicSync() {
        if this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
        }
        this.syncIntervalId = setInterval(async () => {
            await this.checkServerStatus();
            if (this.serverOnline) {
                try {
                    await this.performSyncQuietly();
                } catch (error) {
                    console.error('Periodic sync failed:'.red, error.message);
                }
            }
        }, this.pollInterval);
        console.log(`Periodic sync started (every ${this.pollInterval/1000} seconds)`.cyan);
    }

    // Process queued changes when back online
    async processOfflineQueue() {
        if (this.offlineQueue.length === 0) return;
        console.log('\n🔄 Processing queued offline changes...'.cyan);
        // Sort by timestamp to preserve order
        this.offlineQueue.sort((a, b) => a.timestamp - b.timestamp);

        // First process renames
        for (const change of this.offlineQueue.filter(c => c.type === 'rename')) {
            try {
                await this.api.renameFile(change.oldName, change.newName);
                console.log(`Renamed ${change.oldName} to ${change.newName} on server`.green);
            } catch (err) {
                console.error(`Failed to process queued rename for ${change.oldName}:`, err.message);
            }
        }
        // Then process other changes (add/change/delete)
        for (const change of this.offlineQueue.filter(c => c.type !== 'rename')) {
            try {
                if (change.type === 'delete' || change.type === 'unlink') {
                    this.markForDeletion(change.fileName);
                } else if (['add', 'change'].includes(change.type)) {
                    try {
                        await this.uploadFile(change.filePath);
                    } catch (err) {
                        if (err && err.conflict) {
                            await this.handleConflict(change.fileName, change.filePath, err.details);
                        } else {
                            console.error(`Failed to process queued change for ${change.fileName}:`, err.message);
                        }
                    }
                }
            } catch (err) {
                console.error(`Failed to process queued change for ${change.fileName}:`, err.message);
            }
        }
        this.offlineQueue = [];
        console.log('✅ All offline changes processed.'.green);
    }

    stop() {
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }

        console.log('Sync manager stopped'.yellow);
    }

    isServerOnline() {
        return this.serverOnline;
    }

    queueRename(oldName, newName) {
        this.offlineQueue.push({
            type: 'rename',
            oldName,
            newName,
            timestamp: Date.now()
        });
        console.log(`Queued rename from ${oldName} to ${newName} (offline)`.yellow);
    }
}

module.exports = SyncManager;