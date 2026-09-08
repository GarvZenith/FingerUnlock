// FingerUnlock Self-Hosted Secure Relay Server
// Routes unlock commands from Phone to Laptop Agent via persistent WebSocket session.
// Supports device identity, authenticated routing, heartbeats, and online presence tracking.

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 5590;

// Active laptop WebSocket connections keyed by deviceId
const laptopSessions = new Map(); // deviceId -> { ws, token, lastPing, machine }
// Pending HTTP unlock requests waiting for laptop ACK keyed by requestId
const pendingRequests = new Map(); // requestId -> res (HTTP response object)

const server = http.createServer((req, res) => {
  // Enable CORS for web/mobile management if needed
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Health check endpoint
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', activeLaptops: laptopSessions.size }));
    return;
  }

  // Device status / reachability check endpoint
  if (req.method === 'GET' && url.pathname.startsWith('/status/')) {
    const deviceId = url.pathname.replace('/status/', '').trim();
    const session = laptopSessions.get(deviceId);
    const isOnline = !!(session && session.ws.readyState === WebSocket.OPEN);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      deviceId,
      online: isOnline,
      machine: session ? session.machine : null,
      lastPing: session ? session.lastPing : null
    }));
    return;
  }

  // Phone unlock request endpoint (POST /unlock)
  if (req.method === 'POST' && url.pathname === '/unlock') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const deviceId = json.deviceId || '';
        const token = json.token || req.headers['x-token'] || '';
        const requestId = json.requestId || `req_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        if (!deviceId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing deviceId' }));
          return;
        }

        const session = laptopSessions.get(deviceId);
        if (!session || session.ws.readyState !== WebSocket.OPEN) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Laptop is offline / not connected to relay', online: false }));
          return;
        }

        // Verify token matches paired laptop session token
        if (session.token && token && session.token !== token) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Authentication token mismatch' }));
          return;
        }

        // Set a 4-second timeout for laptop acknowledgment
        const timeout = setTimeout(() => {
          if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Laptop acknowledgment timeout', requestId }));
          }
        }, 4000);

        pendingRequests.set(requestId, { res, timeout });

        // Forward unlock command to laptop WebSocket agent
        session.ws.send(JSON.stringify({
          type: 'unlock',
          deviceId,
          requestId,
          token,
          extra: json.extra || {}
        }));

        console.log(`[Relay] Routed unlock command for device ${deviceId} (req: ${requestId})`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// WebSocket Server for persistent Laptop Agent connections
const wss = new WebSocket.Server({ server, path: '/laptop' });

wss.on('connection', (ws, req) => {
  let registeredDeviceId = null;

  console.log('[Relay] New laptop connection attempt from', req.socket.remoteAddress);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 1. Laptop Agent Registration (type: 'register')
      if (data.type === 'register') {
        const deviceId = (data.deviceId || '').trim();
        const token = (data.token || '').trim();
        const machine = (data.machine || 'PC').trim();

        if (!deviceId) {
          ws.send(JSON.stringify({ type: 'error', message: 'deviceId is required' }));
          return;
        }

        registeredDeviceId = deviceId;
        laptopSessions.set(deviceId, {
          ws,
          token,
          machine,
          lastPing: Date.now()
        });

        console.log(`[Relay] Laptop registered: ${machine} (${deviceId})`);
        ws.send(JSON.stringify({ type: 'registered', deviceId, status: 'online' }));
        return;
      }

      // 2. Heartbeat Ping (type: 'ping')
      if (data.type === 'ping') {
        if (registeredDeviceId && laptopSessions.has(registeredDeviceId)) {
          const session = laptopSessions.get(registeredDeviceId);
          session.lastPing = Date.now();
        }
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        return;
      }

      // 3. Unlock Acknowledgment from Laptop Agent (type: 'ack')
      if (data.type === 'ack') {
        const requestId = data.requestId;
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timeout);
          pendingRequests.delete(requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ status: 'OK', message: 'Laptop unlocked successfully', requestId }));
          console.log(`[Relay] ACK received for request ${requestId} -> Phone notified SUCCESS`);
        }
        return;
      }
    } catch (e) {
      console.error('[Relay] Error handling message:', e.message);
    }
  });

  ws.on('close', () => {
    if (registeredDeviceId) {
      console.log(`[Relay] Laptop disconnected: ${registeredDeviceId}`);
      laptopSessions.delete(registeredDeviceId);
    }
  });

  ws.on('error', (err) => {
    console.error('[Relay] Socket error:', err.message);
  });
});

// Periodic cleanup of stale sessions & dead ping timers (every 30s)
setInterval(() => {
  const now = Date.now();
  for (const [deviceId, session] of laptopSessions.entries()) {
    if (now - session.lastPing > 45000) { // 45 seconds timeout
      console.log(`[Relay] Pruning inactive laptop session: ${deviceId}`);
      try { session.ws.terminate(); } catch (e) {}
      laptopSessions.delete(deviceId);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log(`[FingerUnlock Relay] Listening on port ${PORT} (HTTP + WebSocket)`);
});
