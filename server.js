import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import nano from 'nano';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';

const app = express();

// Enable CORS for all routes
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false
}));

app.use(express.json({ limit: '50mb' })); // For handling base64 images
const server = createServer(app);
const wss = new WebSocketServer({ server });

// In-memory storage for signaling
const rooms = new Map(); // roomId -> Set of client objects
const clients = new Map(); // ws -> { id, roomId }

// CouchDB connection (configure via environment variables)
const couchDbUrl = process.env.COUCHDB_URL || 'https://admin:RootPass123!@team1-videoconfdb2.apache-couchdb.auto.prod.osaas.io';
const couchDb = nano(couchDbUrl);
let roomsDb;
let configDb;

// Anthropic Claude AI client (will be initialized from CouchDB)
let anthropic = null;

// Initialize CouchDB and load configuration
async function initCouchDB() {
  try {
    const dbList = await couchDb.db.list();

    // Initialize rooms database
    const roomsDbName = 'webrtc_rooms';
    if (!dbList.includes(roomsDbName)) {
      await couchDb.db.create(roomsDbName);
      console.log(`Created CouchDB database: ${roomsDbName}`);
    }
    roomsDb = couchDb.use(roomsDbName);

    // Initialize config database
    const configDbName = 'webrtc_config';
    if (!dbList.includes(configDbName)) {
      await couchDb.db.create(configDbName);
      console.log(`Created CouchDB database: ${configDbName}`);
    }
    configDb = couchDb.use(configDbName);

    // Load API key from config
    await loadConfig();

    console.log('Connected to CouchDB');
  } catch (error) {
    console.error('CouchDB initialization error:', error.message);
    console.log('Continuing without CouchDB persistence...');
  }
}

// Load configuration from CouchDB
async function loadConfig() {
  try {
    const config = await configDb.get('app_config');
    if (config.anthropicApiKey) {
      anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
      console.log('Claude AI configured from CouchDB');
    }
  } catch (error) {
    if (error.statusCode === 404) {
      console.log('No configuration found in CouchDB. Claude AI is not configured.');
      console.log('To enable Claude AI, create a document with ID "app_config" in the webrtc_config database with field "anthropicApiKey"');
    } else {
      console.error('Error loading config from CouchDB:', error.message);
    }
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

// API endpoint for Claude AI image analysis
app.post('/api/analyze-image', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(500).json({
        error: 'Claude AI is not configured. Please set aikey secret in OSC.'
      });
    }

    const { image } = req.body;

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    // Extract base64 data from data URL
    const base64Data = image.split(',')[1];
    const mediaType = image.split(';')[0].split(':')[1];

    // Call Claude AI API
    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType || 'image/jpeg',
                data: base64Data
              }
            },
            {
              type: 'text',
              text: 'You are analyzing a screenshot from a video conference. Describe what you see in the meeting. Who is present? What are they doing? Provide a helpful summary of the meeting scene.'
            }
          ]
        }
      ]
    });

    const analysis = message.content[0].text;

    res.json({ analysis });
  } catch (error) {
    console.error('Error analyzing image:', error);
    res.status(500).json({
      error: error.message || 'Failed to analyze image'
    });
  }
});

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
