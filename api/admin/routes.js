const express = require('express');
const router = express.Router();
const cors = require('cors');
const authenticateUser = require('../middleware/auth');
const authenticateAdmin = require('../middleware/adminAuth');
const WebScraperService = require('../services/webScraperService');
const ImageProcessingService = require('../services/imageProcessingService');
const supabase = require('../supabaseClient');

// Simple in-memory status tracking for scraping operations
const scrapingStatus = new Map();

// Helper function to update scraping status
const updateScrapingStatus = (businessId, status, progress = null, error = null) => {
  const currentStatus = scrapingStatus.get(businessId) || {};
  scrapingStatus.set(businessId, {
    ...currentStatus,
    status,
    progress,
    error,
    lastUpdated: new Date().toISOString(),
    ...(status === 'started' && { startTime: new Date().toISOString() }),
    ...(status === 'completed' && { endTime: new Date().toISOString() }),
    ...(status === 'failed' && { endTime: new Date().toISOString() })
  });
};

// Helper function to get scraping status
const getScrapingStatus = (businessId) => {
  return scrapingStatus.get(businessId) || {
    status: 'idle',
    progress: null,
    error: null,
    lastUpdated: null,
    startTime: null,
    endTime: null
  };
};

// Cleanup old status entries (older than 1 hour)
const cleanupOldStatus = () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  for (const [businessId, status] of scrapingStatus.entries()) {
    if (status.lastUpdated && new Date(status.lastUpdated) < oneHourAgo) {
      scrapingStatus.delete(businessId);
    }
  }
};

// Run cleanup every 30 minutes
setInterval(cleanupOldStatus, 30 * 60 * 1000);

// CORS configuration specifically for admin routes
const adminCorsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://www.bidievents.com',
      'https://bidievents.com',
      'https://bidi-express.vercel.app',
      'http://localhost:3000'
    ];
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      // For debugging, allow all origins temporarily
      callback(null, true);
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true,
  preflightContinue: false,
  optionsSuccessStatus: 204
};

// Apply CORS to all admin routes
router.use(cors(adminCorsOptions));

// Handle preflight requests explicitly
router.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.status(204).end();
});

// Middleware to ensure CORS headers are always set
router.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  next();
});

// Rate limiting for admin endpoints
const rateLimit = require('express-rate-limit');

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each admin to 10 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests from this admin, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// More lenient rate limiter for status polling
const statusLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // Allow 60 requests per minute for status polling
  message: {
    success: false,
    error: 'Too many status requests, please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Simple test endpoint to verify admin routes are working
router.get('/test', (req, res) => {
  // Set CORS headers explicitly
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  
  res.json({
    success: true,
    message: 'Admin routes are working',
    timestamp: new Date().toISOString()
  });
});

// Clear scraping status for a business (useful for testing)
router.post('/clear-scraping-status/:businessId',
  adminLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      const { businessId } = req.params;
      
      // Clear the status
      scrapingStatus.delete(businessId);
      
      res.json({
        success: true,
        message: 'Scraping status cleared',
        businessId: businessId
      });
      
    } catch (error) {
      console.error('Error clearing scraping status:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
      });
    }
  }
);

/**
 * POST /api/admin/scrape-website
 * Scrape a vendor's website for portfolio images
 * 
 * Request Body:
 * {
 *   "websiteUrl": "https://example.com",
 *   "businessId": "uuid"
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "totalImages": 25,
 *   "relevantImages": [...],
 *   "websiteUrl": "https://example.com",
 *   "businessId": "uuid",
 *   "timestamp": "2024-01-01T00:00:00.000Z"
 * }
 */
