const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const supabase = require('../supabaseClient');

class ImageProcessingService {
  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp');
    this.maxFileSize = 10 * 1024 * 1024; // 10MB
    this.minDimensions = { width: 400, height: 300 };
    this.supportedFormats = ['jpeg', 'jpg', 'png', 'webp', 'gif'];
  }

  /**
   * Ensure temp directory exists
   */
  async ensureTempDir() {
    try {
      await fs.access(this.tempDir);
    } catch {
      await fs.mkdir(this.tempDir, { recursive: true });
    }
  }

  /**
   * Download and process an image
   */
  async processImage(imageData, businessId) {
    try {
      await this.ensureTempDir();
      
      console.log(`Processing image: ${imageData.src}`);
      
      // Download image
      const imageBuffer = await this.downloadImage(imageData.src);
      
      // Validate image
      const validation = await this.validateImage(imageBuffer);
      if (!validation.isValid) {
        throw new Error(`Image validation failed: ${validation.error}`);
      }
      
      // Process image (resize, optimize, convert format)
      const processedBuffer = await this.optimizeImage(imageBuffer, validation.metadata);
      
      // Generate unique filename
      const filename = this.generateFilename(imageData.src, businessId);
      
      // Upload to Supabase Storage
      const uploadResult = await this.uploadToStorage(processedBuffer, filename, businessId);
      
      // Clean up temp file
      await this.cleanupTempFile(filename);
      
      return {
        success: true,
        originalUrl: imageData.src,
        storageUrl: uploadResult.publicUrl,
        storagePath: uploadResult.storagePath,
        filename: filename,
        metadata: validation.metadata,
        processedMetadata: {
          width: validation.metadata.width,
          height: validation.metadata.height,
          format: 'webp', // Always convert to WebP for consistency
          size: processedBuffer.length
        }
      };
      
    } catch (error) {
      console.error(`Error processing image ${imageData.src}:`, error.message);
      return {
        success: false,
        originalUrl: imageData.src,
        error: error.message
      };
    }
  }

  /**
   * Download image from URL
   */
  async downloadImage(imageUrl) {
    try {
      const response = await axios({
        method: 'GET',
        url: imageUrl,
        responseType: 'arraybuffer',
        timeout: 30000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
      });
      
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const buffer = Buffer.from(response.data);
      
      // Check file size
      if (buffer.length > this.maxFileSize) {
        throw new Error(`File size ${buffer.length} bytes exceeds maximum ${this.maxFileSize} bytes`);
      }
      
      return buffer;
      
    } catch (error) {
      throw new Error(`Failed to download image: ${error.message}`);
    }
  }

  /**
   * Validate downloaded image
   */
  async validateImage(imageBuffer) {
    try {
      // Get image metadata using Sharp
      const metadata = await sharp(imageBuffer).metadata();
      
      // Check if format is supported
      if (!this.supportedFormats.includes(metadata.format)) {
        return {
          isValid: false,
          error: `Unsupported format: ${metadata.format}`,
          metadata: null
        };
      }
      
      // Check dimensions
      if (metadata.width < this.minDimensions.width || metadata.height < this.minDimensions.height) {
        return {
          isValid: false,
          error: `Image dimensions ${metadata.width}x${metadata.height} below minimum ${this.minDimensions.width}x${this.minDimensions.height}`,
          metadata: null
        };
      }
      
      return {
        isValid: true,
        error: null,
        metadata: metadata
      };
      
    } catch (error) {
      return {
        isValid: false,
        error: `Invalid image file: ${error.message}`,
        metadata: null
      };
    }
  }

  /**
   * Optimize image for storage
   */
  async optimizeImage(imageBuffer, metadata) {
    try {
      let sharpInstance = sharp(imageBuffer);
      
      // Resize if too large (max 2000x2000)
      if (metadata.width > 2000 || metadata.height > 2000) {
        sharpInstance = sharpInstance.resize(2000, 2000, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }
      
      // Convert to WebP with quality optimization
      const optimizedBuffer = await sharpInstance
        .webp({
          quality: 80,
          effort: 6
        })
        .toBuffer();
      
      return optimizedBuffer;
      
    } catch (error) {
      throw new Error(`Failed to optimize image: ${error.message}`);
    }
  }

  /**
   * Generate unique filename
   */
  generateFilename(originalUrl, businessId) {
    const timestamp = Date.now();
    const hash = crypto.createHash('md5').update(originalUrl).digest('hex').substring(0, 8);
    const extension = 'webp';
    
    return `portfolio_${businessId}_${timestamp}_${hash}.${extension}`;
  }

  /**
   * Upload image to Supabase Storage
   */
  async uploadToStorage(imageBuffer, filename, businessId) {
    try {
      const storagePath = `${businessId}/${filename}`;
      
      const { data, error } = await supabase.storage
        .from('profile-photos')
        .upload(storagePath, imageBuffer, {
          contentType: 'image/webp',
          cacheControl: '3600',
          upsert: false
        });
      
      if (error) {
        throw new Error(`Storage upload failed: ${error.message}`);
      }
      
      // Get public URL
      const { data: urlData } = supabase.storage
        .from('profile-photos')
        .getPublicUrl(storagePath);
      
      return {
        publicUrl: urlData.publicUrl,
        storagePath: storagePath
      };
      
    } catch (error) {
      throw new Error(`Failed to upload to storage: ${error.message}`);
    }
  }

  /**
   * Clean up temporary files
   */
  async cleanupTempFile(filename) {
    try {
      const tempPath = path.join(this.tempDir, filename);
      await fs.unlink(tempPath);
    } catch (error) {
      console.error(`Failed to cleanup temp file ${filename}:`, error.message);
    }
  }

  /**
   * Process multiple images in batch
   */
  async processImagesBatch(images, businessId, maxConcurrent = 3) {
    const results = [];
    const batches = this.chunkArray(images, maxConcurrent);
    
    for (const batch of batches) {
      const batchPromises = batch.map(image => this.processImage(image, businessId));
      const batchResults = await Promise.allSettled(batchPromises);
      
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          results.push({
            success: false,
            error: result.reason.message
          });
        }
      }
      
      // Add delay between batches to avoid overwhelming the system
      if (batches.indexOf(batch) < batches.length - 1) {
        await this.delay(1000);
      }
    }
    
    return results;
  }

  /**
   * Save processed images to database
   */
  async saveImagesToDatabase(processedImages, businessId, businessCategory = null) {
    try {
      const successfulImages = processedImages.filter(img => img.success);
      
      if (successfulImages.length === 0) {
        return {
          success: false,
          error: 'No images were successfully processed',
          savedCount: 0
        };
      }
      
      // Get current display order for this business
      const { data: existingPhotos } = await supabase
        .from('profile_photos')
        .select('display_order')
        .eq('user_id', businessId)
        .eq('photo_type', 'portfolio')
        .order('display_order', { ascending: false })
        .limit(1);
      
      let nextDisplayOrder = 1;
      if (existingPhotos && existingPhotos.length > 0) {
        nextDisplayOrder = existingPhotos[0].display_order + 1;
      }
      
      // Prepare database records
      const photoRecords = successfulImages.map((image, index) => ({
        user_id: businessId,
        photo_url: image.storageUrl,
        file_path: image.storagePath || '',
        photo_type: 'portfolio',
        display_order: nextDisplayOrder + index,
        category_id: Array.isArray(businessCategory) ? businessCategory[0] : businessCategory, // Handle array or single value
        created_at: new Date().toISOString()
      }));
      
      // Insert into database
      const { data, error } = await supabase
        .from('profile_photos')
        .insert(photoRecords)
        .select();
      
      if (error) {
        throw new Error(`Database insert failed: ${error.message}`);
      }
      
      return {
        success: true,
        savedCount: data.length,
        savedImages: data
      };
      
    } catch (error) {
      console.error('Error saving images to database:', error);
      return {
        success: false,
        error: error.message,
        savedCount: 0
      };
    }
  }

  /**
   * Utility functions
   */
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clean up all temporary files
   */
  async cleanupAllTempFiles() {
    try {
      const files = await fs.readdir(this.tempDir);
      for (const file of files) {
        await fs.unlink(path.join(this.tempDir, file));
      }
    } catch (error) {
      console.error('Error cleaning up temp files:', error.message);
    }
  }
}

module.exports = ImageProcessingService;
