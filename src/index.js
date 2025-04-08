(function(window) {
  'use strict';

  // API configuration
  const API_URL = "http://localhost:8000/api/v1/translate";

  // Main SDK object
  const TranslationSDK = {
    config: {
      apiUrl: API_URL,
      siteId: null,
      sourceLanguage: "en", // This is our "Original" language.
      targetLanguage: null,
      apiKey: null,
      autoTranslate: true,
      selectors: {
        // Only include textual elements; adjust as needed.
        include: [
          'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
          'li', 'td', 'th', 'button', 'a', 'label', 'span'
        ],
        exclude: ['.no-translate', '[data-no-translate]']
      }
    },
    // Counter for retry attempts when content is not yet available.
    _translationRetries: 0,
    // Reference for the language selector button.
    _languageSelectorButton: null,
    // Mapping of language codes to friendly names.
    _languageMapping: {
      en: 'Original',
      hi: 'हिन्दी (Hindi)',
      mr: 'मराठी (Marathi)',
      ta: 'தமிழ் (Tamil)',
      kn: 'ಕನ್ನಡ (Kannada)',
      pa: 'ਪੰਜਾਬੀ (Punjabi)',
      gu: 'ગુજરાતી (Gujarati)'
    },
    // Local storage key for the original content.
    _originalContentKey: "translationSDK_originalContent",
    // Local storage key for the translation cache.
    _cacheKey: "translationSDK_cache",

    /* ------------------ Helper Cache Functions ------------------ */
    // Retrieve the current cache as an object.
    _getCache: function() {
      const stored = localStorage.getItem(this._cacheKey);
      try {
        return stored ? JSON.parse(stored) : {};
      } catch(e) {
        return {};
      }
    },
    // Save the provided cache object back to localStorage.
    _setCache: function(cache) {
      localStorage.setItem(this._cacheKey, JSON.stringify(cache));
    },
    // Compute a simple hash (djb2) for a given string.
    _computeHash: function(str) {
      let hash = 5381;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) + str.charCodeAt(i); // hash * 33 + c
      }
      // Convert to positive number and return as string.
      return (hash >>> 0).toString(16);
    },
    /* ------------------------------------------------------------ */

    // Save the original (untranslated) content.
    _saveOriginalContent: function() {
      const content = this.extractContent();
      const mapping = {};
      content.forEach(item => {
        // Save the original text in a dataset property if not already set.
        if (!item.element.dataset.originalText) {
          item.element.dataset.originalText = item.text;
        }
        mapping[item.id] = item.element.dataset.originalText;
      });
      localStorage.setItem(this._originalContentKey, JSON.stringify(mapping));
    },

    // Restore the original content (remove translation classes).
    _restoreOriginalContent: function() {
      const stored = localStorage.getItem(this._originalContentKey);
      if (!stored) return;
      const mapping = JSON.parse(stored);
      Object.keys(mapping).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
          el.textContent = mapping[id];
          // Remove any translation class (any class starting with "translated-")
          Array.from(el.classList).forEach(cls => {
            if (cls.indexOf("translated-") === 0) {
              el.classList.remove(cls);
            }
          });
        }
      });
    },

    // Initializes the SDK with provided options.
    init: function(options) {
      this.config = { ...this.config, ...options };

      if (!this.config.siteId || !this.config.apiKey) {
        console.error('TranslationSDK: siteId and apiKey are required');
        return;
      }

      // Delay saving the original content to ensure page is rendered.
      setTimeout(() => {
        this._saveOriginalContent();
      }, 50);

      // Set up the language selector UI.
      this._addLanguageSelector();
      // Set up route change detection to trigger re-translation on URL changes.
      this._setupRouteChangeListener();

      const storedLanguage = localStorage.getItem('translation_language');
      // Allow a slight delay for the DOM to settle before the initial translation.
      setTimeout(() => {
        if (this.config.autoTranslate) {
          this.translatePage(storedLanguage || this.config.targetLanguage);
        } else if (storedLanguage) {
          this.translatePage(storedLanguage);
        }
      }, 100);

      return this;
    },

    // Extracts content elements from the document.
    extractContent: function() {
      const includeSelector = this.config.selectors.include.join(',');
      const elements = Array.from(document.querySelectorAll(includeSelector));
      const excludeSelector = this.config.selectors.exclude.join(',');
      const excludedElements = excludeSelector ? Array.from(document.querySelectorAll(excludeSelector)) : [];

      // Filter out excluded elements.
      const filteredElements = elements.filter(el =>
        !excludedElements.some(excluded => excluded.contains(el) || el.contains(excluded))
      );

      return filteredElements.map(el => {
        if (!el.id) {
          el.id = `el-${Math.random().toString(36).substr(2, 9)}`;
        }
        const sectionEl = el.closest('section, article, div.section');
        const sectionTitle = sectionEl
          ? (sectionEl.querySelector('h1, h2, h3')?.textContent.trim() || "")
          : "";
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

    // Determines an element's type based on its tag.
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

    // Triggers a translation or restores original content if requested.
    translatePage: function(targetLanguage) {
      // Save target language and update localStorage.
      this.config.targetLanguage = targetLanguage;
      localStorage.setItem('translation_language', targetLanguage);

      // Update the language selector button immediately.
      if (this._languageSelectorButton) {
        const languageName = this._languageMapping[targetLanguage] || targetLanguage;
        this._languageSelectorButton.innerHTML = `<span>🌐</span> <span>${languageName}</span>`;
      }

      // If target language equals source, restore original content.
      if (targetLanguage === this.config.sourceLanguage) {
        this._restoreOriginalContent();
        return;
      }

      const content = this.extractContent();
      if (content.length === 0 && this._translationRetries < 3) {
        this._translationRetries++;
        console.warn("No content extracted; retrying in 500ms... Retry count: " + this._translationRetries);
        setTimeout(() => {
          this.translatePage(targetLanguage);
        }, 500);
        return;
      }
      this._translationRetries = 0;
      this._showLoadingIndicator();

      // Send the translation request (using cache if available).
      this._sendTranslationRequest(content, (translations) => {
        this._applyTranslations(translations);
        this._hideLoadingIndicator();
      });
    },

    // Sends a translation request; uses local cache to avoid duplicate API requests.
    _sendTranslationRequest: function(content, callback) {
      let cache = this._getCache();
      const contentToRequest = [];
      const cachedResponses = [];

      // Process each content item.
      content.forEach(item => {
        // Use stored original text if available.
        const originalText = item.element.dataset.originalText || item.text;
        // Compute hash from original text.
        const hash = this._computeHash(originalText);
        // Compose a cache key using hash and target language.
        const cacheKey = hash + "-" + this.config.targetLanguage;
        if (cache[cacheKey]) {
          // If cached, add to responses.
          cachedResponses.push({ id: item.id, translated: cache[cacheKey] });
        } else {
          // Save the computed hash on the item, so we can update the cache later.
          item.hash = hash;
          contentToRequest.push(item);
        }
      });

      // If all content is cached, use the cached responses.
      if (contentToRequest.length === 0) {
        callback(cachedResponses);
        return;
      }

      // Prepare payload for items not in cache.
      const payload = {
        sourceLanguage: this.config.sourceLanguage,
        targetLanguage: this.config.targetLanguage,
        siteId: this.config.siteId,
        content: contentToRequest.map(item => ({
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
        // Update cache with newly received translations.
        data.translations.forEach(translation => {
          // Find the original item to get its hash.
          const originalItem = contentToRequest.find(item => item.id === translation.id);
          if (originalItem) {
            const key = originalItem.hash + "-" + this.config.targetLanguage;
            cache[key] = translation.translated;
          }
        });
        // Save updated cache.
        this._setCache(cache);
        // Combine cached responses with API responses.
        const combined = cachedResponses.concat(data.translations);
        callback(combined);
      })
      .catch(error => {
        console.error("Translation request failed:", error);
        this._hideLoadingIndicator();
      });
    },

    // Applies translations to the page and adds a language-specific CSS class.
    _applyTranslations: function(translations) {
      translations.forEach(translation => {
        const element = document.getElementById(translation.id);
        if (!element) return;
        if (!element.dataset.originalText) {
          element.dataset.originalText = element.textContent;
        }
        element.textContent = translation.translated;
        // Remove any previous translation classes (classes starting with "translated-")
        Array.from(element.classList).forEach(cls => {
          if (cls.indexOf("translated-") === 0) {
            element.classList.remove(cls);
          }
        });
        // Add a new class for the current target language.
        element.classList.add(`translated-${this.config.targetLanguage}`);
      });
    },

    // Sets up a listener for route changes (for single-page applications).
    _setupRouteChangeListener: function() {
      const _pushState = history.pushState;
      history.pushState = function() {
        _pushState.apply(history, arguments);
        window.dispatchEvent(new Event('locationchange'));
      };
      const _replaceState = history.replaceState;
      history.replaceState = function() {
        _replaceState.apply(history, arguments);
        window.dispatchEvent(new Event('locationchange'));
      };
      window.addEventListener('popstate', function() {
        window.dispatchEvent(new Event('locationchange'));
      });
      window.addEventListener('locationchange', () => {
        setTimeout(() => {
          TranslationSDK.translatePage(TranslationSDK.config.targetLanguage);
        }, 500);
      });
    },

    // Adds the language selector dropdown UI.
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
      const initLang = this.config.targetLanguage || this.config.sourceLanguage;
      const initName = this._languageMapping[initLang] || initLang;
      button.innerHTML = `<span>🌐</span> <span>${initName}</span>`;
      button.style.background = 'none';
      button.style.border = 'none';
      button.style.padding = '10px 15px';
      button.style.cursor = 'pointer';
      button.style.display = 'flex';
      button.style.alignItems = 'center';
      button.style.gap = '8px';
      button.style.fontFamily = 'system-ui, sans-serif';
      button.style.fontSize = '14px';

      this._languageSelectorButton = button;

      const dropdown = document.createElement('div');
      dropdown.className = 'translation-language-dropdown';
      dropdown.style.display = 'none';
      dropdown.style.padding = '5px 0';
      dropdown.style.borderTop = '1px solid #ddd';

      const languages = [
        { code: this.config.sourceLanguage, name: this._languageMapping[this.config.sourceLanguage] },
        { code: 'hi', name: this._languageMapping['hi'] },
        { code: 'mr', name: this._languageMapping['mr'] },
        { code: 'ta', name: this._languageMapping['ta'] },
        { code: 'kn', name: this._languageMapping['kn'] },
        { code: 'pa', name: this._languageMapping['pa'] },
        { code: 'gu', name: this._languageMapping['gu'] }
      ];

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

        option.addEventListener('click', () => {
          TranslationSDK.translatePage(lang.code);
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
        dropdown.style.display = (dropdown.style.display === 'none') ? 'block' : 'none';
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
