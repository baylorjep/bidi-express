// api/send-notification.js
const webpush = require("web-push");
const { supabase } = require("./supabaseClient");

// Configure your VAPID keys for sending notifications
webpush.setVapidDetails(
  "mailto:jamjimmer@gmail.com", // Your email address
  "YOUR_PUBLIC_VAPID_KEY", // Public key from web-push
  "YOUR_PRIVATE_VAPID_KEY" // Private key from web-push
);

module.exports = async function (req, res) {
  const { recipient_id, title, body } = req.body;

  try {
    // Log the recipient and notification details
    console.log("Sending notification to recipient_id:", recipient_id);
    console.log("Notification title:", title);
    console.log("Notification body:", body);

    // Retrieve the subscription for the recipient user
    const { data: subscription, error } = await supabase
      .from("subscriptions")
      .select("*")
      .eq("user_id", recipient_id)
      .single();

    if (error || !subscription) {
      return res
        .status(404)
        .json({ error: "Subscription not found for the user" });
    }

    // Prepare the payload for the push notification
    const payload = JSON.stringify({
      title: title || "New Notification",
      body: body || "You have a new message!",
    });

    // Send the notification using the subscription data
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: {
          auth: subscription.keys_auth,
          p256dh: subscription.keys_p256dh,
        },
      },
      payload
    );

    res.status(200).json({ message: "Notification sent successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
