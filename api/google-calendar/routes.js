const express = require('express');
const router = express.Router();
const calendarService = require('./calendarService');

// Initiate OAuth flow
router.get('/auth', (req, res) => {
  const { businessId } = req.query;
  if (!businessId) {
    return res.status(400).json({ error: 'Business ID is required' });
  }
  
  const authUrl = calendarService.getAuthUrl(businessId);
  res.json({ authUrl });
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

// Create event
router.post('/events', async (req, res) => {
  try {
    const { businessId } = req.query;
    const eventDetails = req.body;
    
    if (!businessId || !eventDetails) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }

    const event = await calendarService.createEvent(businessId, eventDetails);
    res.json(event);
  } catch (error) {
    console.error('Create event error:', error);
    res.status(500).json({ error: 'Failed to create event' });
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