router.post('/scrape-website', 
  adminLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      console.log('Scrape website endpoint called with:', { websiteUrl: req.body.websiteUrl, businessId: req.body.businessId });
      
      const { websiteUrl, businessId } = req.body;
      
      // Validate request body
      if (!websiteUrl || !businessId) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: websiteUrl and businessId are required'
        });
      }

      // Validate business exists
      const { data: business, error: businessError } = await supabase
        .from('business_profiles')
        .select('id, business_name, website, business_category')
        .eq('id', businessId)
        .single();

      if (businessError || !business) {
        return res.status(404).json({
          success: false,
          error: 'Business not found'
        });
      }

      // Validate business has a website
      if (!business.website) {
        return res.status(400).json({
          success: false,
          error: 'Business does not have a website URL configured'
        });
      }

      // Optionally validate that the provided URL matches the business website
      if (business.website !== websiteUrl) {
        console.log(`Warning: Provided URL (${websiteUrl}) differs from business website (${business.website})`);
      }

      // Log scraping attempt
      console.log(`Admin ${req.user.email} initiated scraping for business ${businessId} (${business.business_name})`);
      
      // Update status to started
      updateScrapingStatus(businessId, 'started', 'Initializing scraping service...');
      
      // Initialize scraping service
      console.log('Initializing WebScraperService...');
      const scraperService = new WebScraperService();
      console.log('WebScraperService initialized successfully');
      
      // Update status
      updateScrapingStatus(businessId, 'started', 'Starting website scraping...');
      
      // Start scraping
      console.log('Starting website scraping...');
      updateScrapingStatus(businessId, 'started', 'Crawling website and analyzing images...');
      
      const scrapingResult = await scraperService.scrapeWebsite(
        websiteUrl, 
        businessId, 
        business.business_category
      );
      console.log('Scraping completed with result:', scrapingResult);
      
      if (!scrapingResult.success) {
        // Update status to failed
        updateScrapingStatus(businessId, 'failed', null, scrapingResult.error);
        
        return res.status(500).json({
          success: false,
          error: scrapingResult.error,
          websiteUrl,
          businessId
        });
      }

      // Update status with results
      const statusMessage = `Found ${scrapingResult.totalImages} total images, ${scrapingResult.relevantImages.length} relevant`;
      updateScrapingStatus(businessId, 'completed', statusMessage);

      // Log successful scraping
      console.log(`Scraping completed for ${businessId}: ${scrapingResult.totalImages} total, ${scrapingResult.relevantImages.length} relevant`);
      
      // Set CORS headers explicitly
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      
      res.json({
        success: true,
        message: 'Website scraping completed successfully',
        data: scrapingResult,
        business: {
          id: business.id,
          name: business.business_name,
          category: business.business_category
        }
      });

    } catch (error) {
      console.error('Error in scrape-website endpoint:', error);
      console.error('Error stack:', error.stack);
      
      // Set CORS headers explicitly
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      
      res.status(500).json({
        success: false,
        error: 'Internal server error during website scraping',
        details: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

/**
 * POST /api/admin/save-scraped-images
 * Save scraped images to the vendor's portfolio
 * 
 * Request Body:
 * {
 *   "businessId": "uuid",
 *   "images": [
 *     {
 *       "src": "https://example.com/image1.jpg",
 *       "alt": "Wedding photography",
 *       "title": "Beautiful wedding ceremony",
 *       "context": "Our wedding photography services...",
 *       "relevanceScore": 0.85
 *     }
 *   ],
 *   "options": {
 *     "maxImages": 20,
 *     "qualityThreshold": 0.7
 *   }
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "message": "Images saved successfully",
 *   "data": {
 *     "processedCount": 15,
 *     "savedCount": 15,
 *     "failedCount": 2,
 *     "savedImages": [...]
 *   }
 * }
 */
router.post('/save-scraped-images',
  adminLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      const { businessId, images, options = {} } = req.body;
      
      // Validate request body
      if (!businessId || !images || !Array.isArray(images)) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: businessId and images array are required'
        });
      }

      // Validate business exists
      const { data: business, error: businessError } = await supabase
        .from('business_profiles')
        .select('id, business_name, business_category')
        .eq('id', businessId)
        .single();

      if (businessError || !business) {
        return res.status(404).json({
          success: false,
          error: 'Business not found'
        });
      }

      // Apply options
      const maxImages = options.maxImages || 20;
      const qualityThreshold = options.qualityThreshold || 0.7;
      
      // Filter images by quality threshold
      const filteredImages = images
        .filter(img => img.relevanceScore >= qualityThreshold)
        .slice(0, maxImages);

      if (filteredImages.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No images meet the quality threshold requirements'
        });
      }

      console.log(`Admin ${req.user.email} saving ${filteredImages.length} images for business ${businessId}`);

      // Initialize image processing service
      const imageService = new ImageProcessingService();
      
      // Process images in batches
      const processedImages = await imageService.processImagesBatch(filteredImages, businessId, 3);
      
      // Count results
      const successfulImages = processedImages.filter(img => img.success);
      const failedImages = processedImages.filter(img => !img.success);
      
      if (successfulImages.length === 0) {
        return res.status(500).json({
          success: false,
          error: 'No images were successfully processed',
          processedCount: processedImages.length,
          failedCount: failedImages.length
        });
      }

      // Save to database
      const saveResult = await imageService.saveImagesToDatabase(successfulImages, businessId, business.business_category);
      
      if (!saveResult.success) {
        return res.status(500).json({
          success: false,
          error: `Failed to save images to database: ${saveResult.error}`,
          processedCount: processedImages.length,
          successfulCount: successfulImages.length
        });
      }

      // Clean up temp files
      await imageService.cleanupAllTempFiles();

      // Log successful save
      console.log(`Successfully saved ${saveResult.savedCount} images for business ${businessId}`);

      res.json({
        success: true,
        message: 'Images saved successfully to portfolio',
        data: {
          processedCount: processedImages.length,
          successfulCount: successfulImages.length,
          failedCount: failedImages.length,
          savedCount: saveResult.savedCount,
          savedImages: saveResult.savedImages,
          business: {
            id: business.id,
            name: business.business_name,
            category: business.business_category
          }
        }
      });

    } catch (error) {
      console.error('Error in save-scraped-images endpoint:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error during image saving',
        details: error.message
      });
    }
  }
);

