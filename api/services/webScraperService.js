const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');
const URL = require('url-parse');
const imageSize = require('image-size');

class WebScraperService {
  constructor() {
    this.browser = null;
    this.visitedUrls = new Set();
    this.imageQueue = [];
    this.maxDepth = 3;
    this.maxImagesPerSite = 50;
    this.rateLimitDelay = 1000; // 1 second between requests
  }

  /**
   * Initialize the browser instance
   */
  async initialize() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu'
        ]
      });
    }
  }

  /**
   * Close the browser instance
   */
  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Main scraping function
   */
  async scrapeWebsite(websiteUrl, businessId, businessCategory) {
    try {
      await this.initialize();
      
      console.log(`Starting scrape for: ${websiteUrl}`);
      
      // Validate URL
      if (!this.isValidUrl(websiteUrl)) {
        throw new Error('Invalid URL provided');
      }

      // Check robots.txt
      const robotsAllowed = await this.checkRobotsTxt(websiteUrl);
      if (!robotsAllowed) {
        throw new Error('Website robots.txt disallows scraping');
      }

      // Start crawling
      const scrapedImages = await this.crawlWebsite(websiteUrl, businessCategory);
      
      console.log(`Found ${scrapedImages.length} potential images`);
      
      // Filter and score images
      const filteredImages = await this.filterAndScoreImages(scrapedImages, businessCategory);
      
      console.log(`Filtered to ${filteredImages.length} relevant images`);
      
      return {
        success: true,
        totalImages: scrapedImages.length,
        relevantImages: filteredImages,
        websiteUrl,
        businessId,
        timestamp: new Date().toISOString()
      };

    } catch (error) {
      console.error('Scraping error:', error);
      return {
        success: false,
        error: error.message,
        websiteUrl,
        businessId,
        timestamp: new Date().toISOString()
      };
    } finally {
      await this.cleanup();
    }
  }

  /**
   * Validate URL format and accessibility
   */
  isValidUrl(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Check robots.txt for scraping permissions
   */
  async checkRobotsTxt(baseUrl) {
    try {
      const robotsUrl = new URL('/robots.txt', baseUrl).href;
      const response = await axios.get(robotsUrl, { timeout: 5000 });
      const robotsText = response.data.toLowerCase();
      
      // Check if User-agent: * disallows all
      if (robotsText.includes('user-agent: *') && robotsText.includes('disallow: /')) {
        return false;
      }
      
      return true;
    } catch (error) {
      // If robots.txt is not accessible, assume scraping is allowed
      console.log('Robots.txt not accessible, proceeding with scrape');
      return true;
    }
  }

  /**
   * Crawl website and discover images
   */
  async crawlWebsite(startUrl, businessCategory) {
    const images = [];
    const urlsToVisit = [{ url: startUrl, depth: 0 }];
    
    while (urlsToVisit.length > 0 && this.visitedUrls.size < 100) {
      const { url, depth } = urlsToVisit.shift();
      
      if (this.visitedUrls.has(url) || depth > this.maxDepth) {
        continue;
      }
      
      this.visitedUrls.add(url);
      
      try {
        console.log(`Crawling: ${url} (depth: ${depth})`);
        
        // Add rate limiting delay
        if (depth > 0) {
          await this.delay(this.rateLimitDelay);
        }
        
        const pageImages = await this.scrapePage(url, businessCategory);
        images.push(...pageImages);
        
        // If we have enough images, stop crawling
        if (images.length >= this.maxImagesPerSite) {
          break;
        }
        
        // Find internal links for next level crawling
        if (depth < this.maxDepth) {
          const internalLinks = await this.findInternalLinks(url);
          for (const link of internalLinks.slice(0, 5)) { // Limit to 5 links per level
            urlsToVisit.push({ url: link, depth: depth + 1 });
          }
        }
        
      } catch (error) {
        console.error(`Error crawling ${url}:`, error.message);
      }
    }
    
    return images;
  }

  /**
   * Scrape a single page for images
   */
  async scrapePage(url, businessCategory) {
    try {
      const page = await this.browser.newPage();
      
      // Set user agent
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
      
      // Set timeout
      await page.setDefaultTimeout(30000);
      
      // Navigate to page
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      // Get page content
      const content = await page.content();
      const $ = cheerio.load(content);
      
      const images = [];
      
      // Find all images
      $('img').each((index, element) => {
        const $img = $(element);
        const src = $img.attr('src');
        const alt = $img.attr('alt') || '';
        const title = $img.attr('title') || '';
        const width = $img.attr('width');
        const height = $img.attr('height');
        
        if (src && this.isValidImageUrl(src)) {
          const absoluteUrl = this.resolveUrl(src, url);
          
          // Get surrounding context
          const context = this.getImageContext($img);
          
          images.push({
            src: absoluteUrl,
            alt: alt,
            title: title,
            width: width ? parseInt(width) : null,
            height: height ? parseInt(height) : null,
            context: context,
            pageUrl: url
          });
        }
      });
      
      await page.close();
      return images;
      
    } catch (error) {
      console.error(`Error scraping page ${url}:`, error.message);
      return [];
    }
  }

  /**
   * Find internal links on a page
   */
  async findInternalLinks(pageUrl) {
    try {
      const page = await this.browser.newPage();
      await page.goto(pageUrl, { waitUntil: 'networkidle2' });
      
      const links = await page.evaluate((url) => {
        const baseUrl = new URL(url);
        const internalLinks = [];
        
        document.querySelectorAll('a[href]').forEach(link => {
          const href = link.href;
          try {
            const linkUrl = new URL(href);
            if (linkUrl.hostname === baseUrl.hostname && 
                !href.includes('#') && 
                !href.includes('javascript:') &&
                href !== url) {
              internalLinks.push(href);
            }
          } catch (e) {
            // Skip invalid URLs
          }
        });
        
        return [...new Set(internalLinks)]; // Remove duplicates
      }, pageUrl);
      
      await page.close();
      return links;
      
    } catch (error) {
      console.error(`Error finding internal links for ${pageUrl}:`, error.message);
      return [];
    }
  }

  /**
   * Filter and score images based on relevance
   */
  async filterAndScoreImages(images, businessCategory) {
    const scoredImages = [];
    
    for (const image of images) {
      try {
        const score = await this.calculateImageScore(image, businessCategory);
        
        if (score > 0.7) { // Only include images with relevance score > 0.7
          scoredImages.push({
            ...image,
            relevanceScore: score
          });
        }
      } catch (error) {
        console.error(`Error scoring image ${image.src}:`, error.message);
      }
    }
    
    // Sort by relevance score (highest first)
    scoredImages.sort((a, b) => b.relevanceScore - a.relevanceScore);
    
    return scoredImages.slice(0, 20); // Limit to top 20 images
  }

  /**
   * Calculate relevance score for an image
   */
  async calculateImageScore(image, businessCategory) {
    let score = 0;
    
    // Check image dimensions (prefer larger images)
    if (image.width && image.height) {
      const area = image.width * image.height;
      if (area >= 400 * 300) { // Minimum 400x300
        score += 0.3;
      }
      if (area >= 800 * 600) {
        score += 0.2;
      }
    }
    
    // Check alt text quality
    if (image.alt && image.alt.length > 10) {
      score += 0.2;
      if (this.textRelevance(image.alt, businessCategory)) {
        score += 0.3;
      }
    }
    
    // Check title quality
    if (image.title && image.title.length > 5) {
      score += 0.1;
      if (this.textRelevance(image.title, businessCategory)) {
        score += 0.2;
      }
    }
    
    // Check surrounding context
    if (image.context && this.textRelevance(image.context, businessCategory)) {
      score += 0.2;
    }
    
    // Penalize common non-portfolio images
    const nonPortfolioKeywords = ['logo', 'icon', 'banner', 'advertisement', 'social', 'share'];
    const imageText = `${image.alt} ${image.title} ${image.context}`.toLowerCase();
    
    for (const keyword of nonPortfolioKeywords) {
      if (imageText.includes(keyword)) {
        score -= 0.1;
      }
    }
    
    return Math.max(0, Math.min(1, score)); // Ensure score is between 0 and 1
  }

  /**
   * Check if text is relevant to business category
   */
  textRelevance(text, businessCategory) {
    if (!text || !businessCategory) return false;
    
    const textLower = text.toLowerCase();
    
    // Handle both array and string business categories
    const categories = Array.isArray(businessCategory) ? businessCategory : [businessCategory];
    
    // Simple keyword matching - could be enhanced with AI/ML
    const categoryKeywords = {
      'photography': ['photo', 'photograph', 'camera', 'portrait', 'wedding', 'event'],
      'catering': ['food', 'catering', 'meal', 'dinner', 'lunch', 'breakfast'],
      'music': ['music', 'band', 'dj', 'concert', 'performance', 'sound'],
      'florist': ['flower', 'floral', 'bouquet', 'arrangement', 'plant'],
      'venue': ['venue', 'hall', 'room', 'space', 'facility', 'location'],
      'transportation': ['car', 'limo', 'bus', 'transport', 'vehicle', 'travel']
    };
    
    // Check each category for relevance
    for (const category of categories) {
      const categoryLower = category.toLowerCase();
      const keywords = categoryKeywords[categoryLower] || [];
      
      for (const keyword of keywords) {
        if (textLower.includes(keyword)) {
          return true;
        }
      }
    }
    
    return false;
  }

  /**
   * Utility functions
   */
  isValidImageUrl(url) {
    const validExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'];
    const lowerUrl = url.toLowerCase();
    
    return validExtensions.some(ext => lowerUrl.includes(ext)) || 
           lowerUrl.includes('data:image/');
  }

  resolveUrl(relativeUrl, baseUrl) {
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch {
      return relativeUrl;
    }
  }

  getImageContext($img) {
    // Get text from parent elements and siblings
    const parent = $img.parent();
    const context = [];
    
    // Get text from parent
    const parentText = parent.text().trim();
    if (parentText) {
      context.push(parentText);
    }
    
    // Get text from siblings
    $img.siblings().each((index, sibling) => {
      const siblingText = $(sibling).text().trim();
      if (siblingText) {
        context.push(siblingText);
      }
    });
    
    return context.join(' ').substring(0, 200); // Limit context length
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WebScraperService;
