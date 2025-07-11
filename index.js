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

// Interest-based queues for users waiting to be matched
const interestQueues = {
  "Any Interest": [],
  "Music": [],
  "Tech": [],
  "AI": [],
  "Books": [],
  "Fitness": [],
  "Movies": [],
  "Travel": [],
  "Gaming": []
};

// Store user preferences: Map of socketId -> user data
const userPreferences = new Map();

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
function removeFromAllQueues(socketId) {
  let removed = false;
  for (const [interest, queue] of Object.entries(interestQueues)) {
    const index = queue.findIndex(user => user.socketId === socketId);
    if (index !== -1) {
      queue.splice(index, 1);
      logEvent('QUEUE_REMOVE', `User ${socketId} removed from ${interest} queue. Queue size: ${queue.length}`);
      removed = true;
    }
  }
  userPreferences.delete(socketId);
  return removed;
}

function addToQueue(socketId, userData) {
  // Store user preferences
  userPreferences.set(socketId, userData);
  
  // Get user's selected interest (fallback to "Any Interest")
let selectedInterest = userData.interest || "Any Interest";

  // Ensure the interest queue exists
  if (!interestQueues[selectedInterest]) {
    logEvent('QUEUE_WARNING', `Interest "${selectedInterest}" not found, using "Any Interest"`);
    selectedInterest = "Any Interest";
  }
  
  // Add user to the single appropriate queue
  interestQueues[selectedInterest].push({
    socketId: socketId,
    ...userData
  });
  
  logEvent('QUEUE_ADD', `User ${socketId} added to ${selectedInterest} queue. Queue size: ${interestQueues[selectedInterest].length}`);
}

/**
 * Attempts to match two users from the queue
 */
function attemptInterestMatching(requestingSocketId) {
  const userData = userPreferences.get(requestingSocketId);
  if (!userData) {
    logEvent('MATCH_ERROR', `No user data found for ${requestingSocketId}`);
    return;
  }

  const userInterest = userData.interest || "Any Interest";
  logEvent('MATCHING_ATTEMPT', `User ${requestingSocketId} looking for match with interest: ${userInterest}`);
  
  // Phase 1: Try matching in user's selected interest queue
  if (tryMatchInQueue(userInterest, requestingSocketId)) {
    return; // Match found!
  }
  
  // Phase 2: If not "Any Interest" already, try "Any Interest" queue  
  if (userInterest !== "Any Interest" && tryMatchInQueue("Any Interest", requestingSocketId)) {
    return; // Match found in fallback!
  }
  
  // Phase 3: Try matching across all other queues (FIXED)
  if (tryMatchAcrossAllQueues(requestingSocketId)) {
    return; // Cross-interest match found!
  }
  
  logEvent('NO_MATCH', `No match found for ${requestingSocketId} with interest ${userInterest}`);
}



// Helper function to try matching in a specific queue
function tryMatchInQueue(interest, requestingSocketId) {
  const queue = interestQueues[interest];
  if (!queue || queue.length < 2) {
    return false; // Not enough users in this queue
  }
  


// Try matching across different interests
function tryMatchAcrossAllQueues(requestingSocketId) {
  // Get all users from all queues
  const allUsers = [];
  
  for (const [interest, queue] of Object.entries(interestQueues)) {
    queue.forEach(user => {
      if (user.socketId !== requestingSocketId) {
        allUsers.push({...user, queueInterest: interest});
      }
    });
  }
  
  // If we have at least one other user, match with them
  if (allUsers.length > 0) {
    const partner = allUsers[0]; // Take the first available user
    createMatch(requestingSocketId, partner.socketId, "Cross-Interest");
    return true;
  }
  
  return false;
}
  
  // Find the requesting user in this queue
  const userIndex = queue.findIndex(user => user.socketId === requestingSocketId);
  if (userIndex === -1) {
    // User not in this specific queue, but that's OK for cross-interest matching
    // Just find any two different users
    if (queue.length >= 2) {
      const user1 = queue[0];
      const user2 = queue[1];
      
      // Make sure we're not trying to match the requesting user with themselves
      if (user1.socketId !== requestingSocketId && user2.socketId !== requestingSocketId) {
        createMatch(user1.socketId, user2.socketId, interest);
        return true;
      }
    }
    return false; // User not in this queue and no other matches available
  }
  
  // Find another user to match with
  let partnerIndex = -1;
  for (let i = 0; i < queue.length; i++) {
    if (i !== userIndex && queue[i].socketId !== requestingSocketId) {
      partnerIndex = i;
      break;
    }
  }
  
  if (partnerIndex === -1) {
    return false; // No partner found
  }
  
  // Create the match
  const user = queue[userIndex];
  const partner = queue[partnerIndex];
  
  createMatch(user.socketId, partner.socketId, interest);
  return true; // Match created successfully
}
function createMatch(socketId1, socketId2, matchType) {
  const socket1 = connections.get(socketId1);
  const socket2 = connections.get(socketId2);
  
  if (!socket1 || !socket2 || !socket1.connected || !socket2.connected) {
    logEvent('MATCH_FAILED', `Invalid sockets for users ${socketId1} and ${socketId2}`);
    return;
  }
  
  // Remove both users from all queues
  removeFromAllQueues(socketId1);
  removeFromAllQueues(socketId2);
  
  // Create match with Perfect Negotiation roles
  activeMatches.set(socketId1, { partnerId: socketId2, role: 'impolite' });
  activeMatches.set(socketId2, { partnerId: socketId1, role: 'polite' });
  
  // Notify both users of the match
  socket1.emit('matched', { 
    partnerId: socketId2, 
    role: 'impolite',
    matchType: matchType 
  });
  
  socket2.emit('matched', { 
    partnerId: socketId1, 
    role: 'polite',
    matchType: matchType 
  });
  
  logEvent('MATCH_SUCCESS', `Users ${socketId1} and ${socketId2} matched via ${matchType}`);
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
      
      // Re-add partner to queue with their stored preferences
      const partnerData = userPreferences.get(match.partnerId);
      if (partnerData) {
        addToQueue(match.partnerId, partnerData);
        attemptInterestMatching(match.partnerId);
      }
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
      
      // Re-add partner to queues with their stored preferences
      const partnerData = userPreferences.get(partnerId);
      if (partnerData) {
        addToQueue(partnerId, partnerData);
        attemptInterestMatching(partnerId);
      }
    }
    
    // Re-add current user to queues with their stored preferences
    const userData = userPreferences.get(socketId);
    if (userData) {
      addToQueue(socketId, userData);
      attemptInterestMatching(socketId);
    }
    
    logEvent('NEXT_ACTION', `User ${socketId} and ${partnerId} returned to queue`);
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


