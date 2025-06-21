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

        // CRITICAL: Connect file watcher to sync manager
        this.syncManager.fileWatcher = this.fileWatcher;

        this.ui = new CliInterface(this.syncManager);
    }
    
    async start() {
        console.log('\n===================================='.cyan);
        console.log('🚀 FILE SYNC CLIENT STARTING'.green.bold);
        console.log('===================================='.cyan);
        
        try {
            // Start sync manager first
            console.log('Starting sync manager...'.yellow);
            const syncStarted = await this.syncManager.start();
            if (!syncStarted) {
                throw new Error('Failed to start sync manager');
            }
            
            // Start file watcher
            console.log('Starting file watcher...'.yellow);
            this.fileWatcher.start();
            
            // Start CLI interface
            console.log('Starting CLI interface...'.yellow);
            this.ui.start();
            
            console.log('\n✅ All components started successfully!'.green.bold);
            console.log(`📁 Sync folder: ${this.syncFolder}`.cyan);
            console.log(`🆔 Client ID: ${this.clientId}`.cyan);
            console.log(`🔄 Poll interval: ${this.pollInterval/1000}s`.cyan);
            console.log('====================================\n'.cyan);
            
            // Setup graceful shutdown
            this.setupGracefulShutdown();
            
        } catch (error) {
            console.error('❌ Failed to start sync client:'.red.bold, error.message);
            console.error('Stack trace:'.red, error.stack);
            process.exit(1);
        }
    }
    
    handleFileChange(filePath, eventType) {
        const fileName = path.basename(filePath);
        
        // Format the event properly for sync manager
        const fileEvent = {
            type: eventType,
            path: filePath,
            fileName: fileName
        };
        
        // Handle the file change asynchronously
        this.syncManager.handleFileChange(fileEvent).catch(error => {
            console.error(`Error handling file change for ${fileName}:`.red, error.message);
        });
    }
    
    setupGracefulShutdown() {
        const shutdown = () => {
            console.log('\n\n🛑 Shutting down sync client...'.yellow);
            
            try {
                if (this.fileWatcher) {
                    console.log('Stopping file watcher...'.gray);
                    this.fileWatcher.stop();
                }
                
                if (this.syncManager) {
                    console.log('Stopping sync manager...'.gray);
                    this.syncManager.stop();
                }
                
                console.log('✅ Sync client stopped gracefully'.green);
                process.exit(0);
            } catch (error) {
                console.error('Error during shutdown:'.red, error.message);
                process.exit(1);
            }
        };
        
        // Handle different shutdown signals
        process.on('SIGINT', shutdown);    // Ctrl+C
        process.on('SIGTERM', shutdown);   // Termination signal
        process.on('SIGQUIT', shutdown);   // Quit signal
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:'.red.bold, error.message);
            console.error('Stack trace:'.red, error.stack);
            shutdown();
        });
        
        // Handle unhandled promise rejections
        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled Rejection at:'.red.bold, promise);
            console.error('Reason:'.red, reason);
            shutdown();
        });
    }
    
    // Method to restart components if needed
    async restart() {
        console.log('🔄 Restarting sync client...'.yellow);
        
        // Stop components
        if (this.fileWatcher) this.fileWatcher.stop();
        if (this.syncManager) this.syncManager.stop();
        
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Restart
        await this.start();
    }
    
    // Method to get status
    getStatus() {
        return {
            serverUrl: this.serverUrl,
            syncFolder: this.syncFolder,
            clientId: this.clientId,
            pollInterval: this.pollInterval,
            components: {
                apiClient: !!this.apiClient,
                syncManager: !!this.syncManager,
                fileWatcher: !!this.fileWatcher,
                ui: !!this.ui
            }
        };
    }
}

// Start the application if run directly
if (require.main === module) {
    const app = new SyncApplication();
    app.start().catch(error => {
        console.error('Fatal error starting application:'.red.bold, error.message);
        process.exit(1);
    });
}

module.exports = SyncApplication;