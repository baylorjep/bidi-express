// Disable debug logging in production to avoid missing common.js error
process.env.DEBUG = '';

require('dotenv').config(); // Load environment variables
const express = require("express");
const cors = require("cors"); 
const bodyParser = require('body-parser');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const supabase = require('./supabaseClient');
const { generateAutoBidForBusiness } = require('./Autobid');
const googleCalendarRoutes = require('./google-calendar/routes');
const googlePlacesRoutes = require('./google-places/routes');
const authRoutes = require('./auth/routes');
const http = require("http");
const { Server } = require("socket.io");
// Validate Stripe configuration
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
  process.exit(1);
}

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY,
  {
    apiVersion: "2024-12-18.acacia",
  }
);

// Test Stripe connection
stripe.accounts.list({ limit: 1 }).then(() => {
  console.log('✅ Stripe connection successful');
}).catch((error) => {
  console.error('❌ Stripe connection failed:', error.message);
});
const crypto = require('crypto');

// Initialize OpenAI for training functions
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();

// Trust proxy - needed for proper rate limiting behind Vercel
app.set('trust proxy', 1);

// Debug environment
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('VERCEL_ENV:', process.env.VERCEL_ENV);

// CORS configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://www.savewithbidi.com',
      'https://savewithbidi.com',
      'https://www.bidievents.com',
      'https://bidievents.com',
      'http://localhost:3000',
      'https://bidi-express.vercel.app' // Add the Vercel domain
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      // For debugging, allow all origins temporarily
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  maxAge: 86400 // 24 hours
};

app.use(cors(corsOptions));

// Handle preflight requests
app.options('*', cors(corsOptions));

// Security middleware
app.use((req, res, next) => {
  // Set security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';");
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Debug middleware for payment endpoints
app.use('/account', (req, res, next) => {
  console.log('Account endpoint request:', {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'origin': req.headers['origin'],
      'user-agent': req.headers['user-agent']
    },
    body: req.body,
    url: req.url,
    contentType: req.get('Content-Type')
  });
  next();
});

app.use('/account_session', (req, res, next) => {
  console.log('Account session endpoint request:', {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'origin': req.headers['origin'],
      'user-agent': req.headers['user-agent']
    },
    body: req.body,
    url: req.url,
    contentType: req.get('Content-Type')
  });
  next();
});

// Test endpoint to verify server is working
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    stripe_configured: !!process.env.STRIPE_SECRET_KEY
  });
});

// Test Stripe connection endpoint
app.get('/test-stripe', async (req, res) => {
  try {
    const accounts = await stripe.accounts.list({ limit: 1 });
    res.json({ 
      status: 'ok',
      stripe_working: true,
      accounts_count: accounts.data.length
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error',
      stripe_working: false,
      error: error.message
    });
  }
});

// Serve static files (logo, favicon, etc.)
app.use('/static', express.static('public'));

// Mount Auth routes first
app.use('/api/auth', authRoutes);

// Mount Google Calendar routes
app.use('/api/google-calendar', googleCalendarRoutes);

// Mount Google Places routes
app.use('/api/google-places', googlePlacesRoutes);

// Business Profile routes
app.get('/api/business-profiles/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from('business_profiles')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Business profile not found' });
    }
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching business profile:', error);
    res.status(500).json({ error: 'Failed to fetch business profile' });
  }
});

// In-memory log storage (for development/debugging)
const logStore = {
  logs: [],
  maxLogs: 1000, // Keep last 1000 logs
  addLog(level, message, data = null) {
    // Sanitize sensitive data before logging
    let sanitizedData = null;
    if (data) {
      if (typeof data === 'object') {
        sanitizedData = this.sanitizeData(data);
      } else {
        sanitizedData = data;
      }
    }
    
    const logEntry = {
      id: Date.now() + Math.random(),
      timestamp: new Date().toISOString(),
      level,
      message,
      data: sanitizedData ? JSON.stringify(sanitizedData, null, 2) : null
    };
    
    this.logs.unshift(logEntry); // Add to beginning
    
    // Keep only the last maxLogs entries
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(0, this.maxLogs);
    }
    
    // Also log to console for Vercel (with sanitized data)
    console.log(`[${logEntry.timestamp}] [${level.toUpperCase()}] ${message}`, sanitizedData || '');
  },
  
  // Sanitize sensitive data
  sanitizeData(data) {
    if (!data || typeof data !== 'object') return data;
    
    const sanitized = { ...data };
    
    // Remove sensitive fields from request bodies
    const sensitiveFields = [
      'email', 'phone', 'name', 'first_name', 'last_name', 'address', 'location',
      'additional_comments', 'special_requests', 'dietary_restrictions',
      'music_preferences', 'hairstyle_preferences', 'makeup_style_preferences',
      'flower_preferences', 'style_preferences', 'colors'
    ];
    
    sensitiveFields.forEach(field => {
      if (sanitized[field] !== undefined) {
        sanitized[field] = '[REDACTED]';
      }
    });
    
    // Sanitize nested objects
    Object.keys(sanitized).forEach(key => {
      if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizeData(sanitized[key]);
      }
    });
    
    return sanitized;
  }
};

// Enhanced logging functions
const logger = {
  info: (message, data) => logStore.addLog('info', message, data),
  warn: (message, data) => logStore.addLog('warn', message, data),
  error: (message, data) => logStore.addLog('error', message, data),
  debug: (message, data) => logStore.addLog('debug', message, data)
};