console.log('🧪 ABOUT TO SET UP IO CONNECTION HANDLER');

io.on('connection', (socket) => {
   console.log('🧪 Setting up event handlers for socket:', socket.id); // Add this line

  logEvent('USER_CONNECT', `User ${socket.id} connected from ${socket.handshake.address}`);
   

  // Store socket connection
  connections.set(socket.id, socket);
  

  
  // Enhanced debugging listeners
  socket.on('disconnect', (reason) => {
    logEvent('USER_DISCONNECT', `User ${socket.id} disconnected. Reason: ${reason}`);
    
    // Remove from queue
  removeFromAllQueues(socket.id);
    
    // Disconnect from match if active
    disconnectFromMatch(socket.id);
    
    // Remove socket connection
    connections.delete(socket.id);
    
   
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

 // Handle chat messages
 socket.on('message', (data) => {
  console.log('🔥 BACKEND: MESSAGE EVENT TRIGGERED!');
  console.log('📦 BACKEND: Data received:', data);
  logEvent('MESSAGE_RECEIVED', `Message from ${socket.id} to ${data.partnerId}`);
  relaySignalingMessage(socket.id, 'message', data);
});

  socket.on('test-connection', (data) => {
  console.log('🧪 BACKEND: Test connection received:', data);
  socket.emit('test-response', { message: 'Hello from backend' });
});
  
  // Handle manual disconnect from match (but staying connected to server)
  socket.on('disconnect_match', () => {
  logEvent('MANUAL_DISCONNECT', `User ${socket.id} manually disconnected from match`);
  disconnectFromMatch(socket.id);
  
  // Re-add user to queue with their stored preferences
  const userData = userPreferences.get(socket.id);
  if (userData) {
    addToQueue(socket.id, userData);
    attemptInterestMatching(socket.id);
  }
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

  // Handle user joining queue with preferences
socket.on('join_queue', (userData) => {
  logEvent('JOIN_QUEUE', `User ${socket.id} joining with preferences: ${JSON.stringify(userData)}`);
  
  // Remove from any existing queues first
  removeFromAllQueues(socket.id);
  
  // Add to appropriate queue (single queue now)
  addToQueue(socket.id, userData);
  
  // Attempt matching immediately
  attemptInterestMatching(socket.id);
});

});

// =============================================================================
// EXPRESS ROUTES
// =============================================================================

// Cloudflare TURN credentials endpoint
app.get('/api/turn-credentials', async (req, res) => {
  try {
    console.log('🔄 Calling Cloudflare API...');
    
    const response = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/b279b7d70b7aa3e0ff1eb21e02245a5b/credentials/generate-ice-servers', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer c54c7c205b6a197d16f0243e7d6a9ef9ae5a0bf2e85a60a3b37f529f0800e8b5', // Fixed token
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ ttl: 86400 })
    });
    
    console.log('📡 Cloudflare API Status:', response.status);
    console.log('📡 Response Headers:', response.headers.raw());


    if (!response.ok) {
      const errorText = await response.text();
      console.log('❌ Cloudflare API Error:', errorText);
      throw new Error(`API Error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    console.log('✅ Cloudflare API Success:', JSON.stringify(data, null, 2));
    
    logEvent('CLOUDFLARE_CREDS', '✅ Cloudflare TURN credentials generated');
    res.json(data);
  } catch (error) {
    console.log('❌ Full Error:', error);
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
  const totalQueueSize = Object.values(interestQueues).reduce((sum, queue) => sum + queue.length, 0);
  
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeConnections: connections.size,
    totalQueueSize: totalQueueSize,
    interestQueues: Object.fromEntries(
      Object.entries(interestQueues).map(([interest, queue]) => [interest, queue.length])
    ),
    activeMatches: activeMatches.size / 2,
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
interestQueues: Object.fromEntries(
  Object.entries(interestQueues).map(([interest, queue]) => [interest, queue.length])
),
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
const totalQueueSize = Object.values(interestQueues).reduce((sum, queue) => sum + queue.length, 0);
logEvent('KEEPALIVE', `Active connections: ${connections.size}, Total Queue: ${totalQueueSize}, Matches: ${activeMatches.size / 2}`);  
  // Clean up any stale connections
  for (const [socketId, socket] of connections) {
    if (!socket.connected) {
      logEvent('CLEANUP_STALE', `Cleaning up stale connection ${socketId}`);
      connections.delete(socketId);
      removeFromAllQueues(socketId); 
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