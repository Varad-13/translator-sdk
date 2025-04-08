(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  /**
   * Helper function to update only the text nodes of an element.
   * It finds text nodes in an element and replaces their text content,
   * preserving the overall element structure.
   *
   * @param {Element} element - The DOM element to update.
   * @param {string} newText - The translated text to apply.
   */
  function updateTextNodes(element, newText) {
    const textNodes = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          return node.nodeValue.trim().length > 0
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
    if (textNodes.length === 0) {
      element.appendChild(document.createTextNode(newText));
    } else if (textNodes.length === 1) {
      textNodes[0].nodeValue = newText;
    } else {
      // When multiple text nodes exist, clear element content and replace with one new text node.
      element.innerHTML = '';
      element.appendChild(document.createTextNode(newText));
    }
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

    // Initialize the SDK with options
    init: function(options) {
      // Merge user options with defaults.
      this.config = { ...this.config, ...options };

      // Ensure required options are provided.
      if (!this.config.siteId || !this.config.apiKey) {
        console.error('TranslationSDK: siteId and apiKey are required');
        return;
      }

      // Add language selector UI to the page.
      this._addLanguageSelector();

      // If autoTranslate is enabled and a target language is set, translate immediately.
      if (this.config.autoTranslate && this.config.targetLanguage) {
        this.translatePage(this.config.targetLanguage);
      }
      return this;
    },

    // Extracts text content from elements while omitting excluded selectors.
    extractContent: function() {
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));

      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];

      // Filter out excluded elements.
      const filteredElements = elements.filter(el => {
        return !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded));
      });

      // Extract content along with context; assign an id if none exists.
      return filteredElements.map(el => {
        if (!el.id) {
          el.id = `el-${Math.random().toString(36).substr(2, 9)}`;
        }
        const sectionEl = el.closest('section, article, div.section');
        const sectionTitle = sectionEl ? sectionEl.querySelector('h1, h2, h3')?.textContent.trim() : '';

        const siblings = Array.from(el.parentNode.children);
        const index = siblings.indexOf(el);
        const precedingEl = index > 0 ? siblings[index - 1] : null;
        const followingEl = index < siblings.length - 1 ? siblings[index + 1] : null;

        return {
          id: el.id,
          text: el.textContent.trim(),
          type: this._getElementType(el),
          element: el,
          context: {
            preceding: precedingEl ? precedingEl.textContent.trim() : '',
            following: followingEl ? followingEl.textContent.trim() : '',
            sectionTitle: sectionTitle
          }
        };
      }).filter(item => item.text.length > 0);
    },

    // Determine element type based on tag.
    _getElementType: function(el) {
      const tag = el.tagName.toLowerCase();
      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return 'heading';
      if (tag === 'p') return 'paragraph';
      if (tag === 'li') return 'list-item';
      if (['td', 'th'].includes(tag)) return 'table-cell';
      if (tag === 'button') return 'button';
      if (tag === 'a') return 'link';
      return 'other';
    },

    // Translate the page into the target language, one element at a time.
    translatePage: function(targetLanguage) {
      // Set target language and store preference.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);

      const content = this.extractContent();

      // If target language equals the source language, restore original content.
      if (targetLanguage === this.config.sourceLanguage) {
        content.forEach(item => {
          const element = document.getElementById(item.id);
          if (element && element.dataset.originalHTML) {
            element.innerHTML = element.dataset.originalHTML;
          }
        });
        return;
      }

      // Show a global loading indicator.
      this._showLoadingIndicator();

      // Process each element individually.
      content.forEach(item => {
        const cached = this._getCachedTranslation(item, targetLanguage);
        if (cached) {
          this._applyTranslation(cached);
        } else {
          this._sendTranslationRequestForElement(item, (translation) => {
            this._applyTranslation(translation);
            this._cacheTranslation(item, translation, targetLanguage);
          });
        }
      });

      // Hide the loading indicator after a delay.
      setTimeout(() => { this._hideLoadingIndicator(); }, 5000);
    },

    /**
     * Sends a translation request for a single element.
     * The payload is constructed with one content item.
     *
     * @param {Object} item - Object representing the element and its text.
     * @param {Function} callback - Function to execute upon receiving the translation.
     */
    _sendTranslationRequestForElement: function(item, callback) {
      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: [{
          id: item.id,
          text: item.text,
          type: item.type,
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
        if (data.error) {
          console.error('Translation error:', data.error);
          return;
        }
        // Assume API returns an array; we take the first translation.
        if (data.translations && data.translations.length > 0) {
          callback(data.translations[0]);
        }
      })
      .catch(error => {
        console.error("Translation request failed:", error);
      });
    },

    /**
     * Apply a single translation to the corresponding element.
     * Saves the original HTML (if not already saved) and then updates only text nodes.
     *
     * @param {Object} translation - Object with { id, translated }.
     */
    _applyTranslation: function(translation) {
      const element = document.getElementById(translation.id);
      if (!element) return;
      if (!element.dataset.originalHTML) {
        element.dataset.originalHTML = element.innerHTML;
      }
      updateTextNodes(element, translation.translated);
    },

    /**
     * Retrieves a cached translation for a single element from localStorage.
     *
     * @param {Object} item - The element content object.
     * @param {string} targetLanguage - The language code.
     * @returns {Object|null} - The cached translation (with id and translated) or null.
     */
    _getCachedTranslation: function(item, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${item.id}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return null;
      try {
        const cache = JSON.parse(cached);
        const now = new Date().getTime();
        if (now - cache.timestamp > 24 * 60 * 60 * 1000) { // cache expires after 24 hours
          localStorage.removeItem(cacheKey);
          return null;
        }
        return { id: item.id, original: item.text, translated: cache.translated };
      } catch (e) {
        console.error('Cache parsing error:', e);
        localStorage.removeItem(cacheKey);
        return null;
      }
    },

    /**
     * Caches a single translation for an element in localStorage.
     *
     * @param {Object} item - The element content object.
     * @param {Object} translation - The translation data returned by the API.
     * @param {string} targetLanguage - The target language code.
     */
    _cacheTranslation: function(item, translation, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${item.id}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cacheData = { translated: translation.translated, timestamp: new Date().getTime() };
      try {
        localStorage.setItem(cacheKey, JSON.stringify(cacheData));
      } catch (e) {
        console.error('Cache saving error:', e);
      }
    },

    // Add the language selector UI to the document.
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

      // Include the Original option plus additional languages.
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

    // Display a loading indicator.
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

    // Remove the loading indicator.
    _hideLoadingIndicator: function() {
      const indicator = document.querySelector('.translation-loading-indicator');
      if (indicator) {
        indicator.remove();
      }
    }
  };

  // Expose the SDK to the global window object.
  window.TranslationSDK = TranslationSDK;
})(window);
