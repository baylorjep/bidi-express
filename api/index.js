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

// basic page
app.get("/", (req, res) => res.send("Bidi Express is Running!"));

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

// Resend email endpoint
app.post('/send-resend-email', async (req, res) => {
  const { category } = req.body;

  if (!category) {
    return res.status(400).json({ error: "Missing required field: category." });
  }

  try {
    // Fetch user IDs matching the category from `business_profiles`
    const { data: users, error: usersError } = await supabase
      .from('business_profiles')
      .select('id')
      .eq('business_category', category);

    if (usersError) {
      console.error("Error fetching users by category:", usersError.message);
      return res.status(500).json({ error: "Failed to fetch users by category." });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ error: `No users found in category: ${category}.` });
    }
    console.log(`Users retrieved from business_profiles:`, users.map(u => u.id));

    // Extract user IDs
    const userIds = users.map(user => user.id);

    // Fetch emails for these user IDs from the `profiles` table
    const { data: emails, error: emailsError } = await supabase
      .from('profiles')
      .select('email')
      .in('id', userIds);

    if (emailsError) {
      console.error("Error fetching emails:", emailsError.message);
      return res.status(500).json({ error: "Failed to fetch emails for users." });
    }

    if (!emails || emails.length === 0) {
      return res.status(404).json({ error: `No emails found for users in category: ${category}.` });
    }
    console.log("Emails retrieved from profiles:", emails);

    const validEmails = emails.map(e => e.email).filter(email => email); // Ensure no null values

    console.log(`📩 Sending emails to ${validEmails.length} users in category: ${category}`);

    // **Batch Processing to Avoid Rate Limit**
    const batchSize = 2; // Resend allows 2 requests per second
    let batchIndex = 0;

    while (batchIndex < validEmails.length) {
      const batch = validEmails.slice(batchIndex, batchIndex + batchSize);

      await Promise.all(
        batch.map(async (email) => {
          const subject = `You have a new ${category} request on Bidi!`;
          const htmlContent = `
            <p>Hey there!</p>
            <p>You have 1 new ${category} request to view on Bidi!</p>
            <p>Log in to your Bidi dashboard to learn more.</p>
            <p><a href="https://www.savewithbidi.com/open-requests" target="_blank" style="color: #007BFF; text-decoration: none;">Click here to view the request!</a></p>
            <p>Best,</p>
            <p>The Bidi Team</p>
          `;

          try {
            await resend.emails.send({
              from: 'noreply@savewithbidi.com',
              to: email,
              subject,
              html: htmlContent,
            });
            console.log(`✅ Email sent to: ${email}`);
          } catch (emailError) {
            console.error(`❌ Failed to send email to ${email}:`, emailError.message);
          }
        })
      );

      batchIndex += batchSize;

      if (batchIndex < validEmails.length) {
        console.log(`⏳ Waiting 1 second before sending next batch...`);
        await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1 second before next batch
      }
    }

    console.log(`✅ All emails sent successfully for category: ${category}`);
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
  console.log("🚀 === TRIGGER-AUTOBID ROUTE STARTED ===");
  console.log("📋 Request body:", JSON.stringify(req.body, null, 2));
  
  const { request_id } = req.body;

  if (!request_id) {
      console.log("❌ Missing request_id in request body");
      return res.status(400).json({ error: "Missing required field: request_id." });
  }

  try {
      console.log(`🆕 Auto-bid triggered for Request ID: ${request_id}`);

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
      console.log("🔍 Searching for request in category tables...");
      let requestData = null;
      let foundCategory = null;

      const categories = ['catering', 'dj', 'beauty', 'florist', 'wedding_planning', 'videography', 'photography'];
      
      for (const category of categories) {
          const tableName = getTableNameForCategory(category);
          if (!tableName) {
              console.log(`⚠️ No table mapping found for category: ${category}`);
              continue;
          }

          console.log(`🔍 Checking table: ${tableName}`);
          const { data, error } = await supabase
              .from(tableName)
              .select("*")
              .eq("id", request_id)
              .single();

          if (error) {
              console.log(`❌ Error querying ${tableName}:`, error.message);
          } else if (data) {
              console.log(`✅ Found request in ${tableName}`);
              requestData = data;
              foundCategory = category;
              break;
          } else {
              console.log(`📭 No data found in ${tableName}`);
          }
      }

      if (!requestData || !foundCategory) {
          console.error(`❌ Request not found in any category table for ID: ${request_id}`);
          return res.status(404).json({ error: "Request not found." });
      }

      console.log(`🔍 Retrieved request details from ${foundCategory} table:`, JSON.stringify(requestData, null, 2));

      // Create standardized request details for the generateAutoBidForBusiness function
      console.log("📝 Creating standardized request details...");
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

      console.log("📋 Standardized request details:", JSON.stringify(requestDetails, null, 2));

      // Find businesses with Auto-Bidding enabled
      console.log("🏢 Fetching businesses with auto-bidding enabled...");
      const { data: autoBidBusinesses, error: businessError } = await supabase
          .from("business_profiles")
          .select("id, autobid_enabled, business_category")
          .eq("autobid_enabled", true);

      if (businessError) {
          console.error("❌ Error fetching businesses:", businessError.message);
          return res.status(500).json({ error: "Failed to fetch businesses." });
      }

      console.log(`📊 Found ${autoBidBusinesses?.length || 0} businesses with auto-bidding enabled`);

      // Filter businesses to only include those whose category matches the request's category
      const eligibleBusinesses = autoBidBusinesses.filter(business => {
        const businessCategories = Array.isArray(business.business_category) 
          ? business.business_category.map(cat => cat.toLowerCase())
          : [business.business_category?.toLowerCase() || ''];
        const requestCategory = requestDetails.service_category.toLowerCase();
        
        console.log(`🔍 Business categories:`, businessCategories);
        console.log(`🔍 Request category: "${requestCategory}"`);
        console.log(`🔍 Business ${business.id} categories:`, businessCategories);
        
        return businessCategories.includes(requestCategory);
      });

      console.log(`🔍 Found ${eligibleBusinesses.length} eligible businesses for category: ${requestDetails.service_category}`);
      console.log("🏢 Eligible businesses:", JSON.stringify(eligibleBusinesses, null, 2));

      let bidsGenerated = [];

      for (const business of eligibleBusinesses) {
        console.log(`🤖 Generating auto-bid for business: ${business.id}`);
        const autoBid = await generateAutoBidForBusiness(business.id, requestDetails);
        if (autoBid) {
            console.log(`✅ Auto-bid generated for Business ${business.id}:`, autoBid);
            bidsGenerated.push({
                business_id: business.id,
                bid_amount: autoBid.bidAmount,
                bid_description: autoBid.bidDescription,
            });
        } else {
            console.log(`❌ Failed to generate auto-bid for Business ${business.id}`);
        }
      }

      console.log("✅ === TRIGGER-AUTOBID ROUTE COMPLETED SUCCESSFULLY ===");
      res.status(200).json({
          message: "Auto-bids generated successfully (LOG ONLY, NO INSERTION)",
          bids: bidsGenerated,
      });

  } catch (error) {
      console.error("❌ === TRIGGER-AUTOBID ROUTE FAILED ===");
      console.error("Error details:", error);
      console.error("Error message:", error.message);
      console.error("Error stack:", error.stack);
      console.error("=== END ERROR LOG ===");
      res.status(500).json({ error: "Failed to trigger auto-bid.", details: error.message });
  }
});

