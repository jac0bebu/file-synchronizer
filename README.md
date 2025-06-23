# File Synchronization System

A real-time file synchronization system built with Node.js featuring bidirectional sync, version control, conflict resolution, and background job processing.

## 🚀 Features

- **Real-time file synchronization** between multiple clients and server
- **Version control** with complete file history
- **Conflict detection and resolution** for simultaneous edits
- **Chunked file uploads** for large files
- **Background job processing** for scalable operations
- **Interactive CLI interface** with comprehensive commands
- **Automatic file monitoring** with real-time updates
- **Multi-client support** with unique client identification
- **Pause/Resume functionality** for sync control
- **Health monitoring** and error recovery

## 🏗️ Architecture

### Client-Server Model
- **Server:** Centralized file storage with REST API
- **Client:** Local file monitoring and sync agents
- **Communication:** HTTP REST API with periodic polling
- **Storage:** File system with JSON metadata database

## 📋 Prerequisites

- Node.js 14.0 or higher
- npm 6.0 or higher
- Windows/macOS/Linux operating system

## 🛠️ Installation

### 1. Clone the Repository
```bash
git clone <your-repository-url>
cd file-synchronizer
```

### 2. Install Server Dependencies
```bash
cd server
npm install
```

**Server packages installed:**
- `express` - Web framework for REST API
- `multer` - File upload middleware
- `fs-extra` - Enhanced file system operations
- `cors` - Cross-origin resource sharing
- `axios` - HTTP client for external requests
- `crypto` - Cryptographic functionality
- `path` - File path utilities
- `colors` - Console output coloring

### 3. Install Client Dependencies
```bash
cd ../client
npm install
```

**Client packages installed:**
- `axios` - HTTP client for API communication
- `fs-extra` - Enhanced file system operations
- `chokidar` - File system watcher
- `colors` - Console output coloring
- `readline` - Interactive command-line interface
- `crypto` - Cryptographic functionality
- `path` - File path utilities

## 🚀 Quick Start

### 1. Start the Server
```bash
cd server
node src/api/server.js
```
Server will start on `http://localhost:3000`

### 2. Start the Client
```bash
cd client
node src/app.js
```

### 3. Using the CLI Interface
Once the client starts, you'll see the interactive prompt:
```
🚀 File Synchronization Client
Type "help" for available commands

sync>
```

## 📚 CLI Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `status` | Show sync status of files | `status` |
| `sync` | Manually trigger synchronization | `sync` |
| `list` | List files on the server | `list` |
| `delete` | Delete a file | `delete <filename>` |
| `versions` | Show file versions | `versions <filename>` |
| `conflicts` | Show detected conflicts | `conflicts` |
| `pause` | Pause synchronization | `pause` |
| `resume` | Resume synchronization | `resume` |
| `config` | Show current configuration | `config` |
| `help` | Show available commands | `help` |
| `quit` | Exit the application | `quit` |
| `download` | Download File | `download-version <filename> <version>` |
| `rename` | Rename a file (does not change version, does not create a new version) | `rename <oldName> <newName>` |

## 🔄 How It Works

### File Upload Flow
1. **File Watcher** detects local file changes
2. **Sync Manager** processes the change
3. **API Client** uploads file to server (chunked if large)
4. **Queue Manager** queues background processing
5. **File Processor** validates and processes file
6. **Metadata Storage** records file information

### File Download Flow
1. **Sync Manager** polls server for changes
2. **API Client** fetches updated file list
3. **Sync Manager** compares with local files
4. **API Client** downloads new/modified files
5. **File system** updates local files

### Conflict Resolution
1. **Server** detects simultaneous modifications
2. **Conflict detection** algorithm identifies conflicts
3. **Resolution strategy** applied (default: keep local version)
4. **Metadata** updated with resolution details

## 🔧 Testing Multiple Clients

### Method 1: Create Additional Client Scripts
```bash
# Create client2.js
cd client
```

Create `client2.js`:
```javascript
const SyncApplication = require('./src/app.js');

const app = new SyncApplication({
  serverUrl: 'http://localhost:3000',
  syncFolder: './sync-folder-client2',
  clientId: 'client-2',
  pollInterval: 10000
});

app.start();
```

