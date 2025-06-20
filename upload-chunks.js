const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks

async function uploadFileInChunks(filePath, serverUrl) {
    try {
        const fileName = path.basename(filePath);
        const fileId = crypto.randomBytes(8).toString('hex');
        const fileBuffer = await fs.readFile(filePath);
        const totalChunks = Math.ceil(fileBuffer.length / CHUNK_SIZE);

        console.log(`Starting upload: ${fileName}`);
        console.log(`File size: ${fileBuffer.length} bytes`);
        console.log(`Total chunks: ${totalChunks}`);
        console.log(`FileID: ${fileId}`);

        for (let i = 0; i < totalChunks; i++) {
            const chunkNumber = i + 1;
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, fileBuffer.length);
            const chunk = fileBuffer.slice(start, end);

            const form = new FormData();
            form.append('fileId', fileId);
            form.append('chunkNumber', chunkNumber.toString());
            form.append('totalChunks', totalChunks.toString());
            form.append('fileName', fileName);
            form.append('chunk', chunk, { filename: `${fileName}.part${chunkNumber}` });

            console.log(`Uploading chunk ${chunkNumber}/${totalChunks} (${chunk.length} bytes)...`);
            
            const response = await axios.post(`${serverUrl}/files/chunk`, form, {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });

            console.log(`✓ Chunk ${chunkNumber} response:`, response.data.message);
        }

        console.log('🎉 All chunks uploaded successfully!');
        console.log(`File assembled as: ${fileName}`);
        
    } catch (error) {
        console.error('❌ Upload failed:', error.message);
    }
}

// Usage: node upload-chunks.js <path-to-file> <server-url>
if (require.main === module) {
    const [,, filePath, serverUrl] = process.argv;
    if (!filePath || !serverUrl) {
        console.log('Usage: node upload-chunks.js <path-to-file> <server-url>');
        console.log('Example: node upload-chunks.js ./myfile.zip http://localhost:3000');
        process.exit(1);
    }
    
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found: ${filePath}`);
        process.exit(1);
    }
    
    uploadFileInChunks(filePath, serverUrl);
}

module.exports = { uploadFileInChunks };