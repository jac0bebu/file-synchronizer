// src/workers/chunk-alerter.js
const { v4: uuidv4 } = require('uuid');
const metadataStorage = require('../storage/metadata-storage');
const queueManager = require('../queues/queue-manager');

class ChunkAlerter {
    async process(data) {
        console.log('Processing chunk alert:', data);

        try {
            // Create metadata entry
            const metadata = {
                fileId: data.fileId || uuidv4(),
                fileName: data.fileName || 'unknown',
                chunkId: data.chunkId || 'unknown',
                timestamp: new Date().toISOString(),
                status: 'pending',
                alertProcessedAt: new Date().toISOString()
            };

            // Save metadata
            await metadataStorage.saveMetadata(metadata);

            // Send to file processing queue
            await queueManager.addFileJob({
                fileId: metadata.fileId,
                action: 'process_chunk',
                chunkId: data.chunkId,
                fileName: data.fileName
            });

            return { success: true, fileId: metadata.fileId };
        } catch (error) {
            console.error('Chunk Alerter Error:', error);
            throw error;
        }
    }
}

module.exports = new ChunkAlerter();