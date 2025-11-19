# WebRTC Video Conferencing

A simple single-page application for video conferencing using WebRTC.

## Features

- Video-only streaming (no audio)
- Room-based conferencing via URL query parameter
- WebSocket signaling with in-memory storage
- CouchDB integration for room persistence
- Responsive grid layout for multiple participants
- Peer-to-peer WebRTC connections

## Prerequisites

- Node.js (v18 or higher recommended)
- CouchDB (optional, can run without it)

## Installation

```bash
npm install
```

## Configuration

### CouchDB

Set the CouchDB connection URL via environment variable:

```bash
export COUCHDB_URL=http://admin:password@localhost:5984
```

If CouchDB is not available, the application will continue to work with in-memory storage only.

### MCP Tool for CouchDB

If you have an MCP tool for CouchDB (Open Source Cloud), you can integrate it by modifying the CouchDB connection logic in `server.js`.

## Running the Application

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in the `PORT` environment variable).

## Usage

1. Start the server
2. Open your browser and navigate to:
   ```
   http://localhost:3000/?room=myroom
   ```
3. Share the same URL with others to join the same room
4. Allow camera access when prompted
5. Your video stream will appear, and you'll see other participants as they join

## URL Parameters

- `room` (required): The room name/ID to join
  - Example: `/?room=meeting123`

## Architecture

### Backend (`server.js`)

- Express web server for serving static files
- WebSocket server for WebRTC signaling
- In-memory storage for active connections and rooms
- CouchDB integration for persisting room information

### Frontend (`public/`)

- `index.html`: Main page structure and styles
- `app.js`: WebRTC client logic, signaling, and peer connection management

### Signaling Protocol

Messages exchanged via WebSocket:

- `join`: Client joins a room
- `existing-clients`: Server sends list of clients already in room
- `new-client`: Server notifies existing clients of new participant
- `offer`: WebRTC offer for initiating connection
- `answer`: WebRTC answer in response to offer
- `ice-candidate`: ICE candidate for NAT traversal
- `client-left`: Notification when a client leaves

## WebRTC Configuration

The application uses Google's public STUN servers for NAT traversal:
- `stun:stun.l.google.com:19302`
- `stun:stun1.l.google.com:19302`

For production use, you may want to configure your own STUN/TURN servers in `public/app.js`.

## Browser Compatibility

Requires a modern browser with WebRTC support:
- Chrome 74+
- Firefox 66+
- Safari 12.1+
- Edge 79+

## Security Notes

- HTTPS is required in production for camera access
- For local development, `http://localhost` is allowed
- Consider implementing authentication for room access
- Set up CORS policies for production deployments

## Troubleshooting

### Camera not accessible
- Ensure you're using HTTPS or localhost
- Check browser permissions for camera access
- Verify no other application is using the camera

### Connection issues
- Check that WebSocket connection is established
- Verify firewall settings allow WebSocket connections
- Ensure STUN servers are accessible

### CouchDB errors
- Verify CouchDB is running and accessible
- Check credentials in COUCHDB_URL
- Application will continue without CouchDB if connection fails
