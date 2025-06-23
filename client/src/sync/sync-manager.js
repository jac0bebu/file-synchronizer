const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const colors = require('colors');

class SyncManager {
    constructor(apiClient, syncFolder, options = {}) {
        this.api = apiClient;
        this.syncFolder = path.resolve(syncFolder);
        this.clientId = options.clientId || `client-${crypto.randomBytes(4).toString('hex')}`;
        this.pollInterval = options.pollInterval || 10000;
        this.syncIntervalId = null;
        this.pendingUploads = new Map();
        this.pendingDownloads = new Map();
        this.fileSyncStatus = new Map();
        this.recentlyDeleted = new Set();
        this.pendingDeletions = new Set(); // Track files marked for server deletion
        
        console.log('Sync Manager initialized'.green);
        console.log(`Client ID: ${this.clientId}`.cyan);
        console.log(`Sync folder: ${this.syncFolder}`.cyan);
    }

    async start() {
        console.log('Starting sync manager...'.yellow);
        
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
            console.error('Failed to start sync manager:'.red, error.message);
            return false;
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
            
            if (type === 'unlink') {
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
            
            this.pendingUploads.set(fileName, filePath);
            this.updateSyncStatus(fileName, 'uploading');
            
            const stats = await fs.stat(filePath);
            const fileSize = stats.size;
            
            console.log(`Uploading ${fileName} (${fileSize} bytes)`.cyan);
            
            const result = await this.api.uploadFile(filePath, this.clientId);
            
            console.log(`Successfully uploaded ${fileName} (version ${result.version})`.green);
            this.updateSyncStatus(fileName, 'synced', { 
                version: result.version,
                lastSync: new Date().toISOString()
            });
            
        } catch (error) {
            if (error.conflict) {
                this.updateSyncStatus(fileName, 'conflict');
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

    async handleConflict(fileName, localPath, conflictDetails) {
        console.log(`Conflict detected for ${fileName}`.yellow.bold);
        
        // Auto-resolution strategy: keep local changes by default
        // In a real app, you might prompt the user for a decision
        console.log(`Resolving conflict: keeping local version of ${fileName}`.blue);
        
        // Force upload our version using the chunked uploader to bypass conflict detection
        try {
            const result = await this.api.uploadChunkedFile(localPath, this.clientId);
            console.log(`Conflict resolved by keeping local version of ${fileName}`.green);
            
            this.updateSyncStatus(fileName, 'synced', { 
                version: result.version,
                lastSync: new Date().toISOString(),
                resolvedConflict: true
            });
        } catch (error) {
            console.error(`Failed to resolve conflict for ${fileName}:`.red, error.message);
            this.updateSyncStatus(fileName, 'conflict-error', error.message);
        }
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
            
            // Compare and sync
            await this.compareAndSync(localFiles, serverFiles);
            
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

    async compareAndSync(localFiles, serverFiles, verbose = true) {
        const serverFileMap = new Map();
        serverFiles.forEach(file => serverFileMap.set(file.name || file.fileName, file));
        
        const localFileMap = new Map();
        localFiles.forEach(file => localFileMap.set(file.name, file));
        
        let updatesFound = 0;
        
        // 1. Handle pending deletions FIRST
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
        
        // 2. Files to download (on server but not local)
        for (const serverFile of serverFiles) {
            const fileName = serverFile.name || serverFile.fileName;
            
            if (this.recentlyDeleted.has(fileName)) {
                if (verbose) console.log(`Skipping recently deleted file: ${fileName}`.gray);
                continue;
            }
            
            if (!localFileMap.has(fileName)) {
                if (verbose) console.log(`New server file: ${fileName}`.blue);
                await this.downloadFile(serverFile);
                updatesFound++;
            } else {
                const localFile = localFileMap.get(fileName);
                const serverTime = new Date(serverFile.lastModified || 0);
                const localTime = new Date(localFile.lastModified);
                
                const timeDifferenceMs = Math.abs(serverTime.getTime() - localTime.getTime());
                const tolerance = 2000;
                
                if (timeDifferenceMs > tolerance && serverTime > localTime) {
                    if (verbose) console.log(`Server has newer version of ${fileName}`.blue);
                    await this.downloadFile(serverFile);
                    updatesFound++;
                }
            }
        }
        
        // 3. Handle local files not on server (SINGLE LOOP - no duplication)
        for (const localFile of localFiles) {
            if (!serverFileMap.has(localFile.name) && 
                !this.recentlyDeleted.has(localFile.name) && 
                !this.pendingDeletions.has(localFile.name)) {
                
                // Decide: Upload or Delete based on file age
                const fileAge = Date.now() - new Date(localFile.lastModified).getTime();
                const isNewFile = fileAge < 60000; // Less than 1 minute = new file
                
                if (isNewFile) {
                    // NEW FILE: Upload it
                    if (verbose) console.log(`New local file to upload: ${localFile.name}`.green);
                    
                    try {
                        await this.uploadFile(localFile.path);
                        updatesFound++;
                    } catch (error) {
                        console.error(`Failed to upload ${localFile.name}:`.red, error.message);
                    }
                } else {
                    // OLD FILE: Delete it (was deleted from server by another client)
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
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
        }
        
        this.syncIntervalId = setInterval(async () => {
            if (this.verbose) {
                console.log('Running periodic sync...'.gray);
            }
            
            try {
                await this.performSyncQuietly();
            } catch (error) {
                console.error('Periodic sync failed:'.red, error.message);
            }
        }, this.pollInterval);
        
        console.log(`Periodic sync started (every ${this.pollInterval/1000} seconds)`.cyan);
    }
    
    stop() {
        if (this.syncIntervalId) {
            clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
        }
        
        console.log('Sync manager stopped'.yellow);
    }
}

module.exports = SyncManager;