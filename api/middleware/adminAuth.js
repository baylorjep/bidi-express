const supabase = require('../supabaseClient');

/**
 * Middleware to check if the authenticated user has admin privileges
 * This middleware should be used after the authenticateUser middleware
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    console.log('Admin authentication middleware called');
    console.log('User object:', { id: req.user?.id, email: req.user?.email });
    
    if (!req.user) {
      console.log('No user found in request');
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // First, let's see what fields are available in business_profiles
    console.log('Checking available fields in business_profiles table...');
    const { data: sampleBusiness, error: sampleError } = await supabase
      .from('business_profiles')
      .select('*')
      .limit(1);
    
    console.log('Sample business profile fields:', sampleBusiness?.[0] ? Object.keys(sampleBusiness[0]) : 'No data');
    console.log('Sample business profile:', sampleBusiness?.[0]);

    // Check if the user has an admin business profile
    // We need to find the business profile by the user's email since req.user.id is the Supabase Auth user ID
    console.log('Looking for business profile with business_owner:', req.user.email);
    
    let { data: businessProfile, error } = await supabase
      .from('business_profiles')
      .select('id, business_name, is_admin')
      .eq('business_owner', req.user.email) // Use email to find the business profile
      .single();

    console.log('Business profile query result (business_owner):', { businessProfile, error });

    // If business_owner field doesn't work, try alternative approaches
    if (error || !businessProfile) {
      console.log('Trying alternative method to find business profile...');
      
      // Try to find by email in a different field or check if there's a profiles table relationship
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email')
        .eq('email', req.user.email)
        .single();
      
      console.log('Profiles query result:', { profiles, profilesError });
      
      if (profiles && !profilesError) {
        // Try to find business profile by the profiles.id
        const { data: altBusinessProfile, error: altError } = await supabase
          .from('business_profiles')
          .select('id, business_name, is_admin')
          .eq('id', profiles.id)
          .single();
        
        console.log('Alternative business profile query result:', { altBusinessProfile, altError });
        
        if (altBusinessProfile && !altError) {
          businessProfile = altBusinessProfile;
          error = null;
        }
      }
    }

    if (error || !businessProfile) {
      console.error('Error fetching business profile:', error);
      return res.status(403).json({
        success: false,
        error: 'Access denied - business profile not found for this user'
      });
    }

    console.log('Business profile found:', businessProfile);

    if (!businessProfile.is_admin) {
      console.log('User does not have admin privileges');
      return res.status(403).json({
        success: false,
        error: 'Access denied - admin privileges required'
      });
    }

    console.log('Admin authentication successful');
    req.isAdmin = true;
    req.businessProfile = businessProfile;
    next();
  } catch (error) {
    console.error('Admin authentication error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during admin authentication'
    });
  }
};

module.exports = authenticateAdmin;
