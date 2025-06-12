const express = require('express');
const router = express.Router();
const { Client } = require('@googlemaps/google-maps-services-js');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const { google } = require('googleapis');
const supabase = require('../supabaseClient');

// Initialize Google Maps client
const client = new Client({});

// Initialize cache with 1 hour TTL
const cache = new NodeCache({ stdTTL: 3600 });

// Rate limiting configuration
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

// Apply rate limiting to all routes
router.use(limiter);

// Add helper functions at the top of the file
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const makeApiRequest = async (url, accessToken, maxRetries = 3, baseDelay = 2000) => {
  let retries = 0;
  
  while (retries <= maxRetries) {
    try {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      return response;
    } catch (error) {
      if (error.response?.status === 429 && retries < maxRetries) {
        const delayTime = baseDelay * Math.pow(2, retries);
        console.log(`Rate limit hit, retrying in ${delayTime}ms (attempt ${retries + 1}/${maxRetries})`);
        await delay(delayTime);
        retries++;
        continue;
      }
      throw error;
    }
  }
};

// Helper function to validate Place ID format
const isValidPlaceId = (placeId) => {
  // Google Place IDs typically start with 'ChIJ' and are 27 characters long
  // They should not contain URLs or special characters
  return typeof placeId === 'string' && 
         placeId.length >= 27 && 
         placeId.length <= 100 && 
         !placeId.includes(' ') &&
         !placeId.includes('http') &&
         !placeId.includes('/') &&
         !placeId.includes('?') &&
         !placeId.includes('&') &&
         !placeId.includes('=');
};

// Helper function to extract Place ID from Google Maps URL
const extractPlaceIdFromUrl = async (url) => {
  console.log('Extracting Place ID from URL:', url);

  try {
    let businessName = '';
    let location = '';

    // Helper function to clean location string
    const cleanLocation = (loc) => {
      if (!loc) return undefined;
      // Remove zoom level and any other non-coordinate parts
      const match = loc.match(/([-\d.]+),([-\d.]+)/);
      if (match) {
        return `${match[1]},${match[2]}`;
      }
      return undefined;
    };

    // Helper function to find place using business name and location
    const findPlace = async (name, loc) => {
      if (!name) return null;

      console.log('Searching for business:', name, 'in location:', loc);
      
      // First try with location bias
      if (loc) {
        const response = await client.findPlaceFromText({
          params: {
            input: name,
            inputtype: 'textquery',
            locationbias: `point:${loc}`,
            fields: ['place_id', 'name', 'formatted_address'],
            key: process.env.GOOGLE_PLACES_API_KEY
          }
        });

        console.log('Find Place response with location:', JSON.stringify(response.data, null, 2));

        if (response.data.candidates && response.data.candidates.length > 0) {
          const placeId = response.data.candidates[0].place_id;
          console.log('Found Place ID with location:', placeId);
          return placeId;
        }
      }

      // If no results with location or no location provided, try without location
      console.log('Trying without location bias...');
      const responseWithoutLocation = await client.findPlaceFromText({
        params: {
          input: name,
          inputtype: 'textquery',
          fields: ['place_id', 'name', 'formatted_address'],
          key: process.env.GOOGLE_PLACES_API_KEY
        }
      });

      console.log('Find Place response without location:', JSON.stringify(responseWithoutLocation.data, null, 2));

      if (responseWithoutLocation.data.candidates && responseWithoutLocation.data.candidates.length > 0) {
        const placeId = responseWithoutLocation.data.candidates[0].place_id;
        console.log('Found Place ID without location:', placeId);
        return placeId;
      }

      return null;
    };

    // Handle maps.app.goo.gl URLs
    if (url.includes('maps.app.goo.gl')) {
      console.log('Detected maps.app.goo.gl URL, following redirect...');
      const response = await axios.get(url, {
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 400; // Accept redirects
        }
      });
      
      // Get the final URL after redirects
      const finalUrl = response.request.res.responseUrl;
      console.log('Final URL after redirect:', finalUrl);
      
      // Extract business name and location
      const nameMatch = finalUrl.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = finalUrl.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
      }

      // Try to find the place using the business name and location
      const placeId = await findPlace(businessName, location);
      if (placeId) {
        return placeId;
      }
    }
    
    // Handle goo.gl/maps URLs
    if (url.includes('goo.gl/maps')) {
      console.log('Detected goo.gl/maps URL, following redirect...');
      const response = await axios.get(url, {
        maxRedirects: 5,
        validateStatus: function (status) {
          return status >= 200 && status < 400;
        }
      });
      
      const finalUrl = response.request.res.responseUrl;
      console.log('Final URL after redirect:', finalUrl);
      
      // Extract business name and location
      const nameMatch = finalUrl.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = finalUrl.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
      }

      // Try to find the place using the business name and location
      const placeId = await findPlace(businessName, location);
      if (placeId) {
        return placeId;
      }
    }
    
    // Handle maps.google.com/?cid= URLs
    if (url.includes('maps.google.com/?cid=')) {
      console.log('Detected maps.google.com URL with CID...');
      const cidMatch = url.match(/cid=([^&]+)/);
      if (cidMatch && cidMatch[1]) {
        const placeId = cidMatch[1];
        console.log('Extracted Place ID from CID:', placeId);
        return placeId;
      }
    }
    
    // Handle google.com/maps/place/ URLs
    if (url.includes('google.com/maps/place/')) {
      console.log('Detected google.com/maps/place URL...');
      
      // Extract business name and location
      const nameMatch = url.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = url.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
      }

      // Try to find the place using the business name and location
      const placeId = await findPlace(businessName, location);
      if (placeId) {
        return placeId;
      }
    }

    // If URL is already a Place ID
    if (isValidPlaceId(url)) {
      console.log('Input is already a valid Place ID');
      return url;
    }

    // If we have a business name, try one last time to find the place
    if (businessName) {
      const placeId = await findPlace(businessName, location);
      if (placeId) {
        return placeId;
      }
    }

    throw new Error('Could not extract Place ID from URL');
  } catch (error) {
    console.error('Error extracting Place ID:', error);
    throw new Error(`Failed to extract Place ID: ${error.message}`);
  }
};

