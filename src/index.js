(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";
  // A delimiter unlikely to appear in normal text.
  const DELIMITER = "|||";

  /**
   * Walks through the DOM tree of a given element and returns an array of nonempty text nodes.
   * @param {Element} element - The element to search.
   * @returns {Array} - Array of text nodes.
   */
  function getTextNodes(element) {
    const textNodes = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          return (node.nodeValue && node.nodeValue.trim().length > 0)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        }
      },
      false
    );
    let currentNode;
    while ((currentNode = walker.nextNode())) {
      textNodes.push(currentNode);
    }
    return textNodes;
  }

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
        include: ['div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'td', 'th', 'button', 'a', 'label', 'span'],
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },

    // Initialize the SDK with options.
    init: function(options) {
      this.config = { ...this.config, ...options };

      if (!this.config.siteId || !this.config.apiKey) {
        console.error('TranslationSDK: siteId and apiKey are required');
        return;
      }

      // Add the language selector UI.
      this._addLanguageSelector();

      // Auto-translate if enabled and a target language is set.
      if (this.config.autoTranslate && this.config.targetLanguage) {
        this.translatePage(this.config.targetLanguage);
      }

      return this;
    },

    // Extract candidate elements that contain user-facing text.
    extractContent: function() {
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));

      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];

      const filteredElements = elements.filter(el => {
        return !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded));
      });

      // Ensure each element has an ID and add minimal context.
      return filteredElements.map(el => {
        if (!el.id) {
          el.id = `el-${Math.random().toString(36).substr(2, 9)}`;
        }
        // Attempt to grab a section title as simple context.
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

    // Translate the page by processing each element individually.
    translatePage: function(targetLanguage) {
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);

      const contentItems = this.extractContent();

      // If target equals source language, restore original text.
      if (targetLanguage === this.config.sourceLanguage) {
        contentItems.forEach(item => {
          const el = item.element;
          if (el.dataset.originalText) {
            // Restore original content without modifying child tags.
            // Note: This assumes that the stored originalText is the aggregated text.
            // If more granularity is required, you must cache per text node.
            // Here we simply set each node's value back.
            const textNodes = getTextNodes(el);
            let parts = el.dataset.originalText.split(DELIMITER);
            if (parts.length === textNodes.length) {
              textNodes.forEach((node, index) => {
                node.nodeValue = parts[index];
              });
            } else {
              // Fallback: replace innerText
              el.innerText = el.dataset.originalText;
            }
          }
        });
        return;
      }

      this._showLoadingIndicator();

      contentItems.forEach(item => {
        this._translateElement(item);
      });

      setTimeout(() => { this._hideLoadingIndicator(); }, 2000);
    },

    /**
     * Translates a single element’s text nodes while preserving its HTML structure.
     * It:
     *  - Extracts all non-empty text nodes.
     *  - Combines their text using a unique delimiter.
     *  - Caches the original aggregated text (if not cached).
     *  - Checks for cached translations; otherwise sends to the API.
     *  - Splits the translated text and updates each text node.
     *
     * @param {Object} item - Object with { id, element, context }
     */
    _translateElement: function(item) {
      const el = item.element;
      const textNodes = getTextNodes(el);
      if (textNodes.length === 0) return;

      // Get aggregated text from text nodes.
      const originalTexts = textNodes.map(node => node.nodeValue.trim());
      const aggregatedText = originalTexts.join(DELIMITER);

      // Save the original aggregated text for later restoration.
      if (!el.dataset.originalText) {
        el.dataset.originalText = aggregatedText;
      }

      // Check for a cached translation.
      const cached = this._getCachedTranslation(item.id, aggregatedText, this.config.targetLanguage);
      if (cached) {
        this._applyTranslatedText(el, textNodes, cached);
        return;
      }

      // Prepare the payload: note that we send the aggregated text.
      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: [{
          id: item.id,
          text: aggregatedText,
          type: "paragraph",
          context: item.context
        }]
      };

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
        // Expect a single translation corresponding to the aggregated text.
        const translatedAggregated = data.translations[0].translated;
        this._cacheTranslation(item.id, aggregatedText, translatedAggregated, this.config.targetLanguage);
        this._applyTranslatedText(el, textNodes, translatedAggregated);
      })
      .catch(error => {
        console.error("Translation request failed:", error);
      });
    },

    /**
     * Splits the translated aggregated text into parts (based on DELIMITER)
     * and applies each part to its corresponding text node.
     *
     * @param {Element} el - The container element.
     * @param {Array} textNodes - Array of text nodes to update.
     * @param {string} translatedAggregated - The full translated text.
     */
    _applyTranslatedText: function(el, textNodes, translatedAggregated) {
      const parts = translatedAggregated.split(DELIMITER);
      if (parts.length === textNodes.length) {
        textNodes.forEach((node, index) => {
          node.nodeValue = parts[index];
        });
      } else {
        // Fallback: update the element's innerText.
        el.innerText = translatedAggregated;
      }
    },

    /**
     * Retrieves a cached translation from localStorage if available.
     */
    _getCachedTranslation: function(elementId, originalText, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return null;
      try {
        const cache = JSON.parse(cached);
        const now = Date.now();
        if (now - cache.timestamp > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(cacheKey);
          return null;
        }
        if (cache.original === originalText) {
          return cache.translated;
        }
        return null;
      } catch (e) {
        console.error('Cache parsing error:', e);
        localStorage.removeItem(cacheKey);
        return null;
      }
    },

    /**
     * Caches the translated aggregated text for an element.
     */
    _cacheTranslation: function(elementId, originalText, translatedAggregated, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cacheData = {
        original: originalText,
        translated: translatedAggregated,
        timestamp: Date.now()
      };
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (e) {
        console.error('Cache saving error:', e);
      }
    },

    // Language selector UI.
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

    // Displays a loading indicator.
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

    // Hides the loading indicator.
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
