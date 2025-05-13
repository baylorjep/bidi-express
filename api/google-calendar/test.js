const calendarService = require('./calendarService');

async function testCalendarIntegration() {
  try {
    // Test 1: Generate Auth URL
    console.log('Test 1: Generating Auth URL');
    const authUrl = calendarService.getAuthUrl('test-business-id');
    console.log('Auth URL:', authUrl);
    console.log('Please visit this URL in your browser to authorize the application\n');

    // Test 2: Check Availability (requires valid tokens)
    console.log('Test 2: Checking Availability');
    const today = new Date().toISOString().split('T')[0];
    const events = await calendarService.checkAvailability('test-business-id', today);
    console.log('Today\'s events:', events);
    console.log('\n');

    // Test 3: Create Event (requires valid tokens)
    console.log('Test 3: Creating Event');
    const eventDetails = {
      summary: 'Test Event',
      description: 'This is a test event',
      start: {
        dateTime: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: new Date(Date.now() + 7200000).toISOString(), // 2 hours from now
        timeZone: 'America/New_York',
      },
    };
    const createdEvent = await calendarService.createEvent('test-business-id', eventDetails);
    console.log('Created event:', createdEvent);
    console.log('\n');

    // Test 4: Update Event (requires valid tokens)
    if (createdEvent && createdEvent.id) {
      console.log('Test 4: Updating Event');
      const updatedEvent = await calendarService.updateEvent('test-business-id', createdEvent.id, {
        ...eventDetails,
        summary: 'Updated Test Event',
      });
      console.log('Updated event:', updatedEvent);
      console.log('\n');

      // Test 5: Delete Event (requires valid tokens)
      console.log('Test 5: Deleting Event');
      await calendarService.deleteEvent('test-business-id', createdEvent.id);
      console.log('Event deleted successfully');
    }

  } catch (error) {
    console.error('Test failed:', error.message);
  }
}

// Run the tests
testCalendarIntegration();