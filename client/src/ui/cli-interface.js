const readline = require('readline');
const colors = require('colors');
const path = require('path');
const fs = require('fs-extra');
const stringArgv = require('string-argv').default || require('string-argv');

class CliInterface {
    constructor(syncManager, options = {}) {
        this.syncManager = syncManager;
        this.downloadFolder = options.downloadFolder || path.join(process.cwd(), 'downloads', options.username || 'unknown');
        this.username = options.username || 'unknown';
        this.rl = null;
        this.commands = {
            'status': this.showStatus.bind(this),
            'sync': this.startSync.bind(this),
            'list': this.listFiles.bind(this),
            'delete': this.deleteFile.bind(this),
            'quit': this.quit.bind(this),
            'help': this.showHelp.bind(this),
            'conflicts': this.showConflicts.bind(this),
            'versions': this.showVersions.bind(this),
            'download-version': this.downloadVersion.bind(this),
            'pause': this.pauseSync.bind(this),
            'resume': this.resumeSync.bind(this),
            'config': this.showConfig.bind(this),
            'restore': this.restoreVersion.bind(this),
            'rename': this.renameFile.bind(this),
            'resolve': this.resolveConflictById.bind(this)
        };
    }

    start() {
        console.log('\n🚀 File Synchronization Client'.green.bold);
        console.log('Type "help" for available commands\n');

        this.rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
            prompt: 'sync> '.cyan
        });

        this.rl.on('line', (line) => {
            this.handleCommand(line.trim());
            this.rl.prompt();
        });

        this.rl.on('close', () => {
            console.log('\n👋 Goodbye!'.yellow);
            process.exit(0);
        });

        this.rl.prompt();
    }

    async resolveConflictById(args) {
        if (!args || args.length === 0) {
            console.log('Usage: resolve <conflictId|filename>'.yellow);
            if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
            return;
        }
        let conflictId = args[0];
        try {
            // Fetch conflict details from server
            const conflicts = await this.syncManager.api.getConflicts();
            let conflict = Array.isArray(conflicts)
                ? conflicts.find(c => c.id === conflictId)
                : null;

            // If not found by ID, try by filename (latest unresolved)
            if (!conflict) {
                const byFile = Array.isArray(conflicts)
                    ? conflicts.filter(c => (c.fileName === conflictId || c.fileName === args[0]) && c.status !== 'resolved')
                    : [];
                if (byFile.length === 1) {
                    conflict = byFile[0];
                    conflictId = conflict.id;
                    console.log(`Found unresolved conflict for "${args[0]}": ID ${conflictId}`.yellow);
                } else if (byFile.length > 1) {
                    console.log(`Multiple unresolved conflicts found for "${args[0]}":`.yellow);
                    byFile.forEach((c, idx) => {
                        console.log(`  [${idx + 1}] ID: ${c.id} | Reason: ${c.reason} | Time: ${c.timestamp}`);
                    });
                    await new Promise(resolve => {
                        this.rl.question('Enter the number of the conflict to resolve: '.cyan, async (answer) => {
                            const sel = parseInt(answer.trim(), 10);
                            if (!isNaN(sel) && sel > 0 && sel <= byFile.length) {
                                conflict = byFile[sel - 1];
                                conflictId = conflict.id;
                                resolve();
                            } else {
                                console.log('Invalid selection.'.red);
                                conflict = null;
                                resolve();
                            }
                        });
                    });
                    if (!conflict) {
                        if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
                        return;
                    }
                }
            }

            if (!conflict) {
                console.log(`No conflict found with ID or filename: ${args[0]}`.red);
                if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
                return;
            }

            // --- Only allow the correct client to resolve their conflict ---
            const clientId = this.syncManager.clientId;
            const winner = conflict.winner;
            const myLoser = (conflict.losers || []).find(l => l.clientId === clientId);

            if (!myLoser && !(winner && winner.clientId === clientId)) {
                console.log('This conflict does not belong to you. Only the involved client can resolve this conflict.'.red);
                if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
                return;
            }

            let localMeta, localContent, serverMeta, serverContent;

            if (myLoser) {
                // This client is a loser (conflicted file)
                localMeta = myLoser;
                const conflictFileName = myLoser.conflictFileName || myLoser.fileName;
                let conflictPath = require('path').join(this.syncManager.syncFolder, conflictFileName);
                try {
                    localContent = await require('fs-extra').readFile(conflictPath, 'utf-8');
                } catch {
                    try {
                        conflictPath = require('path').join(this.downloadFolder, conflictFileName);
                        localContent = await require('fs-extra').readFile(conflictPath, 'utf-8');
                    } catch {
                        localContent = '[content not available]';
                    }
                }
                serverMeta = winner;
                serverContent = '[content not available]';
                if (winner && winner.fileName && winner.version && this.syncManager.api.downloadFileVersion) {
                    const os = require('os');
                    const tempPath = require('path').join(os.tmpdir(), `conflict-server-${winner.fileName}.v${winner.version}`);
                    try {
                        await this.syncManager.api.downloadFileVersion(winner.fileName, winner.version, tempPath);
                        serverContent = await require('fs-extra').readFile(tempPath, 'utf-8');
                        await require('fs-extra').remove(tempPath);
                    } catch {}
                }
            } else if (winner && winner.clientId === clientId) {
                // This client is the winner
                localMeta = winner;
                serverMeta = winner;
                let filePath = require('path').join(this.syncManager.syncFolder, winner.fileName);
                try {
                    localContent = await require('fs-extra').readFile(filePath, 'utf-8');
                } catch {
                    localContent = '[content not available]';
                }
                serverContent = localContent;
            } else {
                // Not involved, fallback to default display (should not reach here)
                await this.displayConflictDetails(conflict);
                if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
                return;
            }

            const displayObj = {
                fileName: conflict.fileName,
                incoming: {
                    ...localMeta,
                    content: localContent
                },
                existing: {
                    ...serverMeta,
                    content: serverContent
                }
            };
            await this.displayConflictDetails(displayObj);

        } catch (error) {
            console.error('Error resolving conflict:'.red, error.message);
        }
        if (this.rl && typeof this.rl.prompt === 'function') this.rl.prompt();
    }

    async displayConflictDetails(conflict) {
        // Show local and server versions with size, timestamp, and content preview
        console.log(`\n📄 File: ${conflict.fileName}`.cyan.bold);
        console.log('-'.repeat(60));
        // Local (incoming) version
        const local = conflict.incoming;
        console.log('🏠 LOCAL VERSION:'.green.bold);
        console.log(`   📏 Size: ${local.size} bytes`);
        console.log(`   📅 Modified: ${new Date(local.lastModified).toLocaleString()}`);
        console.log('   📝 Content Preview:');
        console.log('   ' + '-'.repeat(40));
        let localContent = local.content;
        if (!localContent) {
            // Try to read from sync folder
            const localPath = path.join(this.syncManager.syncFolder, conflict.fileName);
            try {
                localContent = await fs.readFile(localPath, 'utf-8');
            } catch {}
        }
        if (!localContent) localContent = '[content not available]';
        const localPreview = localContent.length > 200 ? localContent.substring(0, 200) + '...' : localContent;
        console.log(`   ${localPreview.split('\n').join('\n   ')}`);
        console.log('   ' + '-'.repeat(40));
        console.log('');
        // Server (existing) version
        const server = conflict.existing;
        if (server) {
            console.log('🌐 SERVER VERSION:'.blue.bold);
            console.log(`   📏 Size: ${server.size} bytes`);
            console.log(`   📅 Modified: ${new Date(server.lastModified).toLocaleString()}`);
            console.log(`   🔢 Version: ${server.version || 'unknown'}`);
            console.log('   📝 Content Preview:');
            console.log('   ' + '-'.repeat(40));
            let serverContent = server.content;
            if (!serverContent && this.syncManager.api.downloadFileVersion) {
                // Try to download the server version to a temp file and read it
                const os = require('os');
                const tempPath = path.join(os.tmpdir(), `conflict-server-${conflict.fileName}.v${server.version}`);
                try {
                    await this.syncManager.api.downloadFileVersion(conflict.fileName, server.version, tempPath);
                    serverContent = await fs.readFile(tempPath, 'utf-8');
                    await fs.remove(tempPath);
                } catch {}
            }
            if (!serverContent) serverContent = '[content not available]';
            const serverPreview = serverContent.length > 200 ? serverContent.substring(0, 200) + '...' : serverContent;
            console.log(`   ${serverPreview.split('\n').join('\n   ')}`);
            console.log('   ' + '-'.repeat(40));
        } else {
            console.log('🌐 SERVER VERSION: Not available'.red);
        }
        console.log('\n' + '='.repeat(60));
    }

    handleCommand(input) {
        const [command, ...args] = stringArgv(input);
        if (this.commands[command]) {
            try {
                const result = this.commands[command](args);
                if (result && typeof result.catch === 'function') {
                    result.catch(error => {
                        console.error(`Error executing ${command}:`.red, error.message);
                    });
                }
            } catch (error) {
                console.error(`Error executing ${command}:`.red, error.message);
            }
        } else if (command) {
            console.log(`Unknown command: ${command}. Type "help" for available commands.`.red);
        }
    }

    // In your CLI interface (cli-interface.js or similar)
    async handleConflictCommands(command, args) {
        switch (command) {
            case 'conflicts':
            case 'list-conflicts':
                this.syncManager.listPendingConflicts();
                break;
                
            case 'resolve':
                if (args[0]) {
                    await this.syncManager.resolvePendingConflict(args[0]);
                } else {
                    console.log('Usage: resolve <filename>'.yellow);
                }
                break;
                
            case 'conflict-history':
                this.showConflictHistory();
                break;
        }
    }

    showConflictHistory() {
        console.log('\n📚 CONFLICT HISTORY'.blue.bold);
        console.log('='.repeat(40));
        
        if (this.syncManager.conflictHistory.size === 0) {
            console.log('No resolved conflicts in history'.gray);
            return;
        }
        
        this.syncManager.conflictHistory.forEach((conflict, fileName) => {
            console.log(`✅ ${fileName}`.green);
            console.log(`   Resolved: ${conflict.resolvedAt.toLocaleString()}`);
            console.log(`   Resolution: ${conflict.resolution.type}`);
            console.log('');
        });
    }

    async showStatus() {
        console.log('\n📊 Sync Status:'.blue.bold);
        
        const status = this.syncManager.getSyncStatus();
        
        if (status.length === 0) {
            console.log('No files have been synced yet.'.yellow);
            return;
        }
        
        status.forEach(item => {
            const statusColor = this.getStatusColor(item.status);
            console.log(colors[statusColor](`${item.fileName}: ${item.status.toUpperCase()}`));
            
            if (item.version) {
                console.log(`  Version: ${item.version}`.gray);
            }
            
            if (item.lastSync) {
                console.log(`  Last synced: ${new Date(item.lastSync).toLocaleString()}`.gray);
            }
            
            if (item.error) {
                console.log(`  Error: ${item.error}`.red);
            }
        });
    }

    getStatusColor(status) {
        const colorMap = {
            'synced': 'green',
            'uploading': 'cyan',
            'downloading': 'cyan',
            'processing': 'yellow',
            'conflict': 'red',
            'error': 'red',
            'deleted': 'gray',
            'paused': 'yellow'
        };
        
        return colorMap[status] || 'white';
    }

    async startSync() {
        console.log('Starting manual sync...'.yellow);
        await this.syncManager.performFullSync();
    }

    async listFiles() {
        try {
            console.log('\n📁 Server Files:'.blue.bold);
            const files = await this.syncManager.api.listFiles();
            
            if (files.length === 0) {
                console.log('No files found on server.'.yellow);
                return;
            }
            
            files.forEach(file => {
                console.log(`- ${file.name || file.fileName}`.white);
                if (file.lastModified) {
                    console.log(`  Modified: ${new Date(file.lastModified).toLocaleString()}`.gray);
                }
                if (file.size) {
                    console.log(`  Size: ${file.size} bytes`.gray);
                }
                if (file.version) {
                    console.log(`  Latest Version: ${file.version}`.cyan);
                }
                if (file.totalVersions && file.totalVersions > 1) {
                    console.log(`  Total Versions: ${file.totalVersions}`.gray);
                }
            });
            
        } catch (error) {
            console.error('Failed to list files:'.red, error.message);
        }
    }

    async deleteFile(args) {
        if (!args || args.length === 0) {
            console.log('Usage: delete <filename>'.red);
            return;
        }
        const fileName = args[0];

        // Always sync before delete to ensure latest state
        await this.syncManager.performFullSync();

        try {
            // Try to delete from server
            try {
                await this.syncManager.api.deleteFile(fileName);
                console.log(`✅ File ${fileName} deleted from server`.green);
                this.syncManager.markAsDeleted(fileName);
            } catch (error) {
                console.log(`File ${fileName} not found on server or already deleted`.yellow);
            }

            // Delete local file if it exists
            const localPath = path.join(this.syncManager.syncFolder, fileName);
            if (await fs.pathExists(localPath)) {
                await fs.remove(localPath);
                console.log(`✅ File ${fileName} deleted locally`.green);
            }

            console.log(`🗑️ File ${fileName} deleted successfully`.green.bold);

        } catch (error) {
            console.error(`Error deleting ${fileName}:`.red, error.message);
        }
    }
    async showVersions(args) {
        if (!args || args.length === 0) {
            console.log('Usage: versions <filename>'.red);
            return;
        }
        
        const fileName = args[0];
        
        try {
            console.log(`\n📜 Versions for ${fileName}:`.blue.bold);
            const versions = await this.syncManager.api.getFileVersions(fileName);
            
            if (versions.length === 0) {
                console.log('No versions found.'.yellow);
                return;
            }
            
            versions.forEach(version => {
                console.log(`- Version ${version.version}`.white);
                if (version.createdAt) {
                    console.log(`  Created: ${new Date(version.createdAt).toLocaleString()}`.gray);
                }
                if (version.size) {
                    console.log(`  Size: ${version.size} bytes`.gray);
                }
                if (version.clientId) {
                    console.log(`  Client: ${version.clientId}`.gray);
                }
            });
            
        } catch (error) {
            console.error(`Failed to get versions for ${fileName}:`.red, error.message);
        }
    }

    async downloadVersion(args) {
        if (!args || args.length < 2) {
            console.log('Usage: download-version <filename> <version>'.red);
            return;
        }
        const [fileName, version] = args;
        // Place downloads outside sync folder, grouped by clientId
        const downloadsDir = this.downloadFolder;
        await fs.ensureDir(downloadsDir);
        const destinationPath = path.join(downloadsDir, `${fileName}.v${version}`);

        try {
            console.log(`Downloading ${fileName} version ${version}...`.yellow);
            await this.syncManager.api.downloadFileVersion(fileName, version, destinationPath);
            console.log(`✅ Downloaded ${fileName} version ${version} to ${destinationPath}`.green);
        } catch (error) {
            console.error(`❌ Error downloading version:`.red, error.message);
        }
    }

    async pauseSync() {
        try {
            this.syncManager.pauseSync();
            console.log('⏸️ Sync paused'.yellow);
        } catch (error) {
            console.error('Error pausing sync:'.red, error.message);
        }
    }

    async resumeSync() {
        try {
            this.syncManager.resumeSync();
            console.log('▶️ Sync resumed'.green);
        } catch (error) {
            console.error('Error resuming sync:'.red, error.message);
        }
    }

    async showConfig() {
        console.log('\n⚙️ Configuration:'.blue.bold);
        console.log(`Server URL: ${this.syncManager.api.serverUrl}`.white);
        console.log(`Sync Folder: ${this.syncManager.syncFolder}`.white);
        console.log(`Client ID: ${this.syncManager.clientId}`.white);
        console.log(`Poll Interval: ${this.syncManager.pollInterval/1000} seconds`.white);
        console.log(`Sync Status: ${this.syncManager.syncIntervalId ? 'Running' : 'Stopped'}`.white);
    }

    async showConflicts() {
    try {
        console.log('\n⚠️ Conflicts:'.yellow.bold);
        const allConflicts = await this.syncManager.api.getConflicts();
        const clientId = this.syncManager.clientId;
        // Only show conflicts where this client is a loser (not winner) and there is exactly one loser (themselves)
        const conflicts = (allConflicts || []).filter(conflict =>
            Array.isArray(conflict.losers) &&
            conflict.losers.length === 1 &&
            conflict.losers[0].clientId === clientId
        );

        if (conflicts.length === 0) {
            console.log('No conflicts found.'.green);
            return;
        }

        conflicts.forEach(conflict => {
            const timestamp = conflict.timestamp
                ? new Date(conflict.timestamp).toLocaleString()
                : '';
            console.log(`- ${conflict.fileName}`.white);
            console.log(`  ID: ${conflict.id}`.gray);
            if (timestamp) {
                console.log(`  Time: ${timestamp}`.gray);
            }
            console.log(`  Reason: ${conflict.reason}`.yellow);

            if (conflict.resolution) {
                console.log(`  Resolution: ${conflict.resolution.method}`.green);
                console.log(`  Resolved by: ${conflict.resolution.resolvedBy}`.green);
                console.log(`  Resolved at: ${new Date(conflict.resolvedAt).toLocaleString()}`.green);
            }
        });

    } catch (error) {
        console.error('Failed to fetch conflicts:'.red, error.message);
    }
}

    showHelp() {
        console.log('\n📚 Available Commands:'.blue.bold);
        console.log('  status'.cyan + '          - Show sync status of files');
        console.log('  sync'.cyan + '            - Manually trigger synchronization');
        console.log('  list'.cyan + '            - List files on the server');
        console.log('  delete'.cyan + ' <file>    - Delete a file');
        console.log('  versions'.cyan + ' <file>  - Show versions of a file');
        console.log('  download-version'.cyan + ' - Download specific version');
        console.log('  restore'.cyan + ' <file> <version> - Restore a previous version as new');
        console.log('  conflicts'.cyan + '       - Show detected conflicts');
        console.log('  resolve'.cyan + ' <conflictId>    - Resolve a file conflict by conflict ID (see conflicts command)');
        console.log('  rename'.cyan + ' <old> <new> - Rename a file');
        console.log('  pause'.cyan + '           - Pause synchronization');
        console.log('  resume'.cyan + '          - Resume synchronization');
        console.log('  config'.cyan + '          - Show current configuration');
        console.log('  help'.cyan + '            - Show this help message');
        console.log('  quit'.cyan + '            - Exit the application\n');
    }

    async restoreVersion(args) {
        if (!args || args.length < 2) {
            console.log('Usage: restore <filename> <version>'.red);
            return;
        }
        const [fileName, version] = args;
        // Add confirmation prompt
        this.rl.question(
            `Are you sure you want to restore ${fileName} version ${version} as a new version? (yes/no): `.yellow,
            async (answer) => {
                if (answer.trim().toLowerCase() === 'yes' || answer.trim().toLowerCase() === 'y') {
                    try {
                        console.log(`Restoring ${fileName} version ${version} as new version...`.yellow);
                        const result = await this.syncManager.api.restoreFileVersion(fileName, version, this.syncManager.clientId);
                        if (result.success) {
                            console.log(`✅ Restored ${fileName} version ${version} as version ${result.version}`.green);
                        } else {
                            console.log(`❌ Failed to restore: ${result.error || 'Unknown error'}`.red);
                        }
                    } catch (error) {
                        console.error(`❌ Error restoring version:`.red, error.message);
                    }
                } else {
                    console.log('Restore cancelled.'.gray);
                }
                this.rl.prompt();
            }
        );
    }

    async renameFile(args) {
        if (!args || args.length < 2) {
            console.log('Usage: rename <oldName> <newName>'.red);
            return;
        }
        const [oldName, newName] = args;
        try {
            const result = await this.syncManager.api.renameFile(oldName, newName);
            if (result.success) {
                console.log(`✅ File renamed from ${oldName} to ${newName}`.green);
            } else {
                console.log(`❌ Failed to rename: ${result.error || 'Unknown error'}`.red);
            }
        } catch (error) {
            console.error(`❌ Error renaming file:`, error.message.red);
        }
    }

    quit() {
        console.log('\nExiting application...'.yellow);
        this.rl.close();
    }
}

module.exports = CliInterface;
module.exports = CliInterface;