// ==================== AUTOBID TRAINING SYSTEM ====================

// 1. AI Bid Generation Endpoint for Training
app.post('/api/autobid/generate-sample-bid', async (req, res) => {
  console.log("🚀 === GENERATE SAMPLE BID ROUTE STARTED ===");
  console.log("📋 Request body:", JSON.stringify(req.body, null, 2));
  
  try {
    const { business_id, category, sample_request } = req.body;
    
    if (!business_id || !category || !sample_request) {
      return res.status(400).json({ 
        error: "Missing required fields: business_id, category, sample_request" 
      });
    }

    console.log(`🤖 Generating AI sample bid for Business ${business_id}, Category: ${category}`);

    // 1. Fetch business training data
    const trainingData = await getBusinessTrainingData(business_id, category);
    console.log(`📊 Retrieved ${trainingData.responses?.length || 0} training responses`);

    // 2. Generate AI bid using training data
    const generatedBid = await generateAIBidForTraining(trainingData, sample_request, category);
    console.log("✅ AI bid generated:", generatedBid);

    // 3. Store AI bid in database
    const aiResponse = await storeAIBid(business_id, sample_request.id, generatedBid, category);
    console.log("💾 AI bid stored with ID:", aiResponse.id);

    res.json({
      success: true,
      generated_bid: generatedBid,
      response_id: aiResponse.id
    });

  } catch (error) {
    console.error("❌ === GENERATE SAMPLE BID ROUTE FAILED ===");
    console.error("Error details:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Training Data Retrieval Endpoint
app.get('/api/autobid/training-data/:business_id/:category', async (req, res) => {
  console.log("📊 === TRAINING DATA RETRIEVAL ROUTE STARTED ===");
  
  try {
    const { business_id, category } = req.params;
    console.log(`📋 Fetching training data for Business ${business_id}, Category: ${category}`);

    const trainingData = await getBusinessTrainingData(business_id, category);
    
    res.json({
      success: true,
      business_responses: trainingData.responses || [],
      feedback_data: trainingData.feedback || []
    });

  } catch (error) {
    console.error("❌ Error retrieving training data:", error);
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
    const { business_id, training_response_id, feedback_type, feedback_text, specific_issues, suggested_improvements } = req.body;

    if (!business_id || !training_response_id || !feedback_type) {
      return res.status(400).json({ 
        error: "Missing required fields: business_id, training_response_id, feedback_type" 
      });
    }

    // Store feedback
    const { data: feedback, error: feedbackError } = await supabase
      .from('autobid_training_feedback')
      .insert({
        business_id,
        training_response_id,
        feedback_type,
        feedback_text,
        specific_issues,
        suggested_improvements
      })
      .select()
      .single();

    if (feedbackError) {
      console.error("❌ Error storing feedback:", feedbackError);
      return res.status(500).json({ error: "Failed to store feedback" });
    }

    // Update training progress based on feedback
    if (feedback_type === 'approved') {
      await updateTrainingProgress(business_id, training_response_id);
    }

    console.log("✅ Feedback stored successfully:", feedback.id);

    res.json({
      success: true,
      feedback_id: feedback.id
    });

  } catch (error) {
    console.error("❌ Error processing feedback:", error);
    res.status(500).json({ error: error.message });
  }
});

// Helper Functions for Training System

async function getBusinessTrainingData(businessId, category) {
  console.log(`🔍 Fetching training data for Business ${businessId}, Category: ${category}`);

  // Fetch business responses for this category
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

async function generateAIBidForTraining(trainingData, sampleRequest, category) {
  console.log(`🤖 Generating AI bid for training with ${trainingData.responses.length} responses`);

  // Process training data for AI
  const processedData = processTrainingDataForAI(trainingData);
  
  // Create AI prompt with training data
  const prompt = createTrainingAIPrompt(processedData, sampleRequest, category);
  
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

  return {
    amount: aiBid.bidAmount || aiBid.amount,
    description: aiBid.bidDescription || aiBid.description,
    breakdown: aiBid.breakdown || aiBid.pricingBreakdown || "",
    reasoning: aiBid.reasoning || aiBid.pricingReasoning || ""
  };
}

async function storeAIBid(businessId, requestId, generatedBid, category) {
  console.log(`💾 Storing AI bid for Business ${businessId}`);

  const { data: aiResponse, error: insertError } = await supabase
    .from('autobid_training_responses')
    .insert({
      business_id: businessId,
      request_id: requestId,
      bid_amount: generatedBid.amount,
      bid_description: generatedBid.description,
      pricing_breakdown: generatedBid.breakdown,
      pricing_reasoning: generatedBid.reasoning,
      is_training: true,
      is_ai_generated: true,
      category: category
    })
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

  // Update progress
  const { error: progressError } = await supabase
    .from('autobid_training_progress')
    .update({
      consecutive_approvals: supabase.sql`consecutive_approvals + 1`,
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
    service_preferences: extractServicePreferences(trainingData.responses)
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
    preferred_improvements: []
  };

  if (feedback.length > 0) {
    const approvals = feedback.filter(f => f.feedback_type === 'approved').length;
    preferences.approval_rate = approvals / feedback.length;

    // Extract common issues from rejected feedback
    const rejectedFeedback = feedback.filter(f => f.feedback_type === 'rejected');
    preferences.common_issues = extractCommonIssues(rejectedFeedback);
  }

  return preferences;
}

function extractCommonIssues(rejectedFeedback) {
  const issues = [];

  rejectedFeedback.forEach(feedback => {
    const text = feedback.feedback_text?.toLowerCase() || '';

    if (text.includes('too high') || text.includes('expensive')) {
      issues.push('pricing_too_high');
    }
    if (text.includes('too low') || text.includes('cheap')) {
      issues.push('pricing_too_low');
    }
    if (text.includes('missing') || text.includes('incomplete')) {
      issues.push('incomplete_description');
    }
    if (text.includes('wrong') || text.includes('incorrect')) {
      issues.push('incorrect_services');
    }
  });

  return [...new Set(issues)];
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

function createTrainingAIPrompt(processedData, sampleRequest, category) {
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

  return `
You are an AI assistant that generates personalized bids for ${category} services based on a business's training data.

### BUSINESS TRAINING PATTERNS:
- **Average Bid Amount:** $${processedData.business_patterns.average_bid_amount.toFixed(2)}
- **Pricing Strategy:** ${Object.entries(processedData.pricing_strategy).filter(([k,v]) => v).map(([k,v]) => k.replace('_', ' ')).join(', ')}
- **Service Emphasis:** ${processedData.service_preferences.join(', ')}
- **Description Style:** ${processedData.business_patterns.description_style}
- **Pricing Factors:** ${processedData.business_patterns.pricing_factors.join(', ')}

### FEEDBACK PREFERENCES:
- **Approval Rate:** ${(processedData.feedback_preferences.approval_rate * 100).toFixed(1)}%
- **Common Issues to Avoid:** ${processedData.feedback_preferences.common_issues.join(', ')}

### SAMPLE REQUEST:
${JSON.stringify(sampleRequest, null, 2)}

### CATEGORY-SPECIFIC FACTORS:
- **Pricing Factors:** ${categoryInfo.pricingFactors}
- **Service Types:** ${categoryInfo.serviceTypes}

### INSTRUCTIONS:
Generate a bid that matches this business's style and pricing patterns. Consider:
1. Their average bid amount and pricing strategy
2. Their preferred service emphasis and description style
3. Common issues they've identified in previous feedback
4. The specific requirements of this sample request

### RETURN JSON FORMAT ONLY:
\`\`\`json
{
  "bidAmount": <calculated bid amount>,
  "bidDescription": "<detailed bid description matching business style>",
  "pricingBreakdown": "<detailed pricing breakdown>",
  "pricingReasoning": "<explanation of pricing strategy>"
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

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
    details: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

module.exports = app; // Export for Vercel