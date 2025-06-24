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
app.get("/", (req, res) => res.send("Bidi Express on Vercel"));

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
  const { request_id } = req.body;

  if (!request_id) {
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
      let requestData = null;
      let foundCategory = null;

      const categories = ['catering', 'dj', 'beauty', 'florist', 'wedding_planning', 'videography', 'photography'];
      
      for (const category of categories) {
          const tableName = getTableNameForCategory(category);
          if (!tableName) continue;

          const { data, error } = await supabase
              .from(tableName)
              .select("*")
              .eq("id", request_id)
              .single();

          if (!error && data) {
              requestData = data;
              foundCategory = category;
              break;
          }
      }

      if (!requestData || !foundCategory) {
          console.error(`❌ Request not found in any category table for ID: ${request_id}`);
          return res.status(404).json({ error: "Request not found." });
      }

      console.log(`🔍 Retrieved request details from ${foundCategory} table:`, requestData);

      // Create standardized request details for the generateAutoBidForBusiness function
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

      // Find businesses with Auto-Bidding enabled
      const { data: autoBidBusinesses, error: businessError } = await supabase
          .from("business_profiles")
          .select("id, autobid_enabled, business_category")
          .eq("autobid_enabled", true);

      if (businessError) {
          console.error("❌ Error fetching businesses:", businessError.message);
          return res.status(500).json({ error: "Failed to fetch businesses." });
      }

      // Filter businesses to only include those whose category matches the request's category
      const eligibleBusinesses = autoBidBusinesses.filter(business =>
        business.business_category.toLowerCase() === requestDetails.service_category.toLowerCase()
      );

      console.log(`🔍 Found ${eligibleBusinesses.length} eligible businesses for category: ${requestDetails.service_category}`);

      let bidsGenerated = [];

      for (const business of eligibleBusinesses) {
        const autoBid = await generateAutoBidForBusiness(business.id, requestDetails);
        if (autoBid) {
            console.log(` Auto-bid generated for Business ${business.id}:`, autoBid);
            bidsGenerated.push({
                business_id: business.id,
                bid_amount: autoBid.bidAmount,
                bid_description: autoBid.bidDescription,
            });
        }
      }

      res.status(200).json({
          message: "Auto-bids generated successfully (LOG ONLY, NO INSERTION)",
          bids: bidsGenerated,
      });

  } catch (error) {
      console.error("❌ Error triggering auto-bid:", error.message);
      res.status(500).json({ error: "Failed to trigger auto-bid.", details: error.message });
  }
});

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