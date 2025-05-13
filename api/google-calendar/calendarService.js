const { google } = require('googleapis');
const config = require('./config');
const supabase = require('../supabaseClient');

class GoogleCalendarService {
  constructor() {
    this.oauth2Client = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
      config.redirectUri
    );
  }

  // Generate OAuth URL
  getAuthUrl(businessId) {
    const state = Buffer.from(JSON.stringify({ businessId })).toString('base64');
    return this.oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: config.scopes,
      state,
      prompt: 'consent'
    });
  }

  // Handle OAuth callback
  async handleCallback(code, state) {
    try {
      const { tokens } = await this.oauth2Client.getToken(code);
      const { businessId } = JSON.parse(Buffer.from(state, 'base64').toString());
      // Store tokens in database
      await supabase
        .from('business_profiles')
        .update({
          google_calendar_connected: true,
          google_calendar_token: tokens,
          google_calendar_refresh_token: tokens.refresh_token
        })
        .eq('id', businessId);
      return { success: true };
    } catch (error) {
      console.error('Error handling OAuth callback:', error);
      throw error;
    }
  }

  // Get calendar client for a business
  async getCalendarClient(businessId) {
    const { data: business } = await supabase
      .from('business_profiles')
      .select('google_calendar_token')
      .eq('id', businessId)
      .single();
    if (!business?.google_calendar_token) {
      throw new Error('Google Calendar not connected');
    }
    this.oauth2Client.setCredentials(business.google_calendar_token);
    return google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  // Check calendar availability
  async checkAvailability(businessId, date) {
    try {
      const calendar = await this.getCalendarClient(businessId);
      const startOfDay = new Date(date);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(23, 59, 59, 999);
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });
      return response.data.items;
    } catch (error) {
      console.error('Error checking availability:', error);
      throw error;
    }
  }

  // Create calendar event
  async createEvent(businessId, eventDetails) {
    try {
      const calendar = await this.getCalendarClient(businessId);
      const response = await calendar.events.insert({
        calendarId: 'primary',
        resource: eventDetails
      });
      return response.data;
    } catch (error) {
      console.error('Error creating event:', error);
      throw error;
    }
  }

  // Update calendar event
  async updateEvent(businessId, eventId, eventDetails) {
    try {
      const calendar = await this.getCalendarClient(businessId);
      const response = await calendar.events.update({
        calendarId: 'primary',
        eventId,
        resource: eventDetails
      });
      return response.data;
    } catch (error) {
      console.error('Error updating event:', error);
      throw error;
    }
  }

  // Delete calendar event
  async deleteEvent(businessId, eventId) {
    try {
      const calendar = await this.getCalendarClient(businessId);
      await calendar.events.delete({
        calendarId: 'primary',
        eventId
      });
      return { success: true };
    } catch (error) {
      console.error('Error deleting event:', error);
      throw error;
    }
  }

  // Refresh access token
  async refreshToken(businessId) {
    try {
      const { data: business } = await supabase
        .from('business_profiles')
        .select('google_calendar_refresh_token')
        .eq('id', businessId)
        .single();
      if (!business?.google_calendar_refresh_token) {
        throw new Error('No refresh token available');
      }
      this.oauth2Client.setCredentials({
        refresh_token: business.google_calendar_refresh_token
      });
      const { credentials } = await this.oauth2Client.refreshAccessToken();
      await supabase
        .from('business_profiles')
        .update({
          google_calendar_token: credentials
        })
        .eq('id', businessId);
      return credentials;
    } catch (error) {
      console.error('Error refreshing token:', error);
      throw error;
    }
  }
}

module.exports = new GoogleCalendarService();