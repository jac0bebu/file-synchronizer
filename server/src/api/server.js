const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');

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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
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
                const part = await fs.readFile(path.join(chunkDir, `${fileId}_${i}`));
                fileBuffers.push(part);
            }
            const completeBuffer = Buffer.concat(fileBuffers);
            
            try {
                // Get next version
                const nextVersion = await metadataStorage.getNextVersion(fileName);
                
                // Save with version
                const saveResult = await fileStorage.saveFile(fileName, completeBuffer, nextVersion);
                
                // Save metadata with conflict detection
                await metadataStorage.saveMetadata({
                    fileId,
                    fileName,
                    version: nextVersion,
                    size: saveResult.size,
                    checksum: saveResult.checksum,
                    clientId: clientId || 'unknown',
                    lastModified: lastModified || new Date().toISOString()
                });

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

// Upload with conflict detection
app.post('/files/upload-safe', upload.single('file'), async (req, res) => {
    try {
        const { fileName, clientId, lastModified } = req.body;
        
        if (!req.file || !fileName || !clientId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const fileBuffer = req.file.buffer;
        const checksum = require('crypto').createHash('md5').update(fileBuffer).digest('hex');
        
        // Prepare metadata for conflict detection
        const metadata = {
            fileId: require('crypto').randomBytes(8).toString('hex'),
            fileName,
            clientId,
            lastModified: lastModified || new Date().toISOString(),
            size: fileBuffer.length,
            checksum
        };
        
        try {
            // Get next version
            const nextVersion = await metadataStorage.getNextVersion(fileName);
            metadata.version = nextVersion;
            
            // Save with conflict detection
            const saveResult = await fileStorage.saveFile(fileName, fileBuffer, nextVersion);
            const savedMetadata = await metadataStorage.saveMetadata({
                ...metadata,
                size: saveResult.size,
                checksum: saveResult.checksum
            });
            
            res.json({
                success: true,
                message: 'File uploaded successfully',
                version: nextVersion,
                metadata: savedMetadata
            });
            
        } catch (conflictError) {
            // Handle conflict
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
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/files/:fileName', async (req, res) => {
    try {
        const fileName = decodeURIComponent(req.params.fileName);
        console.log(`DELETE request for file: ${fileName}`);
        
        // Delete from file storage
        const deleted = await fileStorage.deleteFile(fileName);
        
        if (deleted) {
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

// Start server
app.listen(port, () => {
    console.log(`File Sync API running at http://localhost:${port}`);
    console.log(`Health check: http://localhost:${port}/health`);
});

module.exports = app;