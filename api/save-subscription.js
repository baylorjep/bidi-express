// api/save-subscription.js
const { supabase } = require('./supabaseClient');

module.exports = async function (req, res) {
  const { user_id, subscription } = req.body;

  try {

     // Log before saving to the database
     console.log('Saving subscription for user_id:', user_id);
     console.log('Subscription data:', subscription);
 

    // Insert or update the subscription data into the 'subscriptions' table
    const { error } = await supabase
      .from('subscriptions')
      .upsert({
        user_id,
        endpoint: subscription.endpoint,
        keys_auth: subscription.keys.auth,
        keys_p256dh: subscription.keys.p256dh,
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.status(200).json({ message: 'Subscription saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
