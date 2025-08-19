const supabase = require('../supabaseClient');

class ScrapingLogService {
  constructor() {
    this.logTable = 'scraping_logs';
    this.metricsTable = 'scraping_metrics';
  }

  /**
   * Log a scraping operation
   */
  async logScrapingOperation(operationData) {
    try {
      const {
        adminUserId,
        businessId,
        websiteUrl,
        operationType, // 'scrape_website', 'save_images', 'delete_photo'
        status, // 'success', 'failed', 'in_progress'
        details,
        metadata = {}
      } = operationData;

      const logEntry = {
        admin_user_id: adminUserId,
        business_id: businessId,
        website_url: websiteUrl,
        operation_type: operationType,
        status: status,
        details: details,
        metadata: metadata,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from(this.logTable)
        .insert(logEntry)
        .select()
        .single();

      if (error) {
        console.error('Error logging scraping operation:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error in logScrapingOperation:', error);
      return null;
    }
  }

  /**
   * Update scraping operation status
   */
  async updateScrapingStatus(logId, status, details = null, metadata = {}) {
    try {
      const updateData = {
        status: status,
        updated_at: new Date().toISOString()
      };

      if (details) {
        updateData.details = details;
      }

      if (Object.keys(metadata).length > 0) {
        updateData.metadata = metadata;
      }

      const { data, error } = await supabase
        .from(this.logTable)
        .update(updateData)
        .eq('id', logId)
        .select()
        .single();

      if (error) {
        console.error('Error updating scraping status:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error in updateScrapingStatus:', error);
      return null;
    }
  }

  /**
   * Log scraping metrics
   */
  async logScrapingMetrics(metricsData) {
    try {
      const {
        businessId,
        websiteUrl,
        totalImagesFound,
        relevantImagesCount,
        imagesProcessed,
        imagesSaved,
        processingTime,
        errors = []
      } = metricsData;

      const metricsEntry = {
        business_id: businessId,
        website_url: websiteUrl,
        total_images_found: totalImagesFound,
        relevant_images_count: relevantImagesCount,
        images_processed: imagesProcessed,
        images_saved: imagesSaved,
        processing_time_ms: processingTime,
        error_count: errors.length,
        errors: errors,
        created_at: new Date().toISOString()
      };

      const { data, error } = await supabase
        .from(this.metricsTable)
        .insert(metricsEntry)
        .select()
        .single();

      if (error) {
        console.error('Error logging scraping metrics:', error);
        return null;
      }

      return data;
    } catch (error) {
      console.error('Error in logScrapingMetrics:', error);
      return null;
    }
    }

  /**
   * Get scraping history for a business
   */
  async getBusinessScrapingHistory(businessId, limit = 50) {
    try {
      const { data, error } = await supabase
        .from(this.logTable)
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Error fetching business scraping history:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('Error in getBusinessScrapingHistory:', error);
      return [];
    }
  }

  /**
   * Get admin scraping activity
   */
  async getAdminScrapingActivity(adminUserId, limit = 100) {
    try {
      const { data, error } = await supabase
        .from(this.logTable)
        .select('*')
        .eq('admin_user_id', adminUserId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('Error fetching admin scraping activity:', error);
        return [];
      }

      return data || [];
    } catch (error) {
      console.error('Error in getAdminScrapingActivity:', error);
      return [];
    }
  }

  /**
   * Get scraping statistics
   */
  async getScrapingStatistics(timeRange = '30d') {
    try {
      const now = new Date();
      let startDate;

      switch (timeRange) {
        case '7d':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case '30d':
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
        case '90d':
          startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
          break;
        default:
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      // Get operation counts by status
      const { data: statusCounts, error: statusError } = await supabase
        .from(this.logTable)
        .select('status')
        .gte('created_at', startDate.toISOString());

      if (statusError) {
        console.error('Error fetching status counts:', statusError);
        return null;
      }

      // Get metrics summary
      const { data: metricsSummary, error: metricsError } = await supabase
        .from(this.metricsTable)
        .select('total_images_found, relevant_images_count, images_saved, processing_time_ms')
        .gte('created_at', startDate.toISOString());

      if (metricsError) {
        console.error('Error fetching metrics summary:', metricsError);
        return null;
      }

      // Calculate statistics
      const stats = {
        timeRange,
        totalOperations: statusCounts?.length || 0,
        statusBreakdown: this.calculateStatusBreakdown(statusCounts),
        metrics: this.calculateMetricsSummary(metricsSummary)
      };

      return stats;
    } catch (error) {
      console.error('Error in getScrapingStatistics:', error);
      return null;
    }
  }

  /**
   * Calculate status breakdown from raw data
   */
  calculateStatusBreakdown(statusData) {
    if (!statusData || !Array.isArray(statusData)) {
      return {};
    }

    const breakdown = {};
    statusData.forEach(item => {
      const status = item.status;
      breakdown[status] = (breakdown[status] || 0) + 1;
    });

    return breakdown;
  }

  /**
   * Calculate metrics summary from raw data
   */
  calculateMetricsSummary(metricsData) {
    if (!metricsData || !Array.isArray(metricsData)) {
      return {
        totalImagesFound: 0,
        totalRelevantImages: 0,
        totalImagesSaved: 0,
        averageProcessingTime: 0
      };
    }

    const summary = {
      totalImagesFound: 0,
      totalRelevantImages: 0,
      totalImagesSaved: 0,
      averageProcessingTime: 0
    };

    let totalProcessingTime = 0;
    let validProcessingTimes = 0;

    metricsData.forEach(metric => {
      summary.totalImagesFound += metric.total_images_found || 0;
      summary.totalRelevantImages += metric.relevant_images_count || 0;
      summary.totalImagesSaved += metric.images_saved || 0;
      
      if (metric.processing_time_ms && metric.processing_time_ms > 0) {
        totalProcessingTime += metric.processing_time_ms;
        validProcessingTimes++;
      }
    });

    if (validProcessingTimes > 0) {
      summary.averageProcessingTime = Math.round(totalProcessingTime / validProcessingTimes);
    }

    return summary;
  }

  /**
   * Log error details
   */
  async logError(operationData, error, context = {}) {
    try {
      const errorLog = {
        ...operationData,
        status: 'failed',
        details: error.message || 'Unknown error occurred',
        metadata: {
          ...operationData.metadata,
          error: {
            message: error.message,
            stack: error.stack,
            name: error.name,
            ...context
          }
        }
      };

      return await this.logScrapingOperation(errorLog);
    } catch (logError) {
      console.error('Error logging error details:', logError);
      return null;
    }
  }

  /**
   * Clean up old logs (keep last 90 days)
   */
  async cleanupOldLogs() {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 90);

      // Clean up old scraping logs
      const { error: logsError } = await supabase
        .from(this.logTable)
        .delete()
        .lt('created_at', cutoffDate.toISOString());

      if (logsError) {
        console.error('Error cleaning up old logs:', logsError);
      }

      // Clean up old metrics
      const { error: metricsError } = await supabase
        .from(this.metricsTable)
        .delete()
        .lt('created_at', cutoffDate.toISOString());

      if (metricsError) {
        console.error('Error cleaning up old metrics:', metricsError);
      }

      console.log('Old scraping logs and metrics cleaned up successfully');
    } catch (error) {
      console.error('Error in cleanupOldLogs:', error);
    }
  }
}

module.exports = ScrapingLogService;
