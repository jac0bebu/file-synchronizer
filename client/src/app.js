const ApiClient = require('./api/api-client');
const FileWatcher = require('./watcher/file-watcher');
const SyncManager = require('./sync/sync-manager');
const CliInterface = require('./ui/cli-interface');
const path = require('path');
const crypto = require('crypto');
const colors = require('colors');

class SyncApplication {
    constructor(options = {}) {
        // Initialize configuration
        this.serverUrl = options.serverUrl || 'http://localhost:3000';
        this.syncFolder = options.syncFolder || path.join(__dirname, '../sync-folder');
        this.clientId = options.clientId || `client-${crypto.randomBytes(4).toString('hex')}`;
        this.pollInterval = options.pollInterval || 10000;
        
        // Initialize components
        this.apiClient = new ApiClient(this.serverUrl);
        this.syncManager = new SyncManager(this.apiClient, this.syncFolder, {
            clientId: this.clientId,
            pollInterval: this.pollInterval
        });
        this.fileWatcher = new FileWatcher(this.syncFolder, {
            onChange: this.handleFileChange.bind(this)
        });

        // *** ADD THIS LINE ***
        this.syncManager.fileWatcher = this.fileWatcher;

        this.ui = new CliInterface(this.syncManager);
        
    }
    
    async start() {
        console.log('\n===================================='.yellow);
        console.log('🚀 SYNC CLIENT STARTING'.green.bold);
        console.log('===================================='.yellow);
        
        try {
            // Start sync manager
            const syncStarted = await this.syncManager.start();
            if (!syncStarted) {
                throw new Error('Failed to start sync manager');
            }
            
            // Start file watcher
            this.fileWatcher.start();
            
            // Start UI
            this.ui.start();
            
            console.log('\n✅ Sync client successfully started!'.green.bold);
            console.log('====================================\n'.yellow);
            
            // Setup graceful shutdown
            this.setupGracefulShutdown();
            
        } catch (error) {
            console.error('❌ Failed to start sync client:'.red.bold, error.message);
            process.exit(1);
        }
    }
    
    handleFileChange(filePath, eventType) {
        const fileName = path.basename(filePath);
        
        this.syncManager.handleFileChange({
            type: eventType,
            path: filePath,
            fileName: fileName
        }).catch(error => {
            console.error('Error in file change handler:'.red, error.message);
        });
    }
    
    setupGracefulShutdown() {
        process.on('SIGINT', () => {
            console.log('\n\nShutting down sync client...'.yellow);
            this.fileWatcher.stop();
            this.syncManager.stop();
            process.exit(0);
        });
    }
}

// Start the application if run directly
if (require.main === module) {
    const app = new SyncApplication();
    app.start().catch(console.error);
}

module.exports = SyncApplication;