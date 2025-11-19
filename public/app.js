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
    // Use environment variable or fallback to current host for development
    const backendUrl = window.BACKEND_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`;

    this.ws = new WebSocket(backendUrl);

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

// AI Chat Manager
class AIChatManager {
  constructor() {
    this.chatPanel = document.getElementById('ai-chat-panel');
    this.chatToggle = document.getElementById('ai-chat-toggle');
    this.closeBtn = document.getElementById('close-chat');
    this.screenshotBtn = document.getElementById('screenshot-btn');
    this.messagesContainer = document.getElementById('ai-chat-messages');

    this.setupEventListeners();
  }

  setupEventListeners() {
    this.chatToggle.addEventListener('click', () => this.toggleChat());
    this.closeBtn.addEventListener('click', () => this.toggleChat());
    this.screenshotBtn.addEventListener('click', () => this.captureAndAnalyze());
  }

  toggleChat() {
    this.chatPanel.classList.toggle('open');
  }

  async captureAndAnalyze() {
    this.screenshotBtn.disabled = true;

    try {
      // Add user message
      this.addMessage('user', 'What do you see in this meeting screenshot?');

      // Capture screenshot
      const screenshot = await this.captureScreenshot();

      // Add screenshot to chat
      this.addImageMessage(screenshot);

      // Add loading message
      const loadingMsgId = this.addLoadingMessage();

      // Send to backend for Claude AI analysis
      const response = await this.sendToClaudeAPI(screenshot);

      // Remove loading message
      this.removeMessage(loadingMsgId);

      // Add AI response
      this.addMessage('assistant', response);

    } catch (error) {
      console.error('Error analyzing screenshot:', error);
      this.addMessage('assistant', `Error: ${error.message}`);
    } finally {
      this.screenshotBtn.disabled = false;
    }
  }

  async captureScreenshot() {
    const videosContainer = document.getElementById('videos-container');

    // Use html2canvas approach
    return new Promise((resolve, reject) => {
      // Create a canvas from the videos container
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Set canvas size to match container
      const rect = videosContainer.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      // Fill background
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Get all video elements
      const videos = videosContainer.querySelectorAll('video');

      if (videos.length === 0) {
        reject(new Error('No video streams available to capture'));
        return;
      }

      // Draw each video onto the canvas
      let drawn = 0;
      videos.forEach((video, index) => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          const videoRect = video.getBoundingClientRect();
          const containerRect = videosContainer.getBoundingClientRect();

          const x = videoRect.left - containerRect.left;
          const y = videoRect.top - containerRect.top;

          ctx.drawImage(video, x, y, videoRect.width, videoRect.height);
          drawn++;
        }
      });

      if (drawn === 0) {
        reject(new Error('No video frames ready to capture'));
        return;
      }

      // Convert canvas to base64 image
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve(dataUrl);
    });
  }

  async sendToClaudeAPI(imageBase64) {
    // Get backend URL from config
    const backendUrl = window.BACKEND_URL
      ? window.BACKEND_URL.replace('wss:', 'https:').replace('ws:', 'http:')
      : window.location.origin;

    const response = await fetch(`${backendUrl}/api/analyze-image`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        image: imageBase64
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to analyze image');
    }

    const data = await response.json();
    return data.analysis;
  }

  addMessage(type, text) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `ai-message ${type}`;
    messageDiv.textContent = text;
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();
    return messageDiv.id = `msg-${Date.now()}`;
  }

  addImageMessage(imageDataUrl) {
    const messageDiv = document.createElement('div');
    messageDiv.className = 'ai-message user';

    const img = document.createElement('img');
    img.src = imageDataUrl;
    img.className = 'message-image';

    messageDiv.appendChild(img);
    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();
  }

  addLoadingMessage() {
    const messageDiv = document.createElement('div');
    const id = `loading-${Date.now()}`;
    messageDiv.id = id;
    messageDiv.className = 'ai-message loading';

    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('div');
      dot.className = 'loading-dot';
      messageDiv.appendChild(dot);
    }

    this.messagesContainer.appendChild(messageDiv);
    this.scrollToBottom();
    return id;
  }

  removeMessage(id) {
    const message = document.getElementById(id);
    if (message) {
      message.remove();
    }
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }
}

// Initialize the video conference when the page loads
window.addEventListener('DOMContentLoaded', () => {
  new VideoConference();
  new AIChatManager();
});
