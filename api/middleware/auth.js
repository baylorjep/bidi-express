const supabase = require('../supabaseClient');

/**
 * Middleware to check if the user is authenticated
 * This middleware extracts the JWT token from the Authorization header
 * and validates it with Supabase
 */
const authenticateUser = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required - Bearer token missing'
      });
    }

    const token = authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required - Invalid token format'
      });
    }

    // Validate token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);
    
    if (error || !user) {
      console.error('Token validation error:', error);
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired authentication token'
      });
    }

    // Add user info to request object
    req.user = user;
    req.token = token;
    
    next();
    
  } catch (error) {
    console.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error during authentication'
    });
  }
};

module.exports = authenticateUser;
