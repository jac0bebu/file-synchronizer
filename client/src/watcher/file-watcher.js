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
        this.isIgnoring = false; // Add this flag
        this.ignoredFiles = new Set(); // Track files being downloaded
        
        console.log(`File watcher initialized for folder: ${this.syncFolder}`.cyan);
    }

    // Add method to ignore specific files during downloads
    ignoreFile(fileName) {
        this.ignoredFiles.add(fileName);
        console.log(`Ignoring file watcher events for: ${fileName}`.gray);
    }

    // Add method to stop ignoring files
    unignoreFile(fileName) {
        this.ignoredFiles.delete(fileName);
        console.log(`Resuming file watcher events for: ${fileName}`.gray);
    }

    // Add method to pause all file watching
    pause() {
        this.isIgnoring = true;
        console.log('File watcher paused'.yellow);
    }

    // Add method to resume file watching
    resume() {
        this.isIgnoring = false;
        console.log('File watcher resumed'.yellow);
    }

    start() {
        this.watcher = chokidar.watch(this.syncFolder, {
            ignored: /[\/\\]\./, // ignore dotfiles
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 1000,
                pollInterval: 100
            }
        });

        this.watcher.on('add', (filePath) => {
            this.handleFileEvent(filePath, 'add');
        });

        this.watcher.on('change', (filePath) => {
            this.handleFileEvent(filePath, 'change');
        });

        this.watcher.on('unlink', (filePath) => {
            this.handleFileEvent(filePath, 'delete');
        });

        console.log('File watcher started successfully'.green);
    }

    handleFileEvent(filePath, eventType) {
        // Skip if file watching is paused
        if (this.isIgnoring) {
            console.log(`Ignoring ${eventType} event for ${path.basename(filePath)} (watcher paused)`.gray);
            return;
        }
        const fileName = path.basename(filePath);
        if (!fileName) {
            console.warn('File watcher event missing fileName, skipping:', filePath, eventType);
            return;
        }
        // Skip if this specific file is being ignored
        if (this.ignoredFiles.has(fileName)) {
            console.log(`Ignoring ${eventType} event for ${fileName} (file being downloaded)`.gray);
            return;
        }

        // Clear existing debounce timer
        if (this.debounceTimers[filePath]) {
            clearTimeout(this.debounceTimers[filePath]);
        }

        // Set new debounce timer
        this.debounceTimers[filePath] = setTimeout(() => {
            console.log(`File event: ${eventType} - ${fileName}`.cyan);
            this.onChange(filePath, eventType);
            delete this.debounceTimers[filePath];
        }, this.debounceMs);
    }

    stop() {
        if (this.watcher) {
            this.watcher.close();
            console.log('File watcher stopped'.red);
        }
    }
}

module.exports = FileWatcher;