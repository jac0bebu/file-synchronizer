const axios = require('axios');
const fs = require('fs-extra');
const FormData = require('form-data');
const path = require('path');
const crypto = require('crypto'); // Add at the top if not present

class ApiClient {
    constructor(serverUrl) {
        if (!serverUrl) {
            throw new Error('Server URL must be provided to ApiClient!');
        }
        this.serverUrl = serverUrl;
        console.log(`API Client initialized with server: ${this.serverUrl}`);
    }

    async getHealth() {
        try {
            const response = await axios.get(`${this.serverUrl}/health`);
            return response.data;
        } catch (error) {
            console.error('Health check failed:', error.message);
            throw new Error(`Server connection failed: ${error.message}`);
        }
    }

    async listFiles() {
        try {
            const response = await axios.get(`${this.serverUrl}/files`);
            return response.data.files || [];
        } catch (error) {
            console.error('Failed to list files:', error.message);
            throw error;
        }
    }

    async uploadFile(filePath, clientId) {
        try {
            const fileName = path.basename(filePath);
            const stats = await fs.stat(filePath);
            const lastModified = stats.mtime.toISOString();
            
            const form = new FormData();
            form.append('file', fs.createReadStream(filePath));
            form.append('fileName', fileName);
            form.append('clientId', clientId); // <-- always use provided clientId
            form.append('lastModified', lastModified);
            
            const response = await axios.post(`${this.serverUrl}/files/upload-safe`, form, {
                headers: form.getHeaders(),
                maxContentLength: Infinity,
                maxBodyLength: Infinity
            });
            
            return response.data;
        } catch (error) {
            if (error.response && error.response.status === 409) {
                // Conflict detected
                throw {
                    conflict: true,
                    message: 'Conflict detected',
                    details: error.response.data
                };
            }
            throw error;
        }
    }

    async uploadChunkedFile(filePath, clientId) {
        const CHUNK_SIZE = 10 * 1024 * 1024; // 10MB to match server
        const fileName = path.basename(filePath);
        const stats = await fs.stat(filePath);
        const totalSize = stats.size;
        const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
        const fileId = crypto.randomBytes(8).toString('hex');
        const lastModified = stats.mtime.toISOString();

        console.log(`Starting chunked upload: ${fileName} (${totalSize} bytes, ${totalChunks} chunks)`);

        try {
            // Read file buffer once
            const fileBuffer = await fs.readFile(filePath);
            
            for (let chunkNumber = 1; chunkNumber <= totalChunks; chunkNumber++) {
                const start = (chunkNumber - 1) * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, totalSize);
                const chunk = fileBuffer.slice(start, end);

                const form = new FormData();
                form.append('chunk', chunk, { filename: `${fileName}.part${chunkNumber}` });
                form.append('fileId', fileId);
                form.append('chunkNumber', chunkNumber.toString());
                form.append('totalChunks', totalChunks.toString());
                form.append('fileName', fileName);
                form.append('clientId', clientId);
                form.append('lastModified', lastModified);

                console.log(`Uploading chunk ${chunkNumber}/${totalChunks} (${chunk.length} bytes)...`);

                try {
                    const response = await axios.post(
                        `${this.serverUrl}/files/chunk`,
                        form,
                        {
                            headers: form.getHeaders(),
                            maxContentLength: Infinity,
                            maxBodyLength: Infinity,
                            timeout: 30000 // 30 second timeout per chunk
                        }
                    );
                    // Only log chunk completion, not the response message
                    console.log(`✓ Chunk ${chunkNumber}/${totalChunks} completed`);
                } catch (error) {
                    if (error.response && error.response.status === 409) {
                        // Conflict detected during chunked upload
                        console.error(`Conflict detected during chunk upload for ${fileName}`);
                        throw {
                            conflict: true,
                            message: 'Conflict detected during chunked upload',
                            details: error.response.data
                        };
                    }
                    console.error(`Chunk ${chunkNumber} upload failed:`, error.message);
                    throw new Error(`Chunk upload failed at chunk ${chunkNumber}: ${error.message}`);
                }
            }

            // Return success without logging here - let sync manager handle final message
            return { success: true, message: 'All chunks uploaded', fileId, fileName };

        } catch (error) {
            console.error(`Chunked upload failed for ${fileName}:`, error.message);
            throw error;
        }
    }

    async downloadFile(fileName, destinationPath) {
        try {
            const response = await axios.get(`${this.serverUrl}/files/${fileName}/download`, {
                responseType: 'arraybuffer'
            });
            
            await fs.writeFile(destinationPath, response.data);
            return { success: true, fileName, path: destinationPath };
        } catch (error) {
            console.error(`Failed to download ${fileName}:`, error.message);
            throw error;
        }
    }

    async downloadFileVersion(fileName, version, destinationPath) {
        try {
            const response = await axios.get(
                `${this.serverUrl}/files/${encodeURIComponent(fileName)}/versions/${encodeURIComponent(version)}/download`,
                { responseType: 'arraybuffer' }
            );
            await fs.ensureDir(path.dirname(destinationPath));
            await fs.writeFile(destinationPath, response.data);
            return { success: true, fileName, version, path: destinationPath };
        } catch (error) {
            console.error(`Failed to download ${fileName} version ${version}:`, error.message);
            throw error;
        }
    }

    async deleteFile(fileName) {
        try {
            const response = await axios.delete(`${this.serverUrl}/files/${fileName}`);
            return response.data;
        } catch (error) {
            console.error(`Failed to delete ${fileName}:`, error.message);
            throw error;
        }
    }

    async getFileVersions(fileName) {
        try {
            const response = await axios.get(`${this.serverUrl}/files/${fileName}/versions`);
            return response.data;
        } catch (error) {
            console.error(`Failed to get versions for ${fileName}:`, error.message);
            throw error;
        }
    }

    async getConflicts(status) {
        try {
            const url = status 
                ? `${this.serverUrl}/conflicts?status=${status}` 
                : `${this.serverUrl}/conflicts`;
                
            const response = await axios.get(url);
            return response.data;
        } catch (error) {
            console.error('Failed to get conflicts:', error.message);
            throw error;
        }
    }

    async resolveConflict(conflictId, resolution) {
        try {
            const response = await axios.post(
                `${this.serverUrl}/conflicts/${conflictId}/resolve`,
                resolution,
                { headers: { 'Content-Type': 'application/json' } }
            );
            return response.data;
        } catch (error) {
            console.error(`Failed to resolve conflict ${conflictId}:`, error.message);
            throw error;
        }
    }

    async restoreFileVersion(fileName, version, clientId) {
        try {
            const response = await axios.post(
                `${this.serverUrl}/files/${encodeURIComponent(fileName)}/restore/${encodeURIComponent(version)}`,
                { clientId }
            );
            return response.data;
        } catch (error) {
            console.error(`Failed to restore ${fileName} version ${version}:`, error.message);
            throw error;
        }
    }

    async renameFile(oldName, newName) {
        try {
            const response = await axios.post(`${this.serverUrl}/files/${encodeURIComponent(oldName)}/rename`, {
                newName
            });
            return response.data;
        } catch (error) {
            throw error;
        }
    }
}

module.exports = ApiClient;