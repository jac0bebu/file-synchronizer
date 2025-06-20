const Queue = require('bull');
const redis = require('redis');

class QueueManager {
    constructor() {
        // Create Redis client (optional, Bull manages its own connections)
        this.redisClient = redis.createClient({
            url: 'redis://localhost:6379'
        });
        this.redisClient.on('error', (err) => console.error('Redis Client Error', err));
        this.redisClient.connect().catch(console.error);

        // Create Bull queues
        this.alertQueue = new Queue('alert-queue', {
            redis: { port: 6379, host: 'localhost' }
        });

        this.fileQueue = new Queue('file-queue', {
            redis: { port: 6379, host: 'localhost' }
        });

        this.setupWorkers();
    }

    setupWorkers() {
        // Import workers
        const ChunkAlerter = require('../workers/chunk-alerter');
        const FileProcessor = require('../workers/file-processor');

        // Process alert queue
        this.alertQueue.process(async (job) => {
            return await ChunkAlerter.process(job.data);
        });

        // Process file queue
        this.fileQueue.process(async (job) => {
            return await FileProcessor.process(job.data);
        });
    }

    async addAlertJob(data) {
        return await this.alertQueue.add(data);
    }

    async addFileJob(data) {
        return await this.fileQueue.add(data);
    }

    // Health check
    async getQueueStats() {
        const alertStats = await this.alertQueue.getJobCounts();
        const fileStats = await this.fileQueue.getJobCounts();
        return { alertQueue: alertStats, fileQueue: fileStats };
    }
}