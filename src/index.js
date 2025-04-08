(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  /**
   * Helper function to update only the text nodes of an element.
   * If there is exactly one text node (the common case for simple content),
   * it updates that node in place. Otherwise, it falls back to replacing
   * the element’s content entirely.
   *
   * @param {Element} element - The DOM element to update.
   * @param {string} newText - The translated text that will replace the original.
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
      // If no text nodes exist, append a new text node.
      element.appendChild(document.createTextNode(newText));
    } else if (textNodes.length === 1) {
      // If there is a single text node, update its value.
      textNodes[0].nodeValue = newText;
    } else {
      // If there are multiple text nodes, merging them to match the translated text
      // is nontrivial; so, as a fallback, replace the element’s content altogether.
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

      // Extract content with context; assign an id to elements if none exists.
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

    // Determine element type based on its tag.
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

    // Translate the page into the target language.
    translatePage: function(targetLanguage) {
      // Set target language and save the preference.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);

      // Extract content from the page.
      const content = this.extractContent();

      // If target language equals the source language, restore the original content.
      if (targetLanguage === this.config.sourceLanguage) {
        content.forEach(item => {
          const element = document.getElementById(item.id);
          if (element && element.dataset.originalHTML) {
            element.innerHTML = element.dataset.originalHTML;
          }
        });
        return;
      }

      // Try to retrieve cached translations.
      const cachedTranslations = this._getCachedTranslations(content, targetLanguage);
      if (cachedTranslations && cachedTranslations.length > 0) {
        this._applyTranslations(cachedTranslations);
      }

      // Identify content that isn’t cached.
      const contentToTranslate = content.filter(item => {
        if (!cachedTranslations) return true;
        return !cachedTranslations.some(cached => cached.id === item.id);
      });

      if (contentToTranslate.length === 0) {
        return; // All content already has cached translations.
      }

      // Show a loading indicator.
      this._showLoadingIndicator();

      // Send the content needing translation to the API.
      this._sendTranslationRequest(contentToTranslate, (translations) => {
        // Apply the new translations.
        this._applyTranslations(translations);
        // Cache the newly received translations.
        this._cacheTranslations(translations, targetLanguage);
        // Hide the loading indicator.
        this._hideLoadingIndicator();
      });
    },

    // Sends a translation request to the backend API.
    _sendTranslationRequest: function(content, callback) {
      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: content.map(item => ({
          id: item.id,
          text: item.text,
          type: item.type,
          context: item.context
        }))
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
        callback(data.translations);
      })
      .catch(error => {
        console.error("Translation request failed:", error);
        this._hideLoadingIndicator();
      });
    },

    // Apply translations to the DOM.
    _applyTranslations: function(translations) {
      translations.forEach(translation => {
        const element = document.getElementById(translation.id);
        if (!element) return;
        // Save the original HTML if it hasn't been saved yet.
        if (!element.dataset.originalHTML) {
          element.dataset.originalHTML = element.innerHTML;
        }
        // Update only the text nodes (this preserves the element structure)
        updateTextNodes(element, translation.translated);
      });
    },

    // Retrieve cached translations from localStorage (if available and not expired).
    _getCachedTranslations: function(content, targetLanguage) {
      const cacheKey = `translations_${this.config.siteId}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return null;
      try {
        const cache = JSON.parse(cached);
        const now = new Date().getTime();
        // Cache expires after 24 hours.
        if (now - cache.timestamp > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(cacheKey);
          return null;
        }
        // Return translations matching current content.
        return content.map(item => {
          const cachedItem = cache.data.find(c => c.original === item.text);
          if (!cachedItem) return null;
          return {
            id: item.id,
            original: item.text,
            translated: cachedItem.translated
          };
        }).filter(Boolean);
      } catch (e) {
        console.error('Cache parsing error:', e);
        localStorage.removeItem(cacheKey);
        return null;
      }
    },

    // Cache new translations in localStorage.
    _cacheTranslations: function(translations, targetLanguage) {
      const cacheKey = `translations_${this.config.siteId}_${this.config.sourceLanguage}_${targetLanguage}`;
      try {
        const existing = localStorage.getItem(cacheKey);
        const cache = existing ? JSON.parse(existing) : { data: [], timestamp: new Date().getTime() };
        translations.forEach(translation => {
          const existingIndex = cache.data.findIndex(c => c.original === translation.original);
          if (existingIndex >= 0) {
            cache.data[existingIndex] = {
              original: translation.original,
              translated: translation.translated
            };
          } else {
            cache.data.push({
              original: translation.original,
              translated: translation.translated
            });
          }
        });
        cache.timestamp = new Date().getTime();
        localStorage.setItem(cacheKey, JSON.stringify(cache));
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

      // Added Original option using the sourceLanguage from config.
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

        // Highlight the saved language option if it exists.
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
