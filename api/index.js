const express = require("express");
const cors = require("cors"); // Import CORS
const bodyParser = require('body-parser');

const app = express();



// Set your Stripe secret key. Remember to switch to your live secret key in production.
const stripe = require("stripe")(
  'sk_test_51Pv13ZF25aBU3RMPjAxWeSf0Cvnp6OI0n5MlmU8dLopD2g5gBDOcD0oRs6RAj56SfF5pVACra3BSjJIRDphUNoJm00KUr0QoqJ',
  {
    apiVersion: "2023-10-16",
  }
);

// Enable CORS with the frontend's URL to allow api requests from the site
app.use(cors({
  origin: 'https://www.savewithbidi.com', // Replace with your actual frontend URL
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
    const { connectedAccountId, amount, applicationFeeAmount, serviceName } = req.body;

    console.log("Request Body:", req.body); // Log the incoming request data

    // Validate that the required fields are present
    if (!connectedAccountId || !amount || !applicationFeeAmount || !serviceName) {
      console.error("Missing required fields in request");
      return res.status(400).send("Missing required fields");
    }

    // Create a Checkout session
    const session = await stripe.checkout.sessions.create({
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
          destination: connectedAccountId, // Photographer's connected account ID
        },
      },
      mode: 'payment',
      success_url: 'https://www.savewithbidi.com/payment-successful', // Customize your success URL
      cancel_url: 'https://example.com/payment-cancelled',  // Customize your cancel URL
    });

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
const endpointSecret = process.env.STRIPE_WEBHOOK_TEST;

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

  // Return a response to acknowledge receipt of the event
  res.json({ received: true });
});

// Define functions to handle specific events
async function handleCheckoutSessionCompleted(session) {
  // Implement logic to update your database and application state
  const connectedAccountId = session.payment_intent;
  const amount = session.amount_total;

  console.log(`Checkout session completed for amount ${amount} to account ${connectedAccountId}`);

  // Example: Update database to mark the bid as paid
  // await updateDatabaseForSuccessfulPayment(session);
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


module.exports = app; // Export for Vercel



