const fs = require('fs-extra');
const path = require('path');

// Use shared storage directories from environment or fallback to default
const STORAGE_ROOT = process.env.SHARED_STORAGE_ROOT || path.join(__dirname, '../storage');
const METADATA_DIR = process.env.METADATA_DIR || path.join(STORAGE_ROOT, 'metadata');
const CONFLICTS_DIR = process.env.CONFLICTS_DIR || path.join(STORAGE_ROOT, 'conflicts');

// Ensure directories exist
fs.ensureDirSync(METADATA_DIR);
fs.ensureDirSync(CONFLICTS_DIR);

class MetadataStorage {
    constructor() {
        this.metadataPath = METADATA_DIR;
        this.filesDir = path.join(this.metadataPath, 'files');
        this.conflictsDir = path.join(this.metadataPath, 'conflicts'); // Use directory for conflicts
        this.initPromise = this.init();
    }

    async init() {
        await fs.ensureDir(this.metadataPath);
        await fs.ensureDir(this.filesDir);
        await fs.ensureDir(this.conflictsDir); // Ensure conflicts directory exists
    }

    async getAllMetadata() {
        await this.initPromise;
        const files = await fs.readdir(this.filesDir);
        const all = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                const meta = await fs.readJson(path.join(this.filesDir, file));
                all.push(meta);
            }
        }
        return all;
    }

    async saveMetadata(metadata) {
        await this.initPromise;
        // Check for conflicts
        const conflict = await this.detectConflict(metadata);
        if (conflict) {
            await this.saveConflict(conflict); // Ensure conflict is saved
            throw new Error(`Conflict detected: ${conflict.reason}`);
        }

        // Add versioning fields
        const now = new Date().toISOString();
        const newMetadata = {
            ...metadata,
            version: metadata.version || 1,
            createdAt: metadata.createdAt || now,
            updatedAt: now,
            size: metadata.size || 0,
            checksum: metadata.checksum || null,
            clientId: metadata.clientId || 'unknown',
            lastModified: metadata.lastModified || now,
            chunks: metadata.chunks || null
        };

        // Save as individual file
        const fileId = newMetadata.fileId;
        if (!fileId) throw new Error('fileId is required for metadata');
        await fs.writeJson(path.join(this.filesDir, `${fileId}.json`), newMetadata, { spaces: 2 });
        return newMetadata;
    }

    async detectConflict(incomingMetadata) {
        const latest = await this.getLatestVersion(incomingMetadata.fileName);
        
        if (!latest) return null; // No existing file, no conflict
        
        const timeDifference = new Date(incomingMetadata.lastModified) - new Date(latest.lastModified);
        const CONFLICT_THRESHOLD = 5000; // 5 seconds
        
        // Conflict scenarios
        if (Math.abs(timeDifference) < CONFLICT_THRESHOLD && 
            incomingMetadata.clientId !== latest.clientId &&
            incomingMetadata.checksum !== latest.checksum) {
            return {
                id: require('crypto').randomBytes(8).toString('hex'),
                fileName: incomingMetadata.fileName,
                reason: 'Simultaneous modification detected',
                conflictType: 'concurrent_modification',
                existing: latest,
                incoming: incomingMetadata,
                timestamp: new Date().toISOString(),
                status: 'unresolved'
            };
        }
        
        return null;
    }

    async saveConflict(conflict) {
        await this.initPromise;
        const conflictPath = path.join(this.conflictsDir, `${conflict.id}.json`);
        if (!(await fs.pathExists(conflictPath))) {
            await fs.writeJson(conflictPath, conflict, { spaces: 2 });
        }
    }

    async getConflicts() {
        await this.initPromise;
        const files = await fs.readdir(this.conflictsDir);
        const all = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                const conflict = await fs.readJson(path.join(this.conflictsDir, file));
                all.push(conflict);
            }
        }
        return all;
    }

    async resolveConflict(conflictId, resolution) {
        await this.initPromise;
        const conflictPath = path.join(this.conflictsDir, `${conflictId}.json`);
        if (!(await fs.pathExists(conflictPath))) {
            throw new Error('Conflict not found');
        }
        const conflict = await fs.readJson(conflictPath);
        conflict.status = 'resolved';
        conflict.resolution = resolution;
        conflict.resolvedAt = new Date().toISOString();
        await fs.writeJson(conflictPath, conflict, { spaces: 2 });
        return conflict;
    }

    async getLatestVersion(fileName) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        const fileVersions = allData.filter(item => item.fileName === fileName);
        
        if (fileVersions.length === 0) return null;
        
        return fileVersions.reduce((latest, current) => 
            current.version > latest.version ? current : latest
        );
    }

    async getAllVersions(fileName) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        return allData
            .filter(item => item.fileName === fileName)
            .sort((a, b) => b.version - a.version);
    }

    async getMetadata(fileId) {
        await this.initPromise;
        const filePath = path.join(this.filesDir, `${fileId}.json`);
        if (await fs.pathExists(filePath)) {
            return await fs.readJson(filePath);
        }
        return null;
    }

    async deleteMetadata(fileId) {
        await this.initPromise;
        const filePath = path.join(this.filesDir, `${fileId}.json`);
        if (await fs.pathExists(filePath)) {
            await fs.remove(filePath);
        }
    }

    async deleteMetadataByFileName(fileName) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        for (const meta of allData) {
            if (meta.fileName === fileName) {
                const filePath = path.join(this.filesDir, `${meta.fileId}.json`);
                if (await fs.pathExists(filePath)) {
                    await fs.remove(filePath);
                }
            }
        }
        return true;
    }

    async getNextVersion(fileName) {
        const latest = await this.getLatestVersion(fileName);
        return latest ? latest.version + 1 : 1;
    }

    async renameFileMetadata(oldName, newName) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        let changed = false;
        for (const meta of allData) {
            if (meta.fileName === oldName) {
                meta.fileName = newName;
                await fs.writeJson(path.join(this.filesDir, `${meta.fileId}.json`), meta, { spaces: 2 });
                changed = true;
            }
        }
        return changed;
    }
}

