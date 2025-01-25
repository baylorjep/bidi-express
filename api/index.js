const express = require("express");
const cors = require("cors"); 
const bodyParser = require('body-parser');
const app = express();
const { Resend } = require('resend');
const supabase = require('./supabaseClient');


// Initialize Resend with the API key
const resend = new Resend(process.env.RESEND_API_KEY);


// Set your Stripe secret key. Remember to switch to your live secret key in production.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY,
  {
    apiVersion: "2023-10-16",
  }
);

// Enable CORS with the frontend's URL to allow api requests from the site
app.use(cors({
  origin: ['https://www.savewithbidi.com', 'http://localhost:3000'], // Replace with your actual frontend URL
  methods: ['GET', 'POST'], // Specify allowed methods
  credentials: true, // If needed (e.g., for cookies)
}));

app.use(express.json());

// basic page

app.get("/", (req, res) => res.send("Bidi Express on Vercel"));


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
    const applicationFeeAmount = Math.round(amount * 0.05); // 5% of the amount in cents


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

// Serve static files only if the frontend is hosted from the same project
// If you're hosting the frontend separately, you can remove this

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
  const { category } = req.body; // Expecting the business category from the frontend

  // Validate input
  if (!category) {
    return res.status(400).json({ error: "Missing required field: category." });
  }

  try {
    // Fetch user IDs matching the category from `business_profiles`
    const { data: users, error: usersError } = await supabase
      .from('business_profiles') // Table with business categories
      .select('id') // Fetch only user IDs
      .filter('business_category', 'ilike', category.toLowerCase()); // Match the category

    if (usersError) {
      console.error("Error fetching users by category:", usersError.message);
      return res.status(500).json({ error: "Failed to fetch users by category." });
    }

    if (!users || users.length === 0) {
      return res.status(404).json({ error: `No users found in category: ${category}.` });
    }

    // Extract user IDs
    const userIds = users.map(user => user.id);

    // Fetch emails for these user IDs from the `profiles` table
    const { data: emails, error: emailsError } = await supabase
      .from('profiles') // Table with emails
      .select('email') // Fetch only email field
      .in('id', userIds); // Match user IDs

    if (emailsError) {
      console.error("Error fetching emails:", emailsError.message);
      return res.status(500).json({ error: "Failed to fetch emails for users." });
    }

    if (!emails || emails.length === 0) {
      return res.status(404).json({ error: `No emails found for users in category: ${category}.` });
    }

    // Send emails to all users
    const sendEmailPromises = emails.map(async ({ email }) => {
      const subject = `You have a new ${category} request on Bidi!`;
      const htmlContent = `
        <p>Hey there!</p>
        <p>You have 1 new ${category} request to view on Bidi!</p>
        <p>Log in to your Bidi dashboard to learn more.</p>
        <p>Best,</p>
        <p>The Bidi Team</p>
      `;

      return resend.emails.send({
        from: 'noreply@savewithbidi.com', // Replace with your verified sender email
        to: email,
        subject,
        html: htmlContent,
      });
    });

    // Await all email-sending promises
    await Promise.all(sendEmailPromises);

    console.log(`Emails sent successfully to category: ${category}`);
    res.status(200).json({ message: `Emails sent successfully to all users in category: ${category}.` });
  } catch (error) {
    console.error("Error sending emails:", error.message);
    res.status(500).json({ error: "Failed to send emails.", details: error.message });
  }
});

module.exports = app; // Export for Vercel



