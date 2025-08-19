const express = require('express');
const router = express.Router();
const authenticateUser = require('../middleware/auth');
const authenticateAdmin = require('../middleware/adminAuth');
const WebScraperService = require('../services/webScraperService');
const ImageProcessingService = require('../services/imageProcessingService');
const supabase = require('../supabaseClient');

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
      
      // Initialize scraping service
      const scraperService = new WebScraperService();
      
      // Start scraping
      const scrapingResult = await scraperService.scrapeWebsite(
        websiteUrl, 
        businessId, 
        business.business_category
      );
      
      if (!scrapingResult.success) {
        return res.status(500).json({
          success: false,
          error: scrapingResult.error,
          websiteUrl,
          businessId
        });
      }

      // Log successful scraping
      console.log(`Scraping completed for ${businessId}: ${scrapingResult.totalImages} total, ${scrapingResult.relevantImages.length} relevant`);
      
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
      res.status(500).json({
        success: false,
        error: 'Internal server error during website scraping',
        details: error.message
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
  adminLimiter,
  authenticateUser,
  authenticateAdmin,
  async (req, res) => {
    try {
      const { businessId } = req.params;
      
      // Get business info
      const { data: business, error: businessError } = await supabase
        .from('business_profiles')
        .select('id, business_name, business_category, website_url')
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
          }
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
