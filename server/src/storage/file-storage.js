const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');

// Use shared storage directories from environment or fallback to default
const FILES_DIR = process.env.FILES_DIR || path.join(__dirname, '../storage/files');
const VERSIONS_DIR = process.env.VERSIONS_DIR || path.join(__dirname, '../storage/versions');

// Ensure directories exist
fs.ensureDirSync(FILES_DIR);
fs.ensureDirSync(VERSIONS_DIR);

class FileStorage {
    constructor() {
        this.storagePath = FILES_DIR;
        this.versionsPath = VERSIONS_DIR;
        this.ensureDirectories();
    }

    async ensureDirectories() {
        await fs.ensureDir(this.storagePath);
        await fs.ensureDir(this.versionsPath);
    }

    async saveFile(fileName, fileBuffer, version = 1) {
        await this.ensureDirectories();
        
        // Save current version
        const filePath = path.join(this.storagePath, fileName);
        await fs.writeFile(filePath, fileBuffer);
        
        // Save versioned copy
        const versionedPath = path.join(this.versionsPath, `${fileName}.v${version}`);
        await fs.writeFile(versionedPath, fileBuffer);
        
        return {
            filePath,
            versionedPath,
            checksum: this.calculateChecksum(fileBuffer),
            size: fileBuffer.length
        };
    }

    async getFile(fileName, version = null) {
        if (version) {
            const versionedPath = path.join(this.versionsPath, `${fileName}.v${version}`);
            if (await fs.pathExists(versionedPath)) {
                return await fs.readFile(versionedPath);
            }
            throw new Error(`Version ${version} of file ${fileName} not found`);
        }
        
        const filePath = path.join(this.storagePath, fileName);
        if (!(await fs.pathExists(filePath))) {
            throw new Error('File not found');
        }
        return await fs.readFile(filePath);
    }

    async fileExists(fileName) {
        const filePath = path.join(this.storagePath, fileName);
        return fs.pathExists(filePath);
    }

    async deleteFile(fileName, version = null, deleteAllVersions = false) {
        // If version specified, delete just that version
        if (version) {
            const versionedPath = path.join(this.versionsPath, `${fileName}.v${version}`);
            if (await fs.pathExists(versionedPath)) {
                await fs.remove(versionedPath);
                return true;
            }
            return false;
        } 
        // Delete main file
        else {
            const filePath = path.join(this.storagePath, fileName);
            const fileExists = await fs.pathExists(filePath);
            
            if (fileExists) {
                await fs.remove(filePath);
                
                // Optionally delete all versions
                if (deleteAllVersions) {
                    const versions = await this.listVersions(fileName);
                    for (const version of versions) {
                        const versionedPath = path.join(this.versionsPath, version.file);
                        await fs.remove(versionedPath);
                    }
                }
                
                return true;
            }
            return false;
        }
    }

    async listFiles() {
        await this.ensureDirectories();
        return await fs.readdir(this.storagePath);
    }

    async listVersions(fileName) {
        await this.ensureDirectories();
        const allFiles = await fs.readdir(this.versionsPath);
        return allFiles
            .filter(f => f.startsWith(`${fileName}.v`))
            .map(f => {
                const version = f.split('.v')[1];
                return { fileName, version: parseInt(version), file: f };
            })
            .sort((a, b) => b.version - a.version);
    }

    calculateChecksum(buffer) {
        return crypto.createHash('md5').update(buffer).digest('hex');
    }

    async renameFile(oldName, newName) {
        await this.ensureDirectories();
        // Rename main file
        const oldPath = path.join(this.storagePath, oldName);
        const newPath = path.join(this.storagePath, newName);
        if (await fs.pathExists(oldPath)) {
            await fs.move(oldPath, newPath, { overwrite: true });
        }
        // Rename all versioned files
        const allVersions = await this.listVersions(oldName);
        for (const version of allVersions) {
            const oldVersionPath = path.join(this.versionsPath, version.file);
            const newVersionFile = `${newName}.v${version.version}`;
            const newVersionPath = path.join(this.versionsPath, newVersionFile);
            await fs.move(oldVersionPath, newVersionPath, { overwrite: true });
        }
        return true;
    }
}

module.exports = new FileStorage();