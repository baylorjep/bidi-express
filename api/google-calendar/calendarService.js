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
    console.log(`Checking availability for business: ${businessId}, date: ${date}`);
    
    const calendar = await this.getCalendarClient(businessId);

    // Get business profile with consultation hours (no timezone column)
    console.log('Fetching business profile from Supabase...');
    const { data: business, error } = await supabase
      .from('business_profiles')
      .select('consultation_hours')
      .eq('id', businessId)
      .single();

    console.log('Supabase query result:', { business, error });

    if (error) {
      console.error('Supabase error:', error);
      throw new Error(`Database error: ${error.message}`);
    }

    if (!business) {
      console.error(`Business not found in database: ${businessId}`);
      throw new Error('Business not found');
    }

    console.log('Business found:', business);

    // Hardcode Mountain Daylight Time for now
    const timeZone = 'America/Denver';
    console.log(`Using timezone: ${timeZone} for business ${businessId}`);

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

    // Parse consultation hours with timezone support
    const consultationHours = this.parseConsultationHours(business.consultation_hours, timeZone);
    
    if (!consultationHours) {
      console.warn(`No consultation hours found for business ${businessId}, using default hours`);
      // Fallback to default hours if no consultation hours are set
      consultationHours = {
        startHour: 9,
        endHour: 17,
        daysAvailable: [0, 1, 2, 3, 4, 5, 6] // All days
      };
    }

    // Check if the requested date is within available days
    const dayOfWeek = startOfDay.weekday % 7; // Convert to 0-6 (Sunday = 0)
    if (!consultationHours.daysAvailable.includes(dayOfWeek)) {
      console.log(`Date ${date} is not in available days: ${consultationHours.daysAvailable}`);
      return []; // No available slots on this day
    }

    const slotDuration = 30; // in minutes
    const startHour = consultationHours.startHour;
    const endHour = consultationHours.endHour;

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

      // Don't include slots in the past
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

// Parse consultation hours with timezone support
parseConsultationHours(consultationHours, timeZone) {
  if (!consultationHours) {
    return null;
  }

  try {
    // Handle different consultation hours formats
    if (typeof consultationHours === 'string') {
      consultationHours = JSON.parse(consultationHours);
    }

    // Extract hours and days
    const { startTime, endTime, daysAvailable } = consultationHours;

    if (!startTime || !endTime || !daysAvailable) {
      console.warn('Invalid consultation hours format:', consultationHours);
      return null;
    }

    // Parse time strings (e.g., "09:00", "17:00") to hours
    const startHour = parseInt(startTime.split(':')[0], 10);
    const endHour = parseInt(endTime.split(':')[0], 10);

    // Validate hours
    if (isNaN(startHour) || isNaN(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      console.warn('Invalid hours in consultation hours:', { startHour, endHour });
      return null;
    }

    // Convert string day names to numbers (0-6, Sunday = 0)
    const dayNameToNumber = {
      'Sunday': 0,
      'Monday': 1,
      'Tuesday': 2,
      'Wednesday': 3,
      'Thursday': 4,
      'Friday': 5,
      'Saturday': 6
    };

    let daysArray = daysAvailable;
    if (Array.isArray(daysAvailable)) {
      daysArray = daysAvailable.map(day => {
        if (typeof day === 'string') {
          return dayNameToNumber[day] || 0;
        }
        const dayNum = parseInt(day, 10);
        return isNaN(dayNum) ? 0 : dayNum;
      });
    }

    console.log('Parsed consultation hours:', { startHour, endHour, daysArray });

    return {
      startHour,
      endHour,
      daysAvailable: daysArray,
      timezone: timeZone
    };
  } catch (error) {
    console.error('Error parsing consultation hours:', error);
    return null;
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