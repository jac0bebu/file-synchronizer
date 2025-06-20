// src/workers/file-processor.js
const fileStorage = require('../storage/file-storage');
const metadataStorage = require('../storage/metadata-storage');
const { v4: uuidv4 } = require('uuid');

class FileProcessor {
    async process(data) {
        console.log('Processing file:', data);

        try {
            if (data.action === 'process_chunk') {
                return await this.processChunk(data);
            } else if (data.action === 'upload_file') {
                return await this.uploadFile(data);
            } else {
                throw new Error('Unknown action: ' + data.action);
            }
        } catch (error) {
            console.error('File Processor Error:', error);
            throw error;
        }
    }

    async processChunk(data) {
        // Update metadata for chunk processing
        const metadata = await metadataStorage.getMetadata(data.fileId);
        if (metadata) {
            metadata.status = 'processed';
            metadata.processedAt = new Date().toISOString();
            metadata.chunkProcessed = data.chunkId;
            await metadataStorage.saveMetadata(metadata);
        }

        return { success: true, chunkId: data.chunkId };
    }

    async uploadFile(data) {
        const fileId = data.fileId || uuidv4();
        
        // Save file to storage
        if (data.fileContent) {
            const fileBuffer = Buffer.from(data.fileContent, 'base64');
            await fileStorage.saveFile(data.fileName, fileBuffer);
        }

        // Update metadata
        const metadata = {
            fileId: fileId,
            fileName: data.fileName,
            status: 'uploaded',
            uploadedAt: new Date().toISOString(),
            fileSize: data.fileContent ? Buffer.from(data.fileContent, 'base64').length : 0,
            storagePath: `files/${data.fileName}`
        };

        await metadataStorage.saveMetadata(metadata);

        return { success: true, fileId: fileId };
    }
}

module.exports = new FileProcessor();