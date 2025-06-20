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

    async handleFileChange(fileEvent) {
        const { type, path: filePath, fileName } = fileEvent;
        
        try {
            this.updateSyncStatus(fileName, 'processing');
            
            if (type === 'unlink') {
                // Handle file deletion - not implemented yet
                console.log(`File deleted locally: ${fileName}`.red);
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
        const localPath = path.join(this.syncFolder, serverFile.name);
        this.updateSyncStatus(serverFile.name, 'downloading');
        
        try {
            if (this.pendingDownloads.has(serverFile.name)) {
                return;
            }
            
            this.pendingDownloads.set(serverFile.name, true);
            
            console.log(`Downloading ${serverFile.name}`.cyan);
            
            const result = await this.api.downloadFile(serverFile.name, localPath);
            
            console.log(`Successfully downloaded ${serverFile.name}`.green);
            this.updateSyncStatus(serverFile.name, 'synced', {
                lastSync: new Date().toISOString()
            });
            
            return result;
            
        } catch (error) {
            console.error(`Download failed for ${serverFile.name}:`.red, error.message);
            this.updateSyncStatus(serverFile.name, 'error', error.message);
            throw error;
        } finally {
            this.pendingDownloads.delete(serverFile.name);
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
            // Remove this line that logs every time:
            // console.log(`Sync completed: ${serverFiles.length} server files, ${localFiles.length} local files`.gray);
            
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

    async compareAndSync(localFiles, serverFiles, verbose = true) {
        const serverFileMap = new Map();
        serverFiles.forEach(file => serverFileMap.set(file.name || file.fileName, file));
        
        const localFileMap = new Map();
        localFiles.forEach(file => localFileMap.set(file.name, file));
        
        let updatesFound = 0;
        
        // Files to download (on server but not local)
        for (const serverFile of serverFiles) {
            const fileName = serverFile.name || serverFile.fileName;
            if (!localFileMap.has(fileName)) {
                if (verbose) console.log(`New server file: ${fileName}`.blue);
                await this.downloadFile(serverFile);
                updatesFound++;
            } else {
                // File exists in both places, compare timestamps
                const localFile = localFileMap.get(fileName);
                const serverTime = new Date(serverFile.lastModified || 0);
                const localTime = new Date(localFile.lastModified);
                
                if (serverTime > localTime) {
                    if (verbose) console.log(`Server has newer version of ${fileName}`.blue);
                    await this.downloadFile(serverFile);
                    updatesFound++;
                }
            }
        }
        
        return updatesFound; // Return actual number of changes made
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
            // Only log start of sync if verbose flag is on
            if (this.verbose) {
                console.log('Running periodic sync...'.gray);
            }
            
            try {
                // Perform sync without verbose output
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