// Helper function to fetch reviews with pagination
const fetchAllReviews = async (placeId, apiKey, totalRatings) => {
  console.log(`Fetching reviews for placeId: ${placeId}, total ratings: ${totalRatings}`);
  
  const allReviews = [];
  const MAX_REVIEWS = Math.min(totalRatings, 100); // Use the smaller of total ratings or 100
  const MAX_PAGINATION_ATTEMPTS = 20; // Increased pagination attempts
  let pageToken = null;
  let paginationAttempts = 0;
  
  // Function to fetch a page of reviews
  const fetchReviewsPage = async (params) => {
    try {
      const response = await client.placeDetails({
        params: {
          place_id: placeId,
          fields: ['reviews'],
          reviews_no_translations: true,
          ...params,
          key: apiKey
        }
      });

      if (response.data.result && response.data.result.reviews) {
        const reviews = response.data.result.reviews;
        console.log(`Received ${reviews.length} reviews`);
        return {
          reviews,
          nextPageToken: response.data.next_page_token
        };
      }
      return { reviews: [], nextPageToken: null };
    } catch (error) {
      console.error('Error fetching reviews page:', error);
      return { reviews: [], nextPageToken: null };
    }
  };

  // Try different sort orders to get more reviews
  const sortOrders = [
    'most_relevant',
    'newest',
    'highest_rating',
    'lowest_rating',
    'most_helpful'
  ];

  for (const sortOrder of sortOrders) {
    if (allReviews.length >= MAX_REVIEWS) break;

    console.log(`Fetching reviews with sort order: ${sortOrder}`);
    pageToken = null;
    paginationAttempts = 0;

    // Get initial reviews for this sort order
    let result = await fetchReviewsPage({ reviews_sort: sortOrder });
    
    // Add reviews, only deduplicating by author name
    const newReviews = result.reviews.filter(review => 
      !allReviews.some(existingReview => 
        existingReview.author_name === review.author_name
      )
    );

    console.log(`Found ${newReviews.length} unique reviews for ${sortOrder}`);
    allReviews.push(...newReviews);
    pageToken = result.nextPageToken;

    // Paginate for this sort order
    while (pageToken && allReviews.length < MAX_REVIEWS && paginationAttempts < MAX_PAGINATION_ATTEMPTS) {
      console.log(`Pagination attempt ${paginationAttempts + 1}/${MAX_PAGINATION_ATTEMPTS} for ${sortOrder}, current review count: ${allReviews.length}/${MAX_REVIEWS}`);
      
      // Wait 2 seconds as required by Google Places API
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      result = await fetchReviewsPage({ 
        reviews_sort: sortOrder,
        page_token: pageToken 
      });
      
      const moreNewReviews = result.reviews.filter(review => 
        !allReviews.some(existingReview => 
          existingReview.author_name === review.author_name
        )
      );
      
      console.log(`Found ${moreNewReviews.length} unique additional reviews for ${sortOrder}`);
      allReviews.push(...moreNewReviews);
      console.log(`Total reviews so far: ${allReviews.length}/${MAX_REVIEWS}`);
      
      pageToken = result.nextPageToken;
      paginationAttempts++;
    }
  }

  // If we still don't have enough reviews, try different time ranges
  if (allReviews.length < MAX_REVIEWS) {
    const timeRanges = [
      'last_month',
      'last_3_months',
      'last_6_months',
      'last_year'
    ];

    for (const timeRange of timeRanges) {
      if (allReviews.length >= MAX_REVIEWS) break;

      console.log(`Fetching reviews for time range: ${timeRange}`);
      pageToken = null;
      paginationAttempts = 0;

      // Get initial reviews for this time range
      let result = await fetchReviewsPage({ 
        reviews_sort: 'most_relevant',
        reviews_time: timeRange
      });

      // Add reviews, only deduplicating by author name
      const newReviews = result.reviews.filter(review => 
        !allReviews.some(existingReview => 
          existingReview.author_name === review.author_name
        )
      );

      console.log(`Found ${newReviews.length} unique reviews for ${timeRange}`);
      allReviews.push(...newReviews);
      pageToken = result.nextPageToken;

      // Paginate for this time range
      while (pageToken && allReviews.length < MAX_REVIEWS && paginationAttempts < MAX_PAGINATION_ATTEMPTS) {
        console.log(`Pagination attempt ${paginationAttempts + 1}/${MAX_PAGINATION_ATTEMPTS} for ${timeRange}, current review count: ${allReviews.length}/${MAX_REVIEWS}`);
        
        // Wait 2 seconds as required by Google Places API
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        result = await fetchReviewsPage({ 
          reviews_sort: 'most_relevant',
          reviews_time: timeRange,
          page_token: pageToken 
        });
        
        const moreNewReviews = result.reviews.filter(review => 
          !allReviews.some(existingReview => 
            existingReview.author_name === review.author_name
          )
        );
        
        console.log(`Found ${moreNewReviews.length} unique additional reviews for ${timeRange}`);
        allReviews.push(...moreNewReviews);
        console.log(`Total reviews so far: ${allReviews.length}/${MAX_REVIEWS}`);
        
        pageToken = result.nextPageToken;
        paginationAttempts++;
      }
    }
  }

  // Sort all reviews by time (newest first)
  allReviews.sort((a, b) => b.time - a.time);
  
  // Take only the first MAX_REVIEWS
  const finalReviews = allReviews.slice(0, MAX_REVIEWS);
  
  console.log(`Final review count: ${finalReviews.length}/${MAX_REVIEWS}`);
  return finalReviews;
};

