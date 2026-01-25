Overview                                                                                                                                                                        
                                                                                                                                                                                  
  Implement support for unauthenticated clients to connect to the duratii orchestrator without a pre-configured token. The orchestrator will display these pending clients to     
  authorized users who can approve them, sending a token back over WebSocket that claudecodeui stores and uses for future connections.                                            
                                                                                                                                                                                  
  Architecture                                                                                                                                                                    
                                                                                                                                                                                  
  ┌─────────────────────────────────────────────────────────────────────────┐                                                                                                     
  │                         Connection Flow                                  │                                                                                                    
  ├─────────────────────────────────────────────────────────────────────────┤                                                                                                     
  │                                                                          │                                                                                                    
  │  1. Check .env for ORCHESTRATOR_TOKEN                                   │                                                                                                     
  │     └─ If found → connect to /ws/connect?token=X (existing flow)        │                                                                                                     
  │                                                                          │                                                                                                    
  │  2. Check database for stored token for this host                       │                                                                                                     
  │     └─ If found → connect to /ws/connect?token=X (existing flow)        │                                                                                                     
  │                                                                          │                                                                                                    
  │  3. No token available → connect to /ws/pending?user=<github_user>      │                                                                                                     
  │     └─ Send PendingRegister message with hostname, project, platform    │                                                                                                     
  │     └─ Wait for TokenGranted message                                    │                                                                                                     
  │     └─ Store token in database                                          │                                                                                                     
  │     └─ Reconnect to /ws/connect with new token                          │                                                                                                     
  │                                                                          │                                                                                                    
  └─────────────────────────────────────────────────────────────────────────┘                                                                                                     
                                                                                                                                                                                  
  Token Precedence                                                                                                                                                                
                                                                                                                                                                                  
  1. .env file ORCHESTRATOR_TOKEN - Highest priority, always used if set                                                                                                          
  2. Database token for specific host - Used when .env token is empty/missing                                                                                                     
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Part 1: Database Schema for Token Storage                                                                                                                                       
                                                                                                                                                                                  
  File: server/database/schema.sql (or equivalent)                                                                                                                                
                                                                                                                                                                                  
  Add new table:                                                                                                                                                                  
                                                                                                                                                                                  
  CREATE TABLE IF NOT EXISTS orchestrator_tokens (                                                                                                                                
      id INTEGER PRIMARY KEY AUTOINCREMENT,                                                                                                                                       
      host TEXT NOT NULL UNIQUE,          -- e.g., "duratii.example.com"                                                                                                          
      token TEXT NOT NULL,                 -- Full token string (ao_xxx_yyy)                                                                                                      
      client_id TEXT,                      -- Client ID assigned by orchestrator                                                                                                  
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,                                                                                                                              
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP                                                                                                                               
  );                                                                                                                                                                              
                                                                                                                                                                                  
  File: server/database/db.js (or equivalent)                                                                                                                                     
                                                                                                                                                                                  
  Add CRUD functions:                                                                                                                                                             
                                                                                                                                                                                  
  /**                                                                                                                                                                             
   * Get stored orchestrator token for a specific host                                                                                                                            
   * @param {string} host - The orchestrator host (e.g., "duratii.example.com")                                                                                                   
   * @returns {Promise<{token: string, client_id: string} | null>}                                                                                                                
   */                                                                                                                                                                             
  async function getOrchestratorToken(host) {                                                                                                                                     
      // Implementation                                                                                                                                                           
  }                                                                                                                                                                               
                                                                                                                                                                                  
  /**                                                                                                                                                                             
   * Save or update orchestrator token for a host                                                                                                                                 
   * @param {string} host - The orchestrator host                                                                                                                                 
   * @param {string} token - The full token string                                                                                                                                
   * @param {string} clientId - The client ID from orchestrator                                                                                                                   
   */                                                                                                                                                                             
  async function saveOrchestratorToken(host, token, clientId) {                                                                                                                   
      // Implementation - use INSERT OR REPLACE / upsert                                                                                                                          
  }                                                                                                                                                                               
                                                                                                                                                                                  
  /**                                                                                                                                                                             
   * Delete orchestrator token for a host                                                                                                                                         
   * @param {string} host - The orchestrator host                                                                                                                                 
   */                                                                                                                                                                             
  async function deleteOrchestratorToken(host) {                                                                                                                                  
      // Implementation                                                                                                                                                           
  }                                                                                                                                                                               
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Part 2: Token Resolution with Precedence                                                                                                                                        
                                                                                                                                                                                  
  File: server/orchestrator/index.js (or wherever OrchestratorClient is instantiated)                                                                                             
                                                                                                                                                                                  
  Modify the token resolution logic:                                                                                                                                              
                                                                                                                                                                                  
  /**                                                                                                                                                                             
   * Resolve the orchestrator token using precedence rules                                                                                                                        
   * @param {string} orchestratorUrl - The orchestrator WebSocket URL                                                                                                             
   * @returns {Promise<string | null>} - The token or null if none available                                                                                                      
   */                                                                                                                                                                             
  async function resolveOrchestratorToken(orchestratorUrl) {                                                                                                                      
      // 1. Check .env first (highest priority)                                                                                                                                   
      const envToken = process.env.ORCHESTRATOR_TOKEN;                                                                                                                            
      if (envToken && envToken.trim() !== '') {                                                                                                                                   
          return envToken;                                                                                                                                                        
      }                                                                                                                                                                           
                                                                                                                                                                                  
      // 2. Check database for host-specific token                                                                                                                                
      const url = new URL(orchestratorUrl.replace('wss://', 'https://').replace('ws://', 'http://'));                                                                             
      const host = url.host;                                                                                                                                                      
                                                                                                                                                                                  
      const stored = await db.getOrchestratorToken(host);                                                                                                                         
      if (stored?.token) {                                                                                                                                                        
          return stored.token;                                                                                                                                                    
      }                                                                                                                                                                           
                                                                                                                                                                                  
      // 3. No token available                                                                                                                                                    
      return null;                                                                                                                                                                
  }                                                                                                                                                                               
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Part 3: Pending Connection Mode                                                                                                                                                 
                                                                                                                                                                                  
  File: server/orchestrator/protocol.js (or equivalent)                                                                                                                           
                                                                                                                                                                                  
  Add new message types:                                                                                                                                                          
                                                                                                                                                                                  
  // Outbound message types (claudecodeui -> orchestrator)                                                                                                                        
  const OutboundMessageTypes = {                                                                                                                                                  
      // ... existing types ...                                                                                                                                                   
      PENDING_REGISTER: 'pending_register',                                                                                                                                       
      PING: 'ping',                                                                                                                                                               
  };                                                                                                                                                                              
                                                                                                                                                                                  
  // Inbound message types (orchestrator -> claudecodeui)                                                                                                                         
  const InboundMessageTypes = {                                                                                                                                                   
      // ... existing types ...                                                                                                                                                   
      PENDING_REGISTERED: 'pending_registered',                                                                                                                                   
      TOKEN_GRANTED: 'token_granted',                                                                                                                                             
      AUTHORIZATION_DENIED: 'authorization_denied',                                                                                                                               
      AUTHORIZATION_TIMEOUT: 'authorization_timeout',                                                                                                                             
      PONG: 'pong',                                                                                                                                                               
  };                                                                                                                                                                              
                                                                                                                                                                                  
  File: server/orchestrator/client.js                                                                                                                                             
                                                                                                                                                                                  
  Update the OrchestratorClient class:                                                                                                                                            
                                                                                                                                                                                  
  class OrchestratorClient {                                                                                                                                                      
      constructor(config) {                                                                                                                                                       
          this.config = config;                                                                                                                                                   
          this.ws = null;                                                                                                                                                         
          this.reconnectAttempts = 0;                                                                                                                                             
          this.maxReconnectAttempts = config.maxReconnectAttempts || 5;                                                                                                           
          this.reconnectInterval = config.reconnectInterval || 5000;                                                                                                              
          this.heartbeatInterval = config.heartbeatInterval || 30000;                                                                                                             
          this.heartbeatTimer = null;                                                                                                                                             
                                                                                                                                                                                  
          // Pending mode state                                                                                                                                                   
          this.pendingMode = false;                                                                                                                                               
          this.pendingId = null;                                                                                                                                                  
          this.orchestratorHost = null;  // Store host for token storage                                                                                                          
                                                                                                                                                                                  
          // Claim patterns for pending mode                                                                                                                                      
          this.claimPatterns = config.claimPatterns || {};                                                                                                                        
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Connect to orchestrator                                                                                                                                                  
       * Determines whether to use authenticated or pending mode                                                                                                                  
       */                                                                                                                                                                         
      async connect() {                                                                                                                                                           
          const token = await resolveOrchestratorToken(this.config.url);                                                                                                          
                                                                                                                                                                                  
          // Parse host for token storage                                                                                                                                         
          const url = new URL(this.config.url.replace('wss://', 'https://').replace('ws://', 'http://'));                                                                         
          this.orchestratorHost = url.host;                                                                                                                                       
                                                                                                                                                                                  
          if (token) {                                                                                                                                                            
              // Authenticated mode - existing flow                                                                                                                               
              this.pendingMode = false;                                                                                                                                           
              return this.connectWithToken(token);                                                                                                                                
          } else {                                                                                                                                                                
              // Pending mode - new flow                                                                                                                                          
              this.pendingMode = true;                                                                                                                                            
              return this.connectPending();                                                                                                                                       
          }                                                                                                                                                                       
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Connect in authenticated mode with a token                                                                                                                               
       */                                                                                                                                                                         
      connectWithToken(token) {                                                                                                                                                   
          const clientId = this.generateClientId();                                                                                                                               
          const wsUrl = `${this.config.url}?token=${encodeURIComponent(token)}&client_id=${clientId}`;                                                                            
                                                                                                                                                                                  
          this.ws = new WebSocket(wsUrl);                                                                                                                                         
          this.setupWebSocketHandlers();                                                                                                                                          
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Connect in pending mode (no token)                                                                                                                                       
       */                                                                                                                                                                         
      connectPending() {                                                                                                                                                          
          // Build URL with claim patterns                                                                                                                                        
          const params = new URLSearchParams();                                                                                                                                   
                                                                                                                                                                                  
          // Add claim patterns from config                                                                                                                                       
          if (this.claimPatterns.user) {                                                                                                                                          
              params.set('user', this.claimPatterns.user);                                                                                                                        
          }                                                                                                                                                                       
          if (this.claimPatterns.org) {                                                                                                                                           
              params.set('org', this.claimPatterns.org);                                                                                                                          
          }                                                                                                                                                                       
          if (this.claimPatterns.team) {                                                                                                                                          
              params.set('team', this.claimPatterns.team);                                                                                                                        
          }                                                                                                                                                                       
                                                                                                                                                                                  
          // Require at least one claim pattern                                                                                                                                   
          if (!params.toString()) {                                                                                                                                               
              console.error('Pending mode requires at least one claim pattern (user, org, or team)');                                                                             
              return;                                                                                                                                                             
          }                                                                                                                                                                       
                                                                                                                                                                                  
          const wsUrl = `${this.config.url.replace('/ws/connect', '/ws/pending')}?${params.toString()}`;                                                                          
                                                                                                                                                                                  
          console.log(`[Orchestrator] Connecting in pending mode to ${wsUrl}`);                                                                                                   
          this.ws = new WebSocket(wsUrl);                                                                                                                                         
          this.setupWebSocketHandlers();                                                                                                                                          
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle WebSocket open event                                                                                                                                              
       */                                                                                                                                                                         
      onOpen() {                                                                                                                                                                  
          console.log('[Orchestrator] WebSocket connected');                                                                                                                      
          this.reconnectAttempts = 0;                                                                                                                                             
                                                                                                                                                                                  
          if (this.pendingMode) {                                                                                                                                                 
              // Send PendingRegister message                                                                                                                                     
              this.sendPendingRegister();                                                                                                                                         
          } else {                                                                                                                                                                
              // Send regular Register message (existing flow)                                                                                                                    
              this.sendRegister();                                                                                                                                                
          }                                                                                                                                                                       
                                                                                                                                                                                  
          this.startHeartbeat();                                                                                                                                                  
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Send PendingRegister message for pending mode                                                                                                                            
       */                                                                                                                                                                         
      sendPendingRegister() {                                                                                                                                                     
          this.pendingId = this.generatePendingId();                                                                                                                              
                                                                                                                                                                                  
          const message = {                                                                                                                                                       
              type: 'pending_register',                                                                                                                                           
              pending_id: this.pendingId,                                                                                                                                         
              hostname: os.hostname(),                                                                                                                                            
              project: process.cwd(),                                                                                                                                             
              platform: process.platform,                                                                                                                                         
          };                                                                                                                                                                      
                                                                                                                                                                                  
          this.send(message);                                                                                                                                                     
          console.log('[Orchestrator] Sent pending registration, waiting for authorization...');                                                                                  
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle incoming WebSocket message                                                                                                                                        
       */                                                                                                                                                                         
      onMessage(data) {                                                                                                                                                           
          try {                                                                                                                                                                   
              const message = JSON.parse(data);                                                                                                                                   
                                                                                                                                                                                  
              switch (message.type) {                                                                                                                                             
                  case 'pending_registered':                                                                                                                                      
                      this.handlePendingRegistered(message);                                                                                                                      
                      break;                                                                                                                                                      
                                                                                                                                                                                  
                  case 'token_granted':                                                                                                                                           
                      this.handleTokenGranted(message);                                                                                                                           
                      break;                                                                                                                                                      
                                                                                                                                                                                  
                  case 'authorization_denied':                                                                                                                                    
                      this.handleAuthorizationDenied(message);                                                                                                                    
                      break;                                                                                                                                                      
                                                                                                                                                                                  
                  case 'authorization_timeout':                                                                                                                                   
                      this.handleAuthorizationTimeout(message);                                                                                                                   
                      break;                                                                                                                                                      
                                                                                                                                                                                  
                  case 'pong':                                                                                                                                                    
                      // Heartbeat response - no action needed                                                                                                                    
                      break;                                                                                                                                                      
                                                                                                                                                                                  
                  // ... existing message handlers ...                                                                                                                            
                                                                                                                                                                                  
                  default:                                                                                                                                                        
                      console.log('[Orchestrator] Unknown message type:', message.type);                                                                                          
              }                                                                                                                                                                   
          } catch (error) {                                                                                                                                                       
              console.error('[Orchestrator] Error parsing message:', error);                                                                                                      
          }                                                                                                                                                                       
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle pending registration acknowledgment                                                                                                                               
       */                                                                                                                                                                         
      handlePendingRegistered(message) {                                                                                                                                          
          if (message.success) {                                                                                                                                                  
              console.log('[Orchestrator] Pending registration accepted:', message.message);                                                                                      
          } else {                                                                                                                                                                
              console.error('[Orchestrator] Pending registration failed:', message.message);                                                                                      
          }                                                                                                                                                                       
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle token granted - authorization successful                                                                                                                          
       */                                                                                                                                                                         
      async handleTokenGranted(message) {                                                                                                                                         
          const { token, client_id } = message;                                                                                                                                   
                                                                                                                                                                                  
          console.log('[Orchestrator] Authorization granted! Received token.');                                                                                                   
                                                                                                                                                                                  
          // Store token in database for future connections                                                                                                                       
          await db.saveOrchestratorToken(this.orchestratorHost, token, client_id);                                                                                                
                                                                                                                                                                                  
          // Update config with new token                                                                                                                                         
          this.config.token = token;                                                                                                                                              
          this.pendingMode = false;                                                                                                                                               
                                                                                                                                                                                  
          // Disconnect and reconnect with the new token                                                                                                                          
          console.log('[Orchestrator] Reconnecting with new token...');                                                                                                           
          this.disconnect();                                                                                                                                                      
                                                                                                                                                                                  
          // Small delay before reconnecting                                                                                                                                      
          setTimeout(() => {                                                                                                                                                      
              this.connectWithToken(token);                                                                                                                                       
          }, 1000);                                                                                                                                                               
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle authorization denied                                                                                                                                              
       */                                                                                                                                                                         
      handleAuthorizationDenied(message) {                                                                                                                                        
          console.error('[Orchestrator] Authorization denied:', message.reason);                                                                                                  
          // Could emit an event for the UI to show a notification                                                                                                                
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Handle authorization timeout (10 minutes expired)                                                                                                                        
       */                                                                                                                                                                         
      handleAuthorizationTimeout(message) {                                                                                                                                       
          console.warn('[Orchestrator] Authorization timed out:', message.message);                                                                                               
          // The WebSocket will be closed by the server                                                                                                                           
          // The reconnection logic will attempt to reconnect in pending mode again                                                                                               
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Generate a unique pending ID                                                                                                                                             
       */                                                                                                                                                                         
      generatePendingId() {                                                                                                                                                       
          return `pending_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;                                                                                              
      }                                                                                                                                                                           
                                                                                                                                                                                  
      /**                                                                                                                                                                         
       * Generate a unique client ID                                                                                                                                              
       */                                                                                                                                                                         
      generateClientId() {                                                                                                                                                        
          const hostname = os.hostname();                                                                                                                                         
          const pid = process.pid;                                                                                                                                                
          const random = Math.random().toString(36).substr(2, 8);                                                                                                                 
          return `${hostname}-${pid}-${random}`;                                                                                                                                  
      }                                                                                                                                                                           
  }                                                                                                                                                                               
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Part 4: Configuration                                                                                                                                                           
                                                                                                                                                                                  
  File: .env.example                                                                                                                                                              
                                                                                                                                                                                  
  Add new configuration options:                                                                                                                                                  
                                                                                                                                                                                  
  # Orchestrator connection                                                                                                                                                       
  ORCHESTRATOR_URL=wss://duratii.example.com/ws/connect                                                                                                                           
  ORCHESTRATOR_TOKEN=              # Optional - if empty, pending mode is used                                                                                                    
                                                                                                                                                                                  
  # Claim patterns for pending mode (at least one required if no token)                                                                                                           
  # These determine which users can authorize this client                                                                                                                         
  ORCHESTRATOR_CLAIM_USER=         # GitHub username (e.g., "liamhelmer")                                                                                                         
  ORCHESTRATOR_CLAIM_ORG=          # GitHub org (e.g., "epiphytic")                                                                                                               
  ORCHESTRATOR_CLAIM_TEAM=         # GitHub team (e.g., "epiphytic/developers")                                                                                                   
                                                                                                                                                                                  
  File: server/orchestrator/index.js                                                                                                                                              
                                                                                                                                                                                  
  Update configuration loading:                                                                                                                                                   
                                                                                                                                                                                  
  function createOrchestratorClientFromEnv() {                                                                                                                                    
      const url = process.env.ORCHESTRATOR_URL;                                                                                                                                   
      if (!url) {                                                                                                                                                                 
          return null;                                                                                                                                                            
      }                                                                                                                                                                           
                                                                                                                                                                                  
      return new OrchestratorClient({                                                                                                                                             
          url: url,                                                                                                                                                               
          claimPatterns: {                                                                                                                                                        
              user: process.env.ORCHESTRATOR_CLAIM_USER || '',                                                                                                                    
              org: process.env.ORCHESTRATOR_CLAIM_ORG || '',                                                                                                                      
              team: process.env.ORCHESTRATOR_CLAIM_TEAM || '',                                                                                                                    
          },                                                                                                                                                                      
          reconnectInterval: parseInt(process.env.ORCHESTRATOR_RECONNECT_INTERVAL) || 5000,                                                                                       
          heartbeatInterval: parseInt(process.env.ORCHESTRATOR_HEARTBEAT_INTERVAL) || 30000,                                                                                      
      });                                                                                                                                                                         
  }                                                                                                                                                                               
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Implementation Order                                                                                                                                                            
                                                                                                                                                                                  
  1. Database schema and functions - Add orchestrator_tokens table and CRUD functions                                                                                             
  2. Token resolution - Implement resolveOrchestratorToken() with precedence                                                                                                      
  3. Protocol updates - Add new message types                                                                                                                                     
  4. Pending mode connection - Add connectPending() and sendPendingRegister()                                                                                                     
  5. Token granted handler - Store token and reconnect                                                                                                                            
  6. Configuration - Add new environment variables                                                                                                                                
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Testing                                                                                                                                                                         
                                                                                                                                                                                  
  1. Without token: Remove ORCHESTRATOR_TOKEN from .env, set ORCHESTRATOR_CLAIM_USER to your GitHub username                                                                      
  2. Start claudecodeui: Should connect in pending mode                                                                                                                           
  3. Open duratii dashboard: Should see pending client in "Pending Authorization" section                                                                                         
  4. Click Authorize: claudecodeui should receive token, store it, and reconnect                                                                                                  
  5. Restart claudecodeui: Should use stored token automatically (no pending mode)                                                                                                
  6. With .env token: Set ORCHESTRATOR_TOKEN - should use that instead of database token                                                                                          
                                                                                                                                                                                  
  ---                                                                                                                                                                             
  Message Protocol Reference                                                                                                                                                      
                                                                                                                                                                                  
  Outbound (claudecodeui → orchestrator)                                                                                                                                          
                                                                                                                                                                                  
  // Pending registration                                                                                                                                                         
  {                                                                                                                                                                               
      type: "pending_register",                                                                                                                                                   
      pending_id: string,                                                                                                                                                         
      hostname: string,                                                                                                                                                           
      project: string,                                                                                                                                                            
      platform: string                                                                                                                                                            
  }                                                                                                                                                                               
                                                                                                                                                                                  
  // Heartbeat                                                                                                                                                                    
  {                                                                                                                                                                               
      type: "ping",                                                                                                                                                               
      pending_id: string                                                                                                                                                          
  }                                                                                                                                                                               
                                                                                                                                                                                  
  Inbound (orchestrator → claudecodeui)                                                                                                                                           
                                                                                                                                                                                  
  // Registration acknowledged                                                                                                                                                    
  {                                                                                                                                                                               
      type: "pending_registered",                                                                                                                                                 
      success: boolean,                                                                                                                                                           
      message?: string                                                                                                                                                            
  }                                                                                                                                                                               
                                                                                                                                                                                  
  // Token granted (authorization successful)                                                                                                                                     
  {                                                                                                                                                                               
      type: "token_granted",                                                                                                                                                      
      token: string,      // Full token: "ao_xxx_yyy"                                                                                                                             
      client_id: string   // Assigned client ID                                                                                                                                   
  }                                                                                                                                                                               
                                                                                                                                                                                  
  // Authorization denied                                                                                                                                                         
  {                                                                                                                                                                               
      type: "authorization_denied",                                                                                                                                               
      reason: string                                                                                                                                                              
  }                                                                                                                                                                               
                                                                                                                                                                                  
  // Authorization timeout (10 minutes)                                                                                                                                           
  {                                                                                                                                                                               
      type: "authorization_timeout",                                                                                                                                              
      message: string                                                                                                                                                             
  }                                                                                                                                                                               
                                                                                                                                                                                  
  // Heartbeat response                                                                                                                                                           
  {                                                                                                                                                                               
      type: "pong",                                                                                                                                                               
      pending_id: string                                                                                                                                                          
  }                                                                                                                                                                               

