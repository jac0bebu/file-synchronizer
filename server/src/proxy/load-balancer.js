const http = require('http');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs-extra');
const colors = require('colors');
const os = require('os');

class LoadBalancer {
    constructor(options = {}) {
        this.proxyPort = options.proxyPort || 3000;
        this.baseServerPort = options.baseServerPort || 3001;
        this.minInstances = options.minInstances || 2;
        this.maxInstances = options.maxInstances || 4;
        this.healthCheckInterval = options.healthCheckInterval || 5000;
        this.bindAddress = options.bindAddress || '0.0.0.0'; // Allow binding to specific IP
        
        // Shared storage paths - all instances will use the same directories
        this.sharedStorageRoot = path.join(__dirname, '../../shared-storage');
        this.ensureSharedStorage();
        
        this.servers = new Map(); // port -> { process, healthy, lastCheck }
        this.proxy = httpProxy.createProxyServer({});
        this.currentPort = this.baseServerPort;
        this.roundRobinIndex = 0;
        
        this.setupProxy();
        this.startHealthChecks();
        this.startInitialServers();
        
        console.log(`🔄 Load Balancer starting on ${this.bindAddress}:${this.proxyPort}`.green);
        console.log(`📁 Shared storage: ${this.sharedStorageRoot}`.cyan);
        this.printNetworkInfo();
        console.log(`🌐 To connect a client, use the IP shown above (e.g., http://192.168.50.100:3000)`.yellow);
    }
    
    printNetworkInfo() {
        console.log(`📡 Network Information:`.cyan);
        const interfaces = os.networkInterfaces();
        Object.keys(interfaces).forEach(name => {
            interfaces[name].forEach(iface => {
                if (iface.family === 'IPv4' && !iface.internal) {
                    console.log(`   External IP: ${iface.address}:${this.proxyPort}`.green);
                }
            });
        });
        console.log(`   Local access: localhost:${this.proxyPort}`.gray);
    }
    
    ensureSharedStorage() {
        // Create shared directories that all server instances will use
        const sharedDirs = [
            path.join(this.sharedStorageRoot, 'files'),
            path.join(this.sharedStorageRoot, 'versions'),
            path.join(this.sharedStorageRoot, 'metadata'),
            path.join(this.sharedStorageRoot, 'chunks'),
            path.join(this.sharedStorageRoot, 'conflicts')
        ];
        
        sharedDirs.forEach(dir => {
            fs.ensureDirSync(dir);
        });
        
        console.log(`✅ Shared storage directories created`.green);
    }
    
