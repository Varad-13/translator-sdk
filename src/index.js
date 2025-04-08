(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  // Main SDK object
  const TranslationSDK = {
    config: {
      apiUrl: API_URL,
      siteId: null,
      sourceLanguage: "en",
      targetLanguage: null,
      apiKey: null,
      autoTranslate: true,
      selectors: {
        // Target elements that usually contain user-facing text.
        include: ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'button', 'a', 'label', 'span'],
        // Exclude elements explicitly marked as not for translation.
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },

    // Initializes the SDK with user-provided options.
    init: function(options) {
      this.config = { ...this.config, ...options };

      if (!this.config.siteId || !this.config.apiKey) {
        console.error('TranslationSDK: siteId and apiKey are required');
        return;
      }

      // Add the language selector UI.
      this._addLanguageSelector();

      // If autoTranslate is enabled and a target language is provided, translate immediately.
      if (this.config.autoTranslate && this.config.targetLanguage) {
        this.translatePage(this.config.targetLanguage);
      }

      return this;
    },

    // Extracts candidate elements from the page using include and exclude selectors.
    extractContent: function() {
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));

      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];

      // Filter out elements matching the exclude selectors.
      const filteredElements = elements.filter(el => {
         return !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded));
      });

      // Ensure each candidate has an ID and attach a little context.
      return filteredElements.map(el => {
         if (!el.id) {
            el.id = `el-${Math.random().toString(36).substr(2, 9)}`;
         }
         const sectionEl = el.closest('section, article, div.section');
         const sectionTitle = sectionEl ? (sectionEl.querySelector('h1, h2, h3')?.textContent.trim() || "") : "";
         return {
            id: el.id,
            element: el,
            context: {
               sectionTitle: sectionTitle
            }
         };
      });
    },

    // Translates the page by processing each candidate element individually.
    translatePage: function(targetLanguage) {
      // Save the target language.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);
      const contentItems = this.extractContent();

      // If the target language equals the source, restore original text if available.
      if (targetLanguage === this.config.sourceLanguage) {
         contentItems.forEach(item => {
             const el = item.element;
             if (el.dataset.originalText) {
                 el.innerText = el.dataset.originalText;
             }
         });
         return;
      }

      this._showLoadingIndicator();

      // Process each element with a single API request per element.
      contentItems.forEach(item => {
         this._translateElement(item);
      });

      // Hide the loading indicator after a short delay.
      setTimeout(() => { this._hideLoadingIndicator(); }, 2000);
    },

    /**
     * Translates a single element:
     * - It extracts the element’s aggregated text (via innerText).
     * - Saves the original text (for later restoration if needed).
     * - Checks for a cached translation.
     * - If none exists, it sends a POST request with the text and context.
     * - On response, it updates only the text content of the element.
     *
     * This method ensures that the element’s structure (images, markup, styling) remains unchanged.
     */
    _translateElement: function(item) {
      const el = item.element;
      const originalText = el.innerText.trim();
      if (!originalText) return;
      
      // Save the original text if not already saved.
      if (!el.dataset.originalText) {
         el.dataset.originalText = originalText;
      }

      // Check for a cached translation.
      const cached = this._getCachedTranslation(item.id, originalText, this.config.targetLanguage);
      if (cached) {
         this._applyTranslatedText(el, cached);
         return;
      }

      // Prepare the payload.
      const payload = {
         sourceLanguage: this.config.sourceLanguage,
         targetLanguage: this.config.targetLanguage,
         siteId: this.config.siteId,
         content: [{
             id: item.id,
             text: originalText,
             type: "paragraph", // Adjust this as needed.
             context: item.context
         }]
      };

      // Send a POST request to the translation API.
      fetch(this.config.apiUrl, {
         method: "POST",
         headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.config.apiKey}`
         },
         body: JSON.stringify(payload)
      })
      .then(response => {
         if (!response.ok) {
           throw new Error("Translation API error: " + response.statusText);
         }
         return response.json();
      })
      .then(data => {
         if (data.error || !data.translations || data.translations.length === 0) {
            console.error('Translation error:', data.error);
            return;
         }
         // Expect the API to return a single translation corresponding to the text.
         const translatedText = data.translations[0].translated;
         this._cacheTranslation(item.id, originalText, translatedText, this.config.targetLanguage);
         this._applyTranslatedText(el, translatedText);
      })
      .catch(error => {
         console.error("Translation request failed:", error);
      });
    },

    // Applies the translated text by replacing the element's innerText.
    // This ensures that only the user-facing text changes, leaving images, styling, and structure intact.
    _applyTranslatedText: function(el, translatedText) {
      el.innerText = translatedText;
    },

    /**
     * Retrieves a cached translation for a given element.
     * The cache key combines the site ID, element ID, source language, and target language.
     */
    _getCachedTranslation: function(elementId, originalText, targetLanguage) {
       const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
       const cached = localStorage.getItem(cacheKey);
       if (!cached) return null;
       try {
          const cache = JSON.parse(cached);
          const now = Date.now();
          // Cache expiry: 24 hours.
          if (now - cache.timestamp > 24 * 60 * 60 * 1000) {
             localStorage.removeItem(cacheKey);
             return null;
          }
          // Use the cached translation only if the original text matches.
          if (cache.original === originalText) {
             return cache.translated;
          }
          return null;
       } catch(e) {
          console.error('Cache parsing error:', e);
          localStorage.removeItem(cacheKey);
          return null;
       }
    },

    /**
     * Caches the translated text for a given element.
     */
    _cacheTranslation: function(elementId, originalText, translatedText, targetLanguage) {
       const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
       const cacheData = {
          original: originalText,
          translated: translatedText,
          timestamp: Date.now()
       };
       try {
         localStorage.setItem(cacheKey, JSON.stringify(cacheData));
       } catch(e) {
         console.error('Cache saving error:', e);
       }
    },

    // Adds a language selector UI that lets users choose a language.
    _addLanguageSelector: function() {
      const container = document.createElement('div');
      container.className = 'translation-language-selector no-translate';
      container.style.position = 'fixed';
      container.style.bottom = '20px';
      container.style.right = '20px';
      container.style.background = 'white';
      container.style.border = '1px solid #ddd';
      container.style.borderRadius = '4px';
      container.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
      container.style.zIndex = '9999';
      container.style.overflow = 'hidden';

      const button = document.createElement('button');
      button.innerHTML = `<span>🌐</span> <span>Translate</span>`;
      button.style.background = 'none';
      button.style.border = 'none';
      button.style.padding = '10px 15px';
      button.style.cursor = 'pointer';
      button.style.display = 'flex';
      button.style.alignItems = 'center';
      button.style.gap = '8px';
      button.style.fontFamily = 'system-ui, sans-serif';
      button.style.fontSize = '14px';

      const dropdown = document.createElement('div');
      dropdown.className = 'translation-language-dropdown';
      dropdown.style.display = 'none';
      dropdown.style.padding = '5px 0';
      dropdown.style.borderTop = '1px solid #ddd';

      // List of supported languages.
      const languages = [
         { code: this.config.sourceLanguage, name: 'Original' },
         { code: 'hi', name: 'हिन्दी (Hindi)' },
         { code: 'mr', name: 'मराठी (Marathi)' },
         { code: 'ta', name: 'தமிழ் (Tamil)' },
         { code: 'kn', name: 'ಕನ್ನಡ (Kannada)' },
         { code: 'pa', name: 'ਪੰਜਾਬੀ (Punjabi)' },
         { code: 'gu', name: 'ગુજરાતી (Gujarati)' }
      ];

      const savedLanguage = localStorage.getItem('translation_language');

      languages.forEach(lang => {
         const option = document.createElement('button');
         option.textContent = lang.name;
         option.dataset.language = lang.code;
         option.style.background = 'none';
         option.style.border = 'none';
         option.style.padding = '8px 15px';
         option.style.textAlign = 'left';
         option.style.cursor = 'pointer';
         option.style.width = '100%';
         option.style.fontSize = '14px';
         option.style.fontFamily = 'system-ui, sans-serif';

         if (savedLanguage === lang.code) {
             option.style.backgroundColor = '#f0f0f0';
             button.innerHTML = `<span>🌐</span> <span>${lang.name}</span>`;
             if (this.config.autoTranslate) {
                this.config.targetLanguage = lang.code;
             }
         }

         option.addEventListener('click', () => {
           this.translatePage(lang.code);
           button.innerHTML = `<span>🌐</span> <span>${lang.name}</span>`;
           dropdown.style.display = 'none';
           Array.from(dropdown.children).forEach(child => {
             child.style.backgroundColor = 'transparent';
           });
           option.style.backgroundColor = '#f0f0f0';
         });

         dropdown.appendChild(option);
      });

      button.addEventListener('click', (e) => {
         e.stopPropagation();
         dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      });

      document.addEventListener('click', (e) => {
         if (!container.contains(e.target)) {
            dropdown.style.display = 'none';
         }
      });

      container.appendChild(button);
      container.appendChild(dropdown);
      document.body.appendChild(container);
    },

    // Displays a simple loading indicator.
    _showLoadingIndicator: function() {
      if (document.querySelector('.translation-loading-indicator')) return;
      const indicator = document.createElement('div');
      indicator.className = 'translation-loading-indicator';
      indicator.style.position = 'fixed';
      indicator.style.top = '10px';
      indicator.style.right = '10px';
      indicator.style.background = 'rgba(0,0,0,0.7)';
      indicator.style.color = 'white';
      indicator.style.padding = '8px 15px';
      indicator.style.borderRadius = '4px';
      indicator.style.fontFamily = 'system-ui, sans-serif';
      indicator.style.fontSize = '14px';
      indicator.style.zIndex = '10000';
      indicator.textContent = 'Translating...';
      document.body.appendChild(indicator);
    },

    // Removes the loading indicator.
    _hideLoadingIndicator: function() {
      const indicator = document.querySelector('.translation-loading-indicator');
      if (indicator) {
         indicator.remove();
      }
    }
  };

  // Expose the SDK globally.
  window.TranslationSDK = TranslationSDK;
})(window);
