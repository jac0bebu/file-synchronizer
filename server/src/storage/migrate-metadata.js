const fs = require('fs-extra');
const path = require('path');

const metadataDir = path.join(__dirname, 'metadata');
const legacyMetadataFile = path.join(metadataDir, 'metadata.json');
const altMetadataFile = path.join(metadataDir, 'file-metadata.json');
const filesDir = path.join(metadataDir, 'files');

// Add conflict migration paths
const legacyConflictsFile = path.join(metadataDir, 'conflicts.json');
const altConflictsFile = path.join(metadataDir, 'file-conflicts.json');
const conflictsDir = path.join(metadataDir, 'conflicts');

(async () => {
    try {
        // --- File metadata migration ---
        let sourceFile = null;
        if (await fs.pathExists(legacyMetadataFile)) {
            sourceFile = legacyMetadataFile;
        } else if (await fs.pathExists(altMetadataFile)) {
            sourceFile = altMetadataFile;
        }
        if (sourceFile) {
            await fs.ensureDir(filesDir);
            const legacyData = await fs.readJson(sourceFile);
            if (!Array.isArray(legacyData)) {
                console.error(`${path.basename(sourceFile)} is not an array.`);
            } else {
                let count = 0;
                for (const meta of legacyData) {
                    if (meta.fileId) {
                        const filePath = path.join(filesDir, `${meta.fileId}.json`);
                        await fs.writeJson(filePath, meta, { spaces: 2 });
                        count++;
                    }
                }
                console.log(`Migrated ${count} metadata entries to ${filesDir}`);
                await fs.move(sourceFile, sourceFile + '.bak', { overwrite: true });
                console.log(`Legacy ${path.basename(sourceFile)} backed up as ${path.basename(sourceFile)}.bak`);
            }
        } else {
            console.log('No legacy metadata.json or file-metadata.json found. Nothing to migrate.');
        }

        // --- Conflict migration ---
        let conflictSource = null;
        if (await fs.pathExists(legacyConflictsFile)) {
            conflictSource = legacyConflictsFile;
        } else if (await fs.pathExists(altConflictsFile)) {
            conflictSource = altConflictsFile;
        }
        if (conflictSource) {
            await fs.ensureDir(conflictsDir);
            const conflictData = await fs.readJson(conflictSource);
            if (!Array.isArray(conflictData)) {
                console.error(`${path.basename(conflictSource)} is not an array.`);
            } else {
                let count = 0;
                for (const conflict of conflictData) {
                    if (conflict.id) {
                        const conflictPath = path.join(conflictsDir, `${conflict.id}.json`);
                        await fs.writeJson(conflictPath, conflict, { spaces: 2 });
                        count++;
                    }
                }
                console.log(`Migrated ${count} conflict entries to ${conflictsDir}`);
                await fs.move(conflictSource, conflictSource + '.bak', { overwrite: true });
                console.log(`Legacy ${path.basename(conflictSource)} backed up as ${path.basename(conflictSource)}.bak`);
            }
        } else {
            console.log('No legacy conflicts.json or file-conflicts.json found. Nothing to migrate.');
        }
    } catch (err) {
        console.error('Migration error:', err);
    }
})();