// Landing page with logs viewer
app.get("/", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bidi Express API</title>
    <link rel="icon" type="image/png" href="/static/Bidi-Favicon.png">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            color: #333;
        }
        
        .main-container {
            max-width: 1200px;
            margin: 0 auto;
            padding: 2rem;
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            text-align: center;
            margin-bottom: 2rem;
        }
        
        .logo {
            margin-bottom: 1.5rem;
        }
        
        .logo img {
            max-width: 200px;
            height: auto;
            display: block;
            margin: 0 auto;
        }
        
        .logo-text {
            font-size: 2.5rem;
            font-weight: bold;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 1rem;
        }
        
        .status {
            font-size: 1.2rem;
            color: #4CAF50;
            font-weight: 600;
            margin-bottom: 1.5rem;
        }
        
        .description {
            color: #666;
            line-height: 1.6;
            margin-bottom: 2rem;
        }
        
        .content-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 2rem;
        }
        
        .endpoints, .logs-section {
            background: white;
            border-radius: 20px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .endpoints h3, .logs-section h3 {
            color: #333;
            margin-bottom: 1rem;
            font-size: 1.1rem;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        
        .endpoint {
            background: #f8f9fa;
            border-radius: 8px;
            padding: 0.8rem;
            margin-bottom: 0.5rem;
            border-left: 4px solid #667eea;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.9rem;
        }
        
        .logs-container {
            max-height: 600px;
            overflow-y: auto;
            background: #1e1e1e;
            border-radius: 8px;
            padding: 1rem;
            font-family: 'Monaco', 'Menlo', monospace;
            font-size: 0.85rem;
            line-height: 1.4;
        }
        
        .log-entry {
            margin-bottom: 0.5rem;
            padding: 0.5rem;
            border-radius: 4px;
            border-left: 3px solid #666;
        }
        
        .log-entry.info {
            background: rgba(0, 123, 255, 0.1);
            border-left-color: #007bff;
        }
        
        .log-entry.warn {
            background: rgba(255, 193, 7, 0.1);
            border-left-color: #ffc107;
        }
        
        .log-entry.error {
            background: rgba(220, 53, 69, 0.1);
            border-left-color: #dc3545;
        }
        
        .log-entry.debug {
            background: rgba(108, 117, 125, 0.1);
            border-left-color: #6c757d;
        }
        
        .log-timestamp {
            color: #888;
            font-size: 0.8rem;
        }
        
        .log-level {
            font-weight: bold;
            margin: 0 0.5rem;
        }
        
        .log-level.info { color: #007bff; }
        .log-level.warn { color: #ffc107; }
        .log-level.error { color: #dc3545; }
        .log-level.debug { color: #6c757d; }
        
        .log-message {
            color: #e0e0e0;
        }
        
        .log-data {
            color: #888;
            font-size: 0.8rem;
            margin-top: 0.5rem;
            white-space: pre-wrap;
            word-break: break-all;
        }
        
        .controls {
            margin-bottom: 1rem;
            display: flex;
            gap: 1rem;
            align-items: center;
        }
        
        .btn {
            background: #667eea;
            color: white;
            border: none;
            padding: 0.5rem 1rem;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: background 0.2s;
        }
        
        .btn:hover {
            background: #5a6fd8;
        }
        
        .btn.danger {
            background: #dc3545;
        }
        
        .btn.danger:hover {
            background: #c82333;
        }
        
        .auto-refresh {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        
        .auto-refresh input {
            margin: 0;
        }
        
        .timestamp {
            color: #999;
            font-size: 0.9rem;
            margin-top: 1rem;
            text-align: center;
        }
        
        .health-indicator {
            display: inline-block;
            width: 12px;
            height: 12px;
            background: #4CAF50;
            border-radius: 50%;
            margin-right: 8px;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        
        @media (max-width: 768px) {
            .content-grid {
                grid-template-columns: 1fr;
            }
            
            .main-container {
                padding: 1rem;
            }
        }
    </style>
</head>
    <body>
        <div class="main-container">
            <div class="header">
                <div class="logo">
                    <img src="/static/logo.svg" alt="Bidi Logo" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'; console.log('Logo failed to load');" onload="console.log('Logo loaded successfully');">
                    <div class="logo-text" style="display: none;">🚀 Bidi Express</div>
                </div>
                <div class="status">
                    <span class="health-indicator"></span>
                    API Server Running
                </div>
                <div class="description">
                    Bidi Express is online and ready to serve requests.
                </div>
            </div>
            
            <div class="content-grid">
                <div class="endpoints">
                    <h3>🔗 Available Endpoints</h3>
                    <div class="endpoint">GET /api/health - Health check</div>
                    <div class="endpoint">GET /api/test - CORS test</div>
                    <div class="endpoint">GET /api/logs - View server logs</div>
                    <div class="endpoint">GET /api/business-profiles/:id - Business profiles</div>
                    <div class="endpoint">POST /trigger-autobid - Production autobidding</div>
                    <div class="endpoint">POST /api/autobid/generate-sample-bid - AI training</div>
                    <div class="endpoint">POST /api/autobid/training-feedback - Training feedback</div>
                    <div class="endpoint">GET /api/autobid/training-data/:id/:category - Training data</div>
                    <div class="endpoint">GET /api/autobid/training-status/:id - Training status</div>
                    <div class="endpoint">POST /account_session - Stripe onboarding</div>
                    <div class="endpoint">POST /account - Stripe account creation</div>
                    <div class="endpoint">POST /create-checkout-session - Stripe payments</div>
                    <div class="endpoint">POST /check-payment-status - Payment status</div>
                    <div class="endpoint">POST /create-login-link - Stripe login</div>
                    <div class="endpoint">GET /check-account-capabilities/:id - Account capabilities</div>
                    <div class="endpoint">POST /webhook - Stripe webhooks</div>
                    <div class="endpoint">POST /api/auth/* - Authentication routes</div>
                    <div class="endpoint">POST /api/google-calendar/* - Google Calendar integration</div>
                    <div class="endpoint">POST /api/google-places/* - Google Places integration</div>
                </div>
                
                <div class="logs-section">
                    <h3>
                        📊 Server Logs
                        <span id="log-count">(0 logs)</span>
                    </h3>
                    <div class="controls">
                        <button class="btn" onclick="refreshLogs()">🔄 Refresh</button>
                        <button class="btn danger" onclick="clearLogs()">🗑️ Clear</button>
                        <div class="auto-refresh">
                            <input type="checkbox" id="auto-refresh" onchange="toggleAutoRefresh()">
                            <label for="auto-refresh">Auto-refresh (5s)</label>
                        </div>
                    </div>
                    <div class="logs-container" id="logs-container">
                        <div style="color: #888; text-align: center; padding: 2rem;">
                            Loading logs...
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="timestamp">
                Last updated: ${new Date().toLocaleString()}
            </div>
        </div>
        
        <script>
            let autoRefreshInterval = null;
            
            function refreshLogs() {
                fetch('/api/logs')
                    .then(response => response.json())
                    .then(data => {
                        const container = document.getElementById('logs-container');
                        const countElement = document.getElementById('log-count');
                        
                        countElement.textContent = \`(\${data.logs.length} logs)\`;
                        
                        if (data.logs.length === 0) {
                            container.innerHTML = '<div style="color: #888; text-align: center; padding: 2rem;">No logs available</div>';
                            return;
                        }
                        
                        container.innerHTML = data.logs.map(log => {
                            const timestamp = new Date(log.timestamp).toLocaleTimeString();
                            return \`
                                <div class="log-entry \${log.level}">
                                    <span class="log-timestamp">\${timestamp}</span>
                                    <span class="log-level \${log.level}">[\${log.level.toUpperCase()}]</span>
                                    <span class="log-message">\${log.message}</span>
                                    \${log.data ? \`<div class="log-data">\${log.data}</div>\` : ''}
                                </div>
                            \`;
                        }).join('');
                        
                        // Auto-scroll to bottom for new logs
                        container.scrollTop = container.scrollHeight;
                    })
                    .catch(error => {
                        console.error('Error fetching logs:', error);
                        document.getElementById('logs-container').innerHTML = 
                            '<div style="color: #dc3545; text-align: center; padding: 2rem;">Error loading logs</div>';
                    });
            }
            
            function clearLogs() {
                if (confirm('Are you sure you want to clear all logs?')) {
                    fetch('/api/logs', { method: 'DELETE' })
                        .then(() => refreshLogs())
                        .catch(error => console.error('Error clearing logs:', error));
                }
            }
            
            function toggleAutoRefresh() {
                const checkbox = document.getElementById('auto-refresh');
                if (checkbox.checked) {
                    autoRefreshInterval = setInterval(refreshLogs, 5000);
                } else {
                    if (autoRefreshInterval) {
                        clearInterval(autoRefreshInterval);
                        autoRefreshInterval = null;
                    }
                }
            }
            
            // Load logs on page load
            refreshLogs();
        </script>
    </body>
</html>
  `;
  
  res.send(html);
});

// Test endpoint for CORS
app.get("/api/test", (req, res) => {
  res.json({ 
    message: "API is working", 
    timestamp: new Date().toISOString(),
    cors: "enabled"
  });
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Logs endpoint
app.get("/api/logs", (req, res) => {
  const { level, limit = 100 } = req.query;
  
  let logs = logStore.logs;
  
  // Filter by level if specified
  if (level) {
    logs = logs.filter(log => log.level === level);
  }
  
  // Limit results
  logs = logs.slice(0, parseInt(limit));
  
  res.json({
    logs,
    total: logStore.logs.length,
    filtered: logs.length,
    level: level || 'all'
  });
});

// Clear logs endpoint
app.delete("/api/logs", (req, res) => {
  logStore.logs = [];
  logger.info("Logs cleared by user request");
  res.json({ message: "Logs cleared successfully" });
});

// Handle OPTIONS requests for the account_session endpoint
app.options("/account_session", (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).end();
});

// This is the endpoint to create an account session for Stripe onboarding
app.post("/account_session", async (req, res) => {
  try {
    // Add proper CORS headers for this endpoint
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Validate request body
    if (!req.body) {
      console.error("No request body received");
      return res.status(400).json({ 
        error: "Request body is required",
        received: req.body,
        contentType: req.get('Content-Type')
      });
    }

    // Log the request details for debugging
    console.log("Account session request details:", {
      contentType: req.get('Content-Type'),
      body: req.body,
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body'
    });

    // Check for account in different possible locations
    const accountId = req.body.account || req.body.accountId || req.body.account_id;
    if (!accountId) {
      console.error("Missing account in request body:", req.body);
      return res.status(400).json({ 
        error: "Account ID is required (account, accountId, or account_id)",
        received: req.body 
      });
    }

    console.log("Creating account session for account:", accountId);

    let accountSession;
    try {
      // Try account sessions first (newer API)
      accountSession = await stripe.accountSessions.create({
        account: accountId,
        components: {
          account_onboarding: { enabled: true },
        },
      });

      console.log("Account session created successfully");
    } catch (stripeError) {
      console.error("Account sessions not available, trying account links:", stripeError.message);
      
      // Fallback to account links (older API)
      try {
        const accountLink = await stripe.accountLinks.create({
          account: accountId,
          refresh_url: 'https://www.savewithbidi.com/payment-setup',
          return_url: 'https://www.savewithbidi.com/payment-setup',
          type: 'account_onboarding',
        });

        console.log("Account link created successfully");
        return res.json({
          url: accountLink.url,
        });
      } catch (linkError) {
        console.error("Both account sessions and account links failed:", {
          sessionError: stripeError.message,
          linkError: linkError.message
        });
        throw stripeError; // Throw the original error
      }
    }

    res.json({
      client_secret: accountSession.client_secret,
    });
  } catch (error) {
    console.error(
      "An error occurred when calling the Stripe API to create an account session",
      error
    );
    res.status(500).json({ 
      error: error.message,
      details: error.type || 'unknown_error'
    });
  }
});

// Handle OPTIONS requests for the account endpoint
app.options("/account", (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(200).end();
});

// This is the endpoint for creating a connected account
app.post("/account", async (req, res) => {
  try {
    // Add proper CORS headers for this endpoint
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Validate request body
    if (!req.body) {
      console.error("No request body received");
      return res.status(400).json({ 
        error: "Request body is required",
        received: req.body,
        contentType: req.get('Content-Type')
      });
    }

    // Log the request details for debugging
    console.log("Account request details:", {
      contentType: req.get('Content-Type'),
      body: req.body,
      bodyType: typeof req.body,
      bodyKeys: req.body ? Object.keys(req.body) : 'no body'
    });

    // Check for email in different possible locations
    const email = req.body.email || req.body.userEmail || req.body.user_email;
    if (!email) {
      console.error("Missing email in request body:", req.body);
      return res.status(400).json({ 
        error: "Email is required (email, userEmail, or user_email)",
        received: req.body 
      });
    }

    console.log("Creating Stripe account for email:", email);

    let account;
    try {
      account = await stripe.accounts.create({
        type: "express",
        country: "US", // Adjust if needed
        email: email,
      });

      console.log("Stripe account created successfully:", account.id);
    } catch (stripeError) {
      console.error("Stripe account creation failed:", {
        error: stripeError.message,
        type: stripeError.type,
        code: stripeError.code,
        decline_code: stripeError.decline_code,
        param: stripeError.param
      });
      throw stripeError;
    }

    res.json({
      account: account.id,
    });
  } catch (error) {
    console.error(
      "An error occurred when calling the Stripe API to create an account",
      error
    );
    res.status(500).json({ 
      error: error.message,
      details: error.type || 'unknown_error'
    });
  }
});

// This is the endpoint to create a Checkout Session with destination charge
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { connectedAccountId, amount, serviceName } = req.body;

    console.log("Request Body:", req.body); // Log the incoming request data

    // Validate that the required fields are present
    if (!connectedAccountId || !amount || !serviceName) {
      console.error("Missing required fields in request");
      return res.status(400).send("Missing required fields");
    }

    // Calculate the 5% application fee from the business's portion
    const applicationFeeAmount = Math.round(amount * 0.1); // 10% of the amount in cents

    // Create a Checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: serviceName, 
            },
            unit_amount: amount, // Price in cents (e.g., 5000 for $50)
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: applicationFeeAmount, // Fee amount in cents (e.g., 500 for $5)
        transfer_data: {
          destination: connectedAccountId, // businesses connected account ID
        },
      },
      mode: 'payment',
      ui_mode: 'embedded',
      return_url: 'https://www.savewithbidi.com/payment-status',
    });

    console.log("Checkout session created:", session); // Log the session data

    // Send the session ID back to the frontend
    res.json({ client_secret: session.client_secret });
  } catch (error) {
    console.error(
      "An error occurred when creating the Checkout Session",
      error
    );
    res.status(500).send({ error: error.message });
  }
});

app.post('/check-payment-status', async (req, res) => {
  const { paymentIntentId } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status === 'succeeded') {
      res.json({ success: true });
    } else {
      res.json({ success: false });
    }
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Create a login link for the connected account
app.post("/create-login-link", async (req, res) => {
  const { accountId } = req.body; // The connected account ID
  try {
    const loginLink = await stripe.accounts.createLoginLink(accountId);
    res.json({ url: loginLink.url });
  } catch (error) {
    console.error("Failed to create login link:", error);
    res.status(500).send({ error: error.message });
  }
});

// For local development, you can still listen on a port
if (process.env.NODE_ENV !== 'production') {
  app.listen(4242, () => {
    console.log("Node server listening on port 4242! Visit http://localhost:4242");
  });
}

// Endpoint to check connected account capabilities
app.get('/check-account-capabilities/:accountId', async (req, res) => {
  const { accountId } = req.params;

  try {
    const account = await stripe.accounts.retrieve(accountId);
    console.log(account.capabilities);

    res.json({
      capabilities: account.capabilities,
    });
  } catch (error) {
    console.error('Error retrieving account:', error);
    res.status(500).json({ error: error.message });
  }
});

// Simple endpoints for Stripe account verification and deletion (for frontend compatibility)
app.post("/verify-account", async (req, res) => {
  try {
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: "Account ID is required" });
    }

    console.log(`🔍 Verifying Stripe account: ${accountId}`);

    // Retrieve the account from Stripe
    const account = await stripe.accounts.retrieve(accountId);
    
    // Check if the account is valid and properly set up
    const isValid = account && 
                   account.details_submitted && 
                   account.charges_enabled && 
                   account.payouts_enabled;

    console.log(`✅ Account verification result:`, {
      accountId,
      isValid,
      details_submitted: account.details_submitted,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled
    });

    res.json({ isValid });
  } catch (error) {
    console.error("❌ Error verifying account:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/delete-account", async (req, res) => {
  try {
    const { accountId } = req.body;
    
    if (!accountId) {
      return res.status(400).json({ error: "Account ID is required" });
    }

    console.log(`🗑️ Deleting Stripe account: ${accountId}`);

    // Delete the account from Stripe
    const deletedAccount = await stripe.accounts.del(accountId);
    
    console.log(`✅ Account deleted successfully:`, {
      accountId: deletedAccount.id,
      deleted: deletedAccount.deleted
    });

    res.json({ 
      success: true, 
      message: "Account deleted successfully",
      accountId: deletedAccount.id 
    });
  } catch (error) {
    console.error("❌ Error deleting account:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check for Stripe connection
app.get("/stripe-health", async (req, res) => {
  try {
    console.log("🏥 Performing Stripe health check...");
    
    // Test Stripe connection by making a simple API call
    const balance = await stripe.balance.retrieve();
    
    console.log("✅ Stripe health check passed");
    
    res.json({ 
      status: "healthy", 
      stripe_connected: true,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("❌ Stripe health check failed:", error);
    res.status(500).json({ 
      status: "unhealthy", 
      stripe_connected: false,
      error: error.message 
    });
  }
});

// Webhook for stripe
// Your webhook secret from the Stripe Dashboard (calls on env file)
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Webhook endpoint
app.post('/webhook', bodyParser.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    // Verify the event using the Stripe webhook secret
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('Webhook signature verification failed.', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      handleCheckoutSessionCompleted(session);
      break;

    case 'payment_intent.succeeded':
      const paymentIntent = event.data.object;
      handlePaymentIntentSucceeded(paymentIntent);
      break;

    case 'payment_intent.payment_failed':
      const failedPaymentIntent = event.data.object;
      handlePaymentIntentFailed(failedPaymentIntent);
      break;

    default:
      console.warn(`Unhandled event type ${event.type}`);
  }

  // Return a response to acknowledge receipt of the event()
  res.json({ received: true });
});

// Define functions to handle specific events
async function handleCheckoutSessionCompleted(session) {
  try {
    // Implement logic to update your database and application state
    const connectedAccountId = session.payment_intent;
    const bidId = session.metadata.bid_id; // Assuming you passed bid_id as metadata
    const amount = session.amount_total;

    console.log(`Checkout session completed for amount ${amount} to account ${connectedAccountId} for bidID ${bidId}`);

    // Update the bid status to 'paid' in your Supabase database
    const { data, error } = await supabase
      .from('bids')
      .update({ status: 'paid' })
      .eq('id', bidId);

    if (error) {
      console.error('Error updating bid status:', error.message);
    } else {
      console.log(`Bid ${bidId} status updated to 'paid'`);
    }
  } catch (error) {
    console.error('Error in handleCheckoutSessionCompleted function:', error.message);
  }
}

async function handlePaymentIntentSucceeded(paymentIntent) {
  console.log(`PaymentIntent for ${paymentIntent.amount} was successful!`);
  // Implement logic to update your database and application state
  // Example: Update database to reflect successful payment
  // await updateDatabaseForSuccessfulPayment(paymentIntent);
}

async function handlePaymentIntentFailed(paymentIntent) {
  console.error(`PaymentIntent for ${paymentIntent.amount} failed.`);
  // Implement logic to handle a failed payment
  // Example: Update database to reflect failed payment
  // await updateDatabaseForFailedPayment(paymentIntent);
}

// Nodemailer SMTP/email setup
const SibApiV3Sdk = require('sib-api-v3-sdk');

// Initialize Brevo client
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY; // Store your API key securely

// Middleware
app.use(bodyParser.json());

// Function to send an email via Brevo
const sendEmailNotification = async (recipientEmail, subject, htmlContent) => {
    try {
        const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail({
            to: [{ email: recipientEmail }],
            sender: { name: 'Bidi', email: 'savewithbidi@gmail.com' },
            subject: subject,
            htmlContent: htmlContent
        });

        const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
        console.log('API called successfully. Returned data: ' + data);
    } catch (error) {
        console.error('Error sending email:', error);
    }
};

// Endpoint for sending email notifications
app.post('/send-email', async (req, res) => {
    const { recipientEmail, subject, htmlContent } = req.body;

    try {
        await sendEmailNotification(recipientEmail, subject, htmlContent);
        res.status(200).send('Email sent successfully');
    } catch (error) {
        res.status(500).send('Error sending email: ' + error.message);
    }
});

app.post('/create-plus-checkout-session', async (req, res) => {
  const { userId } = req.body; // Pass the user ID from the frontend

  if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
  }

  try {
      // Create a Stripe Checkout session
      const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          mode: 'subscription',
          line_items: [
              {
                  price: 'price_1QNIzyF25aBU3RMPEpbxhWN7', // Your Stripe Price ID
                  quantity: 1,
              },
          ],
          customer_email: req.body.email, // Optional if you want to link it to an email
          metadata: {
              userId, // Pass the userId as metadata for the webhook
          },
          success_url: 'https://www.savewithbidi.com/success?session_id={CHECKOUT_SESSION_ID}',
          cancel_url: 'https://www.savewithbidi.com/cancel',
      });

      // Return the session URL
      res.json({ url: session.url });
  } catch (error) {
      console.error('Error creating checkout session:', error.message);
      res.status(500).json({ error: error.message });
  }
});

/**
 * Example frontend request for /send-resend-email:
 *
 * fetch('/api/send-resend-email', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     category: 'Photography',
 *     businesses: [
 *       {
 *         email: 'biz1@email.com',
 *         businessName: 'Acme Photography',
 *         budget: '$2,000 - $3,000',
 *         location: 'New York, NY',
 *         date: '2024-07-15'
 *       },
 *       {
 *         email: 'biz2@email.com',
 *         businessName: 'Best Snaps',
 *         budget: '$1,500 - $2,500',
 *         location: 'Boston, MA',
 *         date: '2024-08-01'
 *       }
 *     ]
 *   })
 * })
 * .then(res => res.json())
 * .then(data => console.log(data));
 */
// Resend email endpoint
app.post('/api/send-resend-email', async (req, res) => {
  const { category, businesses } = req.body;

  if (!category) {
    return res.status(400).json({ error: "Missing required field: category." });
  }

  try {
    let recipients = [];

    if (Array.isArray(businesses) && businesses.length > 0) {
      // Use provided businesses array
      recipients = businesses.filter(biz => biz.email && biz.businessName && biz.budget && biz.location && biz.date);
    } else {
      // Fallback: fetch from Supabase as before
    const { data: users, error: usersError } = await supabase
      .from('business_profiles')
        .select('id, business_name')
      .eq('business_category', category);

    if (usersError) {
      console.error("Error fetching users by category:", usersError.message);
      return res.status(500).json({ error: "Failed to fetch users by category." });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ error: `No users found in category: ${category}.` });
    }

    const userIds = users.map(user => user.id);
    const { data: emails, error: emailsError } = await supabase
      .from('profiles')
        .select('id, email')
      .in('id', userIds);

    if (emailsError) {
      console.error("Error fetching emails:", emailsError.message);
      return res.status(500).json({ error: "Failed to fetch emails for users." });
    }

      // You may want to fetch budget/location/date from somewhere else or set as "N/A"
      recipients = users.map(user => {
        const emailObj = emails.find(e => e.id === user.id);
        return {
          email: emailObj?.email,
          businessName: user.business_name || "Business",
          budget: "N/A",
          location: "N/A",
          date: "N/A"
        };
      }).filter(r => r.email);
    }

    // Batch sending (2 per second)
    const batchSize = 2;
    let batchIndex = 0;

    while (batchIndex < recipients.length) {
      const batch = recipients.slice(batchIndex, batchIndex + batchSize);

      await Promise.all(
        batch.map(async ({ email, businessName, budget, location, date }) => {
          const htmlContent = `
            <!DOCTYPE html>
            <html>
              <body style="margin:0; padding:0; background:#f6f9fc;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f9fc; padding:40px 0;">
                  <tr>
                    <td align="center">
                      <table width="480" cellpadding="0" cellspacing="0" style="background:#fff; border-radius:12px; box-shadow:0 2px 8px rgba(0,0,0,0.05); padding:32px;">
                        <tr>
                          <td align="center" style="padding-bottom:24px;">
                            <img src="https://i.imgur.com/LBdztzj.png" alt="Bidi Logo" width="120" style="display:block; margin:0 auto 12px;" />
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="font-family:Segoe UI,Arial,sans-serif; color:#222; font-size:22px; font-weight:600; padding-bottom:12px;">
                            Hi ${businessName},
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="font-family:Segoe UI,Arial,sans-serif; color:#444; font-size:16px; padding-bottom:24px;">
                            You have a new <b>${category}</b> request waiting for you on Bidi!
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="padding-bottom:24px;">
                            <table style="margin: 0 auto; background: #f6f9fc; border-radius: 8px; padding: 16px;">
                              <tr>
                                <td style="padding: 4px 12px;"><b>Budget:</b></td>
                                <td style="padding: 4px 12px;">${budget}</td>
                              </tr>
                              <tr>
                                <td style="padding: 4px 12px;"><b>Location:</b></td>
                                <td style="padding: 4px 12px;">${location}</td>
                              </tr>
                              <tr>
                                <td style="padding: 4px 12px;"><b>Date:</b></td>
                                <td style="padding: 4px 12px;">${date}</td>
                              </tr>
                            </table>
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="padding-bottom:32px;">
                            <a href="https://www.savewithbidi.com/business-dashboard"
                              style="background:#A328F4; color:#fff; text-decoration:none; font-weight:600; padding:14px 32px; border-radius:8px; font-size:16px; display:inline-block;">
                              View Request
                            </a>
                          </td>
                        </tr>
                        <tr>
                          <td align="center" style="font-family:Segoe UI,Arial,sans-serif; color:#888; font-size:13px;">
                            Best,<br/>The Bidi Team
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </body>
            </html>
          `;

          try {
            await resend.emails.send({
              from: 'noreply@savewithbidi.com',
              to: email,
              subject: `You have a new ${category} request on Bidi!`,
              html: htmlContent,
            });
            console.log(`✅ Email sent to: ${email}`);
          } catch (emailError) {
            console.error(`❌ Failed to send email to ${email}:`, emailError.message);
          }
        })
      );

      batchIndex += batchSize;
      if (batchIndex < recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    res.status(200).json({ message: `Emails sent successfully to all users in category: ${category}.` });

  } catch (error) {
    console.error("Error sending emails:", error.message);
    res.status(500).json({ error: "Failed to send emails.", details: error.message });
  }
});

//Bid Notifications
app.post('/send-bid-notification', async (req, res) => {
  const { requestId } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: "Missing required field: requestId." });
  }

  try {
    console.log(`🔍 Looking up request owner for request ID: ${requestId}`);

    // First, check the `photography_requests` table
    let { data: requestOwner, error: photoError } = await supabase
      .from('photography_requests')
      .select('profile_id')
      .eq('id', requestId)
      .single();

    if (!requestOwner || photoError) {
      console.log(`❌ Not found in photography_requests. Checking requests table...`);

      // If not found, check `requests` table
      const { data: generalRequestOwner, error: requestError } = await supabase
        .from('requests')
        .select('user_id')
        .eq('id', requestId)
        .single();

      if (requestError || !generalRequestOwner) {
        console.error(`❌ No matching request found for request ID: ${requestId}`);
        return res.status(404).json({ error: "No matching request found." });
      }

      requestOwner = { profile_id: generalRequestOwner.user_id };
    }

    console.log(`✅ Found request owner: ${requestOwner.profile_id}`);

    // Fetch user email from `profiles`
    const { data: userProfile, error: profileError } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', requestOwner.profile_id)
      .single();

    if (profileError || !userProfile?.email) {
      console.error("❌ Failed to retrieve user email:", profileError);
      return res.status(500).json({ error: "Failed to retrieve user email." });
    }

    const recipientEmail = userProfile.email;
    console.log(`📩 Sending email to: ${recipientEmail}`);

    // Construct email content
    const subject = "You received a new bid on Bidi!";
    const htmlContent = `
      <p>Hey there!</p>
      <p>Someone just placed a bid on your request.</p>
      <p>Click below to review the bid:</p>
      <p><a href="https://www.savewithbidi.com/my-bids" target="_blank" style="color: #007BFF; text-decoration: none;">View Your Bids</a></p>
      <p>Best,</p>
      <p>The Bidi Team</p>
    `;

    // Send email using Resend
    await resend.emails.send({
      from: 'noreply@savewithbidi.com',
      to: recipientEmail,
      subject,
      html: htmlContent,
    });

    console.log(`✅ Email sent successfully to: ${recipientEmail}`);
    res.status(200).json({ message: "Email sent successfully." });

  } catch (error) {
    console.error("❌ Error sending email notification:", error.message);
    res.status(500).json({ error: "Failed to send email notification.", details: error.message });
  }
});

// Messaging API - Send a message
app.post("/send-message", async (req, res) => {
  const { senderId, receiverId, message } = req.body;

  if (!senderId || !receiverId || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const { data, error } = await supabase.from("messages").insert([
      { sender_id: senderId, receiver_id: receiverId, message },
    ]);

    if (error) {
      console.error("Error sending message:", error);
      return res.status(500).json({ error: "Failed to send message" });
    }

    res.status(201).json({ message: "Message sent successfully!", data });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Autobidding API
app.post('/trigger-autobid', async (req, res) => {
  logger.info("🚀 === TRIGGER-AUTOBID ROUTE STARTED ===");
  logger.debug("📋 Request received for ID:", req.body?.request_id || 'unknown');
  
    const { request_id } = req.body;

    if (!request_id) {
      logger.error("❌ Missing request_id in request body");
        return res.status(400).json({ error: "Missing required field: request_id." });
    }

    try {
        logger.info(`🆕 Auto-bid triggered for Request ID: ${request_id}`);

        // Check for duplicate requests to prevent spam
        const requestKey = `production-${request_id}`;
        if (isDuplicateRequest('production', 'autobid', { request_id })) {
            logger.warn("⚠️ Duplicate production autobid request detected");
            return res.status(429).json({ 
                error: "Duplicate request detected. Please wait a moment before trying again." 
            });
        }

      // Helper function to determine the correct table name based on category
      const getTableNameForCategory = (category) => {
          const categoryMap = {
              'catering': 'catering_requests',
              'dj': 'dj_requests',
              'beauty': 'beauty_requests',
              'florist': 'florist_requests',
              'wedding_planning': 'wedding_planning_requests',
              'videography': 'videography_requests',
              'photography': 'photography_requests'
          };
          
          const normalizedCategory = category.toLowerCase().replace(/\s+/g, '_');
          return categoryMap[normalizedCategory] || null;
      };

      // Fetch request details from the appropriate category table
      logger.info("🔍 Searching for request in category tables...");
      let requestData = null;
      let foundCategory = null;

      const categories = ['catering', 'dj', 'beauty', 'florist', 'wedding_planning', 'videography', 'photography'];
      
      for (const category of categories) {
          const tableName = getTableNameForCategory(category);
          if (!tableName) {
              logger.warn(`⚠️ No table mapping found for category: ${category}`);
              continue;
          }

          logger.debug(`🔍 Checking table: ${tableName}`);
            const { data, error } = await supabase
              .from(tableName)
                .select("*")
                .eq("id", request_id)
                .single();

          if (error) {
              logger.warn(`❌ Error querying ${tableName}:`, error.message);
          } else if (data) {
              logger.info(`✅ Found request in ${tableName}`);
              requestData = data;
              foundCategory = category;
                break;
          } else {
              logger.debug(`📭 No data found in ${tableName}`);
          }
      }

      if (!requestData || !foundCategory) {
          logger.error(`❌ Request not found in any category table for ID: ${request_id}`);
          return res.status(404).json({ error: "Request not found." });
      }

      logger.debug(`🔍 Retrieved request from ${foundCategory} table`);

      // Create standardized request details for the generateAutoBidForBusiness function
      logger.info("📝 Creating standardized request details...");
      const requestDetails = {
          id: requestData.id,
          service_category: foundCategory,
          location: requestData.location || 'Unknown',
          start_date: requestData.start_date || requestData.service_date || 'Unknown',
          end_date: requestData.end_date || 'Unknown',
          additional_comments: requestData.additional_comments || requestData.special_requests || 'No additional comments',
          // Add category-specific fields based on the category
          ...(foundCategory === 'catering' && {
              title: requestData.title,
              event_type: requestData.event_type,
              estimated_guests: requestData.estimated_guests,
              food_preferences: requestData.food_preferences,
              budget_range: requestData.budget_range,
              equipment_needed: requestData.equipment_needed,
              setup_cleanup: requestData.setup_cleanup,
              food_service_type: requestData.food_service_type,
              serving_staff: requestData.serving_staff,
              dietary_restrictions: requestData.dietary_restrictions
          }),
          ...(foundCategory === 'dj' && {
              title: requestData.title,
              event_type: requestData.event_type,
              event_duration: requestData.event_duration,
              estimated_guests: requestData.estimated_guests,
              music_preferences: requestData.music_preferences,
              budget_range: requestData.budget_range,
              equipment_needed: requestData.equipment_needed,
              additional_services: requestData.additional_services,
              special_requests: requestData.special_requests
          }),
          ...(foundCategory === 'beauty' && {
              event_title: requestData.event_title,
              event_type: requestData.event_type,
              service_type: requestData.service_type,
              num_people: requestData.num_people,
              price_range: requestData.price_range,
              hairstyle_preferences: requestData.hairstyle_preferences,
              makeup_style_preferences: requestData.makeup_style_preferences,
              trial_session_hair: requestData.trial_session_hair,
              trial_session_makeup: requestData.trial_session_makeup,
              on_site_service_needed: requestData.on_site_service_needed
          }),
          ...(foundCategory === 'florist' && {
              event_title: requestData.event_title,
              event_type: requestData.event_type,
              price_range: requestData.price_range,
              flower_preferences: requestData.flower_preferences,
              floral_arrangements: requestData.floral_arrangements,
              additional_services: requestData.additional_services,
              colors: requestData.colors
          }),
          ...(foundCategory === 'wedding_planning' && {
              event_title: requestData.event_title,
              event_type: requestData.event_type,
              guest_count: requestData.guest_count,
              planning_level: requestData.planning_level,
              experience_level: requestData.experience_level,
              budget_range: requestData.budget_range,
              planner_budget: requestData.planner_budget,
              communication_style: requestData.communication_style
          }),
          ...(foundCategory === 'videography' && {
              event_title: requestData.event_title,
              event_type: requestData.event_type,
              duration: requestData.duration,
              num_people: requestData.num_people,
              style_preferences: requestData.style_preferences,
              deliverables: requestData.deliverables,
              coverage: requestData.coverage,
              price_range: requestData.price_range
          }),
          ...(foundCategory === 'photography' && {
              event_title: requestData.event_title,
              event_type: requestData.event_type,
              duration: requestData.duration,
              num_people: requestData.num_people,
              style_preferences: requestData.style_preferences,
              deliverables: requestData.deliverables,
              coverage: requestData.coverage,
              price_range: requestData.price_range
          })
      };

      logger.debug("📋 Request details sanitized for category:", requestDetails.service_category);

      // Find businesses with Auto-Bidding enabled
      logger.info("🏢 Fetching businesses with auto-bidding enabled...");
        const { data: autoBidBusinesses, error: businessError } = await supabase
            .from("business_profiles")
          .select("id, autobid_enabled, business_category")
            .eq("autobid_enabled", true);

        if (businessError) {
            logger.error("❌ Error fetching businesses:", businessError.message);
            return res.status(500).json({ error: "Failed to fetch businesses." });
        }

      logger.info(`📊 Found ${autoBidBusinesses?.length || 0} businesses with auto-bidding enabled`);

      // Filter businesses to only include those whose category matches the request's category
      const eligibleBusinesses = autoBidBusinesses.filter(business => {
            const businessCategories = Array.isArray(business.business_category) 
          ? business.business_category.map(cat => cat.toLowerCase())
          : [business.business_category?.toLowerCase() || ''];
        const requestCategory = requestDetails.service_category.toLowerCase();
        
        logger.debug(`🔍 Business ${business.id} categories: ${businessCategories.join(', ')}`);
        
        return businessCategories.includes(requestCategory);
        });

        logger.info(`🔍 Found ${eligibleBusinesses.length} eligible businesses for category: ${requestDetails.service_category}`);
      logger.debug(`🏢 Found ${eligibleBusinesses.length} eligible businesses`);

        let bidsGenerated = [];

        for (const business of eligibleBusinesses) {
        logger.info(`🤖 Generating auto-bid for business: ${business.id}`);
                
                // Double-check that business still has autobid enabled and is active
                const { data: currentBusiness, error: businessCheckError } = await supabase
                    .from("business_profiles")
                    .select("id, autobid_enabled, business_category, status")
                    .eq("id", business.id)
                    .single();

                if (businessCheckError || !currentBusiness) {
                    logger.warn(`⚠️ Business ${business.id} no longer exists or has errors. Skipping.`);
                    bidsGenerated.push({
                        business_id: business.id,
                        status: "business_not_found",
                        error: businessCheckError?.message || "Business not found"
                    });
                    continue;
                }

                if (!currentBusiness.autobid_enabled) {
                    logger.warn(`⚠️ Business ${business.id} has autobid disabled. Skipping.`);
                    bidsGenerated.push({
                        business_id: business.id,
                        status: "autobid_disabled"
                    });
                    continue;
                }

                if (currentBusiness.status === 'inactive' || currentBusiness.status === 'suspended') {
                    logger.warn(`⚠️ Business ${business.id} is inactive (status: ${currentBusiness.status}). Skipping.`);
                    bidsGenerated.push({
                        business_id: business.id,
                        status: "business_inactive",
                        business_status: currentBusiness.status
                    });
                    continue;
                }
                
                try {
                    // Use the same enhanced approach as sample generation for consistency
                    const trainingData = await getBusinessTrainingData(business.id, requestDetails.service_category);
                    logger.info(`📊 Retrieved ${trainingData.responses?.length || 0} training responses for business ${business.id}`);
                    
                    // Check if business has sufficient training data for accurate production bids
                    if (!trainingData.responses || trainingData.responses.length < 3) {
                        logger.warn(`⚠️ Business ${business.id} has insufficient training data (${trainingData.responses?.length || 0} responses). Skipping production bid.`);
                        bidsGenerated.push({
                            business_id: business.id,
                            status: "insufficient_training_data",
                            training_responses_count: trainingData.responses?.length || 0,
                            message: "Business needs at least 3 training responses for production bids"
                        });
                        continue;
                    }
                    
                    // Check if business has pricing rules configured for accurate production bids
                    const { data: pricingRulesData, error: pricingError } = await supabase
                        .from("business_pricing_rules")
                        .select("*")
                        .eq("business_id", business.id)
                        .eq("category", requestDetails.service_category)
                        .order("created_at", { ascending: false })
                        .limit(1);

                    if (pricingError) {
                        logger.warn(`⚠️ Error fetching pricing rules for Business ${business.id}:`, pricingError.message);
                    }

                    if (!pricingRulesData || pricingRulesData.length === 0) {
                        logger.warn(`⚠️ Business ${business.id} has no pricing rules configured for ${requestDetails.service_category}. Skipping production bid.`);
                        bidsGenerated.push({
                            business_id: business.id,
                            status: "no_pricing_rules",
                            message: "Business needs pricing rules configured for production bids"
                        });
                        continue;
                    }

                    // Generate bid using the same logic as sample generation
                    const generatedBid = await generateAIBidForTraining(trainingData, requestDetails, requestDetails.service_category, business.id);
                
                    if (generatedBid) {
                        logger.info(`✅ Auto-bid generated for Business ${business.id}:`, generatedBid);
                        
                        // Store the bid in the production bids table
                        const { error: insertError } = await supabase
                            .from("bids")
                            .insert([
                                {
                                    request_id: requestDetails.id,
                                    user_id: business.id,
                                    bid_amount: generatedBid.amount,
                                    bid_description: generatedBid.description,
                                    category: requestDetails.service_category === 'photography' || requestDetails.service_category === 'videography' ? 'Photography' : 'General',
                                    status: "pending",
                                    hidden: null
                                },
                            ]);

                        if (insertError) {
                            logger.error(`❌ Error inserting bid for Business ${business.id}:`, insertError.message);
                            bidsGenerated.push({
                                business_id: business.id,
                                bid_amount: generatedBid.amount,
                                bid_description: generatedBid.description,
                                status: "generated_but_not_stored",
                                error: insertError.message
                            });
                        } else {
                            logger.info(`💾 Bid successfully stored for Business ${business.id}`);
                            bidsGenerated.push({
                                business_id: business.id,
                                bid_amount: generatedBid.amount,
                                bid_description: generatedBid.description,
                                status: "successfully_stored"
                            });
                        }
                    } else {
                        logger.error(`❌ Failed to generate auto-bid for Business ${business.id}`);
                        bidsGenerated.push({
                            business_id: business.id,
                            status: "generation_failed"
                        });
                    }
                } catch (businessError) {
                    logger.error(`❌ Error processing business ${business.id}:`, businessError.message);
                    bidsGenerated.push({
                        business_id: business.id,
                        status: "error",
                        error: businessError.message
                    });
                }
      }

      logger.info("✅ === TRIGGER-AUTOBID ROUTE COMPLETED SUCCESSFULLY ===");
      
      // Calculate detailed statistics
      const successfulBids = bidsGenerated.filter(bid => bid.status === "successfully_stored").length;
      const failedBids = bidsGenerated.filter(bid => bid.status === "generation_failed").length;
      const insufficientTraining = bidsGenerated.filter(bid => bid.status === "insufficient_training_data").length;
      const noPricingRules = bidsGenerated.filter(bid => bid.status === "no_pricing_rules").length;
      const storageErrors = bidsGenerated.filter(bid => bid.status === "generated_but_not_stored").length;
      const otherErrors = bidsGenerated.filter(bid => bid.status === "error").length;
      const businessNotFound = bidsGenerated.filter(bid => bid.status === "business_not_found").length;
      const autobidDisabled = bidsGenerated.filter(bid => bid.status === "autobid_disabled").length;
      const businessInactive = bidsGenerated.filter(bid => bid.status === "business_inactive").length;
      
      res.status(200).json({
          message: "Auto-bids processed successfully",
          bids: bidsGenerated,
          statistics: {
              total_businesses_processed: eligibleBusinesses.length,
              successful_bids: successfulBids,
              failed_bids: failedBids,
              insufficient_training_data: insufficientTraining,
              no_pricing_rules: noPricingRules,
              storage_errors: storageErrors,
              other_errors: otherErrors,
              business_not_found: businessNotFound,
              autobid_disabled: autobidDisabled,
              business_inactive: businessInactive
          },
          summary: `${successfulBids} bids generated and stored, ${failedBids + insufficientTraining + noPricingRules + businessNotFound + autobidDisabled + businessInactive} businesses skipped due to insufficient setup or inactive status`
      });

            } catch (error) {
          logger.error("❌ === TRIGGER-AUTOBID ROUTE FAILED ===");
    logger.error("Error message:", error.message);
      res.status(500).json({ error: "Failed to trigger auto-bid.", details: error.message });
  }
});

// Add request deduplication tracking
const recentRequests = new Map();

// Helper function to create request key
function createRequestKey(businessId, category, requestData) {
  const key = `${businessId}-${category}-${JSON.stringify(requestData)}`;
  return key;
}

// Helper function to check if request is duplicate
function isDuplicateRequest(businessId, category, requestData) {
  const key = createRequestKey(businessId, category, requestData);
  const now = Date.now();
  const recentRequest = recentRequests.get(key);
  
  if (recentRequest && (now - recentRequest) < 5000) { // 5 second window
    return true;
  }
  
  recentRequests.set(key, now);
  
  // Clean up old entries (older than 1 minute)
  for (const [k, v] of recentRequests.entries()) {
    if (now - v > 60000) {
      recentRequests.delete(k);
    }
  }
  
  return false;
}

// ==================== AUTOBID TRAINING SYSTEM ====================

// 1. AI Bid Generation Endpoint for Training
app.post('/api/autobid/generate-sample-bid', async (req, res) => {
  logger.info("🚀 === GENERATE SAMPLE BID ROUTE STARTED ===");
  logger.debug("📋 Sample bid request for business:", req.body?.business_id || 'unknown');
  
  try {
    const { business_id, category, sample_request, request_data } = req.body;
    
    // Handle both field names for compatibility
    const actualRequest = sample_request || request_data;
    
    if (!business_id || !category || !actualRequest) {
      logger.error("❌ Missing required fields:");
      logger.error("  - business_id:", business_id);
      logger.error("  - category:", category);
      logger.error("  - sample_request:", sample_request);
      logger.error("  - request_data:", request_data);
      logger.error("  - actualRequest:", actualRequest);
      
      return res.status(400).json({ 
        error: "Missing required fields: business_id, category, and either sample_request or request_data" 
      });
    }

    // Check for duplicate requests
    if (isDuplicateRequest(business_id, category, actualRequest)) {
      logger.warn("⚠️ Duplicate request detected, returning cached response");
      return res.status(429).json({ 
        error: "Duplicate request detected. Please wait a moment before trying again." 
      });
    }

    logger.info(`🤖 Generating AI sample bid for Business ${business_id}, Category: ${category}`);

    // 1. Fetch business training data
    const trainingData = await getBusinessTrainingData(business_id, category);
    logger.info(`📊 Retrieved ${trainingData.responses?.length || 0} training responses`);

    // 2. Generate AI bid using training data and pricing rules
    const generatedBid = await generateAIBidForTraining(trainingData, actualRequest, category, business_id);
    logger.info("✅ AI bid generated:", generatedBid);

    // Validate generated bid has all required fields
    if (!generatedBid || typeof generatedBid !== 'object') {
      logger.error("❌ Generated bid is invalid:", generatedBid);
      return res.status(500).json({ error: "Failed to generate valid bid" });
    }

    // Ensure all required fields exist
    const validatedBid = {
      amount: generatedBid.amount || 0,
      description: generatedBid.description || 'No description available',
      breakdown: generatedBid.breakdown || 'No breakdown available',
      reasoning: generatedBid.reasoning || 'No reasoning available'
    };

    logger.info("✅ Validated bid:", validatedBid);

    // 3. Store AI bid in database
    // Get a random existing training request for this category to avoid always using the same one
    let requestId = actualRequest.id;
    
    // If no request_id provided, get a random training request for this category
    if (!requestId) {
      logger.info("🔍 Looking for training requests with category:", category);
      const { data: trainingRequests, error: trainingError } = await supabase
        .from('autobid_training_requests')
        .select('id')
        .eq('category', category);

      if (trainingError) {
        logger.error("❌ Error fetching training requests:", trainingError);
        return res.status(500).json({ error: "Failed to fetch training requests" });
      }

      if (!trainingRequests || trainingRequests.length === 0) {
        logger.error("❌ No training requests available for category:", category);
        return res.status(404).json({ error: "No training requests available for this category" });
      }

      // Use a deterministic selection based on request data hash to ensure consistency
      const requestHash = JSON.stringify(actualRequest);
      const hashValue = requestHash.split('').reduce((a, b) => {
        a = ((a << 5) - a) + b.charCodeAt(0);
        return a & a;
      }, 0);
      const selectedIndex = Math.abs(hashValue) % trainingRequests.length;
      requestId = trainingRequests[selectedIndex].id;
      
      logger.info(`✅ Using deterministic training request with ID: ${requestId} (${selectedIndex + 1}/${trainingRequests.length})`);
    }

    const aiResponse = await storeAIBid(business_id, requestId, validatedBid, category);
    logger.info("💾 AI bid stored with ID:", aiResponse.id);

    // Ensure all response fields are properly formatted
    const responseData = {
      success: true,
      generated_bid: validatedBid,
      response_id: aiResponse.id,
      amount: validatedBid.amount,
      description: validatedBid.description,
      breakdown: validatedBid.breakdown,
      reasoning: validatedBid.reasoning
    };

    // Log the response for debugging
    console.log("📤 Sending response to frontend:", responseData);

    res.json(responseData);

    } catch (error) {
    logger.error("❌ === GENERATE SAMPLE BID ROUTE FAILED ===");
    logger.error("Error message:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Frontend should call this endpoint with:
// {
//   "business_id": "user-id",
//   "category": "photography", 
//   "request_data": { ... }  // or "sample_request": { ... }
// }

// 2. Training Data Retrieval Endpoint
app.get('/api/autobid/training-data/:business_id/:category', async (req, res) => {
  logger.info("📊 === TRAINING DATA RETRIEVAL ROUTE STARTED ===");
  
  try {
    const { business_id, category } = req.params;
    logger.info(`📋 Fetching training data for Business ${business_id}, Category: ${category}`);

    const trainingData = await getBusinessTrainingData(business_id, category);
    
    res.json({
      success: true,
      business_responses: trainingData.responses || [],
      feedback_data: trainingData.feedback || []
        });

    } catch (error) {
    logger.error("❌ Error retrieving training data:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Training Status Endpoint
app.get('/api/autobid/training-status/:business_id', async (req, res) => {
  console.log("📈 === TRAINING STATUS ROUTE STARTED ===");
  
  try {
    const { business_id } = req.params;
    console.log(`📋 Fetching training status for Business ${business_id}`);

    // Get business categories
    const { data: businessProfile, error: profileError } = await supabase
      .from('business_profiles')
      .select('business_category')
      .eq('id', business_id)
      .single();

    if (profileError) {
      console.error("❌ Error fetching business profile:", profileError);
      return res.status(500).json({ error: "Failed to fetch business profile" });
    }

    let categories = [];
    if (businessProfile?.business_category) {
      categories = Array.isArray(businessProfile.business_category) 
        ? businessProfile.business_category.filter(cat => cat !== 'other')
        : [businessProfile.business_category];
    }

    console.log(`🏢 Business categories:`, categories);

    // Get training progress for each category
    const { data: progress, error: progressError } = await supabase
      .from('autobid_training_progress')
      .select('*')
      .eq('business_id', business_id)
      .in('category', categories);

    if (progressError) {
      console.error("❌ Error fetching training progress:", progressError);
      return res.status(500).json({ error: "Failed to fetch training progress" });
    }

    const categoryStatus = categories.map(category => {
      const categoryProgress = progress.find(p => p.category === category);
      return {
        category,
        training_completed: categoryProgress?.training_completed || false,
        consecutive_approvals: categoryProgress?.consecutive_approvals || 0,
        total_scenarios: categoryProgress?.total_scenarios_completed || 0
      };
    });

    const allComplete = categoryStatus.every(cat => cat.training_completed);

    console.log("✅ Training status retrieved:", categoryStatus);

    res.json({
      success: true,
      categories: categoryStatus,
      all_complete: allComplete
    });

  } catch (error) {
    console.error("❌ Error getting training status:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Training Feedback Endpoint
app.post('/api/autobid/training-feedback', async (req, res) => {
  console.log("💬 === TRAINING FEEDBACK ROUTE STARTED ===");
  console.log("📋 Request body:", JSON.stringify(req.body, null, 2));
  
  try {
    const { 
      business_id, 
      training_response_id, 
      feedback_type, 
      feedback_text, 
      specific_issues, 
      suggested_improvements,
      // Handle frontend field names
      category,
      sample_bid_id,
      approved,
      feedback,
      suggested_changes,
      // New field for AI bid data
      ai_bid_data
    } = req.body;

    // Use the correct field names
    const actualBusinessId = business_id;
    const actualFeedbackType = feedback_type || (approved ? 'approved' : 'rejected');
    const actualFeedbackText = feedback_text || feedback || (approved ? 'Approved' : 'Needs adjustment');

    if (!actualBusinessId || !actualFeedbackType) {
      console.log("❌ Missing required fields:");
      console.log("  - business_id:", actualBusinessId);
      console.log("  - feedback_type:", actualFeedbackType);
      
      return res.status(400).json({ 
        error: "Missing required fields: business_id and feedback_type (or approved)" 
      });
    }

    // Handle AI bid data insertion if provided
    let actualTrainingResponseId = training_response_id || sample_bid_id;
    
    if (ai_bid_data && !actualTrainingResponseId) {
      console.log("📝 Inserting AI bid data into training responses");
      
      // Get a training request ID for this category
      const { data: trainingRequests, error: trainingError } = await supabase
        .from('autobid_training_requests')
        .select('id')
        .eq('category', category)
        .limit(1);

      if (trainingError) {
        console.error("❌ Error fetching training requests:", trainingError);
        return res.status(500).json({ error: "Failed to fetch training requests" });
      }

      if (!trainingRequests || trainingRequests.length === 0) {
        console.error("❌ No training requests available for category:", category);
        return res.status(404).json({ error: "No training requests available for this category" });
      }

      const requestId = trainingRequests[0].id;

      // Insert the AI bid
      const { data: aiResponse, error: aiError } = await supabase
        .from('autobid_training_responses')
        .insert({
          business_id: actualBusinessId,
          request_id: requestId,
          bid_amount: ai_bid_data.bid_amount,
          bid_description: ai_bid_data.bid_description,
          pricing_breakdown: ai_bid_data.pricing_breakdown,
          pricing_reasoning: ai_bid_data.pricing_reasoning,
          is_training: true,
          is_ai_generated: true,
          category: category
        })
        .select()
        .single();

      if (aiError) {
        console.error("❌ Error inserting AI bid:", aiError);
        return res.status(500).json({ error: "Failed to insert AI bid" });
      }

      actualTrainingResponseId = aiResponse.id;
      console.log("✅ AI bid inserted with ID:", actualTrainingResponseId);
    }

    // Check for existing feedback to prevent duplicates
    const { data: existingFeedback, error: checkError } = await supabase
      .from('autobid_training_feedback')
      .select('id')
      .eq('business_id', actualBusinessId)
      .eq('training_response_id', actualTrainingResponseId)
      .maybeSingle();

    if (checkError) {
      console.error("❌ Error checking existing feedback:", checkError);
      return res.status(500).json({ error: "Failed to check existing feedback" });
    }

    if (existingFeedback) {
      console.log("⚠️ Feedback already exists for this training response, skipping duplicate");
      return res.status(409).json({ 
        error: "Feedback already submitted for this training response" 
      });
    }

    // Store feedback
    const { data: feedbackData, error: feedbackError } = await supabase
      .from('autobid_training_feedback')
      .insert({
        business_id: actualBusinessId,
        training_response_id: actualTrainingResponseId,
        feedback_type: actualFeedbackType,
        feedback_text: actualFeedbackText,
        specific_issues: specific_issues || (actualFeedbackType === 'rejected' ? { general: 'needs_adjustment' } : null),
        suggested_improvements: suggested_improvements || suggested_changes
      })
      .select()
      .single();

    if (feedbackError) {
      console.error("❌ Error storing feedback:", feedbackError);
      
      // If it's an RLS policy error, try to handle it gracefully
      if (feedbackError.code === '42501') {
        console.log("⚠️ RLS policy blocked feedback insert, continuing without feedback storage");
        // Continue without storing feedback - the main functionality should still work
      } else {
        throw new Error(`Failed to store feedback: ${feedbackError.message}`);
      }
    } else {
      console.log("✅ Feedback stored successfully:", feedbackData);
    }

    // Update training progress based on feedback
    if (actualFeedbackType === 'approved') {
      await updateTrainingProgress(actualBusinessId, actualTrainingResponseId);
    }

    res.json({
      success: true,
      feedback_id: feedbackData.id,
      ai_bid_id: actualTrainingResponseId
    });

  } catch (error) {
    console.error("❌ Error processing feedback:", error);
    res.status(500).json({ error: error.message });
  }
});

// Helper Functions for Training System

async function getBusinessTrainingData(businessId, category) {
  console.log(`🔍 Fetching training data for Business ${businessId}, Category: ${category}`);

  // First, let's check what's actually in the database
  console.log(`📊 Checking all responses for business ${businessId}:`);
  const { data: allBusinessResponses, error: allError } = await supabase
    .from('autobid_training_responses')
    .select('id, business_id, category, is_training, is_ai_generated, bid_amount, created_at')
    .eq('business_id', businessId);

  if (allError) {
    console.error("❌ Error fetching all business responses:", allError);
  } else {
    console.log(`📊 All responses for business:`, allBusinessResponses);
    console.log(`📊 Categories found:`, [...new Set(allBusinessResponses.map(r => r.category))]);
    console.log(`📊 Training flags:`, allBusinessResponses.map(r => ({ id: r.id, is_training: r.is_training, is_ai_generated: r.is_ai_generated })));
  }

  // Fetch business responses for this category with more flexible filters
  console.log(`📊 Querying autobid_training_responses with filters:`);
  console.log(`  - business_id: ${businessId}`);
  console.log(`  - category: ${category}`);
  console.log(`  - is_training: true`);
  console.log(`  - is_ai_generated: false`);

  const { data: responses, error: responsesError } = await supabase
    .from('autobid_training_responses')
    .select(`
      *,
      autobid_training_requests(request_data)
    `)
    .eq('business_id', businessId)
    .eq('category', category)
    .eq('is_training', true)
    .eq('is_ai_generated', false)
    .order('created_at', { ascending: true });

  if (responsesError) {
    console.error("❌ Error fetching training responses:", responsesError);
    throw new Error(`Failed to fetch training responses: ${responsesError.message}`);
  }

  console.log(`📊 Raw responses data:`, responses);
  console.log(`📊 Number of responses found: ${responses?.length || 0}`);

  // If no responses found, try without the is_training filter
  if (!responses || responses.length === 0) {
    console.log(`⚠️ No responses found with is_training=true, trying without that filter...`);
    
    const { data: fallbackResponses, error: fallbackError } = await supabase
      .from('autobid_training_responses')
      .select(`
        *,
        autobid_training_requests(request_data)
      `)
      .eq('business_id', businessId)
      .eq('category', category)
      .eq('is_ai_generated', false)
      .order('created_at', { ascending: true });

    if (fallbackError) {
      console.error("❌ Error fetching fallback responses:", fallbackError);
    } else {
      console.log(`📊 Fallback responses found: ${fallbackResponses?.length || 0}`);
      if (fallbackResponses && fallbackResponses.length > 0) {
        console.log(`📊 Using fallback responses instead`);
        responses = fallbackResponses;
      }
    }
  }

  // Fetch feedback data
  const { data: feedback, error: feedbackError } = await supabase
    .from('autobid_training_feedback')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: true });

  if (feedbackError) {
    console.error("❌ Error fetching feedback:", feedbackError);
    throw new Error(`Failed to fetch feedback: ${feedbackError.message}`);
  }

  console.log(`📊 Found ${responses?.length || 0} responses and ${feedback?.length || 0} feedback entries`);

  return { responses: responses || [], feedback: feedback || [] };
}

async function generateAIBidForTraining(trainingData, sampleRequest, category, businessId) {
  console.log(`🤖 Generating AI bid for training with ${trainingData.responses.length} responses`);

  // Fetch business pricing rules for training
  console.log(`🔍 Fetching pricing rules for Business ${businessId}, Category: ${category}`);
  console.log(`🔍 Query parameters: business_id=${businessId}, category=${category}`);
  
  const { data: pricingRulesData, error: pricingError } = await supabase
    .from("business_pricing_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("category", category)
    .order("created_at", { ascending: false })
    .limit(1);

  let pricingRules = null;
  if (pricingError) {
    console.warn("⚠️ Error fetching pricing rules for Business ID:", businessId, "Category:", category, "Error:", pricingError);
  } else if (pricingRulesData && pricingRulesData.length > 0) {
    pricingRules = pricingRulesData[0];
    console.log("✅ Found pricing rules for business:", pricingRules);
  } else {
    console.warn("⚠️ No pricing rules found for Business ID:", businessId, "Category:", category);
    
    // Debug: Check if there are any pricing rules for this business at all
    const { data: allBusinessRules, error: allRulesError } = await supabase
      .from("business_pricing_rules")
      .select("id, category, created_at")
      .eq("business_id", businessId);
    
    if (allRulesError) {
      console.warn("⚠️ Error checking all business rules:", allRulesError);
    } else {
      console.log(`🔍 Found ${allBusinessRules?.length || 0} total pricing rules for business ${businessId}:`, allBusinessRules);
    }
  }

  // Fetch business packages for training
  console.log(`📦 Fetching packages for Business ${businessId}`);
  const { data: businessPackages, error: packagesError } = await supabase
    .from("business_packages")
    .select("*")
    .eq("business_id", businessId)
    .order("display_order", { ascending: true });

  if (packagesError) {
    console.warn("⚠️ No packages found for Business ID:", businessId);
  } else {
    console.log(`📦 Found ${businessPackages?.length || 0} packages for business`);
  }

  // Calculate base pricing (simplified for conversation starter approach)
  let basePrice = 0;
  let travelFees = { fee: 0, warning: null };
  let finalPrice = 0;

  if (pricingRules) {
    // Use explicit pricing rules as the foundation
    basePrice = calculateCategoryPricing(sampleRequest, pricingRules);
    
    // Apply platform markup if specified
    finalPrice = basePrice;
    if (pricingRules.platform_fee_markup_percent) {
      const markup = finalPrice * (parseFloat(pricingRules.platform_fee_markup_percent) / 100);
      finalPrice += markup;
    }
    
    // Calculate travel fees for warning purposes
    travelFees = calculateTravelFees(null, sampleRequest.location, pricingRules);
    
    console.log(`💰 Base pricing calculated: $${basePrice} -> Final $${finalPrice}`);
  } else {
    // No pricing rules - let AI generate custom bid based on request details
    basePrice = 0; // Let AI determine based on request
    finalPrice = 0; // Let AI determine based on request
    console.log(`⚠️ No pricing rules found, allowing AI to generate custom bid based on request details`);
  }

  // Process training data for AI
  const processedData = processTrainingDataForAI(trainingData);
  
  // Log feedback analysis for debugging
  console.log("📊 Feedback Analysis:");
  console.log("  - Pricing Adjustments:", processedData.feedback_preferences.pricing_adjustments);
  console.log("  - Common Issues:", processedData.feedback_preferences.common_issues);
  console.log("  - Specific Feedback:", processedData.feedback_preferences.specific_feedback.slice(0, 2));
  console.log("  - Preferred Improvements:", processedData.feedback_preferences.preferred_improvements.slice(0, 2));
  
  // Create AI prompt with training data AND pricing rules
  const prompt = createTrainingAIPrompt(processedData, sampleRequest, category, pricingRules, businessPackages, {
    basePrice,
    travelFees,
    finalPrice
  });
  
  console.log("📜 Training AI Prompt:", prompt);

  // Call OpenAI
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: prompt }],
    temperature: 0.3,
  });

  const aiBidRaw = completion.choices[0].message.content;
  console.log("📄 Raw AI response:", aiBidRaw);

  // Parse AI response
  const match = aiBidRaw.match(/```json\n([\s\S]*?)\n```/);
  let aiBidClean = match ? match[1].trim() : aiBidRaw.trim();

  let aiBid;
  try {
    aiBid = JSON.parse(aiBidClean);
    console.log("✅ Parsed AI bid:", aiBid);
  } catch (error) {
    console.error("❌ Error parsing AI bid response:", aiBidClean, error);
    throw new Error(`Failed to parse AI response: ${error.message}`);
  }

  // Validate and adjust pricing using business rules (same as production)
  const validatedBid = validateAndAdjustPricingForTraining(aiBid, pricingRules, trainingData);
  
  // Use the calculated final price only if pricing rules are configured
  if (pricingRules) {
    validatedBid.bidAmount = finalPrice;
  }
  
  console.log(`💰 Final validated training bid: $${validatedBid.bidAmount}`);

  // Convert nested objects to strings for frontend compatibility
  const breakdown = typeof aiBid.pricingBreakdown === 'object' 
    ? JSON.stringify(aiBid.pricingBreakdown, null, 2)
    : (aiBid.pricingBreakdown || aiBid.breakdown || "");
    
  const reasoning = typeof aiBid.pricingReasoning === 'object'
    ? JSON.stringify(aiBid.pricingReasoning, null, 2)
    : (aiBid.pricingReasoning || aiBid.reasoning || "");

  return {
    amount: validatedBid.bidAmount,
    description: validatedBid.bidDescription,
    breakdown: breakdown,
    reasoning: reasoning
  };
}

async function storeAIBid(businessId, requestId, generatedBid, category) {
  console.log(`💾 Storing AI bid for Business ${businessId}`);

  const insertData = {
    business_id: businessId,
    bid_amount: generatedBid.amount,
    bid_description: generatedBid.description,
    pricing_breakdown: generatedBid.breakdown,
    pricing_reasoning: generatedBid.reasoning,
    is_training: true,
    is_ai_generated: true,
    category: category
  };

  // Only add request_id if it's not null
  if (requestId) {
    insertData.request_id = requestId;
  }

  const { data: aiResponse, error: insertError } = await supabase
    .from('autobid_training_responses')
    .insert(insertData)
    .select()
    .single();

  if (insertError) {
    console.error("❌ Error storing AI bid:", insertError);
    throw new Error(`Failed to store AI bid: ${insertError.message}`);
  }

  return aiResponse;
}

async function updateTrainingProgress(businessId, trainingResponseId) {
  console.log(`📈 Updating training progress for Business ${businessId}`);

  // Get the category and AI generation status from the training response
  const { data: response, error: responseError } = await supabase
    .from('autobid_training_responses')
    .select('category, is_ai_generated')
    .eq('id', trainingResponseId)
    .single();

  if (responseError) {
    console.error("❌ Error fetching training response:", responseError);
    return;
  }

  console.log(`📊 Training response details: category=${response.category}, is_ai_generated=${response.is_ai_generated}`);

  // Get current progress first
  const { data: currentProgress, error: progressFetchError } = await supabase
    .from('autobid_training_progress')
    .select('consecutive_approvals, total_scenarios_completed, scenarios_approved')
    .eq('business_id', businessId)
    .eq('category', response.category)
    .single();

  if (progressFetchError) {
    console.error("❌ Error fetching current progress:", progressFetchError);
    
    // If no record exists, create one
    if (progressFetchError.code === 'PGRST116') {
      console.log("📝 Creating new training progress record");
      const { error: insertError } = await supabase
        .from('autobid_training_progress')
        .insert({
          business_id: businessId,
          category: response.category,
          consecutive_approvals: 1,
          total_scenarios_completed: response.is_ai_generated ? 0 : 1, // Only increment for sample requests
          scenarios_approved: response.is_ai_generated ? 1 : 0, // Only increment for AI bids
          training_completed: false,
          last_training_date: new Date().toISOString()
        });

      if (insertError) {
        console.error("❌ Error creating training progress record:", insertError);
      } else {
        console.log("✅ New training progress record created");
      }
      return;
    }
    return;
  }

  // Prepare update data based on whether it's an AI bid or sample request
  const updateData = {
    consecutive_approvals: (currentProgress?.consecutive_approvals || 0) + 1,
    last_training_date: new Date().toISOString()
  };

  if (response.is_ai_generated) {
    // For AI bids, only increment scenarios_approved
    updateData.scenarios_approved = (currentProgress?.scenarios_approved || 0) + 1;
    console.log(`📈 Incrementing scenarios_approved for AI bid`);
  } else {
    // For sample requests, only increment total_scenarios_completed
    updateData.total_scenarios_completed = (currentProgress?.total_scenarios_completed || 0) + 1;
    console.log(`📈 Incrementing total_scenarios_completed for sample request`);
  }

  // Update existing progress
  const { error: progressError } = await supabase
    .from('autobid_training_progress')
    .update(updateData)
    .eq('business_id', businessId)
    .eq('category', response.category);

  if (progressError) {
    console.error("❌ Error updating training progress:", progressError);
  } else {
    console.log("✅ Training progress updated");
  }
}

function processTrainingDataForAI(trainingData) {
  console.log("🔍 Processing training data for AI");

  const processedData = {
    business_patterns: analyzeBusinessPatterns(trainingData.responses),
    pricing_strategy: extractPricingStrategy(trainingData.responses),
    feedback_preferences: analyzeFeedbackPreferences(trainingData.feedback),
    service_preferences: extractServicePreferences(trainingData.responses),
    responses: trainingData.responses // Include raw responses for bid range calculation
  };

  console.log("📊 Processed data:", processedData);
  return processedData;
}

function analyzeBusinessPatterns(responses) {
  const patterns = {
    average_bid_amount: 0,
    pricing_factors: [],
    service_emphasis: [],
    description_style: ''
  };

  if (responses.length > 0) {
    // Calculate average bid amount
    const totalAmount = responses.reduce((sum, response) => sum + parseFloat(response.bid_amount), 0);
    patterns.average_bid_amount = totalAmount / responses.length;

    // Analyze pricing breakdown patterns
    patterns.pricing_factors = extractPricingFactors(responses);

    // Analyze service emphasis
    patterns.service_emphasis = extractServiceEmphasis(responses);

    // Analyze description style
    patterns.description_style = analyzeDescriptionStyle(responses);
  }

  return patterns;
}

function extractPricingStrategy(responses) {
  const strategies = {
    premium_pricing: false,
    competitive_pricing: false,
    value_based_pricing: false,
    cost_plus_pricing: false
  };

  // Analyze pricing reasoning to determine strategy
  responses.forEach(response => {
    const reasoning = response.pricing_reasoning?.toLowerCase() || '';

    if (reasoning.includes('premium') || reasoning.includes('high-end')) {
      strategies.premium_pricing = true;
    }
    if (reasoning.includes('competitive') || reasoning.includes('market rate')) {
      strategies.competitive_pricing = true;
    }
    if (reasoning.includes('value') || reasoning.includes('quality')) {
      strategies.value_based_pricing = true;
    }
    if (reasoning.includes('cost') || reasoning.includes('overhead')) {
      strategies.cost_plus_pricing = true;
    }
  });

  return strategies;
}

function extractPricingFactors(responses) {
  const factors = [];
  responses.forEach(response => {
    const breakdown = response.pricing_breakdown?.toLowerCase() || '';
    if (breakdown.includes('hour') || breakdown.includes('time')) factors.push('hourly_rate');
    if (breakdown.includes('person') || breakdown.includes('guest')) factors.push('per_person');
    if (breakdown.includes('equipment') || breakdown.includes('gear')) factors.push('equipment');
    if (breakdown.includes('travel') || breakdown.includes('mileage')) factors.push('travel');
    if (breakdown.includes('editing') || breakdown.includes('post')) factors.push('post_production');
  });
  return [...new Set(factors)];
}

function extractServiceEmphasis(responses) {
  const emphasis = [];
  responses.forEach(response => {
    const description = response.bid_description?.toLowerCase() || '';
    if (description.includes('premium') || description.includes('luxury')) emphasis.push('premium_quality');
    if (description.includes('experience') || description.includes('professional')) emphasis.push('experience');
    if (description.includes('package') || description.includes('complete')) emphasis.push('comprehensive_packages');
    if (description.includes('custom') || description.includes('personalized')) emphasis.push('customization');
  });
  return [...new Set(emphasis)];
}

function analyzeDescriptionStyle(responses) {
  const descriptions = responses.map(r => r.bid_description || '').join(' ');
  const wordCount = descriptions.split(' ').length;
  
  if (wordCount > 200) return 'detailed';
  if (wordCount > 100) return 'moderate';
  return 'concise';
}

function analyzeFeedbackPreferences(feedback) {
  const preferences = {
    approval_rate: 0,
    common_issues: [],
    pricing_adjustments: [],
    specific_feedback: [],
    preferred_improvements: []
  };

  if (feedback.length > 0) {
    const approvals = feedback.filter(f => f.feedback_type === 'approved').length;
    preferences.approval_rate = approvals / feedback.length;

    // Extract detailed feedback analysis from rejected feedback
    const rejectedFeedback = feedback.filter(f => f.feedback_type === 'rejected');
    const feedbackAnalysis = extractCommonIssues(rejectedFeedback);
    
    preferences.common_issues = feedbackAnalysis.issues;
    preferences.pricing_adjustments = feedbackAnalysis.pricingAdjustments;
    preferences.specific_feedback = feedbackAnalysis.specificFeedback;

    // Extract approved feedback patterns for positive learning
    const approvedFeedback = feedback.filter(f => f.feedback_type === 'approved');
    approvedFeedback.forEach(f => {
      if (f.feedback_text) {
        preferences.preferred_improvements.push(f.feedback_text);
      }
    });
  }

  return preferences;
}

function extractCommonIssues(rejectedFeedback) {
  const issues = [];
  const pricingAdjustments = [];
  const specificFeedback = [];

  rejectedFeedback.forEach(feedback => {
    const text = feedback.feedback_text?.toLowerCase() || '';
    const specificIssues = feedback.specific_issues || {};
    const suggestedImprovements = feedback.suggested_improvements || {};

    // Extract pricing-specific feedback
    if (text.includes('too high') || text.includes('expensive') || text.includes('overpriced')) {
      issues.push('pricing_too_high');
      pricingAdjustments.push('reduce_pricing');
    }
    if (text.includes('too low') || text.includes('cheap') || text.includes('underpriced')) {
      issues.push('pricing_too_low');
      pricingAdjustments.push('increase_pricing');
    }
    if (text.includes('missing') || text.includes('incomplete')) {
      issues.push('incomplete_description');
    }
    if (text.includes('wrong') || text.includes('incorrect')) {
      issues.push('incorrect_services');
    }

    // Extract specific feedback from structured data
    if (specificIssues.pricing) {
      issues.push(`pricing_${specificIssues.pricing}`);
      if (specificIssues.pricing === 'too_high') pricingAdjustments.push('reduce_pricing');
      if (specificIssues.pricing === 'too_low') pricingAdjustments.push('increase_pricing');
    }
    if (specificIssues.description) {
      issues.push(`description_${specificIssues.description}`);
    }
    if (specificIssues.services) {
      issues.push(`services_${specificIssues.services}`);
    }

    // Store specific feedback text for AI learning
    if (feedback.feedback_text) {
      specificFeedback.push(feedback.feedback_text);
    }
    if (suggestedImprovements) {
      specificFeedback.push(`Suggested: ${JSON.stringify(suggestedImprovements)}`);
    }
  });

  return {
    issues: [...new Set(issues)],
    pricingAdjustments: [...new Set(pricingAdjustments)],
    specificFeedback: specificFeedback
  };
}

function extractServicePreferences(responses) {
  const preferences = [];
  responses.forEach(response => {
    const description = response.bid_description?.toLowerCase() || '';
    if (description.includes('full day') || description.includes('complete coverage')) preferences.push('full_coverage');
    if (description.includes('engagement') || description.includes('pre-wedding')) preferences.push('engagement_sessions');
    if (description.includes('album') || description.includes('prints')) preferences.push('physical_products');
    if (description.includes('online') || description.includes('digital')) preferences.push('digital_delivery');
  });
  return [...new Set(preferences)];
}

function createTrainingAIPrompt(processedData, sampleRequest, category, pricingRules, businessPackages, {
  basePrice,
  travelFees,
  finalPrice
}) {
  const categoryHandlers = {
    photography: {
      pricingFactors: "hourly rates, coverage duration, deliverables, equipment needs, post-production time",
      serviceTypes: "full day coverage, engagement sessions, wedding albums, online galleries"
    },
    videography: {
      pricingFactors: "hourly rates, coverage duration, deliverables, equipment needs, post-production time",
      serviceTypes: "ceremony coverage, reception coverage, highlight reel, full film, drone footage"
    },
    catering: {
      pricingFactors: "per-person costs, guest count, food complexity, service level, equipment needs",
      serviceTypes: "full-service catering, delivery only, setup/cleanup, dietary accommodations"
    },
    dj: {
      pricingFactors: "hourly rates, event duration, equipment needs, additional services, travel distance",
      serviceTypes: "MC services, lighting, photo booth, music selection, equipment setup"
    },
    beauty: {
      pricingFactors: "per-person rates, service type, trial sessions, travel fees, product costs",
      serviceTypes: "hair styling, makeup, trials, on-site services, group packages"
    },
    florist: {
      pricingFactors: "arrangement types, flower costs, setup fees, delivery, consultation",
      serviceTypes: "bouquets, centerpieces, ceremony decor, delivery/setup, consultations"
    },
    wedding_planning: {
      pricingFactors: "planning level, guest count, timeline, vendor management, communication needs",
      serviceTypes: "full planning, partial planning, day-of coordination, vendor referrals"
    }
  };

  const categoryInfo = categoryHandlers[category] || categoryHandlers.photography;

  // Format pricing rules for AI consumption
  const formatPricingRules = (rules) => {
    if (!rules) return "No pricing rules configured";
    
    return `
**PRICING RULES CONFIGURATION:**
- **Category:** ${rules.category || 'Not specified'}
- **Pricing Model:** ${rules.pricing_model || 'Not specified'}
- **Base Price:** $${rules.base_price || 'Not set'}
- **Hourly Rate:** $${rules.hourly_rate || 'Not set'}
- **Per Person Rate:** $${rules.per_person_rate || 'Not set'}
- **Travel Fee:** $${rules.travel_fee_per_mile || 'Not set'} per mile
- **Bid Aggressiveness:** ${rules.bid_aggressiveness || 'Not specified'}
- **Accept Unknowns:** ${rules.accept_unknowns ? 'Yes' : 'No'}
- **Rush Fee:** ${rules.rush_fee_percent || 'Not set'}%
- **Deposit:** ${rules.deposit_percent || 'Not set'}%
- **Min Booking Notice:** ${rules.min_booking_notice_hours || 'Not set'} hours
- **Min Duration:** ${rules.min_duration_hours || 'Not set'} hours
- **Require Consultation:** ${rules.require_consultation ? 'Yes' : 'No'}
- **Max Distance:** ${rules.max_distance_miles || 'Not set'} miles
- **Platform Markup:** ${rules.platform_fee_markup_percent || 'Not set'}%
- **Include Tax:** ${rules.include_tax ? 'Yes' : 'No'}
- **Tax Rate:** ${rules.tax_rate_percent || 'Not set'}%

**MULTIPLIERS & DISCOUNTS:**
- **Holiday Multiplier:** ${rules.holiday_multiplier || 'Not set'}
- **Weekend Multiplier:** ${rules.weekend_multiplier || 'Not set'}
- **Evening Multiplier:** ${rules.evening_multiplier || 'Not set'}
- **Morning Discount:** ${rules.morning_discount_percent || 'Not set'}%
- **Long Booking Discount:** ${rules.discount_for_long_booking_percent || 'Not set'}% (after ${rules.long_booking_hours_threshold || 'Not set'} hours)

**TRAVEL & LOGISTICS:**
- **Travel Included Miles:** ${rules.travel_included_miles || 'Not set'}
- **Per Mile Overage Fee:** $${rules.per_mile_overage_fee || 'Not set'}
- **Base Price Includes Hours:** ${rules.base_price_includes_hours || 'Not set'}

**SERVICE SPECIFICS:**
- **Image Style:** ${rules.image_style || 'Not specified'}
- **Editing Style:** ${rules.editing_style || 'Not specified'}
- **Turnaround Time:** ${rules.turnaround_time_days || 'Not set'} days
- **Print Rights Included:** ${rules.print_rights_included ? 'Yes' : 'No'}
- **Online Gallery Included:** ${rules.online_gallery_included ? 'Yes' : 'No'}
- **Watermark Images:** ${rules.watermark_images ? 'Yes' : 'No'}

**LOCATION PREFERENCES:**
- **Preferred Locations:** ${rules.preferred_locations || 'None specified'}
- **Excluded Locations:** ${rules.excluded_locations || 'None specified'}

**COMPLEX DATA:**
- **Base Category Rates:** ${rules.base_category_rates ? JSON.stringify(rules.base_category_rates) : 'Not configured'}
- **Travel Config:** ${rules.travel_config ? JSON.stringify(rules.travel_config) : 'Not configured'}
- **Platform Markup:** ${rules.platform_markup ? JSON.stringify(rules.platform_markup) : 'Not configured'}
- **Consultation Required:** ${rules.consultation_required ? 'Yes' : 'No'}
- **Dealbreakers:** ${rules.dealbreakers ? JSON.stringify(rules.dealbreakers) : 'None'}
- **Style Preferences:** ${rules.style_preferences ? JSON.stringify(rules.style_preferences) : 'Not configured'}`;
  };

  // Format business packages for AI consumption
  const formatBusinessPackages = (packages) => {
    if (!packages || packages.length === 0) return "No packages configured";
    
    return packages.map(pkg => `
**PACKAGE: ${pkg.name}**
- **Price:** $${pkg.price}
- **Description:** ${pkg.description || 'No description'}
- **Features:** ${pkg.features ? pkg.features.join(', ') : 'No features listed'}
- **Display Order:** ${pkg.display_order || 'Not specified'}`).join('\n\n');
  };

  // Pricing calculation is now handled by the new helper functions above

  return `
You are an AI assistant that generates conversation-starting bids for ${category} services. Your goal is to provide an accurate base offer with smart upsell suggestions, not perfect pricing. ${!pricingRules ? 'Since no pricing rules are configured, generate a custom bid amount based on the specific request details, duration, location, and your training patterns.' : ''}

### BUSINESS PRICING RULES (FOUNDATION):
${formatPricingRules(pricingRules)}

### BUSINESS PACKAGES (AVAILABLE OPTIONS):
${formatBusinessPackages(businessPackages)}

### BASE PRICING CALCULATION:
${pricingRules ? `
- **Base Price:** $${basePrice}
- **Platform Markup:** ${pricingRules.platform_fee_markup_percent ? `${pricingRules.platform_fee_markup_percent}%` : 'None'}
- **Final Base Price:** $${finalPrice}
- **Travel Warning:** ${travelFees.warning || 'None'}` : `
- **No pricing rules configured - generate custom bid based on request details and training patterns**
- **Training Average:** $${processedData.business_patterns.average_bid_amount.toFixed(2)}
- **Travel Warning:** ${travelFees.warning || 'None'}`}

### CONSULTATION REQUIREMENTS:
${pricingRules?.require_consultation ? 'MUST include consultation call requirement.' : 'No consultation call required.'}

### BUSINESS TRAINING PATTERNS:
- **Average Training Bid:** $${processedData.business_patterns.average_bid_amount.toFixed(2)}
- **Service Emphasis:** ${processedData.service_preferences.join(', ')}
- **Description Style:** ${processedData.business_patterns.description_style}

### FEEDBACK LEARNING:
- **Common Issues to Avoid:** ${processedData.feedback_preferences.common_issues.join(', ') || 'none'}
- **Preferred Improvements:** ${processedData.feedback_preferences.preferred_improvements.slice(0, 2).join(' | ') || 'none'}

### SPECIFIC REQUEST:
- **Duration:** ${sampleRequest.duration}
- **Event Type:** ${sampleRequest.event_type}
- **Guest Count:** ${sampleRequest.guest_count}
- **Location:** ${sampleRequest.location}
- **Requirements:** ${sampleRequest.requirements?.join(', ')}

### CATEGORY-SPECIFIC STRATEGY:
${category === 'photography' ? `
**PHOTOGRAPHY FOCUS:**
- Base pricing by service type (weddings, family, couples, portraits)
- Common add-ons: Second shooter, engagement sessions, bridals, prints/albums, videography
- Always mention consultation call requirement
- Include travel disclaimer for engagements/bridals
${!pricingRules ? '- For graduation photography (3 hours): Consider $400-800 range based on location and requirements' : ''}` : ''}
${category === 'dj' ? `
**DJ FOCUS:**
- First hour premium, then hourly rate
- Seasonal pricing adjustments
- Add-ons: MC services, lighting, cold sparks, ceremony audio
- Music style matching important` : ''}
${category === 'videography' ? `
**VIDEOGRAPHY FOCUS:**
- Full-day vs AM/PM pricing
- Add-ons: Second videographer, drone, speed editing, ceremony audio
- Bundle with photography when possible` : ''}

### CONVERSATION STARTER APPROACH:
${pricingRules ? `
1. **BASE OFFER:** Use the calculated base price of $${finalPrice} as your starting point` : `
1. **BASE OFFER:** Generate a custom bid amount based on the specific request details, duration, location, and training patterns`}
2. **UPSELL SUGGESTIONS:** Include 2-3 relevant add-ons as optional enhancements
3. **CONSULTATION CALL:** ${pricingRules?.require_consultation ? 'MUST mention consultation call requirement' : 'Optional to mention'}
4. **TRAVEL WARNING:** ${travelFees.warning ? `Include: "${travelFees.warning}"` : 'No travel warning needed'}
5. **DEALBREAKERS:** ${pricingRules?.dealbreakers ? `Avoid: ${JSON.stringify(pricingRules.dealbreakers)}` : 'No dealbreakers specified'}

### BID STRUCTURE:
- Start with warm, professional greeting
- Present the base offer clearly
- Suggest 2-3 relevant add-ons as "optional enhancements"
- Include consultation call if required
- End with call-to-action for next steps

### RETURN JSON FORMAT ONLY:
\`\`\`json
{
  "bidAmount": ${pricingRules ? finalPrice : '<custom_amount_based_on_request>'},
  "bidDescription": "<conversation-starting bid with base offer and upsell suggestions>",
  "pricingBreakdown": "${pricingRules ? `Base Price: $${basePrice}\\nPlatform Markup: ${pricingRules.platform_fee_markup_percent ? `${pricingRules.platform_fee_markup_percent}%` : 'None'}\\nTotal: $${finalPrice}` : 'Custom pricing based on request details and training patterns'}",
  "pricingReasoning": "<brief explanation of pricing approach and upsell strategy>"
}
\`\`\`
`;
}

// -------------------- SOCKET.IO INTEGRATION --------------------
// Create an HTTP server from the Express app
const server = http.createServer(app);

// Initialize Socket.IO with matching CORS settings
const io = new Server(server, {
  cors: {
    origin: ["https://www.savewithbidi.com", "http://localhost:3000"],
    methods: ["GET", "POST"],
  },
});

// Socket.IO connection logic for private messaging
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // When a client connects, they send their user ID so they can join their own room.
  socket.on("join", (userId) => {
    console.log(`User ${userId} joined room ${userId}`);
    socket.join(userId);
  });

  // Listen for "send_message" events from clients
  socket.on("send_message", async (data) => {
    console.log("Received message:", data);
    try {
      const { senderId, receiverId, message } = data;
      // Save the message in Supabase (just like your HTTP /send-message endpoint)
      const { data: insertedData, error } = await supabase
        .from("messages")
        .insert([{ sender_id: senderId, receiver_id: receiverId, message }]);
      if (error) {
        console.error("Error saving message:", error);
        return;
      }
      const messageData = { ...data, id: insertedData[0].id };

      // Send the message only to the intended receiver's room
      io.to(receiverId).emit("receive_message", messageData);
      // Optionally, update the sender's UI as well
      socket.emit("receive_message", messageData);
    } catch (err) {
      console.error("Error handling send_message event:", err);
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// production testing
if (process.env.NODE_ENV !== "production") {
  server.listen(5000, () => {
    console.log("Node server listening on port 4242 with Socket.IO enabled! Visit http://localhost:5000");
  });
}

// Pricing validation and adjustment function for training (same logic as production)
function validateAndAdjustPricingForTraining(aiBid, pricingRules, trainingData) {
    let adjustedBid = { ...aiBid };
    const bidAmount = parseFloat(aiBid.bidAmount || aiBid.amount);
    
    console.log(`🔍 Validating training bid amount: $${bidAmount}`);
    
    // PRIMARY: Apply business pricing constraints (highest priority)
    if (pricingRules) {
        const minPrice = parseFloat(pricingRules.min_price);
        const maxPrice = parseFloat(pricingRules.max_price);
        
        if (!isNaN(minPrice) && bidAmount < minPrice) {
            console.log(`⚠️ Training bid $${bidAmount} below business minimum $${minPrice}, adjusting up`);
            adjustedBid.bidAmount = minPrice;
        }
        
        if (!isNaN(maxPrice) && bidAmount > maxPrice) {
            console.log(`⚠️ Training bid $${bidAmount} above business maximum $${maxPrice}, adjusting down`);
            adjustedBid.bidAmount = maxPrice;
        }
        
        // Apply business-specific pricing adjustments
        if (pricingRules.base_price && !isNaN(pricingRules.base_price)) {
            const basePrice = parseFloat(pricingRules.base_price);
            console.log(`💰 Business base price: $${basePrice}`);
            
            // If the AI bid is significantly different from base price, consider adjusting
            const basePriceVariance = 0.3; // Allow 30% variance from base price
            const minBasePrice = basePrice * (1 - basePriceVariance);
            const maxBasePrice = basePrice * (1 + basePriceVariance);
            
            if (adjustedBid.bidAmount < minBasePrice) {
                console.log(`⚠️ Training bid $${adjustedBid.bidAmount} significantly below base price $${basePrice}, adjusting up`);
                adjustedBid.bidAmount = Math.round(minBasePrice);
            }
            
            if (adjustedBid.bidAmount > maxBasePrice) {
                console.log(`⚠️ Training bid $${adjustedBid.bidAmount} significantly above base price $${basePrice}, adjusting down`);
                adjustedBid.bidAmount = Math.round(maxBasePrice);
            }
        }
    }
    
    // SECONDARY: Apply training data insights (only if no business rules or as validation)
    if (trainingData.responses && trainingData.responses.length > 0 && (!pricingRules || !pricingRules.base_price)) {
        const avgTrainingBid = trainingData.responses.reduce((sum, r) => sum + parseFloat(r.bid_amount), 0) / trainingData.responses.length;
        const trainingVariance = 0.2; // Allow 20% variance from training average
        
        const minTrainingPrice = avgTrainingBid * (1 - trainingVariance);
        const maxTrainingPrice = avgTrainingBid * (1 + trainingVariance);
        
        if (adjustedBid.bidAmount < minTrainingPrice) {
            console.log(`⚠️ Training bid $${adjustedBid.bidAmount} below training minimum $${minTrainingPrice.toFixed(2)}, adjusting up`);
            adjustedBid.bidAmount = Math.round(minTrainingPrice);
        }
        
        if (adjustedBid.bidAmount > maxTrainingPrice) {
            console.log(`⚠️ Training bid $${adjustedBid.bidAmount} above training maximum $${maxTrainingPrice.toFixed(2)}, adjusting down`);
            adjustedBid.bidAmount = Math.round(maxTrainingPrice);
        }
    }
    
    // TERTIARY: Ensure bid is a reasonable amount (not too low or too high)
    const finalAmount = Math.max(50, Math.min(50000, adjustedBid.bidAmount)); // $50-$50k range
    if (finalAmount !== adjustedBid.bidAmount) {
        console.log(`⚠️ Training bid adjusted to reasonable range: $${finalAmount}`);
        adjustedBid.bidAmount = finalAmount;
    }
    
    console.log(`✅ Final validated training bid amount: $${adjustedBid.bidAmount}`);
    return adjustedBid;
}

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

module.exports = app; // Export for Vercel

// Helper function to calculate category-specific pricing
function calculateCategoryPricing(requestData, pricingRules) {
  const eventType = requestData.event_type?.toLowerCase();
  const guestCount = requestData.guest_count || requestData.estimated_guests || 1;
  const duration = requestData.duration;
  
  // Start with base price
  let basePrice = parseFloat(pricingRules.base_price) || 0;
  
  // Apply hourly rate if duration is specified
  if (duration && pricingRules.hourly_rate) {
    const hours = parseInt(duration.match(/(\d+)/)?.[1] || 1);
    basePrice = parseFloat(pricingRules.hourly_rate) * hours;
  }
  
  // Apply per-person rate if applicable
  if (pricingRules.per_person_rate && guestCount > 1) {
    basePrice = parseFloat(pricingRules.per_person_rate) * guestCount;
  }
  
  // Apply wedding premium if applicable
  if (eventType === 'wedding' && pricingRules.wedding_premium) {
    basePrice += parseFloat(pricingRules.wedding_premium);
  }
  
  // Apply rush fee if timeline is tight
  if (requestData.timeline === 'rush' && pricingRules.rush_fee_percent) {
    const rushFee = basePrice * (parseFloat(pricingRules.rush_fee_percent) / 100);
    basePrice += rushFee;
  }
  
  // Apply multipliers based on time of day
  if (pricingRules.evening_multiplier && requestData.time_of_day === 'evening') {
    basePrice *= parseFloat(pricingRules.evening_multiplier);
  }
  
  if (pricingRules.weekend_multiplier && requestData.day_of_week === 'weekend') {
    basePrice *= parseFloat(pricingRules.weekend_multiplier);
  }
  
  if (pricingRules.holiday_multiplier && requestData.is_holiday) {
    basePrice *= parseFloat(pricingRules.holiday_multiplier);
  }
  
  return Math.round(basePrice);
}

// Helper function to calculate duration-based pricing
function calculateDurationPricing(duration, pricingRules) {
  if (!duration || !pricingRules.hourly_rate) {
    return parseFloat(pricingRules.base_price) || 0;
  }
  
  const hours = parseInt(duration.match(/(\d+)/)?.[1] || 1);
  const hourlyRate = parseFloat(pricingRules.hourly_rate);
  
  return Math.round(hourlyRate * hours);
}

// Helper function to apply seasonal pricing
function applySeasonalPricing(basePrice, eventDate, seasonalPricing) {
  if (!eventDate) {
    return basePrice;
  }
  
  // For now, use a simple seasonal adjustment
  // In production, this could be more sophisticated
  const month = new Date(eventDate).getMonth();
  
  // Summer months (May-August) might have higher demand
  if (month >= 4 && month <= 7) {
    return Math.round(basePrice * 1.1); // 10% premium
  }
  
  return basePrice;
}

// Helper function to calculate travel fees
function calculateTravelFees(vendorLocation, eventLocation, travelConfig) {
  if (!eventLocation) {
    return { fee: 0, warning: null };
  }
  
  // Simple distance calculation (in production, use Google Maps API)
  // For now, we'll use a placeholder that can be enhanced later
  const distance = 25; // Placeholder - would calculate actual distance
  
  // Use travel_fee_per_mile from pricing rules
  const travelFeePerMile = travelConfig?.travel_fee_per_mile || 1;
  const maxDistanceMiles = travelConfig?.max_distance_miles || 50;
  
  if (distance <= maxDistanceMiles) {
    const fee = distance * travelFeePerMile;
    return { 
      fee: Math.round(fee), 
      warning: distance > 30 ? "Travel fee applies" : null 
    };
  }
  
  return { 
    fee: Math.round(maxDistanceMiles * travelFeePerMile), 
    warning: "Maximum travel distance exceeded" 
  };
}

// Rate limiters for Stripe account endpoints
const rateLimit = require('express-rate-limit');
const stripeAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

// Authentication middleware using Supabase
const authenticateUser = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    addLog('warn', 'Authentication failed - no token provided');
    return res.status(401).json({ 
      success: false,
      error: 'Authentication required' 
    });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      addLog('warn', 'Authentication failed - invalid token', { error });
      return res.status(401).json({ 
        success: false,
        error: 'Invalid authentication token' 
      });
    }

    // Add user info to request
    req.user = user;
    next();
  } catch (error) {
    addLog('error', 'Authentication error', { error: error.message });
    return res.status(401).json({ 
      success: false,
      error: 'Authentication failed' 
    });
  }
};

// Middleware to validate Stripe account ID
const validateStripeAccountId = (req, res, next) => {
  const { accountId } = req.body;
  
  if (!accountId || typeof accountId !== 'string' || accountId.trim().length === 0) {
    addLog('warn', 'Invalid account ID provided', { accountId });
    return res.status(400).json({
      success: false,
      error: 'Invalid account ID provided'
    });
  }
  
  // Sanitize the account ID
  req.body.accountId = accountId.trim();
  next();
};

/**
 * Verify if a Stripe Connected Account is properly set up and active
 * @route POST /api/stripe/verify-account
 * @param {string} accountId - The Stripe account ID to verify
 * @returns {Object} Response indicating if the account is valid with detailed status
 */
app.post('/api/stripe/verify-account',
  stripeAccountLimiter,
  authenticateUser,
  validateStripeAccountId,
  async (req, res) => {
    try {
      const { accountId } = req.body;
      
      // Log the verification attempt with user context
      addLog('info', 'Verifying Stripe account', { 
        accountId,
        userId: req.user.id,
        userEmail: req.user.email
      });
      
      const account = await stripe.accounts.retrieve(accountId);
      
      const isValid = account && 
                     account.details_submitted && 
                     account.payouts_enabled &&
                     (!account.requirements.currently_due || 
                      account.requirements.currently_due.length === 0);
      
      // Enhanced status information
      const status = {
        success: true,
        isValid,
        details: {
          detailsSubmitted: account.details_submitted,
          payoutsEnabled: account.payouts_enabled,
          chargesEnabled: account.charges_enabled,
          pendingRequirements: account.requirements.currently_due || [],
          accountStatus: account.charges_enabled ? 'active' : 'inactive',
          disabledReason: account.requirements.disabled_reason || null
        }
      };
      
      // Log the verification result with enhanced details
      addLog('info', 'Stripe account verification result', {
        accountId,
        userId: req.user.id,
        isValid,
        status: status.details.accountStatus,
        details: status.details
      });
      
      res.json(status);
      
    } catch (error) {
      // Enhanced error logging with user context
      addLog('error', 'Error verifying Stripe account', {
        accountId: req.body.accountId,
        userId: req.user.id,
        error: error.message,
        type: error.type,
        stack: error.stack
      });
      
      // Handle specific Stripe errors
      if (error.type === 'StripeInvalidRequestError') {
        return res.status(400).json({
          success: false,
          error: 'Invalid Stripe account ID',
          isValid: false
        });
      }
      
      if (error.type === 'StripePermissionError') {
        return res.status(403).json({
          success: false,
          error: 'Permission denied to access this Stripe account',
          isValid: false
        });
      }
      
      res.status(500).json({
        success: false,
        error: 'Error verifying account',
        isValid: false
      });
    }
});

/**
 * Delete an incomplete or invalid Stripe Connected Account
 * @route POST /api/stripe/delete-account
 * @param {string} accountId - The Stripe account ID to delete
 * @returns {Object} Response indicating if the deletion was successful
 */
app.post('/api/stripe/delete-account',
  stripeAccountLimiter,
  authenticateUser,
  validateStripeAccountId,
  async (req, res) => {
    try {
      const { accountId } = req.body;
      
      // Log the deletion attempt with user context
      addLog('info', 'Deleting Stripe account', { 
        accountId,
        userId: req.user.id,
        userEmail: req.user.email
      });
      
      // First verify if the account exists and get its status
      const account = await stripe.accounts.retrieve(accountId);
      
      // Enhanced validation for account deletion
      if (account.details_submitted && account.payouts_enabled) {
        const warningMessage = 'Attempted to delete complete Stripe account';
        addLog('warn', warningMessage, { 
          accountId,
          userId: req.user.id,
          accountStatus: account.charges_enabled ? 'active' : 'inactive'
        });
        
        return res.status(403).json({
          success: false,
          error: 'Cannot delete a complete and active account',
          details: {
            accountStatus: account.charges_enabled ? 'active' : 'inactive',
            detailsSubmitted: account.details_submitted,
            payoutsEnabled: account.payouts_enabled
          }
        });
      }
      
      // Proceed with deletion
      await stripe.accounts.del(accountId);
      
      // Log successful deletion with context
      addLog('info', 'Successfully deleted Stripe account', { 
        accountId,
        userId: req.user.id,
        previousStatus: {
          detailsSubmitted: account.details_submitted,
          payoutsEnabled: account.payouts_enabled,
          chargesEnabled: account.charges_enabled
        }
      });
      
      res.json({
        success: true,
        message: 'Account successfully deleted',
        details: {
          accountId,
          deletedAt: new Date().toISOString()
        }
      });
      
    } catch (error) {
      // Enhanced error logging with user context
      addLog('error', 'Error deleting Stripe account', {
        accountId: req.body.accountId,
        userId: req.user.id,
        error: error.message,
        type: error.type,
        stack: error.stack
      });
      
      // Handle specific Stripe errors
      if (error.type === 'StripeInvalidRequestError') {
        return res.status(400).json({
          success: false,
          error: 'Invalid Stripe account ID'
        });
      }
      
      if (error.type === 'StripePermissionError') {
        return res.status(403).json({
          success: false,
          error: 'Permission denied to delete this Stripe account'
        });
      }
      
      res.status(500).json({
        success: false,
        error: 'Error deleting account'
      });
    }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Unhandled error:', error);
  
  // Log the error with context
  if (logStore && logStore.addLog) {
    logStore.addLog('error', 'Unhandled server error', {
      error: error.message,
      stack: error.stack,
      url: req.url,
      method: req.method,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  }
  
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler for unmatched routes
app.use('*', (req, res) => {
  console.log(`❌ 404 - Route not found: ${req.method} ${req.originalUrl}`);
  
  if (logStore && logStore.addLog) {
    logStore.addLog('warn', '404 - Route not found', {
      method: req.method,
      url: req.originalUrl,
      userAgent: req.get('User-Agent'),
      ip: req.ip
    });
  }
  
  res.status(404).json({ 
    error: 'Route not found',
    message: `The requested route ${req.method} ${req.originalUrl} was not found`
  });
});

// Email templates for payment receipts
const customerEmailTemplate = ({ amount, businessName, paymentType, date, customerName }) => {
  const formattedAmount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);

  const paymentTypeText = paymentType === 'full' ? 'Full Payment' : 'Down Payment';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Payment Receipt</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .logo {
            max-width: 150px;
            height: auto;
          }
          .receipt-details {
            background: #f9f9f9;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 30px;
          }
          .detail-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 10px;
            border-bottom: 1px solid #eee;
            padding-bottom: 10px;
          }
          .thank-you {
            text-align: center;
            color: #666;
            margin-top: 30px;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <img src="https://i.imgur.com/LBdztzj.png" alt="Bidi Logo" class="logo">
          <h1>Payment Receipt</h1>
        </div>
        
        <div class="receipt-details">
          <div class="detail-row">
            <strong>Paid To:</strong>
            <span>${businessName}</span>
          </div>
          <div class="detail-row">
            <strong>Amount:</strong>
            <span>${formattedAmount}</span>
          </div>
          <div class="detail-row">
            <strong>Payment Type:</strong>
            <span>${paymentTypeText}</span>
          </div>
          <div class="detail-row">
            <strong>Date:</strong>
            <span>${new Date(date).toLocaleString()}</span>
          </div>
        </div>

        <div class="thank-you">
          <p>Thank you for using Bidi! We appreciate your business.</p>
          <p>If you have any questions, please don't hesitate to contact us.</p>
        </div>
      </body>
    </html>
  `;
};

const businessEmailTemplate = ({ amount, paymentType, date, customerName, fees, finalAmount, stripeLoginUrl }) => {
  const formattedAmount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);

  const formattedFees = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(fees);

  const formattedFinalAmount = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(finalAmount);

  const paymentTypeText = paymentType === 'full' ? 'Full Payment' : 'Down Payment';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>New Payment Received</title>
                  <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333;
              margin: 0;
              padding: 0;
              -webkit-text-size-adjust: 100%;
              -ms-text-size-adjust: 100%;
            }
            .email-container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
              background-color: #ffffff;
            }
            .header {
              text-align: center;
              padding: 20px 0;
              margin-bottom: 30px;
            }
            .logo {
              max-width: 150px;
              height: auto;
              display: inline-block;
            }
            .payment-details {
              background: #f9f9f9;
              border-radius: 8px;
              padding: 20px;
              margin-bottom: 30px;
              width: 100%;
              box-sizing: border-box;
            }
            .detail-row {
              display: flex;
              justify-content: space-between;
              margin-bottom: 10px;
              border-bottom: 1px solid #eee;
              padding-bottom: 10px;
              flex-wrap: wrap;
            }
            .detail-row strong {
              margin-right: 10px;
            }
            .fee-breakdown {
              background: #fff3cd;
              border: 1px solid #ffeeba;
              border-radius: 4px;
              padding: 15px;
              margin: 20px 0;
              width: 100%;
              box-sizing: border-box;
            }
            .final-amount {
              font-size: 1.2em;
              font-weight: bold;
              color: #28a745;
              text-align: center;
              padding: 15px;
              background: #f8f9fa;
              border-radius: 4px;
              margin: 20px 0;
              width: 100%;
              box-sizing: border-box;
            }
            .button {
              display: inline-block;
              padding: 12px 24px;
              background-color: #635bff;
              color: white !important;
              text-decoration: none;
              border-radius: 5px;
              margin-top: 20px;
              text-align: center;
              font-weight: 500;
            }
            .button-container {
              text-align: center;
              margin: 30px 0;
              color: white;
            }
            @media only screen and (max-width: 480px) {
              .email-container {
                padding: 10px;
              }
              .detail-row {
                flex-direction: column;
              }
              .detail-row strong {
                margin-bottom: 5px;
              }
            }
        </style>
      </head>
              <body>
          <div class="email-container">
            <div class="header">
              <img src="https://i.imgur.com/LBdztzj.png" alt="Bidi Logo" class="logo">
              <h1>New Payment Received!</h1>
            </div>
        
        <div class="payment-details">
          <div class="detail-row">
            <strong>Paid By:</strong>
            <span>${customerName}</span>
          </div>
          <div class="detail-row">
            <strong>Amount Received:</strong>
            <span>${formattedAmount}</span>
          </div>
          <div class="detail-row">
            <strong>Payment Type:</strong>
            <span>${paymentTypeText}</span>
          </div>
          <div class="detail-row">
            <strong>Date:</strong>
            <span>${new Date(date).toLocaleString()}</span>
          </div>
        </div>

        <div class="fee-breakdown">
          <h3 style="margin-top: 0;">Payment Breakdown</h3>
          <div class="detail-row">
            <strong>Total Payment:</strong>
            <span>${formattedAmount}</span>
          </div>
          <div class="detail-row">
            <strong>Bidi Fee (10%):</strong>
            <span>-${formattedFees}</span>
          </div>
        </div>

        <div class="final-amount">
          <div>Amount to be deposited to your account:</div>
          <div style="font-size: 1.4em; margin-top: 10px;">${formattedFinalAmount}</div>
        </div>

                  <div class="button-container">
            <a href="${stripeLoginUrl}" class="button">View in Stripe Dashboard →</a>
          </div>
        </div>
      </body>
    </html>
  `;
};

// Validation middleware for payment receipt request
/**
 * Fetch Stripe dashboard data for a connected account
 * @route POST /api/stripe-dashboard
 * @param {string} accountId - The Stripe Connect account ID
 * @returns {Object} Dashboard data including balance, payouts, charges, and account status
 */
app.post('/api/stripe-dashboard',
  stripeAccountLimiter,
  authenticateUser,
  validateStripeAccountId,
  async (req, res) => {
    try {
      const { accountId } = req.body;

      // Log the dashboard data request
      addLog('info', 'Fetching Stripe dashboard data', {
        accountId,
        userId: req.user.id,
        userEmail: req.user.email
      });

      // Fetch all required data in parallel
      const [
        balance,
        payouts,
        charges,
        account
      ] = await Promise.all([
        stripe.balance.retrieve({ stripeAccount: accountId }),
        stripe.payouts.list({ 
          limit: 10,
          stripeAccount: accountId
        }),
        stripe.charges.list({
          limit: 10,
          stripeAccount: accountId
        }),
        stripe.accounts.retrieve(accountId)
      ]);

      // Format the response according to the specified structure
      const response = {
        balance: {
          available: balance.available.map(({ amount, currency }) => ({
            amount,
            currency
          })),
          pending: balance.pending.map(({ amount, currency }) => ({
            amount,
            currency
          }))
        },
        payouts: payouts.data.map(payout => ({
          id: payout.id,
          amount: payout.amount,
          status: payout.status,
          created: payout.created
        })),
        charges: charges.data.map(charge => ({
          id: charge.id,
          amount: charge.amount,
          status: charge.status,
          created: charge.created
        })),
        account_status: {
          charges_enabled: account.charges_enabled,
          payouts_enabled: account.payouts_enabled,
          requirements: {
            currently_due: account.requirements.currently_due || [],
            pending_verification: account.requirements.pending_verification || []
          }
        }
      };

      // Log successful response
      addLog('info', 'Successfully fetched Stripe dashboard data', {
        accountId,
        userId: req.user.id,
        balanceCount: response.balance.available.length,
        payoutsCount: response.payouts.length,
        chargesCount: response.charges.length
      });

      res.json({
        success: true,
        ...response
      });

    } catch (error) {
      // Log the error with context
      addLog('error', 'Error fetching Stripe dashboard data', {
        accountId: req.body.accountId,
        userId: req.user.id,
        error: error.message,
        type: error.type,
        stack: error.stack
      });

      // Handle specific Stripe errors
      if (error.type === 'StripeInvalidRequestError') {
        return res.status(400).json({
          success: false,
          error: 'Invalid Stripe account ID'
        });
      }

      if (error.type === 'StripePermissionError') {
        return res.status(403).json({
          success: false,
          error: 'Permission denied to access this Stripe account'
        });
      }

      res.status(500).json({
        success: false,
        error: 'Error fetching dashboard data',
        message: error.message
      });
    }
  }
);

const validatePaymentReceiptRequest = (req, res, next) => {
  const { customerEmail, businessEmail, amount, paymentType, businessName, date, customerName, connectedAccountId } = req.body;

  // Check required fields
  if (!customerEmail || !businessEmail || !amount || !paymentType || !businessName || !date || !customerName || !connectedAccountId) {
    return res.status(400).json({
      error: 'Missing required fields',
      message: 'Please provide all required fields: customerEmail, businessEmail, amount, paymentType, businessName, date, customerName, connectedAccountId'
    });
  }

  // Validate email formats
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(customerEmail) || !emailRegex.test(businessEmail)) {
    return res.status(400).json({
      error: 'Invalid email format',
      message: 'Please provide valid email addresses'
    });
  }

  // Validate amount
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({
      error: 'Invalid amount',
      message: 'Amount must be a positive number'
    });
  }

  // Validate payment type
  if (!['full', 'down'].includes(paymentType)) {
    return res.status(400).json({
      error: 'Invalid payment type',
      message: 'Payment type must be either "full" or "down"'
    });
  }

  // Validate date
  if (isNaN(Date.parse(date))) {
    return res.status(400).json({
      error: 'Invalid date format',
      message: 'Please provide a valid date string'
    });
  }

  next();
};

// Payment receipt email endpoint
app.post('/send-payment-receipts', validatePaymentReceiptRequest, async (req, res) => {
  try {
    const { customerEmail, businessEmail, amount, paymentType, businessName, date, customerName, connectedAccountId } = req.body;

    // Calculate fees and final amount
    const fees = amount * 0.10; // 10% fee
    const finalAmount = amount - fees;

    // Get Stripe login link
    let stripeLoginUrl;
    try {
      const response = await fetch(
        "https://bidi-express.vercel.app/create-login-link",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ accountId: connectedAccountId }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to create Stripe login link');
      }

      const data = await response.json();
      stripeLoginUrl = data.url;
    } catch (error) {
      console.error('Error creating Stripe login link:', error);
      stripeLoginUrl = 'https://dashboard.stripe.com'; // Fallback URL
    }

    // Log the request
    logStore.addLog('info', 'Sending payment receipt emails', {
      customerEmail,
      businessEmail,
      amount,
      paymentType,
      businessName,
      customerName,
      fees,
      finalAmount
    });

    // Send customer receipt
    await resend.emails.send({
      from: 'receipts@bidi.com',
      to: customerEmail,
      subject: `Payment Receipt for ${businessName}`,
      html: customerEmailTemplate({ amount, businessName, paymentType, date, customerName })
    });

    // Send business notification
    await resend.emails.send({
      from: 'notifications@bidi.com',
      to: businessEmail,
      subject: 'New Payment Received',
      html: businessEmailTemplate({ 
        amount, 
        paymentType, 
        date, 
        customerName,
        fees,
        finalAmount,
        stripeLoginUrl
      })
    });

    // Log success
    logStore.addLog('info', 'Payment receipt emails sent successfully', {
      customerEmail,
      businessEmail
    });

    res.json({ 
      success: true,
      message: 'Payment receipt emails sent successfully'
    });

  } catch (error) {
    // Log error
    logStore.addLog('error', 'Failed to send payment receipt emails', {
      error: error.message,
      stack: error.stack
    });

    console.error('Error sending payment receipt emails:', error);

    res.status(500).json({ 
      error: 'Failed to send emails',
      message: 'An error occurred while sending the payment receipt emails'
    });
  }
});