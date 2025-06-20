const chokidar = require('chokidar');
const path = require('path');
const colors = require('colors');

class FileWatcher {
    constructor(syncFolder, options = {}) {
        this.syncFolder = path.resolve(syncFolder);
        this.onChange = options.onChange || (() => {});
        this.debounceMs = options.debounceMs || 500;
        this.watcher = null;
        this.debounceTimers = {};
        
        console.log(`File watcher initialized for folder: ${this.syncFolder}`.cyan);
    }

    start() {
        console.log('Starting file watcher...'.yellow);
        
        this.watcher = chokidar.watch(this.syncFolder, {
            ignored: /[\/\\]\./, // ignore dotfiles
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 1000,
                pollInterval: 100
            }
        });

        this.watcher
            .on('add', (filePath) => this.handleFileEvent('add', filePath))
            .on('change', (filePath) => this.handleFileEvent('change', filePath))
            .on('unlink', (filePath) => this.handleFileEvent('unlink', filePath));
        
        console.log('File watcher started'.green);
        return this;
    }

    handleFileEvent(eventType, filePath) {
        const fileName = path.basename(filePath);
        const relativePath = path.relative(this.syncFolder, filePath);
        
        // Debounce to prevent multiple events for the same file
        clearTimeout(this.debounceTimers[filePath]);
        this.debounceTimers[filePath] = setTimeout(() => {
            console.log(`File event: ${eventType} - ${relativePath}`.blue);
            
            this.onChange({
                type: eventType,
                path: filePath,
                fileName,
                relativePath
            });
            
            delete this.debounceTimers[filePath];
        }, this.debounceMs);
    }

    stop() {
        if (this.watcher) {
            this.watcher.close();
            console.log('File watcher stopped'.yellow);
        }
        
        // Clear all pending debounce timers
        Object.keys(this.debounceTimers).forEach(key => {
            clearTimeout(this.debounceTimers[key]);
        });
        this.debounceTimers = {};
    }
}

module.exports = FileWatcher;