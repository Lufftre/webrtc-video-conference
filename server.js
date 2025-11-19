import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import nano from 'nano';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// In-memory storage for signaling
const rooms = new Map(); // roomId -> Set of client objects
const clients = new Map(); // ws -> { id, roomId }

// CouchDB connection (configure via environment variables)
const couchDbUrl = process.env.COUCHDB_URL || 'http://localhost:5984';
const couchDb = nano(couchDbUrl);
let roomsDb;

// Initialize CouchDB
async function initCouchDB() {
  try {
    const dbName = 'webrtc_rooms';
    const dbList = await couchDb.db.list();

    if (!dbList.includes(dbName)) {
      await couchDb.db.create(dbName);
      console.log(`Created CouchDB database: ${dbName}`);
    }

    roomsDb = couchDb.use(dbName);
    console.log('Connected to CouchDB');
  } catch (error) {
    console.error('CouchDB initialization error:', error.message);
    console.log('Continuing without CouchDB persistence...');
  }
}

// Save room to CouchDB
async function saveRoomToDB(roomId, participants) {
  if (!roomsDb) return;

  try {
    const timestamp = new Date().toISOString();
    let doc;

    try {
      doc = await roomsDb.get(roomId);
      doc.participants = participants;
      doc.lastActivity = timestamp;
      doc.participantCount = participants.length;
    } catch (err) {
      if (err.statusCode === 404) {
        doc = {
          _id: roomId,
          roomId,
          participants,
          participantCount: participants.length,
          createdAt: timestamp,
          lastActivity: timestamp
        };
      } else {
        throw err;
      }
    }

    await roomsDb.insert(doc);
  } catch (error) {
    console.error('Error saving room to CouchDB:', error.message);
  }
}

// Serve static files
app.use(express.static('public'));

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('New WebSocket connection');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.type) {
        case 'join':
          handleJoin(ws, data);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          handleSignaling(ws, data);
          break;
        case 'leave':
          handleLeave(ws);
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  });

  ws.on('close', () => {
    handleLeave(ws);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

function handleJoin(ws, data) {
  const { roomId, clientId } = data;

  // Store client info
  clients.set(ws, { id: clientId, roomId });

  // Add client to room
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Set());
  }

  const room = rooms.get(roomId);
  const existingClients = Array.from(room).map(client => clients.get(client).id);

  room.add(ws);

  // Notify the new client about existing clients
  ws.send(JSON.stringify({
    type: 'existing-clients',
    clients: existingClients
  }));

  // Notify existing clients about the new client
  room.forEach((client) => {
    if (client !== ws && client.readyState === 1) {
      client.send(JSON.stringify({
        type: 'new-client',
        clientId
      }));
    }
  });

  // Save room state to CouchDB
  const participants = Array.from(room).map(client => clients.get(client).id);
  saveRoomToDB(roomId, participants);

  console.log(`Client ${clientId} joined room ${roomId}. Total in room: ${room.size}`);
}

function handleSignaling(ws, data) {
  const client = clients.get(ws);
  if (!client) return;

  const room = rooms.get(client.roomId);
  if (!room) return;

  // Forward signaling message to target client
  room.forEach((targetWs) => {
    const targetClient = clients.get(targetWs);
    if (targetClient && targetClient.id === data.targetId && targetWs.readyState === 1) {
      targetWs.send(JSON.stringify({
        ...data,
        fromId: client.id
      }));
    }
  });
}

function handleLeave(ws) {
  const client = clients.get(ws);
  if (!client) return;

  const room = rooms.get(client.roomId);
  if (room) {
    room.delete(ws);

    // Notify other clients
    room.forEach((otherWs) => {
      if (otherWs.readyState === 1) {
        otherWs.send(JSON.stringify({
          type: 'client-left',
          clientId: client.id
        }));
      }
    });

    // Update CouchDB
    const participants = Array.from(room).map(c => clients.get(c).id);
    saveRoomToDB(client.roomId, participants);

    // Clean up empty rooms
    if (room.size === 0) {
      rooms.delete(client.roomId);
    }

    console.log(`Client ${client.id} left room ${client.roomId}`);
  }

  clients.delete(ws);
}

// Start server
const PORT = process.env.PORT || 3000;

initCouchDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
});
