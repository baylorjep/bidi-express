const express = require('express');
const router = express.Router();
const { Client } = require('@googlemaps/google-maps-services-js');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const google = require('googleapis');
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
      
      // Try to extract Place ID from !1s parameter first
      const placeIdMatch = finalUrl.match(/!1s([^!]+)/);
      if (placeIdMatch && placeIdMatch[1]) {
        const rawPlaceId = placeIdMatch[1];
        console.log('Extracted raw Place ID from !1s parameter:', rawPlaceId);
        
        // If the Place ID doesn't start with ChIJ, use Find Place API
        if (!rawPlaceId.startsWith('ChIJ')) {
          // Extract business name and location for Find Place API
          const nameMatch = finalUrl.match(/place\/([^\/]+)/);
          if (nameMatch && nameMatch[1]) {
            businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
          }

          const locationMatch = finalUrl.match(/@([^\/]+)/);
          if (locationMatch && locationMatch[1]) {
            location = cleanLocation(locationMatch[1]);
          }

          if (businessName) {
            console.log('Using Find Place API to get correct Place ID for:', businessName, 'in location:', location);
            const response = await client.findPlaceFromText({
              params: {
                input: businessName,
                inputtype: 'textquery',
                locationbias: location ? `point:${location}` : undefined,
                fields: ['place_id', 'name', 'formatted_address'],
                key: process.env.GOOGLE_PLACES_API_KEY
              }
            });

            console.log('Find Place response:', JSON.stringify(response.data, null, 2));

            if (response.data.candidates && response.data.candidates.length > 0) {
              const placeId = response.data.candidates[0].place_id;
              console.log('Found correct Place ID:', placeId);
              return placeId;
            }

            // If no results found, try without location bias
            if (location) {
              console.log('No results found with location bias, trying without location...');
              const responseWithoutLocation = await client.findPlaceFromText({
                params: {
                  input: businessName,
                  inputtype: 'textquery',
                  fields: ['place_id', 'name', 'formatted_address'],
                  key: process.env.GOOGLE_PLACES_API_KEY
                }
              });

              console.log('Find Place response without location:', JSON.stringify(responseWithoutLocation.data, null, 2));

              if (responseWithoutLocation.data.candidates && responseWithoutLocation.data.candidates.length > 0) {
                const placeId = responseWithoutLocation.data.candidates[0].place_id;
                console.log('Found correct Place ID without location:', placeId);
                return placeId;
              }
            }
          }
        } else {
          return rawPlaceId;
        }
      }

      // If no Place ID found in !1s, try to extract business name and location
      const nameMatch = finalUrl.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = finalUrl.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
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
      
      // Try to extract Place ID from !1s parameter first
      const placeIdMatch = finalUrl.match(/!1s([^!]+)/);
      if (placeIdMatch && placeIdMatch[1]) {
        const rawPlaceId = placeIdMatch[1];
        console.log('Extracted raw Place ID from !1s parameter:', rawPlaceId);
        
        // If the Place ID doesn't start with ChIJ, use Find Place API
        if (!rawPlaceId.startsWith('ChIJ')) {
          // Extract business name and location for Find Place API
          const nameMatch = finalUrl.match(/place\/([^\/]+)/);
          if (nameMatch && nameMatch[1]) {
            businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
          }

          const locationMatch = finalUrl.match(/@([^\/]+)/);
          if (locationMatch && locationMatch[1]) {
            location = cleanLocation(locationMatch[1]);
          }

          if (businessName) {
            console.log('Using Find Place API to get correct Place ID for:', businessName, 'in location:', location);
            const response = await client.findPlaceFromText({
              params: {
                input: businessName,
                inputtype: 'textquery',
                locationbias: location ? `point:${location}` : undefined,
                fields: ['place_id', 'name', 'formatted_address'],
                key: process.env.GOOGLE_PLACES_API_KEY
              }
            });

            console.log('Find Place response:', JSON.stringify(response.data, null, 2));

            if (response.data.candidates && response.data.candidates.length > 0) {
              const placeId = response.data.candidates[0].place_id;
              console.log('Found correct Place ID:', placeId);
              return placeId;
            }

            // If no results found, try without location bias
            if (location) {
              console.log('No results found with location bias, trying without location...');
              const responseWithoutLocation = await client.findPlaceFromText({
                params: {
                  input: businessName,
                  inputtype: 'textquery',
                  fields: ['place_id', 'name', 'formatted_address'],
                  key: process.env.GOOGLE_PLACES_API_KEY
                }
              });

              console.log('Find Place response without location:', JSON.stringify(responseWithoutLocation.data, null, 2));

              if (responseWithoutLocation.data.candidates && responseWithoutLocation.data.candidates.length > 0) {
                const placeId = responseWithoutLocation.data.candidates[0].place_id;
                console.log('Found correct Place ID without location:', placeId);
                return placeId;
              }
            }
          }
        } else {
          return rawPlaceId;
        }
      }

      const nameMatch = finalUrl.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = finalUrl.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
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
      
      // Try to extract Place ID from !1s parameter first
      const placeIdMatch = url.match(/!1s([^!]+)/);
      if (placeIdMatch && placeIdMatch[1]) {
        const rawPlaceId = placeIdMatch[1];
        console.log('Extracted raw Place ID from !1s parameter:', rawPlaceId);
        
        // If the Place ID doesn't start with ChIJ, use Find Place API
        if (!rawPlaceId.startsWith('ChIJ')) {
          // Extract business name and location for Find Place API
          const nameMatch = url.match(/place\/([^\/]+)/);
          if (nameMatch && nameMatch[1]) {
            businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
          }

          const locationMatch = url.match(/@([^\/]+)/);
          if (locationMatch && locationMatch[1]) {
            location = cleanLocation(locationMatch[1]);
          }

          if (businessName) {
            console.log('Using Find Place API to get correct Place ID for:', businessName, 'in location:', location);
            const response = await client.findPlaceFromText({
              params: {
                input: businessName,
                inputtype: 'textquery',
                locationbias: location ? `point:${location}` : undefined,
                fields: ['place_id', 'name', 'formatted_address'],
                key: process.env.GOOGLE_PLACES_API_KEY
              }
            });

            console.log('Find Place response:', JSON.stringify(response.data, null, 2));

            if (response.data.candidates && response.data.candidates.length > 0) {
              const placeId = response.data.candidates[0].place_id;
              console.log('Found correct Place ID:', placeId);
              return placeId;
            }

            // If no results found, try without location bias
            if (location) {
              console.log('No results found with location bias, trying without location...');
              const responseWithoutLocation = await client.findPlaceFromText({
                params: {
                  input: businessName,
                  inputtype: 'textquery',
                  fields: ['place_id', 'name', 'formatted_address'],
                  key: process.env.GOOGLE_PLACES_API_KEY
                }
              });

              console.log('Find Place response without location:', JSON.stringify(responseWithoutLocation.data, null, 2));

              if (responseWithoutLocation.data.candidates && responseWithoutLocation.data.candidates.length > 0) {
                const placeId = responseWithoutLocation.data.candidates[0].place_id;
                console.log('Found correct Place ID without location:', placeId);
                return placeId;
              }
            }
          }
        } else {
          return rawPlaceId;
        }
      }

      const nameMatch = url.match(/place\/([^\/]+)/);
      if (nameMatch && nameMatch[1]) {
        businessName = decodeURIComponent(nameMatch[1].replace(/\+/g, ' '));
      }

      const locationMatch = url.match(/@([^\/]+)/);
      if (locationMatch && locationMatch[1]) {
        location = cleanLocation(locationMatch[1]);
      }
    }

    // If URL is already a Place ID
    if (isValidPlaceId(url)) {
      console.log('Input is already a valid Place ID');
      return url;
    }

    // If we have a business name, use Places API Find Place to get the Place ID
    if (businessName) {
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

      console.log('Find Place response:', JSON.stringify(response.data, null, 2));

      if (response.data.candidates && response.data.candidates.length > 0) {
        const placeId = response.data.candidates[0].place_id;
        console.log('Found Place ID:', placeId);
        return placeId;
      }

      // If no results found, try without location bias
      if (location) {
        console.log('No results found with location bias, trying without location...');
        const responseWithoutLocation = await client.findPlaceFromText({
          params: {
            input: businessName,
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

// Business Profile API routes
router.get('/business-profile/auth', async (req, res) => {
  console.log('Auth request received with query params:', req.query);
  
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_BUSINESS_CLIENT_ID,  // Changed from GOOGLE_CLIENT_ID
    process.env.GOOGLE_BUSINESS_CLIENT_SECRET,  // Changed from GOOGLE_CLIENT_SECRET
    process.env.NODE_ENV === 'production' 
      ? 'https://savewithbidi.com/api/google-places/business-profile/callback'
      : 'http://localhost:5000/api/google-places/business-profile/callback'
  );

  // Required scopes for Business Profile API
  const scopes = [
    'https://www.googleapis.com/auth/business.manage'  // We need this scope to read and manage reviews
  ];

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',  // This ensures we get a refresh token
    scope: scopes,
    prompt: 'consent',       // Always show consent screen to ensure we get refresh token
    include_granted_scopes: true,
    state: req.query.businessProfileId // Pass the business profile ID in the state parameter
  });

  console.log('Generated auth URL:', authUrl);

  res.json({ 
    authUrl,
    scopes: scopes,
    message: 'Use this URL to authenticate with Google Business Profile. The vendor will need to grant access to manage their business information and reviews.'
  });
});

router.get('/business-profile/callback', async (req, res) => {
  console.log('Callback received with query params:', req.query);
  console.log('Full request URL:', req.originalUrl);
  
  const { code, state: businessProfileId } = req.query;
  
  if (!code || !businessProfileId) {
    console.log('Missing parameters:', { code: !!code, businessProfileId: !!businessProfileId });
    return res.status(400).json({ 
      error: 'Missing required parameters',
      details: 'Authorization code and business profile ID are required'
    });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_BUSINESS_CLIENT_ID,  // Changed from GOOGLE_CLIENT_ID
      process.env.GOOGLE_BUSINESS_CLIENT_SECRET,  // Changed from GOOGLE_CLIENT_SECRET
      process.env.NODE_ENV === 'production' 
        ? 'https://savewithbidi.com/api/google-places/business-profile/callback'
        : 'http://localhost:5000/api/google-places/business-profile/callback'
    );

    // Exchange the authorization code for tokens
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Store the tokens in Supabase
    const { error: tokenError } = await supabase
      .from('oauth_tokens')
      .upsert({
        business_profile_id: businessProfileId,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type,
        expiry_date: new Date(tokens.expiry_date).toISOString(),
        service: 'google_business'  // Added to distinguish from calendar tokens
      });

    if (tokenError) {
      console.error('Error storing tokens:', tokenError);
      throw new Error('Failed to store OAuth tokens');
    }

    // Update the business profile to indicate we're using Places API
    const { error: profileError } = await supabase
      .from('business_profiles')
      .update({
        google_reviews_status: 'connected_places_api',
        google_business_account_id: null,
        google_business_location_id: null
      })
      .eq('id', businessProfileId);

    if (profileError) {
      console.error('Error updating business profile:', profileError);
      throw new Error('Failed to update business profile');
    }

    // Redirect to the frontend with success
    res.redirect(`http://localhost:3000/business-settings?google_connected=true&api_type=places`);
  } catch (error) {
    console.error('Error in callback:', error);
    // Redirect to frontend with error
    res.redirect(`http://localhost:3000/business-settings?google_error=${encodeURIComponent(error.message)}`);
  }
});

module.exports = router; 