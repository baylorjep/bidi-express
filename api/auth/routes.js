const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const supabase = require('../supabaseClient');
const crypto = require('crypto');

// Initialize OAuth2 client
const oauth2Client = new OAuth2Client(
  '816430246369-tbqrj63j9nmjgdblqg7b8uvjp50on10g.apps.googleusercontent.com',
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:4242/api/auth/google/callback'
);

console.log('OAuth2 Client initialized with:');
console.log('Client ID:', '816430246369-tbqrj63j9nmjgdblqg7b8uvjp50on10g.apps.googleusercontent.com');
console.log('Client Secret available:', !!process.env.GOOGLE_CLIENT_SECRET);
console.log('Client Secret length:', process.env.GOOGLE_CLIENT_SECRET?.length || 0);
console.log('Redirect URI:', 'http://localhost:4242/api/auth/google/callback');

// Store state tokens temporarily (in production, use Redis or similar)
const stateTokens = new Map();

// Generate and store state token
const generateStateToken = () => {
  const state = crypto.randomBytes(32).toString('hex');
  stateTokens.set(state, Date.now());
  return state;
};

// Validate state token
const validateStateToken = (state) => {
  const timestamp = stateTokens.get(state);
  if (!timestamp) return false;
  
  // Remove used state token
  stateTokens.delete(state);
  
  // Check if token is expired (5 minutes)
  return Date.now() - timestamp < 5 * 60 * 1000;
};

// Google Sign-In endpoint
router.get('/google', (req, res) => {
  try {
    const state = generateStateToken();
    
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: [
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/userinfo.email'
      ],
      prompt: 'consent',
      state
    });

    // Log the complete URL and its components
    console.log('\n=== Google Auth URL Details ===');
    console.log('Full URL:', authUrl);
    const urlObj = new URL(authUrl);
    console.log('Base URL:', urlObj.origin + urlObj.pathname);
    console.log('Redirect URI:', urlObj.searchParams.get('redirect_uri'));
    console.log('Client ID:', urlObj.searchParams.get('client_id'));
    console.log('Scopes:', urlObj.searchParams.get('scope'));
    console.log('State:', urlObj.searchParams.get('state'));
    console.log('=============================\n');

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({
      error: 'Failed to generate authentication URL',
      code: 'AUTH_URL_ERROR'
    });
  }
});

// Google OAuth callback endpoint
router.get('/google/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    // Check for OAuth errors
    if (error) {
      return res.status(400).json({
        error: 'OAuth error occurred',
        code: 'OAUTH_ERROR',
        details: error
      });
    }

    // Validate state parameter
    if (!state || !validateStateToken(state)) {
      return res.status(400).json({
        error: 'Invalid state parameter',
        code: 'INVALID_STATE'
      });
    }

    // Validate code parameter
    if (!code) {
      return res.status(400).json({
        error: 'Authorization code is required',
        code: 'MISSING_CODE'
      });
    }

    // Exchange code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Get user info from Google
    const oauth2 = google.oauth2({
      auth: oauth2Client,
      version: 'v2'
    });

    const { data: userInfo } = await oauth2.userinfo.get();

    // Check if user exists
    const { data: existingProfile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('email', userInfo.email)
      .single();

    if (profileError && profileError.code !== 'PGRST116') {
      throw profileError;
    }

    let profileId;

    if (existingProfile) {
      // Update existing profile
      const { data: updatedProfile, error: updateError } = await supabase
        .from('profiles')
        .update({
          google_id: userInfo.id,
          avatar_url: userInfo.picture,
          updated_at: new Date().toISOString()
        })
        .eq('id', existingProfile.id)
        .select()
        .single();

      if (updateError) throw updateError;
      profileId = updatedProfile.id;
    } else {
      // Create new profile
      const { data: newProfile, error: createError } = await supabase
        .from('profiles')
        .insert({
          email: userInfo.email,
          role: 'individual',
          google_id: userInfo.id,
          avatar_url: userInfo.picture,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError) throw createError;
      profileId = newProfile.id;
    }

    // Store OAuth tokens
    const { error: tokenError } = await supabase
      .from('oauth_tokens')
      .upsert({
        user_id: profileId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: new Date(tokens.expiry_date).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (tokenError) throw tokenError;

    // Create Supabase session
    const { data: session, error: sessionError } = await supabase.auth.signInWithPassword({
      email: userInfo.email,
      password: crypto.randomBytes(32).toString('hex') // Generate random password for OAuth users
    });

    if (sessionError) throw sessionError;

    // Redirect to frontend with session token
    const frontendUrl = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com'
      : 'http://localhost:3000';

    res.redirect(`${frontendUrl}/auth/success?token=${session.session.access_token}`);

  } catch (error) {
    console.error('Error in OAuth callback:', error);
    
    const frontendUrl = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com'
      : 'http://localhost:3000';

    // Redirect to error page with error details
    res.redirect(`${frontendUrl}/auth/error?error=${encodeURIComponent(error.message)}`);
  }
});

// Token refresh endpoint
router.post('/refresh-token', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({
        error: 'User ID is required',
        code: 'MISSING_USER_ID'
      });
    }

    // Get refresh token from database
    const { data: tokenData, error: tokenError } = await supabase
      .from('oauth_tokens')
      .select('refresh_token')
      .eq('user_id', user_id)
      .single();

    if (tokenError || !tokenData?.refresh_token) {
      return res.status(404).json({
        error: 'No refresh token found',
        code: 'NO_REFRESH_TOKEN'
      });
    }

    // Set refresh token
    oauth2Client.setCredentials({
      refresh_token: tokenData.refresh_token
    });

    // Get new tokens
    const { tokens } = await oauth2Client.refreshAccessToken();

    // Update tokens in database
    const { error: updateError } = await supabase
      .from('oauth_tokens')
      .update({
        access_token: tokens.access_token,
        token_type: tokens.token_type,
        expiry_date: new Date(tokens.expiry_date).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', user_id);

    if (updateError) throw updateError;

    res.json({
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expiry_date: tokens.expiry_date
    });

  } catch (error) {
    console.error('Error refreshing token:', error);
    res.status(500).json({
      error: 'Failed to refresh token',
      code: 'REFRESH_ERROR',
      details: error.message
    });
  }
});

module.exports = router; 