    setupProxy() {
        this.proxyServer = http.createServer((req, res) => {
            const healthyServers = this.getHealthyServers();
            
            if (healthyServers.length === 0) {
                console.log('⚠️  No healthy servers available'.yellow);
                res.writeHead(503, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No healthy servers available' }));
                return;
            }
            
            // Round-robin load balancing
            const targetPort = healthyServers[this.roundRobinIndex % healthyServers.length];
            this.roundRobinIndex++;
            
            // Use localhost for internal communication since servers bind to 0.0.0.0
            const target = `http://localhost:${targetPort}`;
            
            this.proxy.web(req, res, { target }, (error) => {
                if (error) {
                    console.error(`❌ Proxy error for port ${targetPort}:`.red, error.message);
                    this.markServerUnhealthy(targetPort);
                    
                    // Try next healthy server
                    const retryServers = this.getHealthyServers();
                    if (retryServers.length > 0) {
                        const retryPort = retryServers[0];
                        const retryTarget = `http://localhost:${retryPort}`;
                        this.proxy.web(req, res, { target: retryTarget });
                    } else {
                        res.writeHead(503, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
                    }
                }
            });
        });
        
        // Bind to the specified address (0.0.0.0 for external access)
        this.proxyServer.listen(this.proxyPort, this.bindAddress, () => {
            console.log(`✅ Load Balancer listening on ${this.bindAddress}:${this.proxyPort}`.green);
        });
    }
    
    async startInitialServers() {
        console.log(`🚀 Starting ${this.minInstances} initial server instances...`.yellow);
        for (let i = 0; i < this.minInstances; i++) {
            await this.startServerInstance();
            await new Promise(resolve => setTimeout(resolve, 2000)); // Stagger starts
        }
    }
    
    async startServerInstance() {
        const port = this.getNextAvailablePort();
        const serverPath = path.join(__dirname, '../api/server.js');
        
        console.log(`🔧 Starting server instance on port ${port}...`.cyan);
        
        // Environment variables for shared storage
        const serverEnv = {
            ...process.env,
            PORT: port,
            HOST: '0.0.0.0', // Ensure server instances bind to 0.0.0.0
            SHARED_STORAGE_ROOT: this.sharedStorageRoot,
            FILES_DIR: path.join(this.sharedStorageRoot, 'files'),
            VERSIONS_DIR: path.join(this.sharedStorageRoot, 'versions'),
            METADATA_DIR: path.join(this.sharedStorageRoot, 'metadata'),
            CHUNKS_DIR: path.join(this.sharedStorageRoot, 'chunks'),
            CONFLICTS_DIR: path.join(this.sharedStorageRoot, 'conflicts')
        };
        
        const serverProcess = spawn('node', [serverPath], {
            env: serverEnv,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        // Log server output with port identification
        serverProcess.stdout.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                console.log(`[Server:${port}] ${output}`.gray);
            }
        });
        
        serverProcess.stderr.on('data', (data) => {
            const output = data.toString().trim();
            if (output) {
                console.error(`[Server:${port}] ERROR: ${output}`.red);
            }
        });
        
        serverProcess.on('exit', (code) => {
            console.log(`❌ Server on port ${port} exited with code ${code}`.red);
            this.servers.delete(port);
            this.handleServerCrash(port);
        });
        
        this.servers.set(port, {
            process: serverProcess,
            healthy: false,
            lastCheck: Date.now(),
            startTime: Date.now()
        });
        
        // Wait for server to start
        await this.waitForServerStart(port);
        return port;
    }
    
    async waitForServerStart(port, timeout = 30000) {
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            try {
                await axios.get(`http://localhost:${port}/health`, { timeout: 2000 });
                this.servers.get(port).healthy = true;
                console.log(`✅ Server on port ${port} is ready and healthy`.green);
                return;
            } catch (error) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        console.error(`❌ Server on port ${port} failed to start within timeout`.red);
        this.killServer(port);
    }
    
    getNextAvailablePort() {
        while (this.servers.has(this.currentPort)) {
            this.currentPort++;
        }
        return this.currentPort++;
    }
    
    getHealthyServers() {
        return Array.from(this.servers.entries())
            .filter(([port, server]) => server.healthy)
            .map(([port]) => port);
    }
    
    markServerUnhealthy(port) {
        if (this.servers.has(port)) {
            this.servers.get(port).healthy = false;
            console.log(`⚠️  Marked server on port ${port} as unhealthy`.yellow);
        }
    }
    
    async handleServerCrash(crashedPort) {
        const healthyCount = this.getHealthyServers().length;
        const totalCount = this.servers.size;
        
        console.log(`📊 Health status after crash: ${healthyCount}/${totalCount} servers healthy`.yellow);
        
        // Immediately start replacement if below minimum
        if (healthyCount < this.minInstances && totalCount < this.maxInstances) {
            console.log(`🔄 Starting replacement server for crashed instance (port ${crashedPort})...`.cyan);
            setTimeout(() => this.startServerInstance(), 1000);
        }
        
        // Start additional instance if we have no healthy servers
        if (healthyCount === 0 && totalCount < this.maxInstances) {
            console.log(`🚨 CRITICAL: No healthy servers! Starting emergency instance...`.red.bold);
            setTimeout(() => this.startServerInstance(), 500);
        }
    }
    
    startHealthChecks() {
        setInterval(async () => {
            await this.performHealthChecks();
        }, this.healthCheckInterval);
        
        console.log(`🔍 Health checks started (every ${this.healthCheckInterval/1000}s)`.cyan);
    }
    
    async performHealthChecks() {
        const promises = Array.from(this.servers.entries()).map(async ([port, server]) => {
            try {
                const response = await axios.get(`http://localhost:${port}/health`, { 
                    timeout: 3000 
                });
                
                if (!server.healthy) {
                    server.healthy = true;
                    console.log(`✅ Server on port ${port} is back online`.green);
                }
                server.lastCheck = Date.now();
                
            } catch (error) {
                if (server.healthy) {
                    console.log(`❌ Health check failed for server on port ${port}`.red);
                    this.markServerUnhealthy(port);
                }
                
                // If server has been unhealthy for too long, restart it
                if (Date.now() - server.lastCheck > 30000) {
                    console.log(`🔄 Restarting unresponsive server on port ${port}`.yellow);
                    this.killServer(port);
                    setTimeout(() => this.startServerInstance(), 2000);
                }
            }
        });
        
        await Promise.allSettled(promises);
    }
    
    killServer(port) {
        const server = this.servers.get(port);
        if (server && server.process) {
            console.log(`🛑 Killing server on port ${port}`.gray);
            server.process.kill('SIGTERM');
            
            // Force kill if not responsive
            setTimeout(() => {
                if (this.servers.has(port)) {
                    server.process.kill('SIGKILL');
                }
            }, 5000);
        }
        this.servers.delete(port);
    }
    
    async shutdown() {
        console.log('🛑 Shutting down load balancer...'.yellow);
        
        // Close proxy server
        if (this.proxyServer) {
            this.proxyServer.close();
        }
        
        // Kill all server instances
        const shutdownPromises = Array.from(this.servers.keys()).map(port => {
            console.log(`Stopping server on port ${port}...`.gray);
            return new Promise(resolve => {
                this.killServer(port);
                setTimeout(resolve, 1000);
            });
        });
        
        await Promise.all(shutdownPromises);
        console.log('✅ Load balancer shutdown complete'.green);
    }
    
    getStatus() {
        const servers = Array.from(this.servers.entries()).map(([port, server]) => ({
            port,
            healthy: server.healthy,
            uptime: Date.now() - server.startTime,
            lastCheck: server.lastCheck
        }));
        
        return {
            proxyPort: this.proxyPort,
            bindAddress: this.bindAddress,
            totalServers: this.servers.size,
            healthyServers: this.getHealthyServers().length,
            sharedStorageRoot: this.sharedStorageRoot,
            servers
        };
    }
}

/*
How to simulate a crashed server instance on Windows:

1. Open a terminal and run:
   netstat -ano | findstr :3001
   netstat -ano | findstr :3002
   (and so on for each port your servers use)

2. The output will look like:
   TCP    0.0.0.0:3001     0.0.0.0:0     LISTENING     6544
   (Here, 6544 is the PID for the server on port 3001)

3. Now, kill the process for that PID:
   taskkill /PID 6544 /F

4. The load balancer will detect the crash and automatically start a replacement server instance.
   You will see log messages like:
     ❌ Server on port 3001 exited with code ...
     🔄 Starting replacement server for crashed instance (port 3001)...
     ✅ Server on port 300X is ready and healthy

Clients will continue to sync without interruption.

You can repeat this for any server port to simulate a crash.
*/

// In the shutdown() method and signal handlers, the load balancer is designed to stop all managed server instances when you press Ctrl+C (SIGINT) or send SIGTERM.
// This is intentional: the load balancer manages the lifecycle of all server instances it starts.
// If you want server instances to keep running after the load balancer stops, you would need to start them independently, not as child processes of the load balancer.

// Current behavior (recommended for fault-tolerant systems):
// - Pressing Ctrl+C in the load balancer terminal gracefully shuts down the proxy and all server instances it manages.
// - This ensures no orphaned processes and keeps your system clean and predictable.

// If you want to test server crash/fault tolerance, kill only a child server process (not the load balancer):
// 1. Open Task Manager (Windows) or use `ps aux | grep node` (Linux/macOS).
// 2. Find a server instance process (usually running `server.js` on port 3001, 3002, etc.).
// 3. Kill that process (not the load balancer).
// 4. The load balancer will detect the crash and automatically start a replacement instance.

// No code change is needed for this behavior. This is the correct and safe design for managed server clusters.

module.exports = LoadBalancer;

/*
How server instances are started:

- When you run `node start-proxy.js`, the LoadBalancer constructor calls `startInitialServers()`.
- This method starts `minInstances` (default: 2) server instances, one after another.
- The first server instance will be started on `baseServerPort` (default: 3001), the next on 3002, etc.
- So, the first server started is always on port 3001, then 3002, and so on.

Example:
- If minInstances = 2 and baseServerPort = 3001:
    - The first server instance will be on port 3001.
    - The second server instance will be on port 3002.

You will see log messages like:
    🔧 Starting server instance on port 3001...
    [Server:3001] File Sync API running at ...
    ✅ Server on port 3001 is ready and healthy
    🔧 Starting server instance on port 3002...
    [Server:3002] File Sync API running at ...
    ✅ Server on port 3002 is ready and healthy

If a server crashes, the next available port is used (e.g., 3003, 3004, ...).
*/