/**
 * GET /api/admin/scraping-status/:businessId
 * Get the status of scraping operations for a business
 */
router.get('/scraping-status/:businessId',
  statusLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      const { businessId } = req.params;
      
      // Get business info
      const { data: business, error: businessError } = await supabase
        .from('business_profiles')
        .select('id, business_name, business_category, website')
        .eq('id', businessId)
        .single();

      if (businessError || !business) {
        return res.status(404).json({
          success: false,
          error: 'Business not found'
        });
      }

      // Get portfolio photos count
      const { count: photoCount } = await supabase
        .from('profile_photos')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', businessId)
        .eq('photo_type', 'portfolio');

      // Get current scraping status from memory
      const currentScrapingStatus = getScrapingStatus(businessId);

      res.json({
        success: true,
        data: {
          business: {
            id: business.id,
            name: business.business_name,
            category: business.business_category,
            websiteUrl: business.website
          },
          portfolio: {
            totalPhotos: photoCount || 0
          },
          scraping: currentScrapingStatus
        }
      });

    } catch (error) {
      console.error('Error in scraping-status endpoint:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
      });
    }
  }
);

/**
 * DELETE /api/admin/portfolio-photo/:photoId
 * Remove a specific photo from a business portfolio
 */
router.delete('/portfolio-photo/:photoId',
  adminLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      const { photoId } = req.params;
      
      // Get photo info
      const { data: photo, error: photoError } = await supabase
        .from('profile_photos')
        .select('*')
        .eq('id', photoId)
        .eq('photo_type', 'portfolio')
        .single();

      if (photoError || !photo) {
        return res.status(404).json({
          success: false,
          error: 'Portfolio photo not found'
        });
      }

      // Delete from database
      const { error: deleteError } = await supabase
        .from('profile_photos')
        .delete()
        .eq('id', photoId);

      if (deleteError) {
        return res.status(500).json({
          success: false,
          error: `Failed to delete photo: ${deleteError.message}`
        });
      }

      // Delete from storage if file_path exists
      if (photo.file_path) {
        try {
          const { error: storageError } = await supabase.storage
            .from('profile-photos')
            .remove([photo.file_path]);
          
          if (storageError) {
            console.warn(`Failed to delete photo from storage: ${storageError.message}`);
            // Don't fail the request if storage deletion fails
          } else {
            console.log(`Successfully deleted photo from storage: ${photo.file_path}`);
          }
        } catch (storageError) {
          console.warn(`Error deleting photo from storage: ${storageError.message}`);
          // Don't fail the request if storage deletion fails
        }
      }

      console.log(`Admin ${req.user.email} deleted portfolio photo ${photoId} for business ${photo.user_id}`);

      res.json({
        success: true,
        message: 'Portfolio photo deleted successfully',
        data: {
          deletedPhotoId: photoId,
          businessId: photo.user_id
        }
      });

    } catch (error) {
      console.error('Error in delete portfolio-photo endpoint:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
      });
    }
  }
);

module.exports = router;
