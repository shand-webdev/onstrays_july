const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// =============================================================================
// SERVER SETUP
// =============================================================================

const app = express();
const server = createServer(app);

// CORS configuration
const corsOptions = {
  origin: [
    'http://localhost:3000',
    'https://onstrays-july-client.vercel.app/',
    // For MVP, you can also allow all origins:
    // '*'
  ],
  credentials: true
};

app.use(cors(corsOptions));

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling']
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
 * Relays WebRTC signaling messages between matched users
 */
function relaySignalingMessage(socketId, messageType, data) {
  const match = activeMatches.get(socketId);
  if (match) {
    const partnerSocket = connections.get(match.partnerId);
    if (partnerSocket && partnerSocket.connected) {
      partnerSocket.emit(messageType, data);
      logEvent('SIGNALING_RELAY', `${messageType} relayed from ${socketId} to ${match.partnerId}`);
    }
  }
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on('connection', (socket) => {
  logEvent('USER_CONNECT', `User ${socket.id} connected`);
  
  // Store socket connection
  connections.set(socket.id, socket);
  
  // Add user to waiting queue
  addToQueue(socket.id);
  
  // Attempt matching immediately
  attemptMatching();
  
  // Handle user requesting next match
  socket.on('next', () => {
    logEvent('NEXT_REQUEST', `User ${socket.id} requested next match`);
    handleNext(socket.id);
  });
  
  // Handle WebRTC signaling messages
  socket.on('offer', (data) => {
    relaySignalingMessage(socket.id, 'offer', data);
  });
  
  socket.on('answer', (data) => {
    relaySignalingMessage(socket.id, 'answer', data);
  });
  
  socket.on('ice-candidate', (data) => {
    relaySignalingMessage(socket.id, 'ice-candidate', data);
  });
  
  // Handle manual disconnect from match (but staying connected to server)
  socket.on('disconnect_match', () => {
    logEvent('MANUAL_DISCONNECT', `User ${socket.id} manually disconnected from match`);
    disconnectFromMatch(socket.id);
    addToQueue(socket.id);
    attemptMatching();
  });
  
  // Handle full socket disconnection
  socket.on('disconnect', () => {
    logEvent('USER_DISCONNECT', `User ${socket.id} disconnected`);
    
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
  
  // Handle connection errors
  socket.on('error', (error) => {
    logEvent('SOCKET_ERROR', `Socket ${socket.id} error: ${error.message}`);
  });
});

// =============================================================================
// EXPRESS ROUTES
// =============================================================================

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeConnections: connections.size,
    queueSize: waitingQueue.length,
    activeMatches: activeMatches.size / 2 // Divide by 2 since each match has 2 entries
  });
});

// Basic info endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'OnStrays Backend',
    version: '1.0.0',
    status: 'running'
  });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  logEvent('SERVER_START', `OnStrays backend server running on port ${PORT}`);
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  logEvent('SERVER_SHUTDOWN', 'Server shutting down...');
  server.close(() => {
    logEvent('SERVER_SHUTDOWN', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logEvent('SERVER_SHUTDOWN', 'Server shutting down...');
  server.close(() => {
    logEvent('SERVER_SHUTDOWN', 'Server closed');
    process.exit(0);
  });
});

// Export server for testing purposes
module.exports = { app, server, io };