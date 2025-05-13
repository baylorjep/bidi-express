require('dotenv').config();

const config = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  redirectUri: process.env.GOOGLE_REDIRECT_URI,
  scopes: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events'
  ]
};

// Debug print for environment variables
console.log('GOOGLE_CLIENT_ID:', config.clientId);
console.log('GOOGLE_CLIENT_SECRET:', config.clientSecret ? '***set***' : '***missing***');
console.log('GOOGLE_REDIRECT_URI:', config.redirectUri);

module.exports = config;