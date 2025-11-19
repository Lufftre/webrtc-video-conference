// WebRTC Video Conferencing Client

class VideoConference {
  constructor() {
    this.roomId = this.getRoomFromURL();
    this.clientId = this.generateClientId();
    this.ws = null;
    this.localStream = null;
    this.peerConnections = new Map();
    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.init();
  }

  getRoomFromURL() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');

    if (!room) {
      this.showError('No room specified. Please use ?room=yourroom in the URL');
      return null;
    }

    return room;
  }

  generateClientId() {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  async init() {
    if (!this.roomId) return;

    document.getElementById('room-name').textContent = this.roomId;

    try {
      await this.setupLocalStream();
      this.connectToSignalingServer();
    } catch (error) {
      this.showError(`Failed to access camera: ${error.message}`);
    }
  }

  async setupLocalStream() {
    try {
      // Request video only, no audio
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: false
      });

      this.addVideoElement(this.localStream, 'You (Local)', true);
    } catch (error) {
      throw new Error(`Camera access denied or unavailable: ${error.message}`);
    }
  }

  connectToSignalingServer() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to signaling server');
      this.updateStatus('Connected', true);

      // Join the room
      this.ws.send(JSON.stringify({
        type: 'join',
        roomId: this.roomId,
        clientId: this.clientId
      }));
    };

    this.ws.onmessage = (event) => {
      this.handleSignalingMessage(JSON.parse(event.data));
    };

    this.ws.onclose = () => {
      console.log('Disconnected from signaling server');
      this.updateStatus('Disconnected', false);
    };

    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.showError('Connection to server failed');
    };
  }

  async handleSignalingMessage(message) {
    console.log('Received signaling message:', message.type);

    switch (message.type) {
      case 'existing-clients':
        // Create peer connections for existing clients
        for (const clientId of message.clients) {
          await this.createPeerConnection(clientId, true);
        }
        break;

      case 'new-client':
        // New client joined, create peer connection (we'll wait for their offer)
        await this.createPeerConnection(message.clientId, false);
        break;

      case 'offer':
        await this.handleOffer(message);
        break;

      case 'answer':
        await this.handleAnswer(message);
        break;

      case 'ice-candidate':
        await this.handleIceCandidate(message);
        break;

      case 'client-left':
        this.handleClientLeft(message.clientId);
        break;
    }
  }

  async createPeerConnection(remoteClientId, shouldCreateOffer) {
    console.log(`Creating peer connection with ${remoteClientId}`);

    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections.set(remoteClientId, pc);

    // Add local stream tracks to the peer connection
    this.localStream.getTracks().forEach(track => {
      pc.addTrack(track, this.localStream);
    });

    // Handle incoming remote stream
    pc.ontrack = (event) => {
      console.log(`Received remote stream from ${remoteClientId}`);
      this.addVideoElement(event.streams[0], `Remote: ${remoteClientId.substring(0, 12)}`, false);
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'ice-candidate',
          targetId: remoteClientId,
          candidate: event.candidate
        }));
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${remoteClientId}: ${pc.connectionState}`);
    };

    // If we should create an offer (we're the initiator)
    if (shouldCreateOffer) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this.ws.send(JSON.stringify({
          type: 'offer',
          targetId: remoteClientId,
          offer: pc.localDescription
        }));
      } catch (error) {
        console.error('Error creating offer:', error);
      }
    }

    return pc;
  }

  async handleOffer(message) {
    console.log(`Handling offer from ${message.fromId}`);

    let pc = this.peerConnections.get(message.fromId);

    if (!pc) {
      pc = await this.createPeerConnection(message.fromId, false);
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(message.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.ws.send(JSON.stringify({
        type: 'answer',
        targetId: message.fromId,
        answer: pc.localDescription
      }));
    } catch (error) {
      console.error('Error handling offer:', error);
    }
  }

  async handleAnswer(message) {
    console.log(`Handling answer from ${message.fromId}`);

    const pc = this.peerConnections.get(message.fromId);

    if (pc) {
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(message.answer));
      } catch (error) {
        console.error('Error handling answer:', error);
      }
    }
  }

  async handleIceCandidate(message) {
    const pc = this.peerConnections.get(message.fromId);

    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(message.candidate));
      } catch (error) {
        console.error('Error adding ICE candidate:', error);
      }
    }
  }

  handleClientLeft(clientId) {
    console.log(`Client left: ${clientId}`);

    const pc = this.peerConnections.get(clientId);

    if (pc) {
      pc.close();
      this.peerConnections.delete(clientId);
    }

    // Remove video element
    const videoWrapper = document.querySelector(`[data-client-id="${clientId}"]`);
    if (videoWrapper) {
      videoWrapper.remove();
    }

    this.reorganizeVideos();
  }

  addVideoElement(stream, label, isLocal) {
    const container = document.getElementById('videos-container');

    const wrapper = document.createElement('div');
    wrapper.className = `video-wrapper ${isLocal ? 'local' : ''}`;

    if (!isLocal) {
      // For remote videos, use the stream id as identifier
      const streamId = stream.id;
      wrapper.setAttribute('data-client-id', streamId);
    }

    const video = document.createElement('video');
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = isLocal; // Mute local video to avoid feedback

    const labelDiv = document.createElement('div');
    labelDiv.className = 'video-label';
    labelDiv.textContent = label;

    wrapper.appendChild(video);
    wrapper.appendChild(labelDiv);
    container.appendChild(wrapper);

    this.reorganizeVideos();
  }

  reorganizeVideos() {
    const container = document.getElementById('videos-container');
    const videoCount = container.children.length;

    // Adjust grid based on number of videos
    if (videoCount === 1) {
      container.style.gridTemplateColumns = '1fr';
    } else if (videoCount === 2) {
      container.style.gridTemplateColumns = 'repeat(2, 1fr)';
    } else if (videoCount <= 4) {
      container.style.gridTemplateColumns = 'repeat(2, 1fr)';
    } else if (videoCount <= 9) {
      container.style.gridTemplateColumns = 'repeat(3, 1fr)';
    } else {
      container.style.gridTemplateColumns = 'repeat(4, 1fr)';
    }
  }

  updateStatus(text, connected) {
    const statusText = document.getElementById('status-text');
    const statusIndicator = document.getElementById('status-indicator');

    statusText.textContent = text;

    if (connected) {
      statusIndicator.classList.remove('disconnected');
    } else {
      statusIndicator.classList.add('disconnected');
    }
  }

  showError(message) {
    const errorDiv = document.getElementById('error');
    const errorMessage = document.getElementById('error-message');

    errorMessage.textContent = message;
    errorDiv.classList.add('show');
  }
}

// Initialize the video conference when the page loads
window.addEventListener('DOMContentLoaded', () => {
  new VideoConference();
});
