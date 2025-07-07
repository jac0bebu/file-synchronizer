const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const queueManager = require('../queues/queue-manager');
const fileStorage = require('../storage/file-storage');
const metadataStorage = require('../storage/metadata-storage');
const chunkDir = path.join(__dirname, '../storage/chunks');
fs.ensureDirSync(chunkDir);

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json()); // This line might be missing
app.use(express.urlencoded({ extended: true }));

// Configure multer for file uploads (memory storage)
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 10MB limit
});

// Configure multer for file uploads (disk storage)
const uploadDisk = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100 MB
});

// Health check endpoint
app.get('/health', (req, res) => {
  try {
    // Create a simple health response without using queueManager
    const health = {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    };
    
    // Only add queue stats if the function exists
    if (typeof queueManager !== 'undefined' && queueManager && typeof queueManager.getQueueStats === 'function') {
      health.queues = queueManager.getQueueStats();
    }
    
    res.json(health);
  } catch (error) {
    console.error('Health check error:', error);
    // Still return 200 OK for the client to work
    res.status(200).json({ 
      status: 'degraded',
      message: 'Health check partial failure',
      error: error.message
    });
  }
});

// Upload file endpoint (POST /files)
app.post('/files', upload.single('file'), async (req, res) => {
    try {
        let fileData;

        if (req.file) {
            // File uploaded via multipart/form-data
            fileData = {
                fileId: req.body.fileId || null,
                fileName: req.file.originalname,
                fileContent: req.file.buffer.toString('base64'),
                action: 'upload_file'
            };
        } else if (req.body.fileName && req.body.fileContent) {
            // File uploaded via JSON
            fileData = req.body;
        } else {
            return res.status(400).json({ error: 'No file provided' });
        }

        // Add to file processing queue
        const job = await queueManager.addFileJob(fileData);

        res.json({
            success: true,
            message: 'File queued for processing',
            jobId: job.id,
            fileName: fileData.fileName
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/files/chunk', upload.single('chunk'), async (req, res) => {
    try {
        const { fileId, chunkNumber, totalChunks, fileName, clientId, lastModified } = req.body;
        if (!fileId || !chunkNumber || !totalChunks || !fileName || !req.file) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Save the chunk to disk
        const chunkPath = path.join(chunkDir, `${fileId}_${chunkNumber}`);
        await fs.writeFile(chunkPath, req.file.buffer);

        // Check if all chunks are uploaded
        const uploadedChunks = await fs.readdir(chunkDir);
        const chunksForFile = uploadedChunks.filter(f => f.startsWith(`${fileId}_`));
        if (chunksForFile.length == Number(totalChunks)) {
            // Assemble the file
            const fileBuffers = [];
            for (let i = 1; i <= Number(totalChunks); i++) {
                const chunkPath = path.join(chunkDir, `${fileId}_${i}`);
                if (!(await fs.pathExists(chunkPath))) {
                    throw new Error(`Missing chunk file: ${chunkPath}`);
                }
                const part = await fs.readFile(chunkPath);
                if (!part || part.length === 0) {
                    throw new Error(`Corrupt or empty chunk: ${chunkPath}`);
                }
                fileBuffers.push(part);
            }
            const completeBuffer = Buffer.concat(fileBuffers);
            
            try {
                // Get next version
                const nextVersion = await metadataStorage.getNextVersion(fileName);
                
                // Save with version
                const saveResult = await fileStorage.saveFile(fileName, completeBuffer, nextVersion);
                
                // Save metadata with conflict detection
                try {
                    await metadataStorage.saveMetadata({
                        fileId,
                        fileName,
                        version: nextVersion,
                        size: saveResult.size,
                        checksum: saveResult.checksum,
                        clientId: clientId, // <-- always use provided clientId
                        lastModified: lastModified || new Date().toISOString()
                    });
                } catch (conflictError) {
                    if (conflictError.message.includes('Conflict detected')) {
                        return res.status(409).json({
                            success: false,
                            error: 'Conflict detected',
                            message: conflictError.message,
                            action: 'resolve_conflict'
                        });
                    } else {
                        // Log and return a 500 for other errors
                        console.error('Metadata save error:', conflictError);
                        return res.status(500).json({ error: conflictError.message });
                    }
                }

                // Clean up chunks
                for (let i = 1; i <= Number(totalChunks); i++) {
                    await fs.remove(path.join(chunkDir, `${fileId}_${i}`));
                }

                res.json({ 
                    success: true, 
                    message: `File assembled and saved as version ${nextVersion}.`,
                    version: nextVersion
                });
                
            } catch (conflictError) {
                if (conflictError.message.includes('Conflict detected')) {
                    res.status(409).json({
                        success: false,
                        error: 'Conflict detected',
                        message: conflictError.message,
                        action: 'resolve_conflict'
                    });
                } else {
                    throw conflictError;
                }
            }
        } else {
            res.json({ success: true, message: `Chunk ${chunkNumber} uploaded.` });
        }
    } catch (error) {
        console.error('Chunk upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get file metadata (GET /files/:fileId/metadata)
app.get('/files/:fileId/metadata', async (req, res) => {
    try {
        const metadata = await metadataStorage.getMetadata(req.params.fileId);
        if (!metadata) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.json(metadata);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download file (GET /files/:fileName/download)
app.get('/files/:fileName/download', async (req, res) => {
    try {
        const fileBuffer = await fileStorage.getFile(req.params.fileName);
        if (!fileBuffer) {
            return res.status(404).json({ error: 'File not found' });
        }
        res.setHeader('Content-Disposition', `attachment; filename="${req.params.fileName}"`);
        res.send(fileBuffer);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// List all files (GET /files)
app.get('/files', async (req, res) => {
    try {
        const files = await fileStorage.listFiles();
        const metadata = await metadataStorage.getAllMetadata();
        
        const fileList = files.map(fileName => {
            // Get the LATEST version metadata for each file
            const fileMetadata = metadata
                .filter(m => m.fileName === fileName)
                .sort((a, b) => b.version - a.version); // Sort by version descending
            
            const latestMeta = fileMetadata[0]; // Get the highest version
            
            return {
                name: fileName,
                lastModified: latestMeta?.lastModified || latestMeta?.updatedAt,
                size: latestMeta?.size,
                version: latestMeta?.version,  // This should show the latest version
                clientId: latestMeta?.clientId,
                totalVersions: fileMetadata.length
            };
        });

        console.log('Listing files with latest versions:', fileList);
        res.json({ files: fileList });
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).json({ error: error.message });
    }
});

// Trigger chunk alert (POST /alerts/chunk)
app.post('/alerts/chunk', async (req, res) => {
    try {
        const job = await queueManager.addAlertJob(req.body);
        res.json({
            success: true,
            message: 'Chunk alert queued',
            jobId: job.id
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Default root endpoint
app.get('/', (req, res) => {
    res.send('File Synchronizer API is running!');
});

app.get('/files/:fileName/versions', async (req, res) => {
    try {
        const versions = await metadataStorage.getAllVersions(req.params.fileName);
        res.json(versions);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Download specific version
app.get('/files/:fileName/versions/:version/download', async (req, res) => {
    try {
        const { fileName, version } = req.params;
        const fileBuffer = await fileStorage.getFile(fileName, parseInt(version));
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}.v${version}"`);
        res.send(fileBuffer);
    } catch (error) {
        res.status(404).json({ error: error.message });
    }
});

app.get('/conflicts', async (req, res) => {
    try {
        const conflicts = await metadataStorage.getConflicts();
        res.json(conflicts);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Resolve a conflict
app.post('/conflicts/:conflictId/resolve', async (req, res) => {
    try {
        const { conflictId } = req.params;
        const { resolution, keepVersion } = req.body;
        
        if (!resolution) {
            return res.status(400).json({ error: 'Resolution method required' });
        }
        
        const resolvedConflict = await metadataStorage.resolveConflict(conflictId, {
            method: resolution,
            keepVersion: keepVersion,
            resolvedBy: req.body.clientId || 'manual'
        });
        
        res.json({
            success: true,
            message: 'Conflict resolved successfully',
            conflict: resolvedConflict
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Add a simple in-memory map to track recent uploads within the sync interval
const recentUploads = new Map();
const SYNC_INTERVAL_MS = 10000; // 10 seconds

// Upload with conflict detection (overwrite this endpoint)
app.post('/files/upload-safe', upload.single('file'), async (req, res) => {
    try {
        const { fileName, clientId, lastModified } = req.body;
        if (!req.file || !fileName || !clientId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const fileBuffer = req.file.buffer;
        const checksum = require('crypto').createHash('md5').update(fileBuffer).digest('hex');
        const now = Date.now();

        // Prepare metadata for conflict detection
        const metadata = {
            fileId: require('crypto').randomBytes(8).toString('hex'),
            fileName,
            clientId, // <-- always use provided clientId
            lastModified: lastModified || new Date().toISOString(),
            size: fileBuffer.length,
            checksum
        };

        // --- NEW: Check if latest version already has this checksum ---
        // Get all versions for this file
        const allVersions = await metadataStorage.getAllVersions(fileName);
        if (allVersions && allVersions.length > 0) {
            // Find the latest version (highest version number)
            const latestMeta = allVersions.reduce((a, b) => (a.version > b.version ? a : b));
            if (latestMeta && latestMeta.checksum === checksum) {
                // Already up-to-date, do not create new version
                res.json({
                    success: true,
                    message: 'File already up-to-date, no new version created',
                    version: latestMeta.version,
                    metadata: latestMeta
                });
                return;
            }
        }
        // --- END NEW ---

        // Clean up old entries
        for (const [key, arr] of recentUploads.entries()) {
            recentUploads.set(key, arr.filter(entry => now - entry.timestamp <= SYNC_INTERVAL_MS));
            if (recentUploads.get(key).length === 0) recentUploads.delete(key);
        }

        // Key by fileName
        const key = fileName;
        if (!recentUploads.has(key)) {
            recentUploads.set(key, []);
        }
        const arr = recentUploads.get(key);

        // Check if any upload for this file in the interval
        let winner = null;
        let isConflict = false;
        let losers = [];
        // Find if any previous upload is within the interval and has different checksum
        for (const entry of arr) {
            if (entry.clientId !== clientId && entry.checksum !== checksum) {
                isConflict = true;
            }
        }

        // --- Prevent duplicate conflict for same set of clients/checksums ---
        // Compose a unique conflict key for this set
        let conflictKey = null;
        if (isConflict) {
            // All unique clientId+checksum pairs in this conflict
            let allCandidates = [
                ...arr.map(entry => ({ clientId: entry.clientId, checksum: entry.checksum })),
                { clientId, checksum }
            ];
            allCandidates = allCandidates.filter((entry, idx, self) =>
                idx === self.findIndex(e => e.clientId === entry.clientId && e.checksum === entry.checksum)
            );
            // Sort for stable key
            allCandidates.sort((a, b) => (a.clientId + a.checksum).localeCompare(b.clientId + b.checksum));
            conflictKey = fileName + ':' + allCandidates.map(e => `${e.clientId}:${e.checksum}`).join('|');
            // Store conflictKey in recentUploads to prevent duplicate
            if (!recentUploads.conflictKeys) recentUploads.conflictKeys = new Set();
            if (recentUploads.conflictKeys.has(conflictKey)) {
                // Already processed this conflict, just respond as before but do not create new versions/conflict files
                // Find winner/losers as before for response
                let allCandidatesFull = [
                    ...arr.map(entry => ({ ...entry })),
                    { ...metadata, buffer: fileBuffer, timestamp: now }
                ];
                allCandidatesFull = allCandidatesFull.filter((entry, idx, self) =>
                    idx === self.findIndex(e => e.clientId === entry.clientId && e.checksum === entry.checksum)
                );
                allCandidatesFull.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());
                winner = allCandidatesFull[0];
                losers = allCandidatesFull.slice(1);

                // If this client is a loser, notify with all conflict info
                const isCurrentLoser = losers.some(l => l.clientId === clientId && l.checksum === checksum);
                if (isCurrentLoser) {
                    res.status(409).json({
                        success: false,
                        error: 'Conflict detected',
                        message: `Conflict detected: "${fileName}" was modified by multiple clients at nearly the same time. The version from "${winner.clientId}" was kept. Your version was saved as a conflict file.`,
                        conflict: {
                            fileName,
                            winner: {
                                clientId: winner.clientId,
                                lastModified: winner.lastModified
                            },
                            losers: losers.map(l => ({
                                clientId: l.clientId,
                                lastModified: l.lastModified
                            })),
                            conflictId: 'already-exists'
                        },
                        action: 'resolve_conflict'
                    });
                    return;
                }
                // If this client is the winner, return success
                res.json({
                    success: true,
                    message: `File uploaded successfully as the fastest client. Other conflicting clients: ${losers.map(l => l.clientId).join(', ')}`,
                    version: undefined,
                    metadata: {},
                    conflictId: 'already-exists'
                });
                return;
            }
            // Mark this conflictKey as processed
            recentUploads.conflictKeys.add(conflictKey);
        }

        if (!isConflict) {
            // No conflict, save as normal
            const nextVersion = await metadataStorage.getNextVersion(fileName);
            metadata.version = nextVersion;
            const saveResult = await fileStorage.saveFile(fileName, fileBuffer, nextVersion);
            const savedMetadata = await metadataStorage.saveMetadata({
                ...metadata,
                size: saveResult.size,
                checksum: saveResult.checksum,
                lastUpdated: new Date().toISOString()
            });
            arr.push({
                ...metadata,
                buffer: fileBuffer,
                timestamp: now
            });
            res.json({
                success: true,
                message: 'File uploaded successfully',
                version: nextVersion,
                metadata: savedMetadata
            });
            return;
        }

        // There is a conflict: find the winner (earliest timestamp)
        let allCandidates = [
            ...arr.map(entry => ({ ...entry })),
            { ...metadata, buffer: fileBuffer, timestamp: now }
        ];
        // Only consider unique clientId+checksum pairs
        allCandidates = allCandidates.filter((entry, idx, self) =>
            idx === self.findIndex(e => e.clientId === entry.clientId && e.checksum === entry.checksum)
        );
        allCandidates.sort((a, b) => new Date(a.lastModified).getTime() - new Date(b.lastModified).getTime());
        winner = allCandidates[0];
        losers = allCandidates.slice(1);

        // --- NEW: Only create a new version for the winner if its checksum is not already the latest ---
        // Get all versions for this file again (in case of race)
        const allVersionsAfter = await metadataStorage.getAllVersions(fileName);
        let winnerVersion = null;
        let winnerMeta = null; // <-- ensure this is always set
        if (allVersionsAfter && allVersionsAfter.length > 0) {
            const latestMeta = allVersionsAfter.reduce((a, b) => (a.version > b.version ? a : b));
            if (latestMeta && latestMeta.checksum === require('crypto').createHash('md5').update(winner.buffer).digest('hex')) {
                winnerVersion = latestMeta.version;
                winnerMeta = latestMeta;
            }
        }
        if (!winnerVersion) {
            // Save the winner as the main file (new version)
            const nextVersion = await metadataStorage.getNextVersion(fileName);
            await fileStorage.saveFile(fileName, winner.buffer, nextVersion);
            winnerMeta = await metadataStorage.saveMetadata({
                fileId: winner.fileId,
                fileName,
                version: nextVersion,
                size: winner.size,
                checksum: require('crypto').createHash('md5').update(winner.buffer).digest('hex'),
                clientId: winner.clientId,
                lastModified: winner.lastModified,
                lastUpdated: new Date().toISOString()
            });
            winner.version = nextVersion;
            winner.meta = winnerMeta;
            winnerVersion = nextVersion;
        } else {
            // Already exists, get the metadata for response
            winner.meta = winnerMeta;
            winner.version = winnerVersion;
        }
        // Save each loser as a conflict file
        const loserMetas = [];
        for (const loser of losers) {
            const conflictFileName = `${fileName.replace(/(\.[^\.]+)?$/, '')}_conflicted_by_${loser.clientId}${require('path').extname(fileName)}`;
            const conflictVersion = await metadataStorage.getNextVersion(conflictFileName);
            await fileStorage.saveFile(conflictFileName, loser.buffer, conflictVersion);
            const loserMeta = await metadataStorage.saveMetadata({
                fileId: loser.fileId,
                fileName: conflictFileName,
                version: conflictVersion,
                size: loser.size,
                checksum: require('crypto').createHash('md5').update(loser.buffer).digest('hex'),
                clientId: loser.clientId,
                lastModified: loser.lastModified,
                conflict: true,
                conflictedWith: fileName
            });
            loserMetas.push({
                ...loserMeta,
                conflictFileName
            });
            // Update recentUploads for conflict file
            if (!recentUploads.has(conflictFileName)) recentUploads.set(conflictFileName, []);
            recentUploads.get(conflictFileName).push({
                ...loser,
                buffer: loser.buffer,
                timestamp: now
            });
        }

        // Update recentUploads for winner
        arr.push({
            ...winner,
            buffer: winner.buffer,
            timestamp: now
        });

        // --- Save conflict entry for all clients involved ---
        const conflictEntry = {
            id: require('crypto').randomBytes(8).toString('hex'),
            fileName,
            reason: 'Simultaneous modification detected',
            conflictType: 'multi_client_concurrent_modification',
            winner: winnerMeta ? {
                fileId: winnerMeta.fileId,
                fileName: winnerMeta.fileName,
                clientId: winnerMeta.clientId,
                lastModified: winnerMeta.lastModified,
                size: winnerMeta.size,
                checksum: winnerMeta.checksum,
                version: winnerMeta.version,
                createdAt: winnerMeta.createdAt,
                updatedAt: winnerMeta.updatedAt
            } : {},
            losers: loserMetas.map(meta => ({
                fileId: meta.fileId,
                fileName: meta.fileName,
                clientId: meta.clientId,
                lastModified: meta.lastModified,
                size: meta.size,
                checksum: meta.checksum,
                version: meta.version,
                conflictFileName: meta.conflictFileName,
                createdAt: meta.createdAt,
                updatedAt: meta.updatedAt
            })),
            allClients: [winnerMeta ? winnerMeta.clientId : winner.clientId, ...loserMetas.map(meta => meta.clientId)],
            timestamp: new Date().toISOString(),
            status: 'unresolved'
        };
        await metadataStorage.saveConflict(conflictEntry);

        // If this client is a loser, notify with all conflict info
        const isCurrentLoser = losers.some(l => l.clientId === clientId && l.checksum === checksum);
        if (isCurrentLoser) {
            const myMeta = loserMetas.find(meta => meta.clientId === clientId);
            res.status(409).json({
                success: false,
                error: 'Conflict detected',
                message: `Conflict detected: "${fileName}" was modified by multiple clients at nearly the same time. The version from "${winner.meta.clientId}" (saved at ${winner.meta.lastModified}) was kept. Your version was saved as a conflict file. Other conflicting clients: ${loserMetas.filter(l => l.clientId !== clientId).map(l => l.clientId).join(', ')}`,
                conflict: {
                    fileName,
                    winner: {
                        clientId: winner.meta.clientId,
                        lastModified: winner.meta.lastModified
                    },
                    losers: loserMetas.map(l => ({
                        clientId: l.clientId,
                        lastModified: l.lastModified
                    })),
                    conflictFileName: myMeta ? myMeta.conflictFileName : undefined,
                    conflictId: conflictEntry.id
                },
                action: 'resolve_conflict'
            });
            return;
        }

        // If this client is the winner, return success
        res.json({
            success: true,
            message: `File uploaded successfully as the fastest client. Other conflicting clients: ${loserMetas.map(l => l.clientId).join(', ')}`,
            version: winner.version,
            metadata: {
                ...winner.meta,
                version: winner.version
            },
            conflictId: conflictEntry.id
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Check your server.js file for the delete endpoint
app.delete('/files/:fileName', async (req, res) => {
    try {
        const fileName = decodeURIComponent(req.params.fileName);
        console.log(`DELETE request for file: ${fileName}`);
        
        // Delete from storage
        const deleted = await fileStorage.deleteFile(fileName);
        
        if (deleted) {
            // Force a brief delay to ensure file is completely removed
            await new Promise(resolve => setTimeout(resolve, 100));
            
            console.log(`Successfully deleted ${fileName} from server`);
            res.json({ success: true, message: `File ${fileName} deleted successfully` });
        } else {
            res.status(404).json({ success: false, message: 'File not found' });
        }
    } catch (error) {
        console.error('Delete file error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/files/:fileName/restore/:version', async (req, res) => {
    try {
        const { fileName, version } = req.params;
        // Get the buffer for the specified version
        const fileBuffer = await fileStorage.getFile(fileName, parseInt(version));
        if (!fileBuffer) {
            return res.status(404).json({ error: 'File version not found' });
        }
        // Get next version number
        const nextVersion = await metadataStorage.getNextVersion(fileName);
        // Save as new version
        const saveResult = await fileStorage.saveFile(fileName, fileBuffer, nextVersion);
        // Save new metadata
        const restoredMeta = await metadataStorage.saveMetadata({
            fileId: require('crypto').randomBytes(8).toString('hex'),
            fileName,
            version: nextVersion,
            size: saveResult.size,
            checksum: saveResult.checksum,
            clientId: req.body?.clientId || 'restore',
            lastModified: new Date().toISOString(),
            restoredFrom: version
        });
        res.json({
            success: true,
            message: `Version ${version} restored as version ${nextVersion}`,
            version: nextVersion,
            metadata: restoredMeta
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rename file (POST /files/:oldName/rename)
app.post('/files/:oldName/rename', async (req, res) => {
    try {
        const oldName = decodeURIComponent(req.params.oldName);
        const { newName } = req.body;
        if (!newName) {
            return res.status(400).json({ error: 'New file name required' });
        }
        await fileStorage.renameFile(oldName, newName);
        await metadataStorage.renameFileMetadata(oldName, newName);
        res.json({ success: true, message: `File renamed from ${oldName} to ${newName}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Helper to get local IP address
function getLocalIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

// Start server
app.listen(port, '0.0.0.0', () => {
    const ip = getLocalIp();
    console.log(`File Sync API running at http://${ip}:${port}`);
    console.log(`Health check: http://${ip}:${port}/health`);
});

module.exports = app;

app.post('/upload', upload.single('file'), (req, res) => {
  res.send('File uploaded!');
}, (err, req, res, next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).send('File too large');
  }
  next(err);
});