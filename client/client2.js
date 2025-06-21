const SyncApplication = require('./src/app.js');

const app = new SyncApplication({
  serverUrl: 'http://localhost:3000',
  syncFolder: './sync-folder-client2',
  clientId: 'client-2',
  pollInterval: 10000
});

app.start();