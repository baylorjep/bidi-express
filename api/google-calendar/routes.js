const express = require('express');
const router = express.Router();
const calendarService = require('./calendarService');
const supabase = require('../supabaseClient');
const { google } = require('googleapis');

// Initiate OAuth flow
router.get('/auth', (req, res) => {
  const { businessId } = req.query;
  if (!businessId) {
    return res.status(400).json({ error: 'Business ID is required' });
  }
  
  const authUrl = calendarService.getAuthUrl(businessId);
  res.redirect(authUrl); // Redirect the user to the Google OAuth URL
});

// OAuth callback
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    await calendarService.handleCallback(code, state);
    res.redirect('http://savewithbidi.com/business-dashboard?calendar=connected');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ error: 'Failed to complete OAuth flow' });
  }
});

// Check availability
router.get('/availability', async (req, res) => {
  try {
    const { businessId, date } = req.query;
    if (!businessId || !date) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const events = await calendarService.checkAvailability(businessId, date);
    res.json({ events });
  } catch (error) {
    console.error('Availability check error:', error);
    res.status(500).json({ error: 'Failed to check availability' });
  }
});

// Create event with Google Meet
router.post('/events', async (req, res) => {
  try {
    const { businessId, bidId, startTime, duration = 30 } = req.body;
    if (!businessId || !bidId || !startTime) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    // Get business and customer details from database
      const { data: business, error: businessError } = await supabase
        .from('business_profiles')
        .select(`
          business_name,
          profiles(email)
        `)
        .eq('id', businessId)
        .single();


    if (businessError || !business) {
      console.error('Error fetching business details:', businessError);
      return res.status(404).json({ error: 'Business not found' });
    }

// Step 1: Get bid details to find the request_id, category, and customer_id
const { data: bid, error: bidError } = await supabase
  .from('bids')
  .select('request_id, category')
  .eq('id', bidId)
  .single();

if (bidError || !bid) {
  console.error("Error fetching bid details:", bidError);
  return;
}

// Step 2: Determine the request table and correct ID field
let requestTable = '';
let idField = 'user_id'; // default

switch (bid.category) {
  case 'Beauty':
    requestTable = 'beauty_requests';
    break;
  case 'Catering':
    requestTable = 'catering_requests';
    break;
  case 'Photography':
    requestTable = 'photography_requests';
    idField = 'profile_id'; // special case
    break;
  case 'Videography':
    requestTable = 'videography_requests';
    idField = 'user_id'; // special case
    break;
  case 'Florist':
    requestTable = 'florist_requests';
    break;
  case 'DJ':
    requestTable = 'dj_requests';
    break;
  case 'Wedding Planning':
    requestTable = 'wedding_planning_requests';
    break;
  default:
    console.error("Unknown category:", bid.category);
    return;
}

// Step 3: Get the user ID (or profile ID) from the appropriate request table
const { data: request, error: requestError } = await supabase
  .from(requestTable)
  .select(`${idField}, event_title, event_type, location, start_date, end_date`)
  .eq('id', bid.request_id)
  .single();

if (requestError || !request) {
  console.error("Error fetching request details:", requestError);
  return;
}

// Step 4: Get the correct ID
const userId = request[idField];
console.log("Customer User ID:", userId);

// Get bid amount for event description
const { data: bidDetails, error: bidDetailsError } = await supabase
  .from('bids')
  .select('bid_amount')
  .eq('id', bidId)
  .single();

// Get customer details using userId from the request table
const { data: customer, error: customerError } = await supabase
  .from('profiles')
  .select('email')
  .eq('id', userId)
  .single();

if (customerError || !customer) {
  console.error('Error fetching customer details:', customerError);
  return res.status(404).json({ error: 'Customer not found' });
}

// Create event details with request info and bid amount
const startDateTime = new Date(startTime);
const endDateTime = new Date(startDateTime.getTime() + duration * 60000);

const eventDetails = {
  summary: `Consultation: ${request.event_title || request.event_type || 'Event'} @ ${request.location || 'TBD'} - ${business.business_name}`,
  description: `Event Type: ${request.event_type || 'N/A'}\nLocation: ${request.location || 'N/A'}\nStart: ${request.start_date || 'N/A'}\nEnd: ${request.end_date || 'N/A'}\nBid Amount: $${bidDetails?.bid_amount || 'N/A'}`,
  start: {
    dateTime: startDateTime.toISOString(),
    timeZone: 'UTC'
  },
  end: {
    dateTime: endDateTime.toISOString(),
    timeZone: 'UTC'
  },
  attendees: [
    { email: business.profiles.email },
    { email: customer.email }
  ],
  conferenceData: {
    createRequest: {
      requestId: `bid-${bidId}`,
      conferenceSolutionKey: { type: 'hangoutsMeet' }
    }
  }
    };

    // Create the event
    let event;
    try {
      event = await calendarService.createEvent(businessId, eventDetails);
    } catch (calendarError) {
      console.error('Google Calendar event creation error:', calendarError);
      // Log nested error details if available
      if (calendarError.response) {
        console.error('Google API response:', calendarError.response.data || calendarError.response);
      }
      return res.status(500).json({ error: 'Failed to create Google Calendar event', details: calendarError.message || calendarError.toString() });
    }

    // Store event details in database
    const { error: eventStoreError } = await supabase
      .from('consultation_events')
      .insert([{
        bid_id: bidId,
        business_id: businessId,
        event_id: event.id,
        start_time: startDateTime.toISOString(),
        end_time: endDateTime.toISOString(),
        meet_link: event.hangoutLink
      }]);

    if (eventStoreError) {
      console.error('Error storing event details:', eventStoreError);
      // Optionally, return a warning to the client
    }

    res.json({
      success: true,
      event: {
        id: event.id,
        startTime: event.start.dateTime,
        endTime: event.end.dateTime,
        meetLink: event.hangoutLink
      }
    });
  } catch (error) {
    // Improved error logging
    console.error('Create event error:', error);
    if (error.stack) console.error(error.stack);
    // Log nested error details if available
    if (error.response) {
      console.error('Nested error response:', error.response.data || error.response);
    }
    res.status(500).json({ error: 'Failed to create event', details: error.message || error.toString() });
  }
});

// Update event
router.put('/events/:eventId', async (req, res) => {
  try {
    const { businessId } = req.query;
    const { eventId } = req.params;
    const eventDetails = req.body;
    
    if (!businessId || !eventId || !eventDetails) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const event = await calendarService.updateEvent(businessId, eventId, eventDetails);
    res.json(event);
  } catch (error) {
    console.error('Update event error:', error);
    res.status(500).json({ error: 'Failed to update event' });
  }
});

// Delete event
router.delete('/events/:eventId', async (req, res) => {
  try {
    const { businessId } = req.query;
    const { eventId } = req.params;
    
    if (!businessId || !eventId) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    await calendarService.deleteEvent(businessId, eventId);
    res.json({ success: true });
  } catch (error) {
    console.error('Delete event error:', error);
    res.status(500).json({ error: 'Failed to delete event' });
  }
});

module.exports = router;