// Helper function to format review data
const formatReviewData = (placeDetails, allReviews) => {
  console.log('Formatting review data with', allReviews.length, 'reviews');
  
  if (!allReviews || allReviews.length === 0) {
    console.log('No reviews found in place details');
    return {
      rating: placeDetails.rating || 0,
      reviews: [],
      name: placeDetails.name,
      address: placeDetails.formatted_address,
      total_ratings: placeDetails.user_ratings_total || 0
    };
  }

  // Sort reviews by time (newest first)
  const sortedReviews = [...allReviews].sort((a, b) => b.time - a.time);
  
  // Format each review
  const formattedReviews = sortedReviews.map(review => ({
    author_name: review.author_name,
    rating: review.rating,
    text: review.text,
    time: review.time,
    profile_photo_url: review.profile_photo_url,
    relative_time_description: review.relative_time_description
  }));

  console.log('Formatted', formattedReviews.length, 'reviews');
  
  return {
    rating: placeDetails.rating || 0,
    reviews: formattedReviews,
    name: placeDetails.name,
    address: placeDetails.formatted_address,
    total_ratings: placeDetails.user_ratings_total || 0
  };
};

// GET /api/google-reviews
router.get('/google-reviews', async (req, res) => {
  console.log('Received request for Google reviews');
  console.log('Query parameters:', req.query);
  
  const { placeId: input } = req.query;

  // Validate input
  if (!input) {
    console.log('Error: Place ID or URL is missing');
    return res.status(400).json({ 
      error: 'Place ID or URL is required',
      details: 'Please provide a valid Google Place ID or Google Maps URL'
    });
  }

  try {
    // Extract Place ID from URL if necessary
    const placeId = await extractPlaceIdFromUrl(input);
    console.log('Using Place ID:', placeId);

    // Validate Place ID format
    if (!isValidPlaceId(placeId)) {
      console.log('Error: Invalid Place ID format');
      return res.status(400).json({
        error: 'Invalid Place ID format',
        details: 'Could not extract a valid Place ID from the provided URL'
      });
    }

    // Debug logging for API key
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    console.log('API Key available:', !!apiKey);
    console.log('API Key length:', apiKey?.length);
    
    if (!apiKey) {
      console.error('Error: Google Places API key is not configured');
      return res.status(500).json({ 
        error: 'Server configuration error',
        details: 'Google Places API key is not configured'
      });
    }

    // Check cache first
    const cachedData = cache.get(placeId);
    if (cachedData) {
      console.log('Returning cached data for placeId:', placeId);
      return res.json(cachedData);
    }

    console.log('Making request to Google Places API for placeId:', placeId);
    
    // First get the basic place details
    const response = await client.placeDetails({
      params: {
        place_id: placeId,
        fields: [
          'name',
          'rating',
          'user_ratings_total',
          'formatted_address',
          'place_id',
          'types'
        ],
        key: apiKey
      }
    });

    console.log('Received response from Google Places API');
    console.log('Response status:', response.status);
    console.log('Has result:', !!response.data.result);
    console.log('Full response data:', JSON.stringify(response.data, null, 2));

    if (!response.data.result || Object.keys(response.data.result).length === 0) {
      console.log('Error: Empty result from Google Places API');
      return res.status(404).json({ 
        error: 'Place not found or no data available',
        details: 'The provided Place ID may be invalid or the place has no reviews'
      });
    }

    const placeDetails = response.data.result;
    
    // Check if this is a business location
    const isBusiness = placeDetails.types && 
                      placeDetails.types.some(type => 
                        ['store', 'establishment', 'point_of_interest'].includes(type)
                      );

    if (!isBusiness) {
      console.log('Error: Not a business location');
      return res.status(400).json({
        error: 'Not a business location',
        details: 'The provided Place ID is not for a business location'
      });
    }

    // Fetch all reviews using the total ratings count
    const allReviews = await fetchAllReviews(placeId, apiKey, placeDetails.user_ratings_total);
    console.log('Fetched', allReviews.length, 'total reviews out of', placeDetails.user_ratings_total);

    console.log('Place details:', {
      name: placeDetails.name,
      rating: placeDetails.rating,
      user_ratings_total: placeDetails.user_ratings_total,
      reviewCount: allReviews.length,
      address: placeDetails.formatted_address,
      types: placeDetails.types
    });

    const formattedData = formatReviewData(placeDetails, allReviews);
    console.log('Formatted data:', {
      name: formattedData.name,
      rating: formattedData.rating,
      reviewCount: formattedData.reviews.length,
      address: formattedData.address,
      total_ratings: formattedData.total_ratings
    });
    
    // Cache the formatted data
    cache.set(placeId, formattedData);
    console.log('Data cached successfully');
    
    res.json(formattedData);
  } catch (error) {
    console.error('Error in Google Places API request:', error);
    console.error('Error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    
    if (error.response?.status === 404) {
      return res.status(404).json({ 
        error: 'Place not found',
        details: 'The provided Place ID does not exist or is invalid'
      });
    }
    
    if (error.response?.status === 403) {
      return res.status(403).json({ 
        error: 'Invalid API key or quota exceeded',
        details: error.response?.data?.error_message || 'No additional details available'
      });
    }
    
    if (error.response?.status === 429) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        details: 'Too many requests to Google Places API'
      });
    }
    
    // Handle network errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return res.status(503).json({ 
        error: 'Service unavailable',
        details: 'Could not connect to Google Places API'
      });
    }
    
    res.status(500).json({ 
      error: 'Failed to fetch Google reviews',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// GET /api/find-place-id
router.get('/find-place-id', async (req, res) => {
  const { businessName, location } = req.query;

  if (!businessName) {
    return res.status(400).json({
      error: 'Business name is required',
      details: 'Please provide a business name to search for'
    });
  }

  try {
    console.log('Searching for business:', businessName, 'in location:', location);
    
    const response = await client.findPlaceFromText({
      params: {
        input: businessName,
        inputtype: 'textquery',
        locationbias: location ? `point:${location}` : undefined,
        fields: ['place_id', 'name', 'formatted_address'],
        key: process.env.GOOGLE_PLACES_API_KEY
      }
    });

    console.log('Search response:', JSON.stringify(response.data, null, 2));

    if (!response.data.candidates || response.data.candidates.length === 0) {
      return res.status(404).json({
        error: 'Business not found',
        details: 'No matching businesses found'
      });
    }

    // Return all candidates with their details
    const candidates = response.data.candidates.map(candidate => ({
      place_id: candidate.place_id,
      name: candidate.name,
      address: candidate.formatted_address
    }));

    res.json({
      candidates,
      message: 'Found matching businesses. Use the place_id to fetch reviews.'
    });

  } catch (error) {
    console.error('Error searching for business:', error);
    res.status(500).json({
      error: 'Failed to search for business',
      details: error.message || 'An unexpected error occurred'
    });
  }
});

// GET /api/google-places/url-to-place-id
router.get('/url-to-place-id', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({
      error: 'URL is required',
      details: 'Please provide a Google Maps URL'
    });
  }

  try {
    console.log('Converting URL to Place ID:', url);
    const placeId = await extractPlaceIdFromUrl(url);
    
    if (!placeId) {
      return res.status(400).json({
        error: 'Could not extract Place ID',
        details: 'The provided URL could not be converted to a Place ID'
      });
    }

    res.json({
      placeId,
      message: 'Successfully converted URL to Place ID'
    });
  } catch (error) {
    console.error('Error converting URL to Place ID:', error);
    res.status(500).json({
      error: 'Failed to convert URL to Place ID',
      details: error.message
    });
  }
});

// Google Business Profile Authentication endpoint
router.get('/business-profile/auth', async (req, res) => {
  try {
    const { businessProfileId } = req.query;
    
    if (!businessProfileId) {
      return res.status(400).json({ error: 'Business profile ID is required' });
    }

    const redirectUri = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com/api/google-places/business-profile/callback'
      : 'http://localhost:5000/api/google-places/business-profile/callback';

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_BUSINESS_CLIENT_ID,
      process.env.GOOGLE_BUSINESS_SECRET,
      redirectUri
    );

    const scopes = [
      'https://www.googleapis.com/auth/business.manage'
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      include_granted_scopes: true,
      state: businessProfileId
    });

    res.json({ authUrl });
  } catch (error) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: 'Failed to generate authentication URL' });
  }
});

// Google Business Profile OAuth callback endpoint
router.get('/business-profile/callback', async (req, res) => {
  try {
    console.log('Callback received with query params:', req.query);
    console.log('Full request URL:', req.originalUrl);
    
    const { code, state: businessProfileId } = req.query;
    
    if (!code) {
      console.log('Missing authorization code');
      return res.status(400).json({ error: 'Authorization code is required' });
    }

    if (!businessProfileId) {
      console.log('Missing business profile ID');
      return res.status(400).json({ error: 'Business profile ID is required' });
    }

    const redirectUri = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com/api/google-places/business-profile/callback'
      : 'http://localhost:5000/api/google-places/business-profile/callback';

    console.log('Using redirect URI:', redirectUri);
    console.log('Using client ID:', process.env.GOOGLE_BUSINESS_CLIENT_ID);

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_BUSINESS_CLIENT_ID,
      process.env.GOOGLE_BUSINESS_SECRET,
      redirectUri
    );

    console.log('Attempting to get token with code:', code);
    const { tokens } = await oauth2Client.getToken(code);
    console.log('Successfully received tokens:', tokens);
    
    oauth2Client.setCredentials(tokens);

    // Store the tokens in the oauth_tokens table
    console.log('Storing tokens in database...');
    const { data, error } = await supabase
      .from('oauth_tokens')
      .upsert({
        business_profile_id: businessProfileId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: new Date(tokens.expiry_date).toISOString(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });

    if (error) {
      console.error('Error storing tokens in database:', error);
      throw error;
    }

    console.log('Successfully stored tokens in database');

    // Define frontend URL at the start
    const frontendUrl = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com'
      : 'http://localhost:3000';

    try {
      console.log('Starting Google Business Profile API calls...');
      console.log('Access Token:', tokens.access_token);
      console.log('Token Type:', tokens.token_type);
      console.log('Token Expiry:', new Date(tokens.expiry_date).toISOString());

      // Get account information from Google Business Profile API
      console.log('Fetching account information...');
      
      // Use the My Business API v4 with retry logic
      const accountResponse = await makeApiRequest(
        'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
        tokens.access_token
      );
      
      console.log('Account API Response Status:', accountResponse.status);
      console.log('Account API Response Headers:', accountResponse.headers);
      console.log('Account API Response Data:', JSON.stringify(accountResponse.data, null, 2));

      if (accountResponse.data.accounts && accountResponse.data.accounts.length > 0) {
        const account = accountResponse.data.accounts[0];
        console.log('Found account:', JSON.stringify(account, null, 2));
        
        // Add delay between API calls
        await delay(2000);
        
        // Get location information using the My Business API with retry logic
        console.log('Fetching location information for account:', account.name);
        const locationsResponse = await makeApiRequest(
          `https://mybusinessbusinessinformation.googleapis.com/v1/accounts/${account.name}/locations`,
          tokens.access_token
        );
        
        console.log('Locations API Response Status:', locationsResponse.status);
        console.log('Locations API Response Headers:', locationsResponse.headers);
        console.log('Locations API Response Data:', JSON.stringify(locationsResponse.data, null, 2));

        if (locationsResponse.data.locations && locationsResponse.data.locations.length > 0) {
          const locationInfo = locationsResponse.data.locations[0];
          console.log('Found location:', JSON.stringify(locationInfo, null, 2));
          
          // Update the business profile with Google Business Profile information
          console.log('Updating business profile in database...');
          const updateData = {
            google_business_account_id: account.name,
            google_business_connected: true,
            google_business_location_id: locationInfo.name,
            google_business_name: locationInfo.locationName,
            google_business_address: locationInfo.address,
            google_maps_url: locationInfo.websiteUri,
            google_rating: locationInfo.rating,
            google_total_ratings: locationInfo.totalRatingCount
          };
          console.log('Update data:', JSON.stringify(updateData, null, 2));

          const { error: profileError } = await supabase
            .from('business_profiles')
            .update(updateData)
            .eq('id', businessProfileId);

          if (profileError) {
            console.error('Error updating business profile:', profileError);
            throw profileError;
          }

          console.log('Successfully updated business profile');
          return res.redirect(`${frontendUrl}/business-profile/success`);
        } else {
          console.log('No locations found for this account');
          throw new Error('No Google Business Profile locations found');
        }
      } else {
        console.log('No Google Business Profile accounts found in response');
        throw new Error('No Google Business Profile accounts found');
      }
    } catch (apiError) {
      console.error('Error details:', {
        message: apiError.message,
        status: apiError.response?.status,
        statusText: apiError.response?.statusText,
        data: apiError.response?.data,
        headers: apiError.response?.headers,
        config: {
          url: apiError.config?.url,
          method: apiError.config?.method,
          headers: apiError.config?.headers
        }
      });

      // Handle specific API errors
      if (apiError.response?.status === 429) {
        const errorMessage = 'Google Business Profile API rate limit exceeded. Please try again in a few minutes.';
        console.error('Rate limit exceeded:', errorMessage);
        return res.redirect(`${frontendUrl}/business-profile/error?message=${encodeURIComponent(errorMessage)}`);
      }

      if (apiError.response?.status === 403) {
        const errorData = apiError.response.data?.error;
        if (errorData?.message?.includes('API has not been used') || errorData?.message?.includes('it is disabled')) {
          const projectId = errorData.message.match(/project (\d+)/)?.[1];
          const errorMessage = `Google Business Profile API needs to be enabled. Please contact your administrator to enable the API for project ${projectId}.`;
          console.error('API not enabled:', errorMessage);
          return res.redirect(`${frontendUrl}/business-profile/error?message=${encodeURIComponent(errorMessage)}`);
        }
      }

      // For other errors, redirect to error page with a user-friendly message
      const errorMessage = 'Unable to connect to Google Business Profile. Please try again later or contact support.';
      console.error('Detailed error in callback:', apiError);
      return res.redirect(`${frontendUrl}/business-profile/error?message=${encodeURIComponent(errorMessage)}`);
    }
  } catch (error) {
    console.error('Detailed error in callback:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      errors: error.errors
    });
    
    const frontendUrl = process.env.NODE_ENV === 'production'
      ? 'https://www.savewithbidi.com'
      : 'http://localhost:3000';
    
    const errorMessage = encodeURIComponent(error.message || 'An unknown error occurred');
    console.log('Redirecting to error page with message:', errorMessage);
    res.redirect(`${frontendUrl}/business-profile/error?message=${errorMessage}`);
  }
});

// Add a new endpoint to fetch reviews
router.post('/fetch-reviews', async (req, res) => {
  try {
    const { businessProfileId } = req.body;
    
    if (!businessProfileId) {
      return res.status(400).json({ error: 'Business profile ID is required' });
    }

    // Get the business profile and OAuth tokens
    const { data: businessProfile, error: profileError } = await supabase
      .from('business_profiles')
      .select('google_business_location_id')
      .eq('id', businessProfileId)
      .single();

    if (profileError || !businessProfile?.google_business_location_id) {
      return res.status(400).json({ error: 'Business profile not properly connected to Google Business Profile' });
    }

    const { data: oauthToken, error: tokenError } = await supabase
      .from('oauth_tokens')
      .select('access_token')
      .eq('business_profile_id', businessProfileId)
      .single();

    if (tokenError || !oauthToken?.access_token) {
      return res.status(400).json({ error: 'No valid OAuth token found' });
    }

    // Get reviews using the My Business API
    console.log('Fetching reviews for location:', businessProfile.google_business_location_id);
    const reviewsResponse = await axios.get(
      `https://mybusinessplaceactions.googleapis.com/v1/${businessProfile.google_business_location_id}/reviews`,
      {
        headers: {
          'Authorization': `Bearer ${oauthToken.access_token}`
        }
      }
    );

    // Store reviews in the existing reviews table
    if (reviewsResponse.data.reviews) {
      console.log('Storing reviews in database...');
      const { error: reviewsError } = await supabase
        .from('reviews')
        .upsert(
          reviewsResponse.data.reviews.map(review => ({
            vendor_id: businessProfileId,
            rating: review.rating,
            review_rating: review.rating,
            comment: review.comment,
            first_name: review.reviewer.displayName.split(' ')[0] || '',
            last_name: review.reviewer.displayName.split(' ').slice(1).join(' ') || '',
            created_at: review.createTime,
            updated_at: review.updateTime || review.createTime,
            is_google_review: true,
            google_review_id: review.reviewId,
            is_approved: true,
            review_language: review.language || 'en',
            relative_time_description: review.relativeTimeDescription || ''
          }))
        );

      if (reviewsError) {
        console.error('Error storing reviews:', reviewsError);
        return res.status(500).json({ error: 'Failed to store reviews' });
      }

      return res.json({ 
        success: true, 
        message: 'Reviews fetched and stored successfully',
        count: reviewsResponse.data.reviews.length
      });
    } else {
      return res.json({ 
        success: true, 
        message: 'No reviews found',
        count: 0
      });
    }
  } catch (error) {
    console.error('Error fetching reviews:', error);
    return res.status(500).json({ 
      error: 'Failed to fetch reviews',
      details: error.message
    });
  }
});

module.exports = router; 