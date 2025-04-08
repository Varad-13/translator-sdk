(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";
  // Unique delimiter for splitting concatenated text segments.
  const DELIMITER = "|||";

  /**
   * For a given element, find all its nonempty text nodes and return them as an array.
   * @param {Element} element - A DOM element.
   * @returns {Array} Array of text nodes.
   */
  function getTextNodes(element) {
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
      // Merge user options with defaults.
      this.config = { ...this.config, ...options };

      // siteId and apiKey are required.
      if (!this.config.siteId || !this.config.apiKey) {
        console.error('TranslationSDK: siteId and apiKey are required');
        return;
      }

      // Add the language selector UI.
      this._addLanguageSelector();

      // If autoTranslate is enabled and targetLanguage is set, start translation.
      if (this.config.autoTranslate && this.config.targetLanguage) {
        this.translatePage(this.config.targetLanguage);
      }
      return this;
    },

    // Extract translatable elements from the page (excluding those that match the exclude selectors).
    extractContent: function() {
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));

      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];

      // Filter out excluded elements.
      const filteredElements = elements.filter(el => {
        return !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded));
      });

      // Ensure each element has an ID and attach basic context.
      return filteredElements.map(el => {
        if (!el.id) {
          el.id = `el-${Math.random().toString(36).substr(2, 9)}`;
        }
        const sectionEl = el.closest('section, article, div.section');
        const sectionTitle = sectionEl ? sectionEl.querySelector('h1, h2, h3')?.textContent.trim() : '';
        
        // The context can be expanded as needed.
        return {
          id: el.id,
          element: el,
          context: {
            sectionTitle: sectionTitle
          }
        };
      });
    },

    // Translate the page by processing each element.
    translatePage: function(targetLanguage) {
      // Set target language and save preference.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);

      const content = this.extractContent();

      // If target equals the source language, restore original content.
      if (targetLanguage === this.config.sourceLanguage) {
        content.forEach(item => {
          const el = document.getElementById(item.id);
          if (el && el.dataset.originalText) {
            // Restore the original text across all text nodes.
            let textNodes = getTextNodes(el);
            // Here we assume the stored originalText was the full aggregation.
            // For simplicity, we replace the entire element's innerText.
            el.innerText = el.dataset.originalText;
          }
        });
        return;
      }

      // Show a loading indicator.
      this._showLoadingIndicator();

      // Process each element individually.
      content.forEach(item => {
        // For each element, process all its text nodes.
        this._translateElement(item);
      });

      // Hide the loading indicator after a short delay.
      setTimeout(() => { this._hideLoadingIndicator(); }, 2000);
    },

    /**
     * Translates a single element's text without affecting its inner structure.
     * It combines all text nodes using a delimiter, sends them for translation,
     * and then splits the translation to update each text node.
     *
     * @param {Object} item - Object with element info { id, element, context }.
     */
    _translateElement: function(item) {
      const el = item.element;
      // Get all nonempty text nodes.
      const textNodes = getTextNodes(el);
      if (textNodes.length === 0) return;

      // Save the original aggregate text if not already saved.
      if (!el.dataset.originalText) {
        el.dataset.originalText = el.innerText;
      }

      // Build the combined text using the delimiter.
      const originalTexts = textNodes.map(node => node.nodeValue);
      const combinedText = originalTexts.join(DELIMITER);

      // Check for a cached translation.
      const cached = this._getCachedTranslation(item.id, combinedText, this.config.targetLanguage);
      if (cached) {
        this._applyTranslatedText(el, cached);
        return;
      }

      // Build payload with additional context if needed.
      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: [{
          id: item.id,
          text: combinedText,
          context: item.context
        }]
      };

      // Send the payload via a POST request.
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
        // We expect a single translation corresponding to the combined text.
        const translatedCombined = data.translations[0].text;
        // Cache the translation.
        this._cacheTranslation(item.id, combinedText, translatedCombined, this.config.targetLanguage);
        // Apply the translation.
        this._applyTranslatedText(el, translatedCombined);
      })
      .catch(error => {
        console.error("Translation request failed:", error);
      });
    },

    /**
     * Splits the translated combined text using the delimiter and updates each text node.
     * If the split parts count does not match, falls back to replacing innerText.
     *
     * @param {Element} el - The DOM element to update.
     * @param {string} translatedCombined - The full translated text.
     */
    _applyTranslatedText: function(el, translatedCombined) {
      const textNodes = getTextNodes(el);
      const parts = translatedCombined.split(DELIMITER);
      if (parts.length !== textNodes.length) {
        // If a mismatch occurs, use innerText replacement (fallback).
        el.innerText = translatedCombined;
      } else {
        textNodes.forEach((node, i) => {
          node.nodeValue = parts[i];
        });
      }
    },

    /**
     * Retrieves a cached translation for a given element and its original combined text.
     *
     * @param {string} elementId
     * @param {string} originalCombined
     * @param {string} targetLanguage
     * @returns {string|null} The translated combined text or null.
     */
    _getCachedTranslation: function(elementId, originalCombined, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cached = localStorage.getItem(cacheKey);
      if (!cached) return null;
      try {
        const cache = JSON.parse(cached);
        const now = Date.now();
        // Cache expires after 24 hours.
        if (now - cache.timestamp > 24 * 60 * 60 * 1000) {
          localStorage.removeItem(cacheKey);
          return null;
        }
        // Only use the cache if the original text is identical.
        if (cache.original === originalCombined) {
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
     * Caches the translated combined text for an element.
     *
     * @param {string} elementId
     * @param {string} originalCombined
     * @param {string} translatedCombined
     * @param {string} targetLanguage
     */
    _cacheTranslation: function(elementId, originalCombined, translatedCombined, targetLanguage) {
      const cacheKey = `translation_${this.config.siteId}_${elementId}_${this.config.sourceLanguage}_${targetLanguage}`;
      const cacheData = { 
        original: originalCombined, 
        translated: translatedCombined, 
        timestamp: Date.now() 
      };
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

      // Languages list including an option for original.
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
