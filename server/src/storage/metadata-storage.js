const fs = require('fs-extra');
const path = require('path');

class MetadataStorage {
    constructor() {
        this.metadataPath = path.join(__dirname, 'metadata');
        this.dbFile = path.join(this.metadataPath, 'file-metadata.json');
        this.conflictsFile = path.join(this.metadataPath, 'conflicts.json');
        this.initPromise = this.init();
    }

    async init() {
        await fs.ensureDir(this.metadataPath);
        if (!await fs.pathExists(this.dbFile)) {
            await fs.writeJson(this.dbFile, []);
        }
        if (!await fs.pathExists(this.conflictsFile)) {
            await fs.writeJson(this.conflictsFile, []);
        }
    }

    async getAllMetadata() {
        await this.initPromise;
        return await fs.readJson(this.dbFile);
    }

    async saveMetadata(metadata) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        
        // Check for conflicts
        const conflict = await this.detectConflict(metadata);
        if (conflict) {
            await this.saveConflict(conflict); // Ensure conflict is saved
            // Optionally: Save the conflicted file's metadata here if needed
            // await this.saveMetadataForConflictedFile(metadata);
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
            chunks: metadata.chunks || null //
        };

        const existingIndex = allData.findIndex(item => 
            item.fileId === metadata.fileId && item.version === metadata.version
        );

        if (existingIndex >= 0) {
            allData[existingIndex] = { ...allData[existingIndex], ...newMetadata };
        } else {
            allData.push(newMetadata);
        }

        await fs.writeJson(this.dbFile, allData, { spaces: 2 });
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
        const conflicts = await fs.readJson(this.conflictsFile);
        // Prevent duplicate conflict id
        if (!conflicts.some(c => c.id === conflict.id)) {
            conflicts.push(conflict);
            await fs.writeJson(this.conflictsFile, conflicts, { spaces: 2 });
        }
    }

    async getConflicts() {
        await this.initPromise;
        return await fs.readJson(this.conflictsFile);
    }

    async resolveConflict(conflictId, resolution) {
        await this.initPromise;
        const conflicts = await fs.readJson(this.conflictsFile);
        const conflictIndex = conflicts.findIndex(c => c.id === conflictId);
        
        if (conflictIndex === -1) {
            throw new Error('Conflict not found');
        }
        
        conflicts[conflictIndex].status = 'resolved';
        conflicts[conflictIndex].resolution = resolution;
        conflicts[conflictIndex].resolvedAt = new Date().toISOString();
        
        await fs.writeJson(this.conflictsFile, conflicts, { spaces: 2 });
        return conflicts[conflictIndex];
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
        const allData = await this.getAllMetadata();
        return allData.find(item => item.fileId === fileId);
    }

    async deleteMetadata(fileId) {
        await this.initPromise;
        const allData = await this.getAllMetadata();
        const filtered = allData.filter(item => item.fileId !== fileId);
        await fs.writeJson(this.dbFile, filtered, { spaces: 2 });
    }

    async deleteMetadataByFileName(fileName) {
    await this.initPromise;
    const allData = await this.getAllMetadata();
    const filtered = allData.filter(item => item.fileName !== fileName);
    await fs.writeJson(this.dbFile, filtered, { spaces: 2 });
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
        for (let item of allData) {
            if (item.fileName === oldName) {
                item.fileName = newName;
                changed = true;
            }
        }
        if (changed) {
            await fs.writeJson(this.dbFile, allData, { spaces: 2 });
        }
        return changed;
    }
}

module.exports = new MetadataStorage();