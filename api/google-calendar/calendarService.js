const { google } = require('googleapis');
const config = require('./config');
const supabase = require('../supabaseClient');
const { DateTime } = require('luxon');


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
  // Check calendar availability and return available time slots
async checkAvailability(businessId, date) {
  try {
    const calendar = await this.getCalendarClient(businessId);

    // Fetch calendar timezone
    const calendarList = await calendar.calendars.get({ calendarId: 'primary' });
    const timeZone = calendarList.data.timeZone || 'UTC';

    // Start and end of day in the business's timezone
    const startOfDay = DateTime.fromISO(date, { zone: timeZone }).startOf('day');
    const endOfDay = startOfDay.endOf('day');

    // Get busy slots
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: startOfDay.toISO(),
      timeMax: endOfDay.toISO(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const busySlots = response.data.items;
    const availableSlots = [];

    const slotDuration = 30; // in minutes
  const startHour = 9;  // 9 AM
  const endHour = 20;   // 8 PM (in 24-hour format)


    let currentSlot = startOfDay.set({ hour: startHour, minute: 0 });

    while (currentSlot.hour < endHour) {
      const slotEnd = currentSlot.plus({ minutes: slotDuration });

      // Check if this slot overlaps with any busy events
      const isAvailable = !busySlots.some(event => {
        const eventStart = DateTime.fromISO(event.start.dateTime || event.start.date, { zone: timeZone });
        const eventEnd = DateTime.fromISO(event.end.dateTime || event.end.date, { zone: timeZone });
        return (
          (currentSlot >= eventStart && currentSlot < eventEnd) ||
          (slotEnd > eventStart && slotEnd <= eventEnd) ||
          (currentSlot <= eventStart && slotEnd >= eventEnd)
        );
      });

      // Don’t include slots in the past
      const isPast = currentSlot < DateTime.local().setZone(timeZone);

      if (isAvailable && !isPast) {
        availableSlots.push(currentSlot.toISO());
      }

      currentSlot = currentSlot.plus({ minutes: slotDuration });
    }

    return availableSlots;
  } catch (error) {
    console.error('Error checking availability:', error);
    throw error;
  }
}

  // Create calendar event with Google Meet
  async createEvent(businessId, eventDetails) {
    try {
      const calendar = await this.getCalendarClient(businessId);
      const response = await calendar.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1, // Enable Google Meet
        sendUpdates: 'all', // Send emails to attendees
        resource: {
          ...eventDetails,
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'email', minutes: 60 }, // 1 hour before
              { method: 'popup', minutes: 10 } // 10 minutes before
            ]
          }
        }
      });
      return response.data;
    } catch (error) {
      if (error.code === 401) {
        // Token expired, try to refresh
        await this.refreshToken(businessId);
        // Retry the request
        const calendar = await this.getCalendarClient(businessId);
        const response = await calendar.events.insert({
          calendarId: 'primary',
          conferenceDataVersion: 1,
          sendUpdates: 'all',
          resource: {
            ...eventDetails,
            reminders: {
              useDefault: false,
              overrides: [
                { method: 'email', minutes: 60 },
                { method: 'popup', minutes: 10 }
              ]
            }
          }
        });
        return response.data;
      }
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