const express = require("express");
const cors = require("cors"); // Import CORS
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
    const { connectedAccountId, amount, applicationFeeAmount } = req.body;

    // Create a Checkout session
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'Photography Service', // Customize as needed
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
      success_url: 'https://www.savewithbidi.com/success-signup', // Customize your success URL
      cancel_url: 'https://example.com/cancel',  // Customize your cancel URL
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

module.exports = app; // Export for Vercel



