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
        this.pendingDeletions = new Set(); // Track files marked for server deletion

        this.pendingConflicts = new Map(); // Track unresolved conflicts
        this.conflictHistory = new Map(); // Track resolved conflicts
        
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

    // Enhanced handleConflict method
    async handleConflict(fileName, localPath, conflictDetails) {
        console.log(`\n⚠️  CONFLICT DETECTED: ${fileName}`.yellow.bold);
        console.log('=' .repeat(60).yellow);
        
        try {
            // Mark as conflict in status
            this.updateSyncStatus(fileName, 'conflict', { 
                detectedAt: new Date().toISOString(),
                details: conflictDetails 
            });
            
            // Get local file information
            const localStats = await fs.stat(localPath);
            const localContent = await fs.readFile(localPath, 'utf-8');
            const localInfo = {
                size: localStats.size,
                lastModified: localStats.mtime.toISOString(),
                content: localContent,
                location: 'LOCAL'
            };
            
            // Get server file information
            let serverInfo = null;
            try {
                const serverFiles = await this.api.listFiles();
                const serverFile = serverFiles.find(f => (f.name || f.fileName) === fileName);
                
                if (serverFile) {
                    // Download server version to temporary location
                    const tempServerPath = path.join(this.syncFolder, `.conflict_server_${fileName}`);
                    await this.api.downloadFile(fileName, tempServerPath);
                    const serverContent = await fs.readFile(tempServerPath, 'utf-8');
                    
                    serverInfo = {
                        size: serverFile.size,
                        lastModified: serverFile.lastModified,
                        version: serverFile.version || serverFile.currentVersion,
                        content: serverContent,
                        location: 'SERVER',
                        tempPath: tempServerPath
                    };
                }
            } catch (error) {
                console.error('Failed to get server version:'.red, error.message);
            }
            
            // Display both versions
            this.displayConflictVersions(fileName, localInfo, serverInfo);
            
            // Store conflict for resolution
            this.pendingConflicts.set(fileName, {
                localInfo,
                serverInfo,
                localPath,
                detectedAt: new Date(),
                resolved: false
            });
            
            // Prompt user for resolution
            const resolution = await this.promptConflictResolution(fileName, localInfo, serverInfo);
            
            // Apply the chosen resolution
            await this.applyConflictResolution(fileName, resolution, localInfo, serverInfo);
            
            // Clean up temporary files
            if (serverInfo && serverInfo.tempPath) {
                try {
                    await fs.remove(serverInfo.tempPath);
                } catch (error) {
                    console.error('Failed to clean up temp file:'.red, error.message);
                }
            }
            
        } catch (error) {
            console.error(`Error handling conflict for ${fileName}:`.red, error.message);
            this.updateSyncStatus(fileName, 'conflict-error', error.message);
            throw error;
        }
    }

    displayConflictVersions(fileName, localInfo, serverInfo) {
        console.log(`\n📄 File: ${fileName}`.cyan.bold);
        console.log('-'.repeat(60));
        
        // Local version
        console.log('🏠 LOCAL VERSION:'.green.bold);
        console.log(`   📏 Size: ${localInfo.size} bytes`);
        console.log(`   📅 Modified: ${new Date(localInfo.lastModified).toLocaleString()}`);
        console.log(`   📝 Content Preview:`);
        console.log('   ' + '-'.repeat(40));
        const localPreview = localInfo.content.length > 200 
            ? localInfo.content.substring(0, 200) + '...' 
            : localInfo.content;
        console.log(`   ${localPreview.split('\n').join('\n   ')}`);
        console.log('   ' + '-'.repeat(40));
        
        console.log('');
        
        // Server version
        if (serverInfo) {
            console.log('🌐 SERVER VERSION:'.blue.bold);
            console.log(`   📏 Size: ${serverInfo.size} bytes`);
            console.log(`   📅 Modified: ${new Date(serverInfo.lastModified).toLocaleString()}`);
            console.log(`   🔢 Version: ${serverInfo.version || 'unknown'}`);
            console.log(`   📝 Content Preview:`);
            console.log('   ' + '-'.repeat(40));
            const serverPreview = serverInfo.content.length > 200 
                ? serverInfo.content.substring(0, 200) + '...' 
                : serverInfo.content;
            console.log(`   ${serverPreview.split('\n').join('\n   ')}`);
            console.log('   ' + '-'.repeat(40));
        } else {
            console.log('🌐 SERVER VERSION: Not available'.red);
        }
        
        console.log('\n' + '='.repeat(60));
    }

    // Display both versions with detailed information
    displayConflictVersions(fileName, localInfo, serverInfo) {
        console.log(`\n📄 File: ${fileName}`.cyan.bold);
        console.log('-'.repeat(60));
        
        // Local version
        console.log('🏠 LOCAL VERSION:'.green.bold);
        console.log(`   📏 Size: ${localInfo.size} bytes`);
        console.log(`   📅 Modified: ${new Date(localInfo.lastModified).toLocaleString()}`);
        console.log(`   📝 Content Preview:`);
        console.log('   ' + '-'.repeat(40));
        const localPreview = localInfo.content.length > 200 
            ? localInfo.content.substring(0, 200) + '...' 
            : localInfo.content;
        console.log(`   ${localPreview.split('\n').join('\n   ')}`);
        console.log('   ' + '-'.repeat(40));
        
        console.log('');
        
        // Server version
        if (serverInfo) {
            console.log('🌐 SERVER VERSION:'.blue.bold);
            console.log(`   📏 Size: ${serverInfo.size} bytes`);
            console.log(`   📅 Modified: ${new Date(serverInfo.lastModified).toLocaleString()}`);
            console.log(`   🔢 Version: ${serverInfo.version || 'unknown'}`);
            console.log(`   📝 Content Preview:`);
            console.log('   ' + '-'.repeat(40));
            const serverPreview = serverInfo.content.length > 200 
                ? serverInfo.content.substring(0, 200) + '...' 
                : serverInfo.content;
            console.log(`   ${serverPreview.split('\n').join('\n   ')}`);
            console.log('   ' + '-'.repeat(40));
        } else {
            console.log('🌐 SERVER VERSION: Not available'.red);
        }
        
        console.log('\n' + '='.repeat(60));
    }

    // Prompt user for conflict resolution choice (single keypress, raw mode)
    async promptConflictResolution(fileName, localInfo, serverInfo) {
        const validChoices = ['1', '2', 's', 'h'];
        if (serverInfo) {
            validChoices.push('3', '4');
        }

        console.log(`\n🤔 How would you like to resolve this conflict?`.yellow.bold);
        console.log('');
        console.log('Available options:'.cyan);
        console.log('  [1] Keep LOCAL version (overwrite server)');
        console.log('  [2] Keep SERVER version (overwrite local)');
        if (serverInfo) {
            console.log('  [3] Show FULL content comparison');
            console.log('  [4] Create MERGED version (manual edit)');
        }
        console.log('  [s] Skip for now (resolve later)');
        console.log('  [h] Show help');
        console.log('');

        return new Promise((resolve) => {
            const onData = async (buffer) => {
                const choice = buffer.toString().trim();
                if (!validChoices.includes(choice)) {
                    process.stdout.write('\u001b[31mInvalid choice. Please enter 1, 2' + (serverInfo ? ', 3, 4' : '') + ', s, or h\u001b[0m\n');
                    return;
                }
                process.stdin.setRawMode(false);
                process.stdin.pause();
                process.stdin.removeListener('data', onData);

                if (choice === '3' && serverInfo) {
                    this.showFullComparison(localInfo, serverInfo);
                    // Re-enable raw mode for next input
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    process.stdin.on('data', onData);
                    return;
                }
                if (choice === '4' && serverInfo) {
                    const mergedPath = await this.createMergedVersion(fileName, localInfo, serverInfo);
                    resolve({ type: 'merge', path: mergedPath });
                    return;
                }
                if (choice === 'h') {
                    this.showConflictHelp();
                    // Re-enable raw mode for next input
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                    process.stdin.on('data', onData);
                    return;
                }
                // 1, 2, s
                resolve({
                    type: choice === '1' ? 'local' : choice === '2' ? 'server' : 'skip',
                    choice: choice
                });
            };
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.on('data', onData);
        });
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
    

    // Show help for conflict resolution
    showConflictHelp() {
        console.log('\n' + '📚 CONFLICT RESOLUTION HELP'.cyan.bold);
        console.log('='.repeat(50).cyan);
        console.log('Option 1 - Keep LOCAL:'.green);
        console.log('  - Keeps your local changes');
        console.log('  - Uploads your version to server (creates new version)');
        console.log('  - Other clients will get your version');
        console.log('');
        console.log('Option 2 - Keep SERVER:'.blue);
        console.log('  - Downloads server version');
        console.log('  - Overwrites your local file');
        console.log('  - Your local changes will be lost');
        console.log('');
        console.log('Option 3 - Show FULL comparison:'.yellow);
        console.log('  - Shows complete content of both versions');
        console.log('  - Helpful for detailed comparison');
        console.log('');
        console.log('Option 4 - Create MERGED version:'.magenta);
        console.log('  - Creates a file with both versions marked');
        console.log('  - Opens in editor for manual merging');
        console.log('  - You decide what to keep from each version');
        console.log('');
        console.log('Option S - Skip:'.gray);
        console.log('  - Leaves conflict unresolved');
        console.log('  - You can resolve it later');
        console.log('  - File remains in conflict state');
        console.log('='.repeat(50).cyan + '\n');
    }

    // Apply the chosen resolution
    async applyConflictResolution(fileName, resolution, localInfo, serverInfo) {
        try {
            switch (resolution.type) {
                case 'local':
                    console.log(`\n✅ Keeping LOCAL version of ${fileName}`.green);
                    
                    // Force upload local version
                    const uploadResult = await this.api.uploadChunkedFile(localInfo.localPath || path.join(this.syncFolder, fileName), this.clientId);
                    
                    console.log(`✅ Local version uploaded as version ${uploadResult.version}`.green);
                    this.updateSyncStatus(fileName, 'synced', {
                        version: uploadResult.version,
                        resolvedConflict: true,
                        resolution: 'kept-local',
                        resolvedAt: new Date().toISOString()
                    });
                    break;
                    
                case 'server':
                    console.log(`\n✅ Keeping SERVER version of ${fileName}`.blue);
                    
                    // Download server version
                    if (serverInfo && serverInfo.tempPath) {
                        const finalPath = path.join(this.syncFolder, fileName);
                        await fs.copy(serverInfo.tempPath, finalPath);
                        
                        // Set timestamp to match server
                        const serverTime = new Date(serverInfo.lastModified);
                        await fs.utimes(finalPath, serverTime, serverTime);
                        
                        console.log(`✅ Server version downloaded and applied`.blue);
                        this.updateSyncStatus(fileName, 'synced', {
                            version: serverInfo.version,
                            resolvedConflict: true,
                            resolution: 'kept-server',
                            resolvedAt: new Date().toISOString()
                        });
                    }
                    break;
                    
                case 'merge':
                    console.log(`\n✅ Applying MERGED version of ${fileName}`.magenta);
                    
                    // Move merged file to final location
                    const finalPath = path.join(this.syncFolder, fileName);
                    await fs.copy(resolution.path, finalPath);
                    await fs.remove(resolution.path); // Clean up merged file
                    
                    // Upload the merged version
                    const mergeResult = await this.api.uploadChunkedFile(finalPath, this.clientId);
                    
                    console.log(`✅ Merged version uploaded as version ${mergeResult.version}`.magenta);
                    this.updateSyncStatus(fileName, 'synced', {
                        version: mergeResult.version,
                        resolvedConflict: true,
                        resolution: 'merged',
                        resolvedAt: new Date().toISOString()
                    });
                    break;
                    
                case 'skip':
                    console.log(`\n⏸️  Conflict for ${fileName} left unresolved`.yellow);
                    this.updateSyncStatus(fileName, 'conflict-pending', {
                        resolution: 'skipped',
                        skippedAt: new Date().toISOString()
                    });
                    return; // Don't mark as resolved
            }
            
            // Mark conflict as resolved
            if (this.pendingConflicts.has(fileName)) {
                const conflict = this.pendingConflicts.get(fileName);
                conflict.resolved = true;
                conflict.resolvedAt = new Date();
                conflict.resolution = resolution;
                
                // Move to history
                this.conflictHistory.set(fileName, conflict);
                this.pendingConflicts.delete(fileName);
            }
            
        } catch (error) {
            console.error(`Failed to apply resolution for ${fileName}:`.red, error.message);
            this.updateSyncStatus(fileName, 'conflict-error', {
                error: error.message,
                failedAt: new Date().toISOString()
            });
            throw error;
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
        
        // Prompt for resolution
        const resolution = await this.promptConflictResolution(fileName, conflict.localInfo, conflict.serverInfo);
        
        // Apply resolution
        await this.applyConflictResolution(fileName, resolution, conflict.localInfo, conflict.serverInfo);
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
            if (
                !serverFileMap.has(localFile.name) &&
                !this.recentlyDeleted.has(localFile.name) &&
                !this.pendingDeletions.has(localFile.name)
            ) {
                // Decide: Upload or Delete based on file age
                const fileAge = Date.now() - new Date(localFile.lastModified).getTime();
                const isNewFile = fileAge < 5000; // Less than 1 minute = new file

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