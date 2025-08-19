const supabase = require('../supabaseClient');

/**
 * Middleware to check if the authenticated user has admin privileges
 * This middleware should be used after the authenticateUser middleware
 */
const authenticateAdmin = async (req, res, next) => {
  try {
    // Ensure user is authenticated first
    if (!req.user) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required'
      });
    }

    // Check if user has admin role in the database
    const { data: userProfile, error } = await supabase
      .from('user_profiles')
      .select('role, is_admin')
      .eq('id', req.user.id)
      .single();

    if (error || !userProfile) {
      console.error('Error fetching user profile:', error);
      return res.status(403).json({
        success: false,
        error: 'Access denied - user profile not found'
      });
    }

    // Check if user has admin privileges
    if (!userProfile.is_admin && userProfile.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied - admin privileges required'
      });
    }

    // Add admin info to request
    req.isAdmin = true;
    req.userRole = userProfile.role;
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
