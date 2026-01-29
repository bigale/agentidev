/**
 * Preset Extraction Templates
 *
 * Common extraction patterns for popular use cases.
 * Users can select these templates or write custom prompts.
 */

export const EXTRACTION_TEMPLATES = {
  // E-commerce
  'products': {
    name: '🛍️ E-commerce Products',
    prompt: 'Extract all products with title, price, currency, rating, review count, image URL, and product URL',
    description: 'Extract product listings from e-commerce sites',
    schema: {
      fields: [
        { name: 'title', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'currency', type: 'string' },
        { name: 'rating', type: 'number' },
        { name: 'reviewCount', type: 'number' },
        { name: 'imageUrl', type: 'string' },
        { name: 'productUrl', type: 'string' },
        { name: 'inStock', type: 'boolean' }
      ]
    },
    followPagination: true,
    maxPages: 10
  },

  // Jobs
  'jobs': {
    name: '💼 Job Listings',
    prompt: 'Extract all job listings with title, company, location, salary, job type, posted date, and apply URL',
    description: 'Extract job postings from job boards',
    schema: {
      fields: [
        { name: 'title', type: 'string' },
        { name: 'company', type: 'string' },
        { name: 'location', type: 'string' },
        { name: 'salary', type: 'string' },
        { name: 'jobType', type: 'string' },
        { name: 'postedDate', type: 'string' },
        { name: 'applyUrl', type: 'string' }
      ]
    },
    followPagination: true,
    maxPages: 5
  },

  // News/Articles
  'articles': {
    name: '📰 News Articles',
    prompt: 'Extract all articles with headline, author, publish date, summary, full text, and article URL',
    description: 'Extract news articles and blog posts',
    schema: {
      fields: [
        { name: 'headline', type: 'string' },
        { name: 'author', type: 'string' },
        { name: 'publishDate', type: 'string' },
        { name: 'summary', type: 'string' },
        { name: 'fullText', type: 'string' },
        { name: 'imageUrl', type: 'string' },
        { name: 'articleUrl', type: 'string' }
      ]
    },
    followPagination: false,
    maxPages: 1
  },

  // Events
  'events': {
    name: '🎫 Events',
    prompt: 'Extract all events with title, date, time, location, venue, price, and event URL',
    description: 'Extract event listings from event sites',
    schema: {
      fields: [
        { name: 'title', type: 'string' },
        { name: 'date', type: 'string' },
        { name: 'time', type: 'string' },
        { name: 'location', type: 'string' },
        { name: 'venue', type: 'string' },
        { name: 'price', type: 'string' },
        { name: 'eventUrl', type: 'string' }
      ]
    },
    followPagination: true,
    maxPages: 5
  },

  // Real Estate
  'properties': {
    name: '🏠 Real Estate',
    prompt: 'Extract all properties with address, price, bedrooms, bathrooms, square footage, and listing URL',
    description: 'Extract property listings from real estate sites',
    schema: {
      fields: [
        { name: 'address', type: 'string' },
        { name: 'price', type: 'number' },
        { name: 'bedrooms', type: 'number' },
        { name: 'bathrooms', type: 'number' },
        { name: 'squareFeet', type: 'number' },
        { name: 'propertyType', type: 'string' },
        { name: 'imageUrl', type: 'string' },
        { name: 'listingUrl', type: 'string' }
      ]
    },
    followPagination: true,
    maxPages: 10
  },

  // Contacts
  'contacts': {
    name: '📞 Contact Information',
    prompt: 'Extract all contacts with name, email, phone, company, title, and address',
    description: 'Extract contact information from directories',
    schema: {
      fields: [
        { name: 'name', type: 'string' },
        { name: 'email', type: 'string' },
        { name: 'phone', type: 'string' },
        { name: 'company', type: 'string' },
        { name: 'title', type: 'string' },
        { name: 'address', type: 'string' }
      ]
    },
    followPagination: true,
    maxPages: 5
  },

  // Reviews
  'reviews': {
    name: '⭐ Reviews',
    prompt: 'Extract all reviews with reviewer name, rating, review text, date, and helpful count',
    description: 'Extract user reviews and ratings',
    schema: {
      fields: [
        { name: 'reviewerName', type: 'string' },
        { name: 'rating', type: 'number' },
        { name: 'reviewText', type: 'string' },
        { name: 'date', type: 'string' },
        { name: 'helpfulCount', type: 'number' },
        { name: 'verifiedPurchase', type: 'boolean' }
      ]
    },
    followPagination: true,
    maxPages: 10
  },

  // Tables
  'table': {
    name: '📊 Data Table',
    prompt: 'Extract all data from the table on this page',
    description: 'Extract structured data from HTML tables',
    schema: null, // Will be inferred from table structure
    followPagination: false,
    maxPages: 1
  },

  // Custom
  'custom': {
    name: '✏️ Custom Extraction',
    prompt: '',
    description: 'Write your own extraction prompt',
    schema: null,
    followPagination: false,
    maxPages: 5
  }
};

/**
 * Get template by ID
 * @param {string} templateId - Template identifier
 * @returns {Object|null} Template object
 */
export function getTemplate(templateId) {
  return EXTRACTION_TEMPLATES[templateId] || null;
}

/**
 * Get all template options for UI dropdown
 * @returns {Array} Array of {id, name, description}
 */
export function getTemplateOptions() {
  return Object.keys(EXTRACTION_TEMPLATES).map(id => ({
    id,
    name: EXTRACTION_TEMPLATES[id].name,
    description: EXTRACTION_TEMPLATES[id].description
  }));
}

/**
 * Apply template to extraction options
 * @param {string} templateId - Template identifier
 * @returns {Object} Extraction options
 */
export function applyTemplate(templateId) {
  const template = getTemplate(templateId);

  if (!template) {
    return null;
  }

  return {
    prompt: template.prompt,
    followPagination: template.followPagination,
    maxPages: template.maxPages,
    schema: template.schema // Pre-defined schema (optional)
  };
}
