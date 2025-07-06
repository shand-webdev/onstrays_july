const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');

// =============================================================================
// SERVER SETUP
// =============================================================================

const app = express();
const server = createServer(app);

// CORS configuration
const corsOptions = {
  origin: "*",
  credentials: true
};

app.use(cors(corsOptions));

// Socket.IO setup with CORS and enhanced configuration for Render
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,        // 60 seconds
  pingInterval: 25000,       // 25 seconds
  upgradeTimeout: 30000,     // 30 seconds
  allowEIO3: true,           // Backward compatibility
  maxHttpBufferSize: 1e6,    // 1MB buffer
  connectTimeout: 45000      // 45 seconds
});

// =============================================================================
// GLOBAL STATE MANAGEMENT
// =============================================================================

// Queue for users waiting to be matched
const waitingQueue = [];

// Active matches: Map of socketId -> { partnerId, role }
const activeMatches = new Map();

// Socket connections: Map of socketId -> socket instance
const connections = new Map();

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Logs events with timestamp for debugging
 */
function logEvent(event, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${event}`, data);
}

/**
 * Validates if a socket connection is still valid
 */
function validateConnection(socketId) {
  const socket = connections.get(socketId);
  if (!socket || !socket.connected) {
    logEvent('INVALID_CONNECTION', `Socket ${socketId} is invalid or disconnected`);
    return false;
  }
  return true;
}

/**
 * Removes a user from the waiting queue
 */
function removeFromQueue(socketId) {
  const index = waitingQueue.findIndex(id => id === socketId);
  if (index !== -1) {
    waitingQueue.splice(index, 1);
    logEvent('QUEUE_REMOVE', `User ${socketId} removed from queue. Queue size: ${waitingQueue.length}`);
  }
}

/**
 * Adds a user to the waiting queue if not already present
 */
function addToQueue(socketId) {
  if (!waitingQueue.includes(socketId)) {
    waitingQueue.push(socketId);
    logEvent('QUEUE_ADD', `User ${socketId} added to queue. Queue size: ${waitingQueue.length}`);
  }
}

/**
 * Attempts to match two users from the queue
 */
function attemptMatching() {
  if (waitingQueue.length >= 2) {
    const user1Id = waitingQueue.shift();
    const user2Id = waitingQueue.shift();
    
    const user1Socket = connections.get(user1Id);
    const user2Socket = connections.get(user2Id);
    
    // Verify both sockets still exist and are connected
    if (!user1Socket || !user2Socket || !user1Socket.connected || !user2Socket.connected) {
      logEvent('MATCH_FAILED', `Invalid sockets for users ${user1Id} and ${user2Id}`);
      
      // Re-add valid users back to queue
      if (user1Socket && user1Socket.connected) addToQueue(user1Id);
      if (user2Socket && user2Socket.connected) addToQueue(user2Id);
      
      // Try matching again if there are still users in queue
      if (waitingQueue.length >= 2) {
        attemptMatching();
      }
      return;
    }
    
    // Create match with Perfect Negotiation roles
    // user1 is impolite (initiator), user2 is polite (receiver)
    activeMatches.set(user1Id, { partnerId: user2Id, role: 'impolite' });
    activeMatches.set(user2Id, { partnerId: user1Id, role: 'polite' });
    
    // Notify both users of the match
    user1Socket.emit('matched', { 
      partnerId: user2Id, 
      role: 'impolite',
      isInitiator: true 
    });
    
    user2Socket.emit('matched', { 
      partnerId: user1Id, 
      role: 'polite',
      isInitiator: false 
    });
    
    logEvent('MATCH_SUCCESS', `Users ${user1Id} and ${user2Id} matched. Queue size: ${waitingQueue.length}`);
    
    // Continue matching if more users are waiting
    if (waitingQueue.length >= 2) {
      attemptMatching();
    }
  }
}

/**
 * Disconnects a user from their current match
 */
function disconnectFromMatch(socketId) {
  const match = activeMatches.get(socketId);
  if (match) {
    const partnerSocket = connections.get(match.partnerId);
    
    // Remove both users from active matches
    activeMatches.delete(socketId);
    activeMatches.delete(match.partnerId);
    
    // Notify partner of disconnection
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('partner_disconnected');

      addToQueue(match.partnerId);
      logEvent('PARTNER_DISCONNECT', `User ${match.partnerId} notified of partner ${socketId} disconnect`);
    }
    
    logEvent('MATCH_DISCONNECT', `User ${socketId} disconnected from match with ${match.partnerId}`);
    return match.partnerId;
  }
  return null;
}

/**
 * Handles user going to next match
 */
function handleNext(socketId) {
  const match = activeMatches.get(socketId);
  if (match) {
    const partnerId = match.partnerId;
    const partnerSocket = connections.get(partnerId);
    
    // Remove both users from active matches
    activeMatches.delete(socketId);
    activeMatches.delete(partnerId);
    
    // Notify partner about next action
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit('partner_next');
      // Add partner back to queue
      addToQueue(partnerId);
    }
    
    // Add current user back to queue
    addToQueue(socketId);
    
    logEvent('NEXT_ACTION', `User ${socketId} and ${partnerId} returned to queue`);
    
    // Attempt new matching
    attemptMatching();
  }
}

/**
 * Enhanced function to relay WebRTC signaling messages between matched users
 */
function relaySignalingMessage(socketId, messageType, data) {
  const match = activeMatches.get(socketId);
  if (match && validateConnection(socketId) && validateConnection(match.partnerId)) {
    const partnerSocket = connections.get(match.partnerId);
    partnerSocket.emit(messageType, data);
    logEvent('SIGNALING_RELAY', `${messageType} relayed from ${socketId} to ${match.partnerId}`);
  } else {
    logEvent('SIGNALING_FAILED', `Failed to relay ${messageType} from ${socketId} - Invalid connections`);
  }
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on('connection', (socket) => {
  logEvent('USER_CONNECT', `User ${socket.id} connected from ${socket.handshake.address}`);
  
  // Store socket connection
  connections.set(socket.id, socket);
  
  // Add user to waiting queue
  addToQueue(socket.id);
  
  // Attempt matching immediately
  attemptMatching();
  
  // Enhanced debugging listeners
  socket.on('disconnect', (reason) => {
    logEvent('USER_DISCONNECT', `User ${socket.id} disconnected. Reason: ${reason}`);
    
    // Remove from queue
    removeFromQueue(socket.id);
    
    // Disconnect from match if active
    disconnectFromMatch(socket.id);
    
    // Remove socket connection
    connections.delete(socket.id);
    
    // Try to match remaining users
    if (waitingQueue.length >= 2) {
      attemptMatching();
    }
  });
  
  socket.on('connect_error', (error) => {
    logEvent('CONNECT_ERROR', `Socket ${socket.id} connect error: ${error.message}`);
  });
  
  socket.on('reconnect', (attemptNumber) => {
    logEvent('RECONNECT', `Socket ${socket.id} reconnected after ${attemptNumber} attempts`);
  });
  
  // Add ping/pong monitoring
  socket.on('ping', () => {
    logEvent('PING', `Ping from ${socket.id}`);
  });
  
  socket.on('pong', (latency) => {
    logEvent('PONG', `Pong from ${socket.id}, latency: ${latency}ms`);
  });
  
  // Handle user requesting next match
  socket.on('next', () => {
    logEvent('NEXT_REQUEST', `User ${socket.id} requested next match`);
    handleNext(socket.id);
  });
  
  // Handle WebRTC signaling messages
  socket.on('offer', (data) => {
    logEvent('OFFER_RECEIVED', `Offer received from ${socket.id}`);
    relaySignalingMessage(socket.id, 'offer', data);
  });
  
  socket.on('answer', (data) => {
    logEvent('ANSWER_RECEIVED', `Answer received from ${socket.id}`);
    relaySignalingMessage(socket.id, 'answer', data);
  });
  
  socket.on('ice-candidate', (data) => {
    logEvent('ICE_CANDIDATE_RECEIVED', `ICE candidate received from ${socket.id}`);
    relaySignalingMessage(socket.id, 'ice-candidate', data);
  });
  
  // Handle manual disconnect from match (but staying connected to server)
  socket.on('disconnect_match', () => {
    logEvent('MANUAL_DISCONNECT', `User ${socket.id} manually disconnected from match`);
    disconnectFromMatch(socket.id);
    addToQueue(socket.id);
    attemptMatching();
  });
  
  // Handle connection errors
  socket.on('error', (error) => {
    logEvent('SOCKET_ERROR', `Socket ${socket.id} error: ${error.message}`);
  });
  
  // Handle heartbeat/keepalive from client
  socket.on('heartbeat', () => {
    logEvent('HEARTBEAT', `Heartbeat from ${socket.id}`);
    socket.emit('heartbeat_ack');
  });
});

// =============================================================================
// EXPRESS ROUTES
// =============================================================================

// Cloudflare TURN credentials endpoint
app.get('/api/turn-credentials', async (req, res) => {
  try {
    const response = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/b279b7d70b7aa3e0ff1eb21e02245a5b/credentials/generate-ice-servers', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer c54c7c205b6a197d16f0243e7d6a9ef9ae5a0bf2e85a60a3b37f529f0800e8b5',//api
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: 86400 }) // 24 hours
    });
    
    const data = await response.json();
    logEvent('CLOUDFLARE_CREDS', '✅ Cloudflare TURN credentials generated');
    res.json(data);
  } catch (error) {
    logEvent('CLOUDFLARE_ERROR', `❌ Error getting Cloudflare credentials: ${error.message}`);
    
    // Fallback to backup TURN servers
    res.json({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        {
          urls: "turn:a.relay.metered.ca:80",
          username: "openrelayproject",
          credential: "openrelayproject"
        },
        {
          urls: "turn:a.relay.metered.ca:443",
          username: "openrelayproject",
          credential: "openrelayproject"
        }
      ]
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeConnections: connections.size,
    queueSize: waitingQueue.length,
    activeMatches: activeMatches.size / 2, // Divide by 2 since each match has 2 entries
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  });
});

// Basic info endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OnStrays Backend',
    version: '1.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    connections: connections.size,
    matches: activeMatches.size / 2
  });
});

// Debug endpoint for development
app.get('/debug', (req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    waitingQueue: waitingQueue,
    activeMatches: Object.fromEntries(activeMatches),
    connections: Array.from(connections.keys()),
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// =============================================================================
// RENDER-SPECIFIC KEEPALIVE
// =============================================================================

// Keep Render instance alive and log periodic status
setInterval(() => {
  logEvent('KEEPALIVE', `Active connections: ${connections.size}, Queue: ${waitingQueue.length}, Matches: ${activeMatches.size / 2}`);
  
  // Clean up any stale connections
  for (const [socketId, socket] of connections) {
    if (!socket.connected) {
      logEvent('CLEANUP_STALE', `Cleaning up stale connection ${socketId}`);
      connections.delete(socketId);
      removeFromQueue(socketId);
      disconnectFromMatch(socketId);
    }
  }
}, 30000); // Every 30 seconds

// =============================================================================
// SERVER STARTUP
// =============================================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  logEvent('SERVER_START', `OnStrays backend server running on port ${PORT}`);
  logEvent('SERVER_CONFIG', `Ping timeout: 60s, Ping interval: 25s`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  logEvent('SERVER_SHUTDOWN', 'Server shutting down...');
  
  // Notify all connected clients
  for (const [socketId, socket] of connections) {
    if (socket.connected) {
      socket.emit('server_shutdown');
    }
  }
  
  server.close(() => {
    logEvent('SERVER_SHUTDOWN', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logEvent('SERVER_SHUTDOWN', 'Server shutting down...');
  
  // Notify all connected clients
  for (const [socketId, socket] of connections) {
    if (socket.connected) {
      socket.emit('server_shutdown');
    }
  }
  
  server.close(() => {
    logEvent('SERVER_SHUTDOWN', 'Server closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logEvent('UNCAUGHT_EXCEPTION', `${error.message}\n${error.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logEvent('UNHANDLED_REJECTION', `Reason: ${reason}\nPromise: ${promise}`);
});

// Export server for testing purposes
module.exports = { app, server, io };