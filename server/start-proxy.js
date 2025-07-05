const LoadBalancer = require('./src/proxy/load-balancer');
const colors = require('colors');

console.log('🚀 Starting File Sync Load Balancer...'.green.bold);

const loadBalancer = new LoadBalancer({
    proxyPort: 3000,
    baseServerPort: 3001,
    minInstances: 2,
    maxInstances: 4,
    healthCheckInterval: 5000
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Received shutdown signal...'.yellow);
    await loadBalancer.shutdown();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Received termination signal...'.yellow);
    await loadBalancer.shutdown();
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
    console.error('❌ Uncaught Exception:'.red, error);
    await loadBalancer.shutdown();
    process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
    console.error('❌ Unhandled Rejection:'.red, reason);
    await loadBalancer.shutdown();
    process.exit(1);
});

// Status endpoint (optional)
setInterval(() => {
    const status = loadBalancer.getStatus();
    console.log(`📊 Status: ${status.healthyServers}/${status.totalServers} servers healthy`.cyan);
}, 30000);

/*
How to use:
- Start the system with: node start-proxy.js
- The load balancer will automatically launch and monitor multiple server instances.
- If any server instance crashes, the load balancer will start a replacement.
- Clients should always connect to the load balancer's IP:PORT (e.g., http://192.168.50.100:3000)
- You do NOT need to run server.js directly.
*/