Create sync folder:
```bash
mkdir sync-folder-client2
```

Run second client:
```bash
node client2.js
```

### Method 2: Multiple Terminal Windows
```bash
# Terminal 1 - Server
cd server && node src/api/server.js

# Terminal 2 - Client 1
cd client && node src/app.js

# Terminal 3 - Client 2
cd client && node client2.js
```

## 📁 Project Structure

```
file-synchronizer/
├── server/
│   ├── src/
│   │   ├── api/
│   │   │   └── server.js              # Main server entry point
│   │   ├── queues/
│   │   │   └── queue-manager.js       # Background job management
│   │   ├── storage/
│   │   │   ├── file-storage.js        # Physical file operations
│   │   │   ├── metadata-storage.js    # File metadata management
│   │   │   ├── files/                 # File storage directory
│   │   │   ├── versions/              # Version storage
│   │   │   ├── chunks/                # Chunked upload temp storage
│   │   │   └── metadata/              # Metadata JSON files
│   │   └── workers/
│   │       ├── chunk-alerter.js       # Upload progress monitoring
│   │       └── file-processor.js      # Background file processing
│   └── package.json
├── client/
│   ├── src/
│   │   ├── api/
│   │   │   └── api-client.js          # HTTP API client
│   │   ├── sync/
│   │   │   └── sync-manager.js        # Core sync logic
│   │   ├── ui/
│   │   │   └── cli-interface.js       # Command-line interface
│   │   ├── watcher/
│   │   │   └── file-watcher.js        # File system monitoring
│   │   └── app.js                     # Client application entry
│   ├── sync-folder/                   # Default sync directory
│   └── package.json
└── README.md
```

## 🎯 Component Functions

### Server Components
- **`server.js`** - REST API endpoints and HTTP request handling
- **`file-storage.js`** - Physical file management and version control
- **`metadata-storage.js`** - File metadata and conflict detection
- **`queue-manager.js`** - Background job orchestration
- **`chunk-alerter.js`** - Chunked upload monitoring
- **`file-processor.js`** - Background file processing and validation

### Client Components
- **`app.js`** - Application initialization and lifecycle
- **`api-client.js`** - Server communication and file transfers
- **`sync-manager.js`** - Synchronization logic and conflict resolution
- **`cli-interface.js`** - User interface and command handling
- **`file-watcher.js`** - Real-time file system monitoring

## 🧪 Testing Scenarios

### Basic Synchronization
1. Create a file in `sync-folder`
2. Watch it appear on server with `list` command
3. Start second client and verify file syncs

### Conflict Detection
1. Create same file on multiple clients simultaneously
2. Check `conflicts` command for detected conflicts
3. Verify resolution strategy applied

### Version Control
1. Create and modify a file multiple times
2. Use `versions <filename>` to see version history
3. Verify each change creates new version

## 🔒 Security Considerations

- File validation and integrity checks
- Client identification and tracking
- Conflict resolution to prevent data loss
- Chunked upload validation
- Error handling and recovery mechanisms

## 🛠️ Development

### Adding New Features
1. **Server endpoints** - Add to `server.js`
2. **Client commands** - Add to `cli-interface.js`
3. **Storage operations** - Extend storage classes
4. **Background jobs** - Add to queue/worker system

### Configuration Options
- Server port and host settings
- Client sync intervals and timeouts
- File size limits and chunk sizes
- Conflict resolution strategies

## 🐛 Troubleshooting

### Common Issues
- **Port conflicts**: Change server port in configuration
- **Permission errors**: Ensure write access to sync folders
- **Network issues**: Check server connectivity
- **File locks**: Close files before syncing

### Debug Mode
Enable verbose logging by setting environment variable:
```bash
DEBUG=true node src/app.js
```

## 📝 License

This project is for educational purposes demonstrating distributed systems concepts including:
- File synchronization algorithms
- Conflict resolution strategies
- Background job processing
- Real-time monitoring systems
- Client-server architecture patterns

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

---

**Built with Node.js • Express • Real-time File Synchronization**