module.exports = new MetadataStorage();

// --- One-time migration script for legacy metadata.json and conflicts.json ---
(async () => {
    const fs = require('fs-extra');
    const path = require('path');
    const metadataBase = path.join(__dirname, 'metadata');
    const legacyMetadataFile = path.join(metadataBase, 'metadata.json');
    const filesDir = path.join(metadataBase, 'files');
    const legacyConflictsFile = path.join(metadataBase, 'conflicts.json');
    const conflictsDir = path.join(metadataBase, 'conflicts');
    try {
        // Migrate metadata.json to files/
        if (await fs.pathExists(legacyMetadataFile)) {
            const files = await fs.readdir(filesDir);
            if (files.length === 0) {
                const legacyData = await fs.readJson(legacyMetadataFile);
                if (Array.isArray(legacyData)) {
                    for (const meta of legacyData) {
                        if (meta.fileId) {
                            const filePath = path.join(filesDir, `${meta.fileId}.json`);
                            await fs.writeJson(filePath, meta, { spaces: 2 });
                        }
                    }
                    console.log(`[metadata-storage] Migrated ${legacyData.length} metadata entries to per-file JSON files.`);
                    await fs.move(legacyMetadataFile, legacyMetadataFile + '.bak', { overwrite: true });
                }
            }
        }
        // Migrate conflicts.json to conflicts/
        if (await fs.pathExists(legacyConflictsFile)) {
            await fs.ensureDir(conflictsDir);
            const files = await fs.readdir(conflictsDir);
            if (files.length === 0) {
                const legacyConflicts = await fs.readJson(legacyConflictsFile);
                if (Array.isArray(legacyConflicts)) {
                    for (const conflict of legacyConflicts) {
                        if (conflict.id) {
                            const conflictPath = path.join(conflictsDir, `${conflict.id}.json`);
                            await fs.writeJson(conflictPath, conflict, { spaces: 2 });
                        }
                    }
                    console.log(`[metadata-storage] Migrated ${legacyConflicts.length} conflicts to per-file JSON files.`);
                    await fs.move(legacyConflictsFile, legacyConflictsFile + '.bak', { overwrite: true });
                }
            }
        }
    } catch (err) {
        console.error('[metadata-storage] Migration error:', err);
    }
})();