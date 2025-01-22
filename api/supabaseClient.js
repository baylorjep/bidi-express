const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase client using environment variables
const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_KEY  
);

module.exports = supabase;