// Disable debug logging in production to avoid missing common.js error
process.env.DEBUG = '';

require('dotenv').config(); // Load environment variables
const express = require("express");
const cors = require("cors"); 
const bodyParser = require('body-parser');
const { Resend } = require('resend');
const supabase = require('./supabaseClient');
const { generateAutoBidForBusiness } = require('./Autobid');
const googleCalendarRoutes = require('./google-calendar/routes');
const googlePlacesRoutes = require('./google-places/routes');
const authRoutes = require('./auth/routes');
const resend = new Resend(process.env.RESEND_API_KEY);
const http = require("http");
const { Server } = require("socket.io");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY,
  {
    apiVersion: "2023-10-16",
  }
);
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
      'http://localhost:3000'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
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

app.use(express.json());

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

// This is the endpoint to create an account session for Stripe onboarding
app.post("/account_session", async (req, res) => {
  try {
    const { account } = req.body;

    const accountSession = await stripe.accountSessions.create({
      account: account,
      components: {
        account_onboarding: { enabled: true },
      },
    });

    res.json({
      client_secret: accountSession.client_secret,
    });
  } catch (error) {
    console.error(
      "An error occurred when calling the Stripe API to create an account session",
      error
    );
    res.status(500).send({ error: error.message });
  }
});

// This is the endpoint for creating a connected account
app.post("/account", async (req, res) => {
  try {
    const account = await stripe.accounts.create({
      type: "express",
      country: "US", // Adjust if needed
      email: req.body.email, // Assuming email is passed in the request body
    });

    res.json({
      account: account.id,
    });
  } catch (error) {
    console.error(
      "An error occurred when calling the Stripe API to create an account",
      error
    );
    res.status(500).send({ error: error.message });
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
              from: { name: 'Bidi', email: 'noreply@savewithbidi.com' },
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
                const autoBid = await generateAutoBidForBusiness(business.id, requestDetails);
                if (autoBid) {
                    logger.info(`✅ Auto-bid generated for Business ${business.id}:`, autoBid);
                    bidsGenerated.push({
                        business_id: business.id,
                        bid_amount: autoBid.bidAmount,
                        bid_description: autoBid.bidDescription,
            });
        } else {
            logger.error(`❌ Failed to generate auto-bid for Business ${business.id}`);
        }
      }

      logger.info("✅ === TRIGGER-AUTOBID ROUTE COMPLETED SUCCESSFULLY ===");
      res.status(200).json({
          message: "Auto-bids generated successfully (LOG ONLY, NO INSERTION)",
          bids: bidsGenerated,
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

    const aiResponse = await storeAIBid(business_id, requestId, generatedBid, category);
    logger.info("💾 AI bid stored with ID:", aiResponse.id);

    res.json({
      success: true,
      generated_bid: generatedBid,
      response_id: aiResponse.id,
      amount: generatedBid.amount,
      description: generatedBid.description,
      breakdown: generatedBid.breakdown,
      reasoning: generatedBid.reasoning
        });

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
  const { data: pricingRules, error: pricingError } = await supabase
    .from("business_pricing_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("category", category)
    .single();

  if (pricingError) {
    console.warn("⚠️ No explicit pricing rules found for Business ID:", businessId, "Category:", category);
  } else {
    console.log("✅ Found pricing rules for business:", pricingRules);
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

  // Calculate pricing using new logic
  let basePrice = 0;
  let travelFees = { fee: 0, warning: null };
  let finalPrice = 0;

  if (pricingRules) {
    // Calculate base price using new category-specific pricing
    basePrice = calculateCategoryPricing(sampleRequest, pricingRules);
    
    // Apply duration-based pricing if applicable
    if (pricingRules.hourly_tiers && sampleRequest.duration) {
      basePrice = calculateDurationPricing(sampleRequest.duration, pricingRules);
    }
    
    // Apply seasonal pricing
    if (sampleRequest.start_date) {
      basePrice = applySeasonalPricing(basePrice, sampleRequest.start_date, pricingRules.seasonal_pricing);
    }
    
    // Calculate travel fees (placeholder for training)
    if (pricingRules.travel_config) {
      travelFees = calculateTravelFees(null, sampleRequest.location, pricingRules.travel_config);
    }
    
    // Apply platform markup
    finalPrice = basePrice + travelFees.fee;
    if (pricingRules.platform_markup) {
      const markup = finalPrice * (pricingRules.platform_markup / 100);
      finalPrice += markup;
    }
    
    console.log(`💰 Training pricing calculated: Base $${basePrice}, Travel $${travelFees.fee}, Final $${finalPrice}`);
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
  
  // Use the calculated final price instead of AI-generated price
  validatedBid.bidAmount = finalPrice;
  
  console.log(`💰 Final validated training bid: $${validatedBid.bidAmount}`);

  return {
    amount: validatedBid.bidAmount,
    description: validatedBid.bidDescription,
    breakdown: aiBid.breakdown || aiBid.pricingBreakdown || "",
    reasoning: aiBid.reasoning || aiBid.pricingReasoning || ""
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

  // Get the category from the training response
  const { data: response, error: responseError } = await supabase
    .from('autobid_training_responses')
    .select('category')
    .eq('id', trainingResponseId)
    .single();

  if (responseError) {
    console.error("❌ Error fetching training response:", responseError);
    return;
  }

  // Get current progress first
  const { data: currentProgress, error: progressFetchError } = await supabase
    .from('autobid_training_progress')
    .select('consecutive_approvals')
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
          total_scenarios_completed: 1,
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

  // Update existing progress
  const { error: progressError } = await supabase
    .from('autobid_training_progress')
    .update({
      consecutive_approvals: (currentProgress?.consecutive_approvals || 0) + 1,
      total_scenarios_completed: (currentProgress?.total_scenarios_completed || 0) + 1,
      last_training_date: new Date().toISOString()
    })
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
- **Min Price:** $${rules.min_price || 'No limit'}
- **Max Price:** $${rules.max_price || 'No limit'}
- **Hourly Rate:** $${rules.hourly_rate || 'Not set'}
- **Per Person Rate:** $${rules.per_person_rate || 'Not set'}
- **Wedding Premium:** ${rules.wedding_premium ? `$${rules.wedding_premium}` : 'Not set'}
- **Travel Fee:** $${rules.travel_fee_per_mile || 'Not set'} per mile
- **Rush Fee:** ${rules.rush_fee_percentage || 'Not set'}%
- **Deposit:** ${rules.deposit_percentage || 'Not set'}%
- **Min/Max Guests:** ${rules.minimum_guests || 'No limit'} - ${rules.maximum_guests || 'No limit'}
- **Bid Aggressiveness:** ${rules.bid_aggressiveness || 'Not specified'}
- **Accept Unknowns:** ${rules.accept_unknowns ? 'Yes' : 'No'}

**CATEGORY-SPECIFIC PRICING:**
- **Full Day Rate:** $${rules.full_day_rate || 'Not set'}
- **Half Day Rate:** $${rules.half_day_rate || 'Not set'}
- **Editing Rate:** $${rules.editing_rate || 'Not set'}
- **Hair Only Rate:** $${rules.hair_only_rate || 'Not set'}
- **Makeup Only Rate:** $${rules.makeup_only_rate || 'Not set'}
- **Bridal Package Price:** $${rules.bridal_package_price || 'Not set'}
- **Ceremony Package Price:** $${rules.ceremony_package_price || 'Not set'}
- **Full Service Price:** $${rules.full_service_price || 'Not set'}
- **Highlight Video Price:** $${rules.highlight_video_price || 'Not set'}
- **Cinematic Package Price:** $${rules.cinematic_package_price || 'Not set'}

**COMPLEX PRICING STRUCTURES:**
- **Duration Multipliers:** ${rules.duration_multipliers ? JSON.stringify(rules.duration_multipliers) : 'Not configured'}
- **Service Addons:** ${rules.service_addons ? JSON.stringify(rules.service_addons) : 'Not configured'}
- **Seasonal Pricing:** ${rules.seasonal_pricing ? JSON.stringify(rules.seasonal_pricing) : 'Not configured'}
- **Group Discounts:** ${rules.group_discounts ? JSON.stringify(rules.group_discounts) : 'Not configured'}
- **Package Discounts:** ${rules.package_discounts ? JSON.stringify(rules.package_discounts) : 'Not configured'}
- **Custom Pricing Rules:** ${rules.custom_pricing_rules ? JSON.stringify(rules.custom_pricing_rules) : 'Not configured'}

**CATEGORY-SPECIFIC PACKAGES:**
- **Flower Tiers:** ${rules.flower_tiers ? JSON.stringify(rules.flower_tiers) : 'Not configured'}
- **Equipment Packages:** ${rules.equipment_packages ? JSON.stringify(rules.equipment_packages) : 'Not configured'}
- **Menu Tiers:** ${rules.menu_tiers ? JSON.stringify(rules.menu_tiers) : 'Not configured'}
- **Service Staff:** ${rules.service_staff ? JSON.stringify(rules.service_staff) : 'Not configured'}

**CONTENT & MESSAGING:**
- **Default Message:** ${rules.default_message || 'Not set'}
- **Additional Comments:** ${rules.additional_comments || 'None'}
- **Additional Notes:** ${rules.additional_notes || 'None'}
- **Blocklist Keywords:** ${rules.blocklist_keywords ? JSON.stringify(rules.blocklist_keywords) : 'None'}`;
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
You are an AI assistant that generates personalized bids for ${category} services based on a business's pricing rules, training data, and feedback.

### BUSINESS PRICING RULES (PRIMARY FOUNDATION):
${formatPricingRules(pricingRules)}

### BUSINESS PACKAGES (AVAILABLE OPTIONS):
${formatBusinessPackages(businessPackages)}

### CALCULATED PRICING BREAKDOWN:
- **Base Price:** $${basePrice}
- **Travel Fees:** $${travelFees.fee}${travelFees.warning ? ` (${travelFees.warning})` : ''}
- **Platform Markup:** ${pricingRules?.platform_markup ? `${pricingRules.platform_markup}%` : 'None'}
- **Final Price:** $${finalPrice}

### CONSULTATION REQUIREMENTS:
${pricingRules?.consultation_required ? '⚠️ CONSULTATION CALL REQUIRED: Always mention scheduling a consultation call before providing final quote.' : 'No consultation call required.'}

### BUSINESS TRAINING PATTERNS (ENHANCEMENT DATA):
- **Training Bid Range:** $${Math.min(...processedData.responses?.map(r => r.bid_amount) || [0])} - $${Math.max(...processedData.responses?.map(r => r.bid_amount) || [0])}
- **Average Training Bid:** $${processedData.business_patterns.average_bid_amount.toFixed(2)}
- **Pricing Strategy:** ${Object.entries(processedData.pricing_strategy).filter(([k,v]) => v).map(([k,v]) => k.replace('_', ' ')).join(', ')}
- **Service Emphasis:** ${processedData.service_preferences.join(', ')}
- **Description Style:** ${processedData.business_patterns.description_style}
- **Pricing Factors:** ${processedData.business_patterns.pricing_factors.join(', ')}

### CRITICAL FEEDBACK LEARNING:
- **Approval Rate:** ${(processedData.feedback_preferences.approval_rate * 100).toFixed(1)}%
- **Pricing Adjustments Needed:** ${processedData.feedback_preferences.pricing_adjustments.join(', ') || 'none'}
- **Common Issues to Avoid:** ${processedData.feedback_preferences.common_issues.join(', ') || 'none'}
- **Specific Feedback Received:** ${processedData.feedback_preferences.specific_feedback.slice(0, 3).join(' | ') || 'none'}
- **Preferred Improvements:** ${processedData.feedback_preferences.preferred_improvements.slice(0, 2).join(' | ') || 'none'}

### PRICING ADJUSTMENT INSTRUCTIONS:
${processedData.feedback_preferences.pricing_adjustments.includes('reduce_pricing') ? 
  '⚠️ CRITICAL: Previous feedback indicates pricing was TOO HIGH. Reduce your bid amount by 15-25% from the business base price.' : ''}
${processedData.feedback_preferences.pricing_adjustments.includes('increase_pricing') ? 
  '⚠️ CRITICAL: Previous feedback indicates pricing was TOO LOW. Increase your bid amount by 15-25% from the business base price.' : ''}
${processedData.feedback_preferences.pricing_adjustments.length === 0 ? 
  '✅ No major pricing issues identified in feedback. Use business pricing rules as baseline.' : ''}

### SPECIFIC REQUEST ANALYSIS:
- **Duration:** ${sampleRequest.duration}
- **Event Type:** ${sampleRequest.event_type}
- **Guest Count:** ${sampleRequest.guest_count}
- **Location:** ${sampleRequest.location}
- **Requirements:** ${sampleRequest.requirements?.join(', ')}
- **Suggested Base Price Range:** $${Math.round(basePrice * 0.8)} - $${Math.round(basePrice * 1.2)}

### CATEGORY-SPECIFIC FACTORS:
- **Pricing Factors:** ${categoryInfo.pricingFactors}
- **Service Types:** ${categoryInfo.serviceTypes}

### PRICING CALCULATION INSTRUCTIONS (CRITICAL):
**PRIMARY PRICING FOUNDATION:** Use the business's explicit pricing rules as your starting point, NOT training averages.

1. **USE CALCULATED PRICE:** The final price of $${finalPrice} has already been calculated using:
   - Base category rate: $${basePrice}
   - Travel fees: $${travelFees.fee}
   - Platform markup: ${pricingRules?.platform_markup ? `${pricingRules.platform_markup}%` : 'None'}

2. **CATEGORY-SPECIFIC PRICING MODEL:**
   ${pricingRules?.category === 'photography' || pricingRules?.category === 'videography' ? `
   **PHOTOGRAPHY/VIDEOGRAPHY:**
   - Wedding: $${pricingRules?.base_category_rates?.wedding || 'Not set'}
   - Couple/Engagement: $${pricingRules?.base_category_rates?.couple || 'Not set'}
   - Family/Portrait: $${pricingRules?.base_category_rates?.family || 'Not set'}` : ''}
   
   ${pricingRules?.category === 'catering' ? `
   **CATERING:**
   - Base rate: $${pricingRules?.base_category_rates?.catering || 'Not set'}
   - Per-person: $${pricingRules?.per_person_rates?.base || 'Not set'} + $${pricingRules?.per_person_rates?.additionalPerson || 'Not set'} per additional person` : ''}
   
   ${pricingRules?.category === 'dj' ? `
   **DJ:**
   - First hour: $${pricingRules?.hourly_tiers?.firstHour || 'Not set'}
   - Additional hours: $${pricingRules?.hourly_tiers?.additionalHours || 'Not set'}` : ''}

3. **TRAVEL & LOGISTICS:**
   - Travel fees: $${travelFees.fee}${travelFees.warning ? ` - ${travelFees.warning}` : ''}
   - Include travel warnings in bid message if applicable

4. **CONSULTATION REQUIREMENTS:**
   ${pricingRules?.consultation_required ? 
     '⚠️ ALWAYS mention scheduling a consultation call before providing final quote. Example: "I\'d love to schedule a quick call to discuss your specific needs and provide a final quote."' : 
     'No consultation call required.'}

5. **PACKAGE SUGGESTIONS:**
   - Suggest relevant packages from the business packages list
   - Use package pricing as alternative to calculated pricing when appropriate

6. **UPSELL OPPORTUNITIES:**
   - Mention relevant add-ons based on the request
   - Keep suggestions non-aggressive and optional
   - Focus on value-add services

7. **FINAL VALIDATION:**
   - Use the calculated final price: $${finalPrice}
   - Ensure price is reasonable ($50-$50k range)
   - Match business's bid aggressiveness level
   - Avoid blocklist_keywords: ${pricingRules?.blocklist_keywords ? JSON.stringify(pricingRules.blocklist_keywords) : 'None'}

### TRAINING DATA INTEGRATION:
Use the business's training patterns to enhance your bid (but don't override pricing rules):
1. **Follow their pricing strategy** - Use their preferred pricing approach
2. **Emphasize their preferred services** - Highlight services they typically include
3. **Match their description style** - Use their preferred level of detail
4. **AVOID THESE ISSUES:** ${processedData.feedback_preferences.common_issues.join(', ') || 'none'}
5. **INCORPORATE THESE IMPROVEMENTS:** ${processedData.feedback_preferences.preferred_improvements.slice(0, 2).join(' | ') || 'none'}

### RETURN JSON FORMAT ONLY:
\`\`\`json
{
  "bidAmount": <calculated bid amount with feedback-based adjustments>,
  "bidDescription": "<detailed bid description incorporating feedback improvements>",
  "pricingBreakdown": "<detailed pricing breakdown>",
  "pricingReasoning": "<explanation of pricing strategy including feedback considerations>"
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
  const category = requestData.service_category?.toLowerCase();
  const eventType = requestData.event_type?.toLowerCase();
  const guestCount = requestData.guest_count || requestData.estimated_guests || 1;
  
  if (!pricingRules.base_category_rates) {
    return 0;
  }
  
  // Determine which category rate to use
  let baseRate = 0;
  
  if (category === 'photography' || category === 'videography') {
    if (eventType === 'wedding') {
      baseRate = pricingRules.base_category_rates.wedding || 0;
    } else if (eventType === 'couple' || eventType === 'engagement') {
      baseRate = pricingRules.base_category_rates.couple || 0;
    } else if (eventType === 'family' || eventType === 'portrait') {
      baseRate = pricingRules.base_category_rates.family || 0;
    } else {
      baseRate = pricingRules.base_category_rates.portrait || 0;
    }
  } else if (category === 'catering') {
    baseRate = pricingRules.base_category_rates.catering || 0;
  } else if (category === 'dj') {
    baseRate = pricingRules.base_category_rates.dj || 0;
  } else if (category === 'beauty') {
    baseRate = pricingRules.base_category_rates.beauty || 0;
  } else if (category === 'florist') {
    baseRate = pricingRules.base_category_rates.florist || 0;
  } else if (category === 'wedding_planning') {
    baseRate = pricingRules.base_category_rates.wedding_planning || 0;
  }
  
  // Apply per-person logic if applicable
  if (pricingRules.per_person_rates && guestCount > 1) {
    const { base, additionalPerson } = pricingRules.per_person_rates;
    return base + (additionalPerson * (guestCount - 1));
  }
  
  return baseRate;
}

// Helper function to calculate duration-based pricing
function calculateDurationPricing(duration, pricingRules) {
  if (!duration || !pricingRules.hourly_tiers) {
    return 0;
  }
  
  const hours = parseInt(duration.match(/(\d+)/)?.[1] || 1);
  const { firstHour, additionalHours } = pricingRules.hourly_tiers;
  
  if (hours === 1) {
    return firstHour;
  }
  
  return firstHour + (additionalHours * (hours - 1));
}

// Helper function to apply seasonal pricing
function applySeasonalPricing(basePrice, eventDate, seasonalPricing) {
  if (!seasonalPricing || !eventDate) {
    return basePrice;
  }
  
  const month = new Date(eventDate).getMonth();
  const seasonalMultiplier = seasonalPricing[month] || 1.0;
  return Math.round(basePrice * seasonalMultiplier);
}

// Helper function to calculate travel fees
function calculateTravelFees(vendorLocation, eventLocation, travelConfig) {
  if (!travelConfig || !eventLocation) {
    return { fee: 0, warning: null };
  }
  
  // Simple distance calculation (in production, use Google Maps API)
  // For now, we'll use a placeholder that can be enhanced later
  const distance = 25; // Placeholder - would calculate actual distance
  
  if (distance <= travelConfig.freeDistance) {
    return { fee: 0, warning: null };
  }
  
  const fee = (distance - travelConfig.freeDistance) * travelConfig.drivingRate;
  return { 
    fee: Math.round(fee), 
    warning: travelConfig.travelWarning 
  };
}