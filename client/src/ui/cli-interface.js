const readline = require('readline');
const colors = require('colors');
const path = require('path');
const fs = require('fs-extra');

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
            'rename': this.renameFile.bind(this)
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

    handleCommand(input) {
        const [command, ...args] = input.split(' ');

        if (this.commands[command]) {
            try {
                const result = this.commands[command](args);
                
                // Handle async commands properly
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
        
        try {
            console.log(`Deleting file: ${fileName}...`.yellow);
            
            // 1. Delete from server FIRST
            try {
                await this.syncManager.api.deleteFile(fileName);
                console.log(`✅ File ${fileName} deleted from server`.green);
                this.syncManager.markAsDeleted(fileName);
            } catch (error) {
                console.log(`File ${fileName} not found on server or already deleted`.yellow);
            }
            
            // 2. Delete local file
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
            const conflicts = await this.syncManager.api.getConflicts();
            
            if (conflicts.length === 0) {
                console.log('No conflicts found.'.green);
                return;
            }
            
            conflicts.forEach(conflict => {
                const status = conflict.status === 'resolved' ? 'RESOLVED'.green : 'UNRESOLVED'.red;
                console.log(`- ${conflict.fileName} [${status}]`.white);
                console.log(`  ID: ${conflict.id}`.gray);
                console.log(`  Reason: ${conflict.reason}`.yellow);
                
                if (conflict.status === 'resolved' && conflict.resolution